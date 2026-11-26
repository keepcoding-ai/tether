// Electron used as a plain browser for the remote web client's E2E: one ordinary BrowserWindow (no preload, no node
// integration, sandboxed, the default session) pointed at the page the bench server serves, hidden and rendered
// off screen. The test drives
// it over CDP (`--remote-debugging-port` on Electron's command line). The page and the profile come by environment,
// REMOTE_WEB_URL and REMOTE_WEB_PROFILE (Electron 45 exits with 127 when an http URL is on its command line). The
// profile (IndexedDB included) lives in that folder, so a reload keeps the device's keys and a new folder is a new browser.
const { app, BrowserWindow } = require('electron')

const url = process.env.REMOTE_WEB_URL
const profile = process.env.REMOTE_WEB_PROFILE
if (!url || !profile) { console.error('REMOTE_WEB_URL and REMOTE_WEB_PROFILE are required'); process.exit(2) }
app.setPath('userData', profile)

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 390, height: 844, useContentSize: true, show: false,
    // Off-screen rendering keeps painting while hidden, so screenshots never wait for a frame that does not come.
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true },
  })
  await win.loadURL(url)
}).catch((err) => { console.error(err); app.exit(1) })

app.on('window-all-closed', () => app.quit())
