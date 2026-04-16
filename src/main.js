const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron')
const path   = require('path')
const fs     = require('fs')
const crypto = require('crypto')
const http   = require('http')
const https  = require('https')
const { spawn } = require('child_process')
const Store  = require('electron-store')
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
function activeServer() {
  const idx = Math.min(
    store.get('activeServerIndex') || 0,
    config.servers.length - 1
  )
  return config.servers[idx]
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
ipcMain.handle('settings:load', () => ({
  ...store.store,
  servers:     config.servers,
  multiServer: config.servers.length > 1,
  discordUser: store.get('discordUser') || null,
}))
ipcMain.handle('settings:save', (_e, data) => {
  const allowed = ['skyrimPath', 'username', 'activeServerIndex', 'vortexPath', 'vortexProfileId', 'vortexEnabled']
  const clean   = {}
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
  try { return await fetchJSON(`${activeServer().apiUrl}/api/news`) }
  catch { return null }
})

// ── Server status ─────────────────────────────────────────────────────────────
ipcMain.handle('api:status', async () => {
  try {
    const data = await fetchJSON(`${activeServer().apiUrl}/api/status`)
    return { ok: true, ...data }
  } catch {
    return { ok: false }
  }
})

// ── Server info ───────────────────────────────────────────────────────────────
ipcMain.handle('api:serverinfo', async () => {
  try { return await fetchJSON(`${activeServer().apiUrl}/api/serverinfo`) }
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
  const srv = activeServer()

  // 1. Ask backend for the OAuth URL
  let authUrl
  try {
    const data = await fetchJSON(`${srv.apiUrl}/auth/discord/url`)
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
      fetchJSON(`${srv.apiUrl}/auth/discord/exchange?code=${encodeURIComponent(code)}`)
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
  try { return await fetchJSON(`${activeServer().apiUrl}/api/metrics`) }
  catch { return { ok: false, error: 'Backend unreachable' } }
})

// ── Launcher update check ─────────────────────────────────────────────────────
ipcMain.handle('app:checkUpdate', async () => {
  const current = app.getVersion()
  try {
    const data = await fetchJSON(`${activeServer().apiUrl}/api/version`)
    const latest   = data.version
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
const FILES_ROOT = isDev
  ? path.join(__dirname, '..', 'backend', 'public', 'files')
  : path.join(process.resourcesPath, 'files')

const INSTALL_BUCKETS = [
  { dir: path.join(FILES_ROOT, 'root'), destBase: '' },
]

function fileSha256(filePath) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
  } catch {
    return null
  }
}

function buildLocalManifest() {
  const entries = []

  function walk(absDir, rel, destBase) {
    let names
    try { names = fs.readdirSync(absDir) } catch { return }
    for (const name of names) {
      const abs    = path.join(absDir, name)
      const relNew = rel ? path.join(rel, name) : name
      const stat   = fs.statSync(abs)
      if (stat.isDirectory()) {
        walk(abs, relNew, destBase)
      } else {
        entries.push({
          src:    abs,
          dest:   destBase ? path.join(destBase, relNew) : relNew,
          sha256: fileSha256(abs),
        })
      }
    }
  }

  for (const { dir, destBase } of INSTALL_BUCKETS) walk(dir, '', destBase)

  // Root-level files (SKSE exe/dll) go first
  entries.sort((a, b) => {
    const aRoot = path.dirname(a.dest) === '.'
    const bRoot = path.dirname(b.dest) === '.'
    return (aRoot ? 0 : 1) - (bRoot ? 0 : 1)
  })

  return entries
}

let installing = false

ipcMain.on('install:start', () => {
  if (installing) return
  installing = true

  const vortexEnabled  = store.get('vortexEnabled')
  const vortexProfileId = store.get('vortexProfileId')

  if (vortexEnabled) {
    runVortexInstall(vortexProfileId)
  } else {
    runDirectInstall()
  }
})

// ── Direct install (no Vortex) ────────────────────────────────────────────────

function runDirectInstall() {
  const temps = []

  const abort = (msg) => {
    log('[install] ABORT:', msg)
    for (const { tmp } of temps) try { fs.unlinkSync(tmp) } catch {}
    send('install:complete', { success: false, error: msg })
    installing = false
  }

  try {
    const skyrimPath = store.get('skyrimPath')
    log('[install] skyrimPath:', skyrimPath)
    log('[install] FILES_ROOT:', FILES_ROOT)

    if (!skyrimPath) return abort('Skyrim path not configured.')

    // ── 1. Build manifest ────────────────────────────────────────────────────
    const manifest = buildLocalManifest()
    log('[install] manifest count:', manifest.length)
    if (manifest.length === 0) return abort('No files found in app bundle. Re-build the app.')

    const total   = manifest.length
    let   skipped = 0

    // ── 2. Copy phase ────────────────────────────────────────────────────────
    for (let i = 0; i < total; i++) {
      const { src, dest, sha256: srcHash } = manifest[i]
      const destAbs = path.join(skyrimPath, dest)

      if (srcHash && fs.existsSync(destAbs) && fileSha256(destAbs) === srcHash) {
        log(`[install] [${i+1}/${total}] SKIP (unchanged) ${dest}`)
        skipped++
        send('install:progress', { file: dest, index: i + 1, total, skipped: true })
        continue
      }

      const tmpAbs = destAbs + '.tmp'
      log(`[install] [${i+1}/${total}] ${dest}`)

      try {
        fs.mkdirSync(path.dirname(destAbs), { recursive: true })
        fs.copyFileSync(src, tmpAbs)
        temps.push({ tmp: tmpAbs, dest: destAbs })
      } catch (err) {
        log(`[install]   copy FAILED: ${err.message}`)
        return abort(`Failed to copy ${dest}: ${err.message}`)
      }

      send('install:progress', { file: dest, index: i + 1, total, skipped: false })
    }

    log(`[install] copy phase done. ${skipped} skipped, ${temps.length} to commit.`)

    // ── 3. Commit ────────────────────────────────────────────────────────────
    for (const { tmp, dest } of temps) {
      try {
        fs.renameSync(tmp, dest)
      } catch (err) {
        for (const t of temps) try { fs.unlinkSync(t.tmp) } catch {}
        return abort(`Could not commit ${path.basename(dest)}: ${err.message}`)
      }
    }

    // ── 4. Write server connection config ────────────────────────────────────
    const srv = activeServer()
    const settingsDest = path.join(
      skyrimPath, 'Data', 'Platform', 'Plugins', 'skymp5-client-settings.txt'
    )
    fs.mkdirSync(path.dirname(settingsDest), { recursive: true })
    fs.writeFileSync(settingsDest,
      `serverAddress = ${srv.address}\nserverPort = ${srv.port}\n`
    )

    // ── 5. Verify SKSE ───────────────────────────────────────────────────────
    const skseOk = fs.existsSync(path.join(skyrimPath, 'skse64_loader.exe'))
    log('[install] skseOk:', skseOk, '| skipped:', skipped, '/ total:', total)
    send('install:complete', {
      success: true, skseOk, skipped, total,
      skseWarning: skseOk ? null : 'skse64_loader.exe was not found after install.',
    })
  } catch (err) {
    abort(`Unexpected error: ${err.message}`)
  } finally {
    installing = false
  }
}

// ── Vortex install ────────────────────────────────────────────────────────────

function runVortexInstall(profileId) {
  const abort = (msg) => {
    log('[vortex-install] ABORT:', msg)
    send('install:complete', { success: false, error: msg })
    installing = false
  }

  try {
    const skyrimPath = store.get('skyrimPath')
    log('[vortex-install] skyrimPath:', skyrimPath)
    log('[vortex-install] profileId:', profileId)

    if (!skyrimPath) return abort('Skyrim path not configured.')
    if (!profileId)  return abort('No Vortex profile selected. Open Settings and choose a profile.')

    // ── 1. Build manifest ────────────────────────────────────────────────────
    const manifest = buildLocalManifest()
    log('[vortex-install] manifest count:', manifest.length)
    if (manifest.length === 0) return abort('No files found in app bundle. Re-build the app.')

    // ── 2. Stage files into Vortex mod folder ────────────────────────────────
    send('install:progress', { file: 'Preparing Vortex staging…', index: 0, total: manifest.length, skipped: false })

    const stagingEntries = manifest.map(e => ({ src: e.src, dest: e.dest }))

    vortex.installToStaging(
      stagingEntries,
      app.getVersion(),
      (file, i, total) => {
        log(`[vortex-install] stage [${i}/${total}] ${file}`)
        send('install:progress', { file: `[stage] ${file}`, index: i, total: total * 2, skipped: false })
      }
    )

    // ── 3. Write server connection config to staging ─────────────────────────
    const srv         = activeServer()
    const settingsRel = path.join('Data', 'Platform', 'Plugins', 'skymp5-client-settings.txt')
    const settingsDest = path.join(vortex.getModStagingDir(), settingsRel)
    fs.mkdirSync(path.dirname(settingsDest), { recursive: true })
    fs.writeFileSync(settingsDest,
      `serverAddress = ${srv.address}\nserverPort = ${srv.port}\n`
    )
    log('[vortex-install] settings written to staging')

    // ── 4. Enable mod in Vortex profile modlist ──────────────────────────────
    vortex.enableModInProfile(profileId)
    log('[vortex-install] modlist updated for profile', profileId)

    // ── 5. Deploy from staging → Skyrim ──────────────────────────────────────
    const baseIndex = manifest.length
    const { deployed, skipped } = vortex.deployToGame(
      skyrimPath,
      (file, i, total, isSkipped) => {
        log(`[vortex-install] deploy [${i}/${total}]${isSkipped ? ' SKIP' : ''} ${file}`)
        send('install:progress', {
          file:    `[deploy] ${file}`,
          index:   baseIndex + i,
          total:   baseIndex + total,
          skipped: isSkipped,
        })
      }
    )

    // ── 6. Verify SKSE ───────────────────────────────────────────────────────
    const skseOk = fs.existsSync(path.join(skyrimPath, 'skse64_loader.exe'))
    log('[vortex-install] done. deployed:', deployed, 'skipped:', skipped, 'skseOk:', skseOk)

    send('install:complete', {
      success: true, skseOk,
      skipped, total: deployed + skipped,
      skseWarning: skseOk ? null : 'skse64_loader.exe was not found after deploy.',
      vortex: true,
    })
  } catch (err) {
    abort(`Unexpected error: ${err.message}`)
  } finally {
    installing = false
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
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
