'use strict'

/**
 * Vortex Mod Manager integration.
 *
 * Responsibilities:
 *  - Detect the Vortex installation and data directory.
 *  - Manage a dedicated "frostfall-client" mod in Vortex's staging area.
 *  - Keep the selected profile's modlist.txt up to date.
 *  - Deploy staged files to the Skyrim directory via hardlinks (or copy as fallback).
 */

const path   = require('path')
const fs     = require('fs')
const os     = require('os')
const crypto = require('crypto')

const GAME_ID  = 'skyrimse'
const MOD_ID   = 'frostfall-client'
const MOD_NAME = 'Frostfall - SkyMP Client'

// ── Path helpers ──────────────────────────────────────────────────────────────

/** %APPDATA%\Vortex */
function getDataPath() {
  return path.join(
    process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
    'Vortex'
  )
}

/** .../Vortex/skyrimse/mods */
function getStagingRoot() {
  return path.join(getDataPath(), GAME_ID, 'mods')
}

/** .../Vortex/skyrimse/mods/frostfall-client */
function getModStagingDir() {
  return path.join(getStagingRoot(), MOD_ID)
}

/** .../Vortex/skyrimse/profiles */
function getProfilesRoot() {
  return path.join(getDataPath(), GAME_ID, 'profiles')
}

/** .../Vortex/skyrimse/profiles/<profileId> */
function getProfileDir(profileId) {
  return path.join(getProfilesRoot(), profileId)
}

// ── Vortex detection ──────────────────────────────────────────────────────────

/**
 * Search common install locations for Vortex.exe.
 * Returns the path if found, otherwise null.
 */
function findVortexExe() {
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
  const candidates = [
    path.join(local, 'Programs', 'black_tree_gaming', 'Vortex', 'Vortex.exe'),
    path.join(local, 'Programs', 'Vortex', 'Vortex.exe'),
    'C:\\Program Files\\Black Tree Gaming\\Vortex\\Vortex.exe',
    'C:\\Program Files (x86)\\Black Tree Gaming\\Vortex\\Vortex.exe',
  ]
  return candidates.find(p => fs.existsSync(p)) ?? null
}

// ── Profile listing ───────────────────────────────────────────────────────────

/**
 * List profiles from the Vortex filesystem.
 * Profile names from Vortex's internal DB (LevelDB) are not accessible without
 * a native binding, so we return the profile ID as the name unless the user has
 * previously named it via our own .frostfall marker file.
 *
 * @returns {{ id: string, name: string }[]}
 */
function listProfiles() {
  const root = getProfilesRoot()
  if (!fs.existsSync(root)) return []

  return fs.readdirSync(root, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => {
      let name = e.name
      try {
        const marker = JSON.parse(
          fs.readFileSync(path.join(root, e.name, '.frostfall'), 'utf8')
        )
        if (marker.profileName) name = marker.profileName
      } catch { /* marker absent – use the raw ID */ }
      return { id: e.name, name }
    })
}

/**
 * Write a .frostfall marker to the profile directory so we can recall the
 * human-readable name on subsequent launches (Vortex stores names in LevelDB).
 */
function tagProfile(profileId, profileName) {
  const dir = getProfileDir(profileId)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, '.frostfall'),
    JSON.stringify({ profileName, tagged: new Date().toISOString() })
  )
}

// ── Staging install ───────────────────────────────────────────────────────────

/**
 * Copy the given manifest entries into the Vortex staging folder for our mod.
 *
 * Each entry must have:
 *   src   – absolute path to the source file
 *   dest  – relative path that mirrors the Skyrim directory structure
 *           (e.g. "Data\SKSE\Plugins\MpClientPlugin.dll")
 *
 * @param {{ src: string, dest: string }[]} entries
 * @param {string} version  Semver string written into meta.ini
 * @param {(file: string, i: number, total: number) => void} onProgress
 */
function installToStaging(entries, version, onProgress) {
  const stagingDir = getModStagingDir()
  fs.mkdirSync(stagingDir, { recursive: true })

  const total = entries.length
  for (let i = 0; i < total; i++) {
    const { src, dest } = entries[i]
    const destAbs = path.join(stagingDir, dest)
    fs.mkdirSync(path.dirname(destAbs), { recursive: true })
    fs.copyFileSync(src, destAbs)
    if (onProgress) onProgress(dest, i + 1, total)
  }

  // Write meta.ini so Vortex recognises the folder as a managed mod.
  fs.writeFileSync(path.join(stagingDir, 'meta.ini'), [
    '[General]',
    `gameName=${GAME_ID}`,
    'modid=0',
    `version=${version || '1.0.0'}`,
    `installTime=${new Date().toISOString()}`,
    'source=manual',
    `name=${MOD_NAME}`,
    '',
  ].join('\r\n'))
}

// ── Profile modlist ───────────────────────────────────────────────────────────

/**
 * Ensure +frostfall-client appears near the top of the profile's modlist.txt.
 * Creates the file if it does not yet exist.
 */
function enableModInProfile(profileId) {
  const profileDir  = getProfileDir(profileId)
  fs.mkdirSync(profileDir, { recursive: true })

  const modlistPath = path.join(profileDir, 'modlist.txt')

  let lines = []
  if (fs.existsSync(modlistPath)) {
    lines = fs.readFileSync(modlistPath, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
  }

  // Remove any pre-existing entry for our mod (enabled or disabled)
  lines = lines.filter(l => l.slice(1) !== MOD_ID)

  // Insert after header comments, before any other mod entries
  const insertAt = lines.findIndex(l => l.startsWith('+') || l.startsWith('-'))
  if (insertAt === -1) {
    lines.push(`+${MOD_ID}`)
  } else {
    lines.splice(insertAt, 0, `+${MOD_ID}`)
  }

  fs.writeFileSync(modlistPath, lines.join('\r\n') + '\r\n')
}

// ── Deployment ────────────────────────────────────────────────────────────────

function fileSha256(p) {
  try { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex') }
  catch { return null }
}

/**
 * Deploy all files from the frostfall-client staging dir to the Skyrim game
 * directory.  Uses hardlinks when source and destination are on the same
 * volume (zero extra disk space); falls back to a regular copy otherwise.
 *
 * Files that are already identical (same SHA-256) are skipped.
 *
 * @param {string} skyrimPath  Absolute path to the Skyrim installation folder
 * @param {(file: string, i: number, total: number, skipped: boolean) => void} onProgress
 * @returns {{ deployed: number, skipped: number }}
 */
function deployToGame(skyrimPath, onProgress) {
  const stagingDir = getModStagingDir()
  if (!fs.existsSync(stagingDir)) {
    throw new Error('Frostfall mod not found in Vortex staging — run Install first.')
  }

  // Collect all files (excluding meta.ini which is staging-only)
  const queue = []
  function collect(dir, rel) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const relChild = rel ? path.join(rel, entry.name) : entry.name
      if (entry.isDirectory()) {
        collect(path.join(dir, entry.name), relChild)
      } else if (entry.name !== 'meta.ini') {
        queue.push(relChild)
      }
    }
  }
  collect(stagingDir, '')

  let deployed = 0
  let skipped  = 0
  const total  = queue.length

  for (let i = 0; i < total; i++) {
    const rel      = queue[i]
    const srcPath  = path.join(stagingDir, rel)
    const destPath = path.join(skyrimPath, rel)

    // Skip if destination already matches source (identical SHA-256)
    if (fileSha256(srcPath) === fileSha256(destPath)) {
      skipped++
      if (onProgress) onProgress(rel, i + 1, total, true)
      continue
    }

    fs.mkdirSync(path.dirname(destPath), { recursive: true })

    // Attempt hardlink first; fall back to copy if cross-device or locked
    let linked = false
    try {
      if (fs.existsSync(destPath)) fs.unlinkSync(destPath)
      fs.linkSync(srcPath, destPath)
      linked = true
    } catch { /* fall through to copy */ }

    if (!linked) {
      fs.copyFileSync(srcPath, destPath)
    }

    deployed++
    if (onProgress) onProgress(rel, i + 1, total, false)
  }

  return { deployed, skipped }
}

// ── Status ────────────────────────────────────────────────────────────────────

/**
 * Return a snapshot of the Vortex integration state for the UI.
 */
function getStatus(vortexPath, profileId) {
  const dataPath   = getDataPath()
  const stagingDir = getModStagingDir()

  return {
    hasVortexExe: !!(vortexPath && fs.existsSync(vortexPath)),
    hasVortexData: fs.existsSync(dataPath),
    hasStaging:   fs.existsSync(stagingDir),
    hasProfile:   !!(profileId && fs.existsSync(getProfileDir(profileId))),
    profiles:     fs.existsSync(getProfilesRoot()) ? listProfiles() : [],
  }
}

// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  GAME_ID,
  MOD_ID,
  MOD_NAME,
  getDataPath,
  getStagingRoot,
  getModStagingDir,
  getProfilesRoot,
  getProfileDir,
  findVortexExe,
  listProfiles,
  tagProfile,
  installToStaging,
  enableModInProfile,
  deployToGame,
  getStatus,
}
