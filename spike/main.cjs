const { app, BrowserWindow, session } = require('electron');
const path = require('path');

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

app.whenReady().then(() => {
  // The realistic production posture: a strict CSP, sandboxed renderer, no node.
  // Risk #1 in the plan is whether the stretch library survives this.
  session.defaultSession.webRequest.onHeadersReceived((details, cb) => {
    cb({ responseHeaders: { ...details.responseHeaders,
      'Content-Security-Policy': [
        "default-src 'self'; script-src 'self' 'wasm-unsafe-eval' blob:; worker-src 'self' blob:; media-src 'self' blob: tva-file:; style-src 'self' 'unsafe-inline'"
      ] } });
  });

  const win = new BrowserWindow({
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.loadFile(path.join(__dirname, 'spike.html'));
  win.webContents.on('console-message', (_e, _lvl, msg) => {
    console.log(msg);
    if (msg.startsWith('SPIKE-DONE')) app.exit(msg.includes('PASS') ? 0 : 1);
  });
  setTimeout(() => { console.log('SPIKE-DONE FAIL: timed out'); app.exit(1); }, 60000);
});
