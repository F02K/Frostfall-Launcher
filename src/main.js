// Load .env before anything else — only in unpackaged (dev/local) builds.
// Packaged installers use real environment variables set by the OS / process manager.
if (!require('electron').app.isPackaged) {
  require('dotenv').config()
}

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron')
const path   = require('path')
const fs     = require('fs')
const os     = require('os')
const crypto = require('crypto')
const http   = require('http')
const https  = require('https')
const { spawn } = require('child_process')
const Store  = require('electron-store')
const AdmZip = require('adm-zip')
const config = require('./config')
const vortex = require('./vortex')

const isDev = process.argv.includes('--dev')

// ── Dev logger ────────────────────────────────────────────────────────────────
const LOG_FILE = isDev ? path.join(require('os').tmpdir(), 'frostfall-install.log') : null

function log(...args) {
  const line = args.join(' ')
  console.log(line)
  if (LOG_FILE) fs.appendFileSync(LOG_FILE, line + '\n')
}

if (LOG_FILE) {
  fs.writeFileSync(LOG_FILE, `=== frostfall install log ${new Date().toISOString()} ===\n`)
  console.log('[dev] logging to', LOG_FILE)
}

// Only user-specific preferences live in the store.
const store = new Store({
  defaults: {
    skyrimPath:        '',
    username:          '',
    activeServerIndex: 0,
    cachedServers:     [],   // last-known server list fetched from /api/servers
    filesVersion:      '',   // version tag from last successful file download
    discordUser:       null,
    discordToken:      null,
    vortexPath:        '',
    vortexProfileId:   '',
    vortexEnabled:     false,
  }
})

let win = null

function send(channel, ...args) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args)
}

// ── Active server helper ──────────────────────────────────────────────────────
// Returns the currently selected game server from the cached API list,
// or null if no servers have been fetched yet.
function activeServer() {
  const servers = store.get('cachedServers') || []
  if (servers.length === 0) return null
  const idx = Math.min(store.get('activeServerIndex') || 0, servers.length - 1)
  return servers[idx]
}

// ── Window ────────────────────────────────────────────────────────────────────
function createWindow() {
  win = new BrowserWindow({
    width:     1280,
    height:    720,
    minWidth:  1024,
    minHeight: 600,
    frame:     false,
    resizable: true,
    webPreferences: {
      preload:          path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration:  false,
    },
    backgroundColor: '#080503',
    show: false,
  })

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'))
  win.once('ready-to-show', () => win.show())

  if (isDev) win.webContents.openDevTools({ mode: 'detach' })
}

app.whenReady().then(() => {
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// ── Window controls ───────────────────────────────────────────────────────────
ipcMain.on('window:minimize', () => win?.minimize())
ipcMain.on('window:maximize', () => {
  if (win?.isMaximized()) win.unmaximize()
  else win?.maximize()
})
ipcMain.on('window:close', () => win?.close())

// ── Settings ──────────────────────────────────────────────────────────────────
ipcMain.handle('settings:load', async () => {
  // Refresh the server list from the backend on every load.
  // On failure we keep the previously cached list so offline launches still work.
  try {
    const fetched = await fetchJSON(`${config.apiUrl}/api/servers`)
    if (Array.isArray(fetched) && fetched.length > 0) {
      store.set('cachedServers', fetched)
    }
  } catch { /* keep existing cache */ }

  const servers = store.get('cachedServers') || []
  return {
    ...store.store,
    servers,
    multiServer: servers.length > 1,
    discordUser: store.get('discordUser') || null,
  }
})
ipcMain.handle('settings:save', (_e, data) => {
  const allowed = ['skyrimPath', 'username', 'activeServerIndex',
                   'vortexPath', 'vortexProfileId', 'vortexEnabled']
  const clean = {}
  for (const k of allowed) if (k in data) clean[k] = data[k]
  store.set(clean)
})

// ── Folder picker ─────────────────────────────────────────────────────────────
ipcMain.handle('dialog:openFolder', async () => {
  const result = await dialog.showOpenDialog(win, {
    properties: ['openDirectory'],
    title: 'Select Skyrim Installation Folder',
  })
  return result.canceled ? null : result.filePaths[0]
})

// ── Open external URL — http/https only ──────────────────────────────────────
ipcMain.on('open:external', (_e, url) => {
  if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
    shell.openExternal(url)
  }
})

// ── News ──────────────────────────────────────────────────────────────────────
ipcMain.handle('api:news', async () => {
  try { return await fetchJSON(`${config.apiUrl}/api/news`) }
  catch { return null }
})

// ── Server status ─────────────────────────────────────────────────────────────
ipcMain.handle('api:status', async () => {
  try {
    const data = await fetchJSON(`${config.apiUrl}/api/status`)
    return { ok: true, ...data }
  } catch {
    return { ok: false }
  }
})

// ── Server info ───────────────────────────────────────────────────────────────
ipcMain.handle('api:serverinfo', async () => {
  try { return await fetchJSON(`${config.apiUrl}/api/serverinfo`) }
  catch { return null }
})

// ── Discord OAuth ─────────────────────────────────────────────────────────────

ipcMain.handle('discord:getUser', () => store.get('discordUser') || null)

ipcMain.handle('discord:logout', () => {
  store.set('discordUser',  null)
  store.set('discordToken', null)
  return { success: true }
})

ipcMain.handle('discord:login', async () => {
  // 1. Ask backend for the OAuth URL
  let authUrl
  try {
    const data = await fetchJSON(`${config.apiUrl}/auth/discord/url`)
    authUrl = data.url
  } catch (err) {
    return { success: false, error: `Could not reach backend: ${err.message}` }
  }
  if (!authUrl) return { success: false, error: 'Discord auth not configured on this server.' }

  // 2. Open a minimal auth window and wait for the redirect code
  return new Promise(resolve => {
    const authWin = new BrowserWindow({
      width:  520,
      height: 720,
      parent: win,
      modal:  true,
      title:  'Login with Discord',
      webPreferences: {
        nodeIntegration:  false,
        contextIsolation: true,
      },
    })

    authWin.setMenuBarVisibility(false)
    authWin.loadURL(authUrl)

    let settled = false

    function handleUrl(url) {
      if (settled) return
      if (!url.startsWith('http://localhost:4000/auth/callback')) return
      settled = true

      const code = new URL(url).searchParams.get('code')
      authWin.close()

      if (!code) {
        resolve({ success: false, error: 'No authorization code received.' })
        return
      }

      // 3. Exchange the code via backend (keeps clientSecret server-side)
      fetchJSON(`${config.apiUrl}/auth/discord/exchange?code=${encodeURIComponent(code)}`)
        .then(data => {
          if (!data.ok) return resolve({ success: false, error: data.error })
          store.set('discordUser',  data.user)
          store.set('discordToken', data.accessToken)
          resolve({ success: true, user: data.user })
        })
        .catch(err => resolve({ success: false, error: err.message }))
    }

    authWin.webContents.on('will-redirect', (_e, url) => handleUrl(url))
    authWin.webContents.on('will-navigate',  (_e, url) => handleUrl(url))

    authWin.on('closed', () => {
      if (!settled) resolve({ success: false, error: 'Login window closed.' })
    })
  })
})

// ── Vortex integration ────────────────────────────────────────────────────────

ipcMain.handle('vortex:detect', () => {
  const found = vortex.findVortexExe()
  return { found: !!found, path: found || '' }
})

ipcMain.handle('vortex:listProfiles', () => vortex.listProfiles())

ipcMain.handle('vortex:getStatus', () => {
  const vortexPath = store.get('vortexPath')
  const profileId  = store.get('vortexProfileId')
  return vortex.getStatus(vortexPath, profileId)
})

ipcMain.handle('vortex:tagProfile', (_e, profileId, profileName) => {
  try {
    vortex.tagProfile(profileId, profileName)
    return { success: true }
  } catch (err) {
    return { success: false, error: err.message }
  }
})

ipcMain.on('vortex:openProfilesDir', () => {
  const dir = vortex.getProfilesRoot()
  if (fs.existsSync(dir)) shell.openPath(dir)
  else shell.openPath(vortex.getDataPath())
})

// ── Metrics ───────────────────────────────────────────────────────────────────
ipcMain.handle('api:metrics', async () => {
  try { return await fetchJSON(`${config.apiUrl}/api/metrics`) }
  catch { return { ok: false, error: 'Backend unreachable' } }
})

// ── Servers ───────────────────────────────────────────────────────────────────
ipcMain.handle('api:servers', async () => {
  try {
    const servers = await fetchJSON(`${config.apiUrl}/api/servers`)
    if (Array.isArray(servers) && servers.length > 0) store.set('cachedServers', servers)
    return servers
  } catch {
    return store.get('cachedServers') || []
  }
})

// ── Modlist ───────────────────────────────────────────────────────────────────
ipcMain.handle('api:modlist', async () => {
  try { return await fetchJSON(`${config.apiUrl}/api/modlist`) }
  catch { return null }
})

// ── Launcher update check ─────────────────────────────────────────────────────
ipcMain.handle('app:checkUpdate', async () => {
  const current = app.getVersion()
  try {
    const data = await fetchJSON(`${config.apiUrl}/api/version`)
    const latest    = data.version
    const hasUpdate = compareVersions(latest, current) > 0
    return { current, latest, hasUpdate, downloadUrl: data.downloadUrl || '' }
  } catch {
    return { current, latest: null, hasUpdate: false, downloadUrl: '' }
  }
})

// ── Launch SKSE ───────────────────────────────────────────────────────────────

// Files that must exist before we allow launching
const REQUIRED_FILES = [
  path.join('Data', 'Platform', 'Plugins', 'skymp5-client.js'),
  path.join('Data', 'SKSE', 'Plugins', 'SkyrimPlatform.dll'),
  path.join('Data', 'SKSE', 'Plugins', 'MpClientPlugin.dll'),
  'skse64_loader.exe',
]

ipcMain.handle('launch:skse', () => {
  const skyrimPath     = store.get('skyrimPath')
  const vortexEnabled  = store.get('vortexEnabled')
  const vortexProfileId = store.get('vortexProfileId')

  if (!skyrimPath) {
    return { success: false, error: 'Skyrim path not configured.' }
  }

  // When Vortex is enabled, give a more informative hint if staging is missing
  if (vortexEnabled) {
    const stagingDir = vortex.getModStagingDir()
    if (!fs.existsSync(stagingDir)) {
      return {
        success: false,
        error:   'Vortex staging not found — run Install / Update Files first.',
      }
    }
    if (!vortexProfileId) {
      return {
        success: false,
        error:   'No Vortex profile selected — open Settings and choose a profile.',
      }
    }
  }

  // Pre-launch validation — check all required client files are in the game dir
  const missing = REQUIRED_FILES.filter(f => !fs.existsSync(path.join(skyrimPath, f)))
  if (missing.length > 0) {
    const names = missing.map(f => path.basename(f)).join(', ')
    const hint  = vortexEnabled
      ? `Run Install / Update Files so the Vortex profile deploys them.\nMissing: ${names}`
      : `Run Install first.\nMissing: ${names}`
    return { success: false, error: `Files missing — ${hint}` }
  }

  const exe = path.join(skyrimPath, 'skse64_loader.exe')
  try {
    spawn(exe, [], { detached: true, stdio: 'ignore', cwd: skyrimPath }).unref()
    return { success: true }
  } catch (err) {
    return { success: false, error: err.message }
  }
})

// ── Install files ─────────────────────────────────────────────────────────────

let installing = false

ipcMain.on('install:start', () => {
  if (installing) return
  installing = true

  const vortexEnabled   = store.get('vortexEnabled')
  const vortexProfileId = store.get('vortexProfileId')
  const fn = vortexEnabled ? runVortexInstall(vortexProfileId) : runDirectInstall()
  fn.catch(err => {
    log('[install] Unhandled error:', err.message)
    send('install:complete', { success: false, error: `Unexpected error: ${err.message}` })
    installing = false
  })
})

// ── Shared download + extract helpers ─────────────────────────────────────────

/**
 * Stream the client zip from the backend to a local temp file.
 * Calls onProgress(bytesReceived, totalBytes) as data arrives.
 */
function downloadClientZip(tempPath, onProgress) {
  const url = `${config.apiUrl}/api/files/zip`
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http
    const req = mod.get(url, res => {
      if (res.statusCode === 404) {
        res.resume()
        return reject(new Error('Update package not found on server. Run npm run merge on the backend.'))
      }
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume()
        return reject(new Error(`Server returned HTTP ${res.statusCode}`))
      }

      const total    = parseInt(res.headers['content-length'] || '0', 10)
      let   received = 0

      const file = fs.createWriteStream(tempPath)
      res.on('data', chunk => {
        received += chunk.length
        if (onProgress) onProgress(received, total)
      })
      res.pipe(file)
      file.on('finish', () => file.close(resolve))
      file.on('error', err => { try { fs.unlinkSync(tempPath) } catch {} reject(err) })
      res.on('error',  err => { try { fs.unlinkSync(tempPath) } catch {} reject(err) })
    })
    req.on('error', reject)
    req.setTimeout(60_000, () => { req.destroy(); reject(new Error('Download timed out')) })
  })
}

/**
 * Extract the zip at zipPath into destDir, preserving the internal path structure.
 * Calls onProgress(entryName, index, total) for each file entry.
 * Returns the number of files extracted.
 */
function extractClientZip(zipPath, destDir, onProgress) {
  const zip     = new AdmZip(zipPath)
  const entries = zip.getEntries().filter(e => !e.isDirectory)
  const total   = entries.length

  for (let i = 0; i < total; i++) {
    const entry = entries[i]
    zip.extractEntryTo(entry.entryName, destDir, /* maintainEntryPath */ true, /* overwrite */ true)
    if (onProgress) onProgress(entry.entryName, i + 1, total)
  }

  return total
}

// ── Direct install (no Vortex) ────────────────────────────────────────────────

async function runDirectInstall() {
  const abort = (msg) => {
    log('[install] ABORT:', msg)
    send('install:complete', { success: false, error: msg })
    installing = false
  }

  const skyrimPath = store.get('skyrimPath')
  if (!skyrimPath) return abort('Skyrim path not configured.')

  const srv = activeServer()
  if (!srv) return abort('No server selected — open Settings and choose a server.')

  const tempZip = path.join(os.tmpdir(), 'frostfall-client.zip')

  try {
    // ── 1. Check whether a download is needed ────────────────────────────────
    let serverVersion = null
    try {
      const vd = await fetchJSON(`${config.apiUrl}/api/files/version`)
      serverVersion = vd.version
    } catch {
      // Backend unreachable — play on cached files if they exist
      const allPresent = REQUIRED_FILES.every(f => fs.existsSync(path.join(skyrimPath, f)))
      if (!allPresent) return abort('Backend unreachable and client files are not installed. Check your connection.')
      log('[install] Backend unreachable — files already installed, updating settings only')
      writeClientSettings(path.join(skyrimPath, 'Data', 'Platform', 'Plugins', 'skymp5-client-settings.txt'), srv)
      const skseOk = fs.existsSync(path.join(skyrimPath, 'skse64_loader.exe'))
      send('install:complete', { success: true, skseOk, upToDate: true })
      return
    }

    const allPresent    = REQUIRED_FILES.every(f => fs.existsSync(path.join(skyrimPath, f)))
    const needsDownload = serverVersion !== store.get('filesVersion') || !allPresent

    if (!needsDownload) {
      log('[install] Files up to date, updating settings only')
      writeClientSettings(path.join(skyrimPath, 'Data', 'Platform', 'Plugins', 'skymp5-client-settings.txt'), srv)
      const skseOk = fs.existsSync(path.join(skyrimPath, 'skse64_loader.exe'))
      send('install:complete', { success: true, skseOk, upToDate: true })
      return
    }

    // ── 2. Download ──────────────────────────────────────────────────────────
    send('install:progress', { phase: 'download', file: 'Connecting to server…', index: 0, total: 0, skipped: false })
    await downloadClientZip(tempZip, (received, total) => {
      const mb  = n => (n / 1024 / 1024).toFixed(1)
      const pct = total > 0 ? ` (${Math.round(received / total * 100)}%)` : ''
      log(`[install] download ${mb(received)}/${mb(total)} MB`)
      send('install:progress', {
        phase: 'download',
        file:  `Downloading update… ${mb(received)} / ${mb(total)} MB${pct}`,
        index: received, total, skipped: false,
      })
    })

    // ── 3. Extract directly into Skyrim directory ────────────────────────────
    const extracted = extractClientZip(tempZip, skyrimPath, (file, i, total) => {
      log(`[install] extract [${i}/${total}] ${file}`)
      send('install:progress', { phase: 'extract', file, index: i, total, skipped: false })
    })
    log(`[install] extracted ${extracted} files`)

    // ── 4. Write server settings ─────────────────────────────────────────────
    writeClientSettings(path.join(skyrimPath, 'Data', 'Platform', 'Plugins', 'skymp5-client-settings.txt'), srv)

    store.set('filesVersion', serverVersion)

    // ── 5. Verify SKSE ───────────────────────────────────────────────────────
    const skseOk = fs.existsSync(path.join(skyrimPath, 'skse64_loader.exe'))
    log('[install] skseOk:', skseOk)
    send('install:complete', {
      success: true, skseOk,
      skseWarning: skseOk ? null : 'skse64_loader.exe was not found after install.',
    })
  } catch (err) {
    abort(`Install failed: ${err.message}`)
  } finally {
    try { fs.unlinkSync(tempZip) } catch {}
    installing = false
  }
}

// ── Vortex install ────────────────────────────────────────────────────────────

async function runVortexInstall(profileId) {
  const abort = (msg) => {
    log('[vortex-install] ABORT:', msg)
    send('install:complete', { success: false, error: msg })
    installing = false
  }

  const skyrimPath = store.get('skyrimPath')
  if (!skyrimPath) return abort('Skyrim path not configured.')
  if (!profileId)  return abort('No Vortex profile selected. Open Settings and choose a profile.')

  const srv = activeServer()
  if (!srv) return abort('No server selected — open Settings and choose a server.')

  const stagingDir = vortex.getModStagingDir()
  const tempZip    = path.join(os.tmpdir(), 'frostfall-client.zip')

  try {
    // ── 1. Check version ─────────────────────────────────────────────────────
    let serverVersion = null
    try {
      const vd = await fetchJSON(`${config.apiUrl}/api/files/version`)
      serverVersion = vd.version
    } catch {
      const allPresent = REQUIRED_FILES.every(f => fs.existsSync(path.join(skyrimPath, f)))
      if (!allPresent) return abort('Backend unreachable and client files are not installed. Check your connection.')
      log('[vortex-install] Backend unreachable — updating settings only')
      writeClientSettings(path.join(stagingDir, 'Data', 'Platform', 'Plugins', 'skymp5-client-settings.txt'), srv)
      const skseOk = fs.existsSync(path.join(skyrimPath, 'skse64_loader.exe'))
      send('install:complete', { success: true, skseOk, upToDate: true, vortex: true })
      return
    }

    const allPresent    = REQUIRED_FILES.every(f => fs.existsSync(path.join(skyrimPath, f)))
    const needsDownload = serverVersion !== store.get('filesVersion') || !allPresent

    if (!needsDownload) {
      log('[vortex-install] Files up to date, updating settings only')
      writeClientSettings(path.join(stagingDir, 'Data', 'Platform', 'Plugins', 'skymp5-client-settings.txt'), srv)
      const skseOk = fs.existsSync(path.join(skyrimPath, 'skse64_loader.exe'))
      send('install:complete', { success: true, skseOk, upToDate: true, vortex: true })
      return
    }

    // ── 2. Download ──────────────────────────────────────────────────────────
    send('install:progress', { phase: 'download', file: 'Connecting to server…', index: 0, total: 0, skipped: false })
    await downloadClientZip(tempZip, (received, total) => {
      const mb  = n => (n / 1024 / 1024).toFixed(1)
      const pct = total > 0 ? ` (${Math.round(received / total * 100)}%)` : ''
      send('install:progress', {
        phase: 'download',
        file:  `Downloading update… ${mb(received)} / ${mb(total)} MB${pct}`,
        index: received, total, skipped: false,
      })
    })

    // ── 3. Extract into Vortex staging ───────────────────────────────────────
    fs.mkdirSync(stagingDir, { recursive: true })
    const extracted = extractClientZip(tempZip, stagingDir, (file, i, total) => {
      log(`[vortex-install] extract [${i}/${total}] ${file}`)
      send('install:progress', { phase: 'extract', file, index: i, total, skipped: false })
    })
    log(`[vortex-install] extracted ${extracted} files to staging`)

    // ── 4. Write Vortex mod metadata ─────────────────────────────────────────
    fs.writeFileSync(path.join(stagingDir, 'meta.ini'), [
      '[General]',
      `gameName=${vortex.GAME_ID}`,
      'modid=0',
      `version=${app.getVersion()}`,
      `installTime=${new Date().toISOString()}`,
      'source=manual',
      `name=${vortex.MOD_NAME}`,
      '',
    ].join('\r\n'))

    // ── 5. Write server settings to staging ──────────────────────────────────
    writeClientSettings(path.join(stagingDir, 'Data', 'Platform', 'Plugins', 'skymp5-client-settings.txt'), srv)
    log('[vortex-install] settings written to staging')

    // ── 6. Enable mod in Vortex profile modlist ──────────────────────────────
    vortex.enableModInProfile(profileId)
    log('[vortex-install] modlist updated for profile', profileId)

    // ── 7. Deploy from staging → Skyrim ──────────────────────────────────────
    const { deployed, skipped } = vortex.deployToGame(skyrimPath, (file, i, total, isSkipped) => {
      log(`[vortex-install] deploy [${i}/${total}]${isSkipped ? ' SKIP' : ''} ${file}`)
      send('install:progress', { phase: 'deploy', file, index: i, total, skipped: isSkipped })
    })
    log(`[vortex-install] deployed: ${deployed}, skipped: ${skipped}`)

    store.set('filesVersion', serverVersion)

    // ── 8. Verify SKSE ───────────────────────────────────────────────────────
    const skseOk = fs.existsSync(path.join(skyrimPath, 'skse64_loader.exe'))
    send('install:complete', {
      success: true, skseOk, vortex: true,
      skseWarning: skseOk ? null : 'skse64_loader.exe was not found after deploy.',
    })
  } catch (err) {
    abort(`Install failed: ${err.message}`)
  } finally {
    try { fs.unlinkSync(tempZip) } catch {}
    installing = false
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Write (or merge into) the SkyMP client settings JSON file.
 * Only server-ip and server-port are touched — all other keys the user or the
 * client itself may have set (gameData, master, server-public-keys, …) are
 * preserved unchanged.
 */
function writeClientSettings(destPath, srv) {
  let settings = {}
  try {
    settings = JSON.parse(fs.readFileSync(destPath, 'utf8'))
  } catch { /* file absent or invalid — start fresh */ }

  settings['server-ip']   = srv.address
  settings['server-port'] = Number(srv.port)

  fs.mkdirSync(path.dirname(destPath), { recursive: true })
  fs.writeFileSync(destPath, JSON.stringify(settings, null, 2) + '\n')
}

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http
    const req = mod.get(url, res => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume()
        reject(new Error(`HTTP ${res.statusCode} from ${url}`))
        return
      }
      let data = ''
      res.on('data', chunk => { data += chunk })
      res.on('end', () => {
        try { resolve(JSON.parse(data)) }
        catch (e) { reject(new Error(`Invalid JSON from ${url}: ${e.message}`)) }
      })
    })
    req.on('error', reject)
    req.setTimeout(10_000, () => {
      req.destroy()
      reject(new Error(`Request timed out: ${url}`))
    })
  })
}

function compareVersions(a, b) {
  const pa = String(a).split('.').map(Number)
  const pb = String(b).split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0)
    if (diff !== 0) return diff
  }
  return 0
}
