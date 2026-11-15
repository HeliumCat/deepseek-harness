// The transparent desktop-pet window. The worker launches this file through an
// Electron executable with the token-carrying pet page URL as its only
// argument; the process owns one frameless, always-on-top, click-through
// window until the page asks to quit or the worker closes it.
import { app, BrowserWindow, Menu, ipcMain, screen } from 'electron'
import { fileURLToPath } from 'node:url'

const pageUrl = process.argv.at(-1)
if (pageUrl === undefined || !/^http:\/\/127\.0\.0\.1:\d+\//u.test(pageUrl)) {
  console.error('pet-window: expected a loopback HTTP page URL')
  app.exit(1)
}

const preload = fileURLToPath(new URL('./pet-preload.cjs', import.meta.url))
const COMPACT = { width: 240, height: 260 }
const MARGIN = 22

app.disableHardwareAcceleration()
app.commandLine.appendSwitch('disable-background-timer-throttling')

let window

function workAreaFor(bounds) {
  const display = bounds === undefined ? screen.getPrimaryDisplay() : screen.getDisplayMatching(bounds)
  return display.workArea
}

function initialBounds() {
  const area = workAreaFor()
  return {
    width: COMPACT.width,
    height: COMPACT.height,
    x: Math.round(area.x + area.width - COMPACT.width - MARGIN),
    y: Math.round(area.y + area.height - COMPACT.height - MARGIN),
  }
}

function clampToWorkArea(bounds) {
  const area = workAreaFor(bounds)
  return {
    ...bounds,
    x: Math.min(Math.max(area.x, bounds.x), area.x + area.width - bounds.width),
    y: Math.min(Math.max(area.y, bounds.y), area.y + area.height - bounds.height),
  }
}

function createWindow() {
  window = new BrowserWindow({
    ...initialBounds(),
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    title: 'DSH Pet',
    webPreferences: {
      preload,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false,
      spellcheck: false,
    },
  })
  window.setAlwaysOnTop(true, 'floating')
  window.setSkipTaskbar(true)
  if (process.platform === 'darwin') {
    window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    app.dock?.hide()
  }
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event, target) => {
    if (target.startsWith('pet-app://quit')) {
      event.preventDefault()
      app.quit()
      return
    }
    if (!target.startsWith('http://127.0.0.1:')) event.preventDefault()
  })
  window.webContents.on('context-menu', () => {
    Menu.buildFromTemplate([
      { label: 'Open full history', click: () => { void window.webContents.executeJavaScript("document.getElementById('history-button')?.click()") } },
      { type: 'separator' },
      { label: 'Quit pet window', click: () => { app.quit() } },
    ]).popup({ window })
  })
  window.once('ready-to-show', () => { window?.showInactive() })
  window.on('closed', () => { window = undefined })
  void window.loadURL(pageUrl)
}

ipcMain.on('pet-window:resize', (_event, width, height) => {
  if (window === undefined) return
  const current = window.getBounds()
  const next = clampToWorkArea({
    width: Math.max(COMPACT.width, Math.round(width)),
    height: Math.max(COMPACT.height, Math.round(height)),
    x: current.x + current.width - Math.max(COMPACT.width, Math.round(width)),
    y: current.y + current.height - Math.max(COMPACT.height, Math.round(height)),
  })
  window.setBounds(next)
})
ipcMain.on('pet-window:quit', () => { app.quit() })

app.whenReady().then(createWindow, error => {
  console.error('pet-window:', error)
  app.exit(1)
})
app.on('window-all-closed', () => { app.quit() })
