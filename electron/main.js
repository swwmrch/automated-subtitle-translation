const { app, BrowserWindow, shell } = require('electron')
const path = require('path')
const http = require('http')
const net = require('net')
const fs = require('fs')
const crypto = require('crypto')

// ── File logger (writes to app.log next to the exe) ───────────────────────────
const logPath = app.isPackaged
  ? path.join(path.dirname(process.execPath), 'app.log')
  : path.join(__dirname, '..', 'app.log')

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`
  process.stdout.write(line)
  try { fs.appendFileSync(logPath, line) } catch {}
}

// ── Env file loader (no external dependency) ───────────────────────────────────
function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return
  for (const line of fs.readFileSync(filePath, 'utf8').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eqIdx = trimmed.indexOf('=')
    if (eqIdx === -1) continue
    const key = trimmed.slice(0, eqIdx).trim()
    const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '')
    if (key && !process.env[key]) process.env[key] = val
  }
}

// ── Paths: dev vs packaged ─────────────────────────────────────────────────────
function getEnvPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, '.env.local')
    : path.join(__dirname, '..', '.env.local')
}

function getStandalonePath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'standalone')
    : path.join(__dirname, '..', '.next', 'standalone')
}

function getConfigPath() {
  return app.isPackaged
    ? path.join(path.dirname(process.execPath), 'config.json')
    : path.join(__dirname, '..', 'config.json')
}

// ── Config management ──────────────────────────────────────────────────────────
function loadConfig() {
  const configPath = getConfigPath()
  log(`[Config] Path: ${configPath}`)
  let config = {}

  if (fs.existsSync(configPath)) {
    try { config = JSON.parse(fs.readFileSync(configPath, 'utf8')) } catch { config = {} }
  }

  if (!config.sessionSecret || config.sessionSecret.length < 32) {
    config.sessionSecret = crypto.randomBytes(32).toString('base64')
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8')
    log('[Config] Generated new session secret and saved config.json')
  } else {
    log('[Config] Loaded existing session secret')
  }

  return config
}

// ── Env validation ─────────────────────────────────────────────────────────────
function validateEnv(config = {}) {
  log('[Env] Validating required env vars...')

  // A saved custom key (config.json) or CUSTOM_API_KEY env var is just as valid
  // an OpenAI key source as OPENAI_API_KEY itself.
  const openAiKey =
    process.env.OPENAI_API_KEY || config.customApiKey || process.env.CUSTOM_API_KEY
  if (!openAiKey || openAiKey.length < 10) {
    throw new Error('Missing OpenAI key: set OPENAI_API_KEY or save a custom API key')
  }
  log('[Env] OpenAI key: OK')

  const appPassword = process.env.APP_PASSWORD
  if (!appPassword || appPassword.length < 1) {
    throw new Error('Missing env var: APP_PASSWORD')
  }
  log('[Env] APP_PASSWORD: OK')
}

// ── Port helpers ───────────────────────────────────────────────────────────────
function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port
      server.close(() => resolve(port))
    })
    server.on('error', reject)
  })
}

function waitForServer(port, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeout
    function attempt() {
      const req = http.get(`http://127.0.0.1:${port}`, () => resolve())
      req.setTimeout(1000, () => req.destroy())
      req.on('error', () => {
        if (Date.now() >= deadline) return reject(new Error('Next.js server did not start in time'))
        setTimeout(attempt, 600)
      })
    }
    attempt()
  })
}

// ── Next.js server ─────────────────────────────────────────────────────────────
async function startNextServer(config) {
  const port = await getFreePort()
  const standalonePath = getStandalonePath()
  const serverPath = path.join(standalonePath, 'server.js')

  log(`[Server] standalonePath: ${standalonePath}`)
  log(`[Server] serverPath: ${serverPath}`)
  log(`[Server] server.js exists: ${fs.existsSync(serverPath)}`)
  log(`[Server] port: ${port}`)

  process.env.PORT = String(port)
  process.env.HOSTNAME = '127.0.0.1'
  process.env.NODE_ENV = 'production'
  process.env.SESSION_SECRET = config.sessionSecret
  process.env.KMTV_CONFIG_PATH = getConfigPath()
  if (config.customApiKey) process.env.CUSTOM_API_KEY = config.customApiKey

  const { spawn } = require('child_process')

  if (app.isPackaged) {
    log(`[Server] Packaged mode — spawning via ELECTRON_RUN_AS_NODE`)
    log(`[Server] execPath: ${process.execPath}`)
    const nextProcess = spawn(process.execPath, [serverPath], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      cwd: standalonePath,
    })
    nextProcess.stdout.on('data', (d) => { log(`[Next] ${String(d).trimEnd()}`) })
    nextProcess.stderr.on('data', (d) => { log(`[Next:ERR] ${String(d).trimEnd()}`) })
    nextProcess.on('error', (err) => { log(`[Next:SPAWN_ERR] ${err.message}`) })
    nextProcess.on('exit', (code, signal) => { log(`[Next:EXIT] code=${code} signal=${signal}`) })
    app.on('before-quit', () => nextProcess.kill())
  } else {
    log(`[Server] Dev mode — spawning via node`)
    const nextProcess = spawn('node', [serverPath], {
      env: { ...process.env },
      cwd: standalonePath,
    })
    nextProcess.stdout.on('data', (d) => { log(`[Next] ${String(d).trimEnd()}`) })
    nextProcess.stderr.on('data', (d) => { log(`[Next:ERR] ${String(d).trimEnd()}`) })
    nextProcess.on('error', (err) => { log(`[Next:SPAWN_ERR] ${err.message}`) })
    nextProcess.on('exit', (code, signal) => { log(`[Next:EXIT] code=${code} signal=${signal}`) })
    app.on('before-quit', () => nextProcess.kill())
  }

  log('[Server] Waiting for server to be ready...')
  await waitForServer(port)
  log(`[Server] Ready on port ${port}`)
  return port
}

// ── Window ─────────────────────────────────────────────────────────────────────
function createWindow(port) {
  const win = new BrowserWindow({
    width: 1400,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    title: 'KMTV Subtitle Translator',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  })

  win.loadURL(`http://127.0.0.1:${port}`)

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })
}

// ── Bootstrap ──────────────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  log('[Bootstrap] app.whenReady fired')
  log(`[Bootstrap] isPackaged: ${app.isPackaged}`)
  log(`[Bootstrap] execPath: ${process.execPath}`)
  log(`[Bootstrap] resourcesPath: ${process.resourcesPath ?? 'N/A'}`)
  try {
    const envPath = getEnvPath()
    log(`[Bootstrap] Loading env from: ${envPath}`)
    log(`[Bootstrap] .env.local exists: ${fs.existsSync(envPath)}`)
    loadEnvFile(envPath)
    const config = loadConfig()
    validateEnv(config)
    process.env.SESSION_SECRET = config.sessionSecret
    log('[Bootstrap] Starting Next.js server...')
    const port = await startNextServer(config)
    log(`[Bootstrap] Server ready on port ${port}, opening window`)
    createWindow(port)
  } catch (err) {
    log(`[Bootstrap] FATAL: ${err.stack ?? err.message ?? err}`)
    app.quit()
  }
})

app.on('window-all-closed', () => app.quit())
