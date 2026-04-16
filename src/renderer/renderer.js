// ── Window controls ──────────────────────────────────────────────────────────
document.getElementById('btn-minimize').addEventListener('click', () => window.electronAPI.minimize())
document.getElementById('btn-maximize').addEventListener('click', () => window.electronAPI.maximize())
document.getElementById('btn-close').addEventListener('click',    () => window.electronAPI.close())

// ── External nav links ────────────────────────────────────────────────────────
const EXTERNAL_URLS = {
  website: '',   // e.g. 'https://frostfall.example.com'
  discord: '',   // e.g. 'https://discord.gg/...'
}

document.querySelectorAll('.topnav-link[data-href]').forEach(link => {
  link.addEventListener('click', () => {
    const url = EXTERNAL_URLS[link.dataset.href]
    if (url) window.electronAPI.openExternal(url)
  })
})

// ── Settings modal ────────────────────────────────────────────────────────────
const modalOverlay = document.getElementById('modal-settings')

function openModal() { modalOverlay.hidden = false }
function closeModal() { modalOverlay.hidden = true }

document.getElementById('btn-gear').addEventListener('click', openModal)
document.getElementById('modal-close').addEventListener('click', closeModal)
modalOverlay.addEventListener('click', e => { if (e.target === modalOverlay) closeModal() })

// ── Form fields ───────────────────────────────────────────────────────────────
const fieldSkyrimPath   = document.getElementById('setting-skyrim-path')
const fieldUsername     = document.getElementById('setting-username')
const fieldServerSelect = document.getElementById('setting-server')
const installStatus     = document.getElementById('install-status')

// ── Vortex fields ─────────────────────────────────────────────────────────────
const fieldVortexPath    = document.getElementById('setting-vortex-path')
const fieldVortexProfile = document.getElementById('setting-vortex-profile')
const fieldVortexEnabled = document.getElementById('setting-vortex-enabled')
const vortexStatusDot    = document.getElementById('vortex-status-dot')
const vortexStatusText   = document.getElementById('vortex-status-text')

// ── Discord auth state (kept in module scope for PLAY check) ──────────────────
let discordUser         = null
let discordAuthRequired = false

// ── Load / save settings ──────────────────────────────────────────────────────
async function loadSettings() {
  const s = await window.electronAPI.loadSettings()
  fieldSkyrimPath.value = s.skyrimPath || ''
  fieldUsername.value   = s.username   || ''

  // Server selector — only visible when >1 server is returned by the API
  const group = document.getElementById('group-server-select')
  if (s.servers && s.servers.length > 1) {
    group.hidden = false
    fieldServerSelect.innerHTML = ''
    s.servers.forEach((srv, i) => {
      const opt = document.createElement('option')
      opt.value       = i
      opt.textContent = srv.name
      opt.selected    = i === (s.activeServerIndex || 0)
      fieldServerSelect.appendChild(opt)
    })
  } else {
    group.hidden = true
  }

  // Restore Discord user from persisted store
  if (s.discordUser) {
    discordUser = s.discordUser
    renderDiscordRow()
  }

  // Restore Vortex settings
  fieldVortexPath.value    = s.vortexPath    || ''
  fieldVortexEnabled.checked = !!s.vortexEnabled
  await refreshVortexProfiles(s.vortexProfileId || '')
  updateVortexStatus()

  return s
}

// ── Discord login / logout ────────────────────────────────────────────────────
const discordAuthRow = document.getElementById('discord-auth-row')

function renderDiscordRow() {
  discordAuthRow.innerHTML = ''

  if (discordUser) {
    const userBox = document.createElement('div')
    userBox.className = 'discord-user'

    if (discordUser.avatar) {
      const img = document.createElement('img')
      img.className = 'discord-avatar'
      img.src = discordUser.avatar
      img.alt = discordUser.username
      userBox.appendChild(img)
    } else {
      const ph = document.createElement('div')
      ph.className   = 'discord-avatar-placeholder'
      ph.textContent = '✦'
      userBox.appendChild(ph)
    }

    const name = document.createElement('span')
    name.className   = 'discord-username'
    name.textContent = discordUser.tag || discordUser.username
    userBox.appendChild(name)

    discordAuthRow.appendChild(userBox)

    const logoutBtn = document.createElement('button')
    logoutBtn.className   = 'btn-discord-logout'
    logoutBtn.textContent = 'Logout'
    logoutBtn.addEventListener('click', async () => {
      await window.electronAPI.discordLogout()
      discordUser = null
      renderDiscordRow()
    })
    discordAuthRow.appendChild(logoutBtn)
  } else {
    const loginBtn = document.createElement('button')
    loginBtn.className   = 'btn-discord-login'
    loginBtn.textContent = 'Login with Discord'
    loginBtn.addEventListener('click', async () => {
      loginBtn.disabled   = true
      loginBtn.textContent = 'Opening…'
      const result = await window.electronAPI.discordLogin()
      if (result.success) {
        discordUser = result.user
        renderDiscordRow()
      } else {
        loginBtn.disabled   = false
        loginBtn.textContent = 'Login with Discord'
        connectWarning.textContent = `Discord: ${result.error}`
        connectWarning.classList.add('visible')
        setTimeout(() => connectWarning.classList.remove('visible'), 4000)
      }
    })
    discordAuthRow.appendChild(loginBtn)
  }
}

renderDiscordRow()

document.getElementById('btn-save').addEventListener('click', async () => {
  const profileId = fieldVortexProfile.value.trim()

  const data = {
    skyrimPath:      fieldSkyrimPath.value.trim(),
    username:        fieldUsername.value.trim(),
    vortexPath:      fieldVortexPath.value.trim(),
    vortexProfileId: profileId,
    vortexEnabled:   fieldVortexEnabled.checked,
  }
  if (!document.getElementById('group-server-select').hidden) {
    data.activeServerIndex = parseInt(fieldServerSelect.value, 10)
  }

  // Tag the profile with its display name so we can show it on future loads
  if (profileId) {
    const selectedOption = fieldVortexProfile.querySelector(`option[value="${profileId}"]`)
    if (selectedOption) {
      await window.electronAPI.vortexTagProfile(profileId, selectedOption.textContent)
    }
  }

  await window.electronAPI.saveSettings(data)
  updateVortexStatus()

  const btn = document.getElementById('btn-save')
  btn.textContent = 'Saved!'
  setTimeout(() => { btn.textContent = 'Save Settings' }, 1400)
})

// ── Browse folder ─────────────────────────────────────────────────────────────
document.getElementById('btn-browse').addEventListener('click', async () => {
  const folder = await window.electronAPI.openFolder()
  if (folder) fieldSkyrimPath.value = folder
})

// ── Vortex UI ─────────────────────────────────────────────────────────────────

async function refreshVortexProfiles(selectId) {
  const profiles = await window.electronAPI.vortexListProfiles()

  // Preserve current selection if no explicit id given
  const currentVal = selectId !== undefined ? selectId : fieldVortexProfile.value

  fieldVortexProfile.innerHTML = '<option value="">— select profile —</option>'
  profiles.forEach(p => {
    const opt = document.createElement('option')
    opt.value       = p.id
    opt.textContent = p.name !== p.id ? p.name : `Profile ${p.id.slice(0, 8)}…`
    opt.selected    = p.id === currentVal
    fieldVortexProfile.appendChild(opt)
  })
}

function updateVortexStatus() {
  const hasExe     = fieldVortexPath.value.trim().length > 0
  const hasProfile = fieldVortexProfile.value.trim().length > 0
  const enabled    = fieldVortexEnabled.checked

  if (!hasExe) {
    vortexStatusDot.className  = 'vortex-status-dot'
    vortexStatusText.textContent = 'Vortex not configured'
  } else if (!hasProfile) {
    vortexStatusDot.className  = 'vortex-status-dot dot-warn'
    vortexStatusText.textContent = 'Vortex found — no profile selected'
  } else if (!enabled) {
    vortexStatusDot.className  = 'vortex-status-dot dot-warn'
    vortexStatusText.textContent = 'Vortex configured — integration disabled'
  } else {
    const selectedOpt = fieldVortexProfile.querySelector('option:checked')
    const profileName = selectedOpt?.textContent || fieldVortexProfile.value
    vortexStatusDot.className  = 'vortex-status-dot dot-ok'
    vortexStatusText.textContent = `Active — profile: ${profileName}`
  }
}

document.getElementById('btn-detect-vortex').addEventListener('click', async () => {
  const btn = document.getElementById('btn-detect-vortex')
  btn.disabled = true
  btn.textContent = 'Detecting…'
  const result = await window.electronAPI.vortexDetect()
  if (result.found) {
    fieldVortexPath.value = result.path
    await refreshVortexProfiles()
  } else {
    fieldVortexPath.value = ''
    fieldVortexProfile.innerHTML = '<option value="">No Vortex installation found</option>'
  }
  updateVortexStatus()
  btn.disabled = false
  btn.textContent = 'Auto-detect Vortex'
})

document.getElementById('btn-browse-vortex').addEventListener('click', async () => {
  const result = await window.electronAPI.openFolder()
  if (result) {
    // User may have pointed at the Vortex install folder — look for Vortex.exe
    const exePath = result.endsWith('.exe') ? result : result + '\\Vortex.exe'
    fieldVortexPath.value = exePath
    await refreshVortexProfiles()
    updateVortexStatus()
  }
})

document.getElementById('btn-refresh-profiles').addEventListener('click', async () => {
  await refreshVortexProfiles()
  updateVortexStatus()
})

document.getElementById('btn-open-profiles').addEventListener('click', () => {
  window.electronAPI.vortexOpenProfilesDir()
})

fieldVortexEnabled.addEventListener('change', updateVortexStatus)
fieldVortexProfile.addEventListener('change', updateVortexStatus)

// ── Install / Update Files ────────────────────────────────────────────────────
document.getElementById('btn-install').addEventListener('click', () => {
  installStatus.textContent = 'Starting install…'
  window.electronAPI.removeInstallListeners()

  window.electronAPI.onInstallProgress(({ file, index, total, skipped }) => {
    const prefix = skipped ? '[skip]' : `[${index}/${total}]`
    installStatus.textContent = `${prefix} ${file}`
  })

  window.electronAPI.onInstallComplete(({ success, error, skseWarning, skipped, total, vortex: usedVortex }) => {
    if (!success) {
      installStatus.textContent = `Error: ${error}`
    } else if (skseWarning) {
      installStatus.textContent = `Done — ⚠ ${skseWarning}`
    } else {
      const note   = skipped > 0 ? ` (${skipped}/${total} unchanged)` : ''
      const prefix = usedVortex ? 'Staged & deployed via Vortex' : 'Install complete'
      installStatus.textContent = `${prefix}! SKSE ✓${note}`
    }
  })

  window.electronAPI.startInstall()
})

// ── PLAY button ───────────────────────────────────────────────────────────────
const btnConnect     = document.getElementById('btn-connect')
const connectWarning = document.getElementById('connect-warning')

btnConnect.addEventListener('click', async () => {
  const s = await window.electronAPI.loadSettings()
  if (!s.skyrimPath) {
    connectWarning.textContent = 'Set Skyrim path in Settings first.'
    connectWarning.classList.add('visible')
    return
  }

  if (!discordUser) {
    connectWarning.textContent = 'Login with Discord first — open Settings to connect.'
    connectWarning.classList.add('visible')
    return
  }

  const result = await window.electronAPI.launchSkse()
  if (!result.success) {
    connectWarning.textContent = result.error
    connectWarning.classList.add('visible')
  } else {
    connectWarning.classList.remove('visible')
    connectWarning.textContent = ''
  }
})

// ── Server status ─────────────────────────────────────────────────────────────
const badgeStatus  = document.getElementById('badge-status')
const badgeLabel   = document.getElementById('badge-label')
const badgePlayers = document.getElementById('badge-players')

async function checkServerStatus() {
  const data = await window.electronAPI.fetchStatus()
  if (!data || !data.ok) {
    badgeStatus.classList.remove('online')
    badgeLabel.textContent = 'OFFLINE'
    badgePlayers.hidden = true
  } else {
    badgeStatus.classList.add('online')
    badgeLabel.textContent = 'ONLINE'
    if (data.players != null) {
      badgePlayers.textContent = `${data.players} PLAYERS`
      badgePlayers.hidden = false
    } else {
      badgePlayers.hidden = true
    }
  }
}

// ── Server info strip ─────────────────────────────────────────────────────────
async function loadServerInfo() {
  const info = await window.electronAPI.fetchServerInfo()
  if (!info || info.error) return

  const strip    = document.getElementById('server-info-strip')
  const nameEl   = document.getElementById('sinfo-name')
  const capEl    = document.getElementById('sinfo-capacity')
  const modeEl   = document.getElementById('sinfo-mode')
  const modeSep  = document.getElementById('sinfo-mode-sep')
  const discEl   = document.getElementById('sinfo-discord')
  const discSep  = document.getElementById('sinfo-discord-sep')
  const footerName = document.getElementById('footer-server-name')

  nameEl.textContent = info.name
  capEl.textContent  = `Max ${info.maxPlayers} players`
  footerName.textContent = info.name

  if (info.gamemode) {
    modeEl.textContent = info.gamemode
    modeEl.hidden  = false
    modeSep.hidden = false
  }

  if (info.discordAuthRequired) {
    discordAuthRequired = true
    discEl.hidden  = false
    discSep.hidden = false
  }

  strip.hidden = false
}

// ── Launcher update check ─────────────────────────────────────────────────────
const launcherVersionEl = document.getElementById('launcher-version')

async function checkLauncherUpdate() {
  const result = await window.electronAPI.checkUpdate()
  if (!result) return

  if (result.hasUpdate) {
    launcherVersionEl.textContent = '⬆ UPDATE AVAILABLE'
    launcherVersionEl.classList.add('update-available')
    launcherVersionEl.title = `v${result.latest} is available — click to download`
    launcherVersionEl.addEventListener('click', () => {
      if (result.downloadUrl) window.electronAPI.openExternal(result.downloadUrl)
    })
  } else {
    launcherVersionEl.textContent = `v${result.current}`
    launcherVersionEl.classList.remove('update-available')
  }
}

// ── News ──────────────────────────────────────────────────────────────────────
const newsGrid = document.getElementById('news-grid')

const FALLBACK_NEWS = [
  {
    title: 'The Launcher Has Arrived',
    body:  'The Frostfall launcher is now available.',
    date:  'Apr 14, 2026',
    tag:   'UPDATE',
    image: null,
  }
]

function buildNewsCard(item) {
  const card = document.createElement('div')
  card.className = 'news-card'

  const imgWrap = document.createElement('div')
  imgWrap.className = 'news-card-image'
  if (item.image) {
    const img = document.createElement('img')
    img.src = item.image
    img.alt = item.title
    imgWrap.appendChild(img)
  }

  const body = document.createElement('div')
  body.className = 'news-card-body'

  const tag = document.createElement('div')
  tag.className = 'news-card-tag'
  tag.textContent = item.tag || 'UPDATE'

  const title = document.createElement('div')
  title.className = 'news-card-title'
  title.textContent = item.title

  const date = document.createElement('div')
  date.className = 'news-card-date'
  date.textContent = item.date

  body.appendChild(tag)
  body.appendChild(title)
  body.appendChild(date)

  card.appendChild(imgWrap)
  card.appendChild(body)
  return card
}

async function loadNews() {
  let items = await window.electronAPI.fetchNews()
  if (!items || !Array.isArray(items) || items.length === 0) {
    items = FALLBACK_NEWS
  }
  newsGrid.innerHTML = ''
  items.forEach(item => newsGrid.appendChild(buildNewsCard(item)))
}

// ── Modlist ───────────────────────────────────────────────────────────────────

const FALLBACK_MODLIST = [
  { name: 'SKSE64',                                  version: '2.2.6',   required: true,  enabled: true  },
  { name: 'SkyMP Client',                            version: '0.8.2',   required: true,  enabled: true  },
  { name: 'Address Library for SKSE',                version: '11.0.0',  required: true,  enabled: true  },
  { name: 'SkyUI',                                   version: '5.2.1',   required: false, enabled: true  },
  { name: 'Unofficial Skyrim Special Edition Patch', version: '4.3.0',   required: false, enabled: true  },
  { name: 'A Quality World Map',                     version: '9.0.1',   required: false, enabled: false },
  { name: 'Enhanced Lights and FX',                  version: '3.05',    required: false, enabled: false },
]

function buildModItem(mod) {
  const item = document.createElement('div')
  item.className = `modlist-item${mod.enabled ? '' : ' modlist-item--disabled'}`

  const dot = document.createElement('span')
  dot.className = `mod-dot ${mod.enabled ? 'mod-dot--enabled' : 'mod-dot--disabled'}`

  const name = document.createElement('span')
  name.className   = 'mod-name'
  name.textContent = mod.name
  name.title       = mod.name

  item.appendChild(dot)
  item.appendChild(name)

  if (mod.required) {
    const badge = document.createElement('span')
    badge.className   = 'mod-badge mod-badge--required'
    badge.textContent = 'REQ'
    item.appendChild(badge)
  }

  const ver = document.createElement('span')
  ver.className   = 'mod-version'
  ver.textContent = `v${mod.version}`
  item.appendChild(ver)

  return item
}

async function loadModlist() {
  const panel = document.getElementById('modlist')
  const count = document.getElementById('modlist-count')

  const items = await window.electronAPI.fetchModlist() ?? FALLBACK_MODLIST

  panel.innerHTML = ''
  items.forEach(mod => panel.appendChild(buildModItem(mod)))

  const enabled = items.filter(m => m.enabled).length
  count.textContent = `${enabled} / ${items.length} enabled`
}

// ── Metrics modal ─────────────────────────────────────────────────────────────
const modalMetrics  = document.getElementById('modal-metrics')
const metricsGrid   = document.getElementById('metrics-grid')
const metricsLoading = document.getElementById('metrics-loading')

document.getElementById('btn-stats').addEventListener('click', () => {
  modalMetrics.hidden = false
  loadMetrics()
})

document.getElementById('metrics-close').addEventListener('click', () => {
  modalMetrics.hidden = true
})

modalMetrics.addEventListener('click', e => {
  if (e.target === modalMetrics) modalMetrics.hidden = true
})

function metricCard(label, value, sub) {
  const card = document.createElement('div')
  card.className = 'metric-card'

  const lEl = document.createElement('div')
  lEl.className   = 'metric-label'
  lEl.textContent = label

  const vEl = document.createElement('div')
  vEl.className   = 'metric-value'
  vEl.textContent = value

  card.appendChild(lEl)
  card.appendChild(vEl)

  if (sub != null) {
    const sEl = document.createElement('div')
    sEl.className   = 'metric-sub'
    sEl.textContent = sub
    card.appendChild(sEl)
  }

  return card
}

async function loadMetrics() {
  metricsGrid.innerHTML = ''
  const loadEl = document.createElement('div')
  loadEl.className   = 'metrics-loading'
  loadEl.textContent = 'Loading…'
  metricsGrid.appendChild(loadEl)

  const result = await window.electronAPI.fetchMetrics()

  metricsGrid.innerHTML = ''

  if (!result || !result.ok) {
    const err = document.createElement('div')
    err.className   = 'metric-card metric-card--error'
    err.textContent = result?.error || 'Server stats unavailable'
    metricsGrid.appendChild(err)
    return
  }

  const m = result.metrics

  const connects    = m['skymp_connects_total']    ?? null
  const disconnects = m['skymp_disconnects_total'] ?? null
  const online      = (connects !== null && disconnects !== null)
    ? Math.max(0, connects - disconnects)
    : null

  const logins      = m['skymp_logins_total']       ?? null
  const loginErrors = m['skymp_login_errors_total'] ?? null
  const rpcs        = m['skymp_rpc_calls_total']    ?? null
  const tickAvg     = m['skymp_tick_duration_seconds_sum'] != null && m['skymp_tick_duration_seconds_count']
    ? (m['skymp_tick_duration_seconds_sum'] / m['skymp_tick_duration_seconds_count'] * 1000)
    : null

  const fmt = v => v != null ? v.toLocaleString() : '—'
  const fmtMs = v => v != null ? `${v.toFixed(1)} ms` : '—'

  metricsGrid.appendChild(metricCard('Online Now',       fmt(online),      online !== null ? `${fmt(connects)} connects / ${fmt(disconnects)} disconnects` : null))
  metricsGrid.appendChild(metricCard('Total Logins',     fmt(logins),      loginErrors !== null ? `${fmt(loginErrors)} errors` : null))
  metricsGrid.appendChild(metricCard('RPC Calls',        fmt(rpcs),        null))
  metricsGrid.appendChild(metricCard('Avg Tick Duration', fmtMs(tickAvg),  null))
}

// ── Init ──────────────────────────────────────────────────────────────────────
loadSettings()
checkServerStatus()
checkLauncherUpdate()
loadNews()
loadServerInfo()
loadModlist()
setInterval(checkServerStatus, 30_000)
