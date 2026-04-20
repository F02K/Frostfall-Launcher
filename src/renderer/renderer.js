// ── Window controls ──────────────────────────────────────────────────────────
document.getElementById('btn-minimize').addEventListener('click', () => window.electronAPI.minimize())
document.getElementById('btn-maximize').addEventListener('click', () => window.electronAPI.maximize())
document.getElementById('btn-close').addEventListener('click',    () => window.electronAPI.close())

// ── External nav links ────────────────────────────────────────────────────────
const EXTERNAL_URLS = {
  website: 'https://frostfall.online',   // e.g. 'https://frostfall.example.com'
  discord: 'https://discord.gg/4KHMqUUKNT',   // e.g. 'https://discord.gg/...'
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

// ── Settings tabs ─────────────────────────────────────────────────────────────
document.querySelectorAll('.modal-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.modal-tab').forEach(t => t.classList.remove('active'))
    document.querySelectorAll('.tab-panel').forEach(p => { p.hidden = true })
    tab.classList.add('active')
    document.getElementById(`tab-${tab.dataset.tab}`).hidden = false
  })
})

// ── Form fields ───────────────────────────────────────────────────────────────
const fieldSkyrimPath   = document.getElementById('setting-skyrim-path')

// ── Footer server selector ────────────────────────────────────────────────────
const footerServerName   = document.getElementById('footer-server-name')
const footerServerSelect = document.getElementById('footer-server-select')

footerServerSelect.addEventListener('change', () => {
  window.electronAPI.saveSettings({ activeServerIndex: parseInt(footerServerSelect.value, 10) })
})

// ── Vortex fields ─────────────────────────────────────────────────────────────
const fieldVortexPath    = document.getElementById('setting-vortex-path')
const fieldVortexProfile = document.getElementById('setting-vortex-profile')
const fieldVortexEnabled = document.getElementById('setting-vortex-enabled')
const vortexStatusDot    = document.getElementById('vortex-status-dot')
const vortexStatusText   = document.getElementById('vortex-status-text')

// ── Discord auth state (kept in module scope for PLAY check) ──────────────────
let discordUser         = null
let discordAuthRequired = false
let serverLocked        = false
let lockedAllowList     = []

// Re-evaluates Play button state whenever lock state or Discord user changes.
function updateLockState() {
  const userAllowed = serverLocked && discordUser && lockedAllowList.includes(discordUser.id)
  if (serverLocked && !userAllowed) {
    btnConnect.disabled = true
    btnConnect.title    = 'This server is currently locked to the public.'
    connectWarning.textContent = 'Server is currently locked.'
    connectWarning.classList.add('visible')
  } else if (serverLocked && userAllowed) {
    btnConnect.disabled = false
    btnConnect.title    = ''
    connectWarning.classList.remove('visible')
    connectWarning.textContent = ''
  }
}

// ── Load / save settings ──────────────────────────────────────────────────────
async function loadSettings() {
  const s = await window.electronAPI.loadSettings()
  fieldSkyrimPath.value = s.skyrimPath || ''

  // Footer server selector — dropdown when >1 server, plain text otherwise
  if (s.servers && s.servers.length > 1) {
    footerServerName.hidden   = true
    footerServerSelect.hidden = false
    footerServerSelect.innerHTML = ''
    s.servers.forEach((srv, i) => {
      const opt = document.createElement('option')
      opt.value       = i
      opt.textContent = srv.name
      opt.selected    = i === (s.activeServerIndex || 0)
      footerServerSelect.appendChild(opt)
    })
  } else {
    footerServerName.hidden   = false
    footerServerSelect.hidden = true
    if (s.servers && s.servers.length === 1) {
      footerServerName.textContent = s.servers[0].name
    }
  }

  // Restore Discord user from persisted store
  if (s.discordUser) {
    discordUser = s.discordUser
    renderTopbarDiscord()
  }

  // Restore Vortex settings
  fieldVortexPath.value      = s.vortexPath || ''
  fieldVortexEnabled.checked = !!s.vortexEnabled
  await refreshVortexProfiles(s.vortexProfileId || '')
  updateVortexStatus()

  return s
}

// ── Discord topbar widget ─────────────────────────────────────────────────────
const discordTopbarSlot = document.getElementById('discord-topbar-slot')

function renderTopbarDiscord() {
  discordTopbarSlot.innerHTML = ''

  if (discordUser) {
    const wrap = document.createElement('div')
    wrap.className = 'discord-topbar-user'

    if (discordUser.avatar) {
      const img = document.createElement('img')
      img.className = 'discord-topbar-avatar'
      img.src = discordUser.avatar
      img.alt = discordUser.username
      wrap.appendChild(img)
    } else {
      const ph = document.createElement('div')
      ph.className   = 'discord-topbar-avatar-placeholder'
      ph.textContent = '✦'
      wrap.appendChild(ph)
    }

    const name = document.createElement('span')
    name.className   = 'discord-topbar-name'
    name.textContent = discordUser.tag || discordUser.username
    wrap.appendChild(name)

    const logoutBtn = document.createElement('button')
    logoutBtn.className   = 'discord-topbar-logout'
    logoutBtn.title       = 'Logout'
    logoutBtn.textContent = '✕'
    logoutBtn.addEventListener('click', async () => {
      await window.electronAPI.discordLogout()
      discordUser = null
      renderTopbarDiscord()
      updateLockState()
    })
    wrap.appendChild(logoutBtn)

    discordTopbarSlot.appendChild(wrap)
  } else {
    const loginBtn = document.createElement('button')
    loginBtn.className   = 'btn-discord-topbar'
    loginBtn.textContent = 'Discord Login'
    loginBtn.addEventListener('click', async () => {
      loginBtn.disabled    = true
      loginBtn.textContent = 'Opening…'
      const result = await window.electronAPI.discordLogin()
      if (result.success) {
        discordUser = result.user
        renderTopbarDiscord()
        updateLockState()
      } else {
        loginBtn.disabled    = false
        loginBtn.textContent = 'Discord Login'
        connectWarning.textContent = `Discord: ${result.error}`
        connectWarning.classList.add('visible')
        setTimeout(() => connectWarning.classList.remove('visible'), 4000)
      }
    })
    discordTopbarSlot.appendChild(loginBtn)
  }
}

renderTopbarDiscord()

document.getElementById('btn-save').addEventListener('click', async () => {
  const profileId = fieldVortexProfile.value.trim()

  const data = {
    skyrimPath:      fieldSkyrimPath.value.trim(),
    vortexPath:      fieldVortexPath.value.trim(),
    vortexProfileId: profileId,
    vortexEnabled:   fieldVortexEnabled.checked,
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

const FROSTFALL_PROFILE_NAME = 'frostfall server collection'

async function refreshVortexProfiles(selectId) {
  const allProfiles = await window.electronAPI.vortexListProfiles()

  // Only show profiles belonging to the Frostfall Server Collection
  const profiles = allProfiles.filter(p =>
    p.name.toLowerCase().includes(FROSTFALL_PROFILE_NAME)
  )

  // Preserve current selection if no explicit id given
  const currentVal = selectId !== undefined ? selectId : fieldVortexProfile.value

  fieldVortexProfile.innerHTML = profiles.length === 0
    ? '<option value="">— no Frostfall Server Collection profile found —</option>'
    : '<option value="">— select profile —</option>'

  profiles.forEach(p => {
    const opt = document.createElement('option')
    opt.value       = p.id
    opt.textContent = p.name !== p.id ? p.name : `Profile ${p.id.slice(0, 8)}…`
    opt.selected    = p.id === currentVal
    fieldVortexProfile.appendChild(opt)
  })

  // Auto-select if there is exactly one matching profile and none is saved yet
  if (profiles.length === 1 && !currentVal) {
    fieldVortexProfile.value = profiles[0].id
  }
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

// ── Install / Update Client Files ────────────────────────────────────────────
const installStatusClient = document.getElementById('install-status-client')

document.getElementById('btn-install-client').addEventListener('click', () => {
  installStatusClient.textContent = 'Starting install…'
  window.electronAPI.removeInstallListeners()

  window.electronAPI.onInstallProgress(({ phase, file, index, total, skipped }) => {
    if (phase === 'download') {
      installStatusClient.textContent = file
    } else {
      const prefix = skipped ? '[skip]' : `[${index}/${total}]`
      installStatusClient.textContent = `${prefix} ${file}`
    }
  })

  window.electronAPI.onInstallComplete(({ success, error, upToDate }) => {
    if (!success) {
      installStatusClient.textContent = `Error: ${error}`
      return
    }
    installStatusClient.textContent = upToDate ? 'Client files up to date ✓' : 'Client files installed ✓'
  })

  window.electronAPI.startInstall('client')
})

// ── Install Modpack via Vortex ────────────────────────────────────────────────
const installStatusVortex = document.getElementById('install-status-vortex')

document.getElementById('btn-install-vortex').addEventListener('click', () => {
  installStatusVortex.textContent = 'Starting Vortex install…'
  window.electronAPI.removeInstallListeners()

  window.electronAPI.onInstallProgress(({ phase, file, index, total, skipped }) => {
    if (phase === 'download') {
      installStatusVortex.textContent = file
    } else if (phase === 'deploy') {
      installStatusVortex.textContent = `[deploy ${index}/${total}] ${file}`
    } else {
      const prefix = skipped ? '[skip]' : `[${index}/${total}]`
      installStatusVortex.textContent = `${prefix} ${file}`
    }
  })

  window.electronAPI.onInstallComplete(({ success, error, skseWarning, upToDate, vortex: usedVortex }) => {
    if (!success) {
      installStatusVortex.textContent = `Error: ${error}`
      return
    }
    if (skseWarning) {
      installStatusVortex.textContent = `Done — ⚠ ${skseWarning}`
      return
    }

    const prefix = upToDate
      ? 'Server files up to date'
      : (usedVortex ? 'Staged & deployed via Vortex' : 'Install complete')

    const missingNexus = currentModlist.filter(m => m.source === 'nexus' && m.required && m.enabled)
    if (missingNexus.length > 0) {
      const names = missingNexus.map(m => m.name).join(', ')
      installStatusVortex.textContent = `${prefix}. Install these via Vortex: ${names}`
    } else {
      installStatusVortex.textContent = `${prefix}! ✓`
    }
  })

  window.electronAPI.startInstall('vortex')
})

// ── PLAY button ───────────────────────────────────────────────────────────────
const btnConnect     = document.getElementById('btn-connect')
const connectWarning = document.getElementById('connect-warning')


btnConnect.addEventListener('click', async () => {
  const userAllowed = discordUser && lockedAllowList.includes(discordUser.id)
  if (serverLocked && !userAllowed) {
    connectWarning.textContent = 'Server is currently locked.'
    connectWarning.classList.add('visible')
    return
  }

  const s = await window.electronAPI.loadSettings()
  if (!s.skyrimPath) {
    connectWarning.textContent = 'Set Skyrim path in Settings first.'
    connectWarning.classList.add('visible')
    return
  }

  if (!discordUser) {
    connectWarning.textContent = 'Login with Discord first — use the button in the toolbar.'
    connectWarning.classList.add('visible')
    return
  }

  btnConnect.disabled    = true
  btnConnect.textContent = 'Deploying…'
  connectWarning.classList.remove('visible')

  const result = await window.electronAPI.launchSkse()

  if (!result.success) {
    connectWarning.textContent = result.error
    connectWarning.classList.add('visible')
  } else {
    connectWarning.classList.remove('visible')
    connectWarning.textContent = ''
  }

  btnConnect.disabled    = false
  btnConnect.textContent = '\u25BA PLAY'
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

  const strip      = document.getElementById('server-info-strip')
  const nameEl     = document.getElementById('sinfo-name')
  const capEl      = document.getElementById('sinfo-capacity')
  const modeEl     = document.getElementById('sinfo-mode')
  const modeSep    = document.getElementById('sinfo-mode-sep')
  const discEl     = document.getElementById('sinfo-discord')
  const discSep    = document.getElementById('sinfo-discord-sep')
  const lockEl     = document.getElementById('sinfo-locked')
  const lockSep    = document.getElementById('sinfo-locked-sep')
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

  if (info.lockedAllowList) {
    lockedAllowList = info.lockedAllowList
  }

  if (info.locked) {
    serverLocked   = true
    lockEl.hidden  = false
    lockSep.hidden = false
  }

  updateLockState()

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
  { name: 'SKSE64',                                  version: '2.2.6',   required: true,  enabled: true,  source: 'backend' },
  { name: 'SkyMP Client',                            version: '0.8.2',   required: true,  enabled: true,  source: 'backend' },
  { name: 'Address Library for SKSE',                version: '11.0.0',  required: true,  enabled: true,  source: 'nexus',   nexusId: 32444 },
  { name: 'SkyUI',                                   version: '5.2.1',   required: false, enabled: true,  source: 'nexus',   nexusId: 12604 },
  { name: 'Unofficial Skyrim Special Edition Patch', version: '4.3.0',   required: false, enabled: true,  source: 'nexus',   nexusId: 266   },
  { name: 'A Quality World Map',                     version: '9.0.1',   required: false, enabled: false, source: 'nexus',   nexusId: 5804  },
  { name: 'Enhanced Lights and FX',                  version: '3.05',    required: false, enabled: false, source: 'nexus',   nexusId: 2424  },
]

const NEXUS_BASE = 'https://www.nexusmods.com/skyrimspecialedition/mods'

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

  // Backend mods are installed automatically by the launcher.
  // Nexus mods need to be installed by the user via Vortex.
  if (mod.source === 'backend') {
    const badge = document.createElement('span')
    badge.className   = 'mod-badge mod-badge--auto'
    badge.textContent = 'AUTO'
    badge.title       = 'Installed automatically by the launcher'
    item.appendChild(badge)
  } else if (mod.source === 'nexus' && mod.nexusId) {
    const link = document.createElement('a')
    link.className   = 'mod-nexus-link'
    link.textContent = 'Nexus'
    link.title       = 'Open on Nexus Mods'
    link.href        = '#'
    link.addEventListener('click', e => {
      e.preventDefault()
      window.electronAPI.openExternal(`${NEXUS_BASE}/${mod.nexusId}`)
    })
    item.appendChild(link)
  }

  const ver = document.createElement('span')
  ver.className   = 'mod-version'
  ver.textContent = `v${mod.version}`
  item.appendChild(ver)

  return item
}

// Keep a reference to the last-loaded modlist so the install handler can use it.
let currentModlist = []

async function loadModlist() {
  const panel = document.getElementById('modlist')
  const count = document.getElementById('modlist-count')

  currentModlist = await window.electronAPI.fetchModlist() ?? FALLBACK_MODLIST

  panel.innerHTML = ''
  currentModlist.forEach(mod => panel.appendChild(buildModItem(mod)))

  const enabled = currentModlist.filter(m => m.enabled).length
  count.textContent = `${enabled} / ${currentModlist.length} enabled`
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
