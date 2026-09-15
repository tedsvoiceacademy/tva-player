/* The app itself: one window, the files, the registry, the updates.
 *
 * NO AUDIO HAPPENS IN THIS PROCESS. Everything that makes a sound lives in the
 * renderer, which is sandboxed and has no access to the file system. Songs reach
 * it either as an app://player/song/ URL it can stream, or as bytes it asked for.
 */
const { app, BrowserWindow, dialog, ipcMain, protocol, session, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const { pathToFileURL, fileURLToPath } = require('node:url');

const core = require('@tva/practice-core');
const { Store, defaultRoot, detectOneDrive } = require('./store.cjs');
const { Recording, defaultRecordingsDir, repairUnfinished, listRecordings } = require('./recording.cjs');
const { scanFolder, readTags, songLabel } = require('./library.cjs');
const { openDefaultAppsSettings, readUserChoices } = require('./default-apps.cjs');
const { registerShortcuts, KEYS } = require('./shortcuts.cjs');

const RENDERER_DIR = path.join(__dirname, '..', 'renderer');

let win = null;
let store = null;
let recording = null;          // the one in progress, if any
let recordingsDir = null;
const burst = new core.BurstCollector(250);
let burstTimer = null;

/* Chromium will not start audio without a click unless told otherwise. In a
   browser that rule protects people from noisy pages; in a media player the
   person double-clicked a song, which IS the gesture. */
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

/* Only songs the person has actually opened are servable. The renderer cannot
   name a path and have it read: this set is the whole of what it may reach. */
const allowedPaths = new Set();

/* The page is served from app:// rather than opened from disk. A file:// page
   has no real origin, so "default-src 'self'" means nothing there and module
   loading is refused without saying why. Its own scheme gives it an origin the
   policy can actually be written against.
 *
 * SONGS ARE SERVED FROM THAT SAME ORIGIN, under /song/, rather than from a
 * scheme of their own. A separate scheme reads better but is fatal here: a
 * cross-origin media element is tainted, and createMediaElementSource on a
 * tainted element feeds SILENCE into the graph rather than failing. The song
 * would appear to play, with the clock running and nothing audible. Custom
 * schemes cannot be granted CORS, so same-origin is the only honest fix. */
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true } },
]);

function encodePathForUrl(filePath) {
  return `app://player/song/${encodeURIComponent(filePath)}`;
}

async function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 900,
    minHeight: 560,
    backgroundColor: '#0a1628',
    show: false,
    title: 'TVA Player',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, '..', 'preload', 'index.cjs'),
    },
  });
  win.once('ready-to-show', () => win.show());
  await win.loadURL('app://player/index.html');
}

/* The renderer runs under a strict policy. 'wasm-unsafe-eval' and blob: are both
   required by the stretch engine, which compiles its WASM from bytes it carries
   and registers its worklet from a blob — proven working under exactly this
   policy before any of the rest of this was built. */
function applyContentSecurityPolicy() {
  session.defaultSession.webRequest.onHeadersReceived((details, done) => {
    done({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          [
            "default-src 'self'",
            "script-src 'self' 'wasm-unsafe-eval' blob:",
            "worker-src 'self' blob:",
            "media-src 'self' blob:",
            "img-src 'self' data: blob:",
            "style-src 'self' 'unsafe-inline'",
            "connect-src 'self' blob: data:",
          ].join('; '),
        ],
      },
    });
  });
}

/* Serve one file, with the two headers that make a media element behave.
 *
 * net.fetch on a file:// URL returns the bytes but no Content-Length, and a
 * media element streaming a source of unknown length reports its duration as
 * Infinity — so the clock sits at 0:00 and the waveform has nothing to scale
 * itself against, while the song plays perfectly well. Accept-Ranges and the
 * Range handling are what let a 45-minute recording be seeked without reading
 * the whole thing first.
 */
async function serveFile(filePath, rangeHeader, contentType) {
  let stat;
  try { stat = await fsp.stat(filePath); } catch { return new Response('Not found', { status: 404 }); }
  if (!stat.isFile()) return new Response('Not found', { status: 404 });

  const total = stat.size;
  const headers = {
    'Content-Type': contentType,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
  };

  const match = rangeHeader ? /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim()) : null;
  if (match) {
    const start = match[1] ? Number(match[1]) : 0;
    const end = match[2] ? Math.min(Number(match[2]), total - 1) : total - 1;
    if (start >= total || start > end) {
      return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${total}` } });
    }
    const stream = fs.createReadStream(filePath, { start, end });
    return new Response(streamToWeb(stream), {
      status: 206,
      headers: { ...headers,
        'Content-Length': String(end - start + 1),
        'Content-Range': `bytes ${start}-${end}/${total}` },
    });
  }

  return new Response(streamToWeb(fs.createReadStream(filePath)), {
    status: 200,
    headers: { ...headers, 'Content-Length': String(total) },
  });
}

function streamToWeb(nodeStream) {
  const { Readable } = require('node:stream');
  return Readable.toWeb(nodeStream);
}

const MIME_BY_EXT = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm',
  '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.wav': 'audio/wav', '.flac': 'audio/flac',
  '.aac': 'audio/aac', '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.opus': 'audio/ogg',
  '.wma': 'audio/x-ms-wma', '.aiff': 'audio/aiff', '.aif': 'audio/aiff',
};

/* Capturing what the computer itself is playing.
 *
 * Chromium will only hand over system audio as part of a screen share, and only
 * when the app answers this request with audio: 'loopback'. WITHOUT THIS
 * HANDLER the button in the Record tab fails every time — the page asks and
 * nothing answers. It was missing until a check went looking for it.
 *
 * 'loopback' is WASAPI loopback on Windows: the whole system mix, with no
 * virtual audio driver to install and no native code. */
function handleSystemAudio() {
  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    if (!win || win.isDestroyed()) { callback({}); return; }
    callback({ video: win, audio: 'loopback' });
  }, { useSystemPicker: false });
}

function handleAppProtocol() {
  protocol.handle('app', async (request) => {
    const url = new URL(request.url);
    /* Decoded ONCE. An earlier version decoded the whole path and then decoded
       the file name again, so any song whose name contained a per-cent sign
       resolved to a different path and was refused. */
    const raw = url.pathname.replace(/^\/+/, '');
    const range = request.headers.get('Range');

    /* A song the person has actually opened. Only those: the renderer cannot
       name an arbitrary file and have it served. */
    if (raw.startsWith('song/')) {
      const target = decodeURIComponent(raw.slice('song/'.length));
      if (!allowedPaths.has(target)) return new Response('Not opened by this app', { status: 403 });
      const type = MIME_BY_EXT[path.extname(target).toLowerCase()] ?? 'application/octet-stream';
      return serveFile(target, range, type);
    }

    // Otherwise it is the page itself, and nothing outside the renderer folder
    // is servable however it is asked for.
    const target = path.normalize(path.join(RENDERER_DIR, decodeURIComponent(raw)));
    if (!target.startsWith(RENDERER_DIR)) return new Response('No', { status: 403 });
    const type = MIME_BY_EXT[path.extname(target).toLowerCase()] ?? 'application/octet-stream';
    return serveFile(target, range, type);
  });
}

/* Opening songs. Arrivals are gathered rather than handled one at a time,
   because selecting six files in Explorer launches six copies of the app in
   quick succession and each would otherwise replace the last. */
function queueOpen(paths) {
  if (paths.length === 0) return;
  const at = Date.now();
  const readyAt = burst.add(paths, at);
  if (burstTimer) clearTimeout(burstTimer);
  burstTimer = setTimeout(() => {
    const gathered = burst.flush(Date.now());
    if (gathered && gathered.length) deliverOpen(gathered);
  }, Math.max(10, readyAt - at + 20));
}

async function deliverOpen(paths) {
  const songs = [];
  for (const p of paths) {
    try {
      const stat = await fsp.stat(p);
      if (!stat.isFile()) continue;
      allowedPaths.add(p);
      app.addRecentDocument(p);
      songs.push({
        path: p,
        name: path.basename(p),
        bytes: stat.size,
        songKey: core.songKey(path.basename(p), stat.size),
        url: encodePathForUrl(p),
      });
    } catch { /* a file that vanished between the click and here */ }
  }
  if (songs.length && win) win.webContents.send('songs:open', songs);
}

function setJumpList() {
  if (process.platform !== 'win32') return;
  app.setJumpList([
    {
      type: 'custom',
      name: 'Tasks',
      items: [
        { type: 'task', title: 'Play or pause', program: process.execPath,
          args: '--task=playpause', description: 'Play or pause whatever is loaded' },
        { type: 'task', title: 'Start recording', program: process.execPath,
          args: '--task=record', description: 'Open the app and start a new recording' },
      ],
    },
    { type: 'recent' },
  ]);
}

/* ---- Wiring ------------------------------------------------------------- */

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    queueOpen(core.filterAudioArgs(argv));
    const task = core.taskFromArgs(argv);
    if (task && win) win.webContents.send('task:run', task);
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });

  app.whenReady().then(async () => {
    applyContentSecurityPolicy();
    handleAppProtocol();
    handleSystemAudio();

    store = new Store(defaultRoot(app.getPath('userData')));
    await store.init();
    const conflicts = await store.sweepConflicts();

    const appSettingsEarly = await store.loadAppSettings();
    recordingsDir = appSettingsEarly.recordingsDir || defaultRecordingsDir();
    /* A lesson interrupted by the app closing leaves a file whose header says
       it is empty. The length is recoverable from the file itself. */
    const repaired = await repairUnfinished(recordingsDir);

    await createWindow();
    setJumpList();

    const appSettings = appSettingsEarly;
    const shortcutResult = registerShortcuts(appSettings.shortcuts ?? {}, (id) => {
      if (win) win.webContents.send('shortcut', id);
    });

    let openedFromArgv = false;
    const tellRenderer = () => {
      win.webContents.send('app:ready', {
        settingsRoot: store.root,
        oneDrive: detectOneDrive(),
        machine: store.machine,
        conflicts,
        repaired,
        recordingsDir,
        shortcutsTaken: shortcutResult.taken,
        version: app.getVersion(),
      });
      if (!openedFromArgv) {
        openedFromArgv = true;
        queueOpen(core.filterAudioArgs(process.argv));
      }
    };

    /* SEND IT NOW. createWindow() already awaited loadURL, and loadURL resolves
       when the page has finished loading — so by here the page is up and its
       script is listening.
     *
     * An earlier version checked isLoading() first and waited for
     * did-finish-load if it was true. That event had ALREADY fired, so the
     * listener never ran: no settings arrived, no library loaded, and a song
     * double-clicked in Explorer was silently dropped. The window looked
     * perfectly normal and did nothing, which is what "I couldn't get it to
     * play" looks like from the inside.
     *
     * It is also sent again after any later load, so that a page which reloads
     * gets its state back rather than coming up empty. */
    tellRenderer();
    win.webContents.on('did-finish-load', tellRenderer);
  }).catch((err) => {
    /* A failure anywhere in start-up used to leave a window that looked fine
       and did nothing at all: no song would open, no settings would load, and
       nothing said why. Now it says so, in the window and on the console. */
    console.error('Start-up failed:', err);
    const text = `The app did not finish starting up. ${err?.message ?? err}`;
    if (win && !win.isDestroyed()) {
      win.webContents.send('app:failed', text);
      win.webContents.executeJavaScript(
        `document.getElementById('msg') && (document.getElementById('msg').textContent = ${JSON.stringify(text)})`,
      ).catch(() => {});
    } else {
      dialog.showErrorBox('TVA Player', text);
    }
  });

  app.on('window-all-closed', () => app.quit());
  app.on('will-quit', () => { try { require('electron').globalShortcut.unregisterAll(); } catch {} });
}

/* ---- What the renderer may ask for -------------------------------------- */

ipcMain.handle('dialog:openSongs', async () => {
  const result = await dialog.showOpenDialog(win, {
    title: 'Open a song',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Audio', extensions: [...core.AUDIO_EXTENSIONS] }],
  });
  if (result.canceled) return [];
  await deliverOpen(result.filePaths);
  return result.filePaths;
});

ipcMain.handle('song:load', (_e, songKey) => store.loadSong(String(songKey)));
ipcMain.handle('song:save', (_e, songFile) => store.saveSong(songFile));
ipcMain.handle('song:list', () => store.listSongs());
ipcMain.handle('settings:load', () => store.loadAppSettings());
ipcMain.handle('settings:save', (_e, settings) => store.saveAppSettings(settings));
ipcMain.handle('defaults:open', () => openDefaultAppsSettings(app.getName()));
ipcMain.handle('defaults:read', () => readUserChoices());
ipcMain.handle('shortcuts:list', () => KEYS.map(({ id, label }) => ({ id, label })));
ipcMain.handle('folder:reveal', (_e, target) => shell.showItemInFolder(String(target)));


/* ---- The library -------------------------------------------------------- */

ipcMain.handle('library:addFolder', async () => {
  const result = await dialog.showOpenDialog(win, {
    title: 'Choose a folder of songs',
    properties: ['openDirectory'],
  });
  if (result.canceled || !result.filePaths[0]) return null;

  const settings = await store.loadAppSettings();
  const folders = Array.isArray(settings.folders) ? settings.folders : [];
  if (!folders.includes(result.filePaths[0])) folders.push(result.filePaths[0]);
  await store.saveAppSettings({ ...settings, folders });
  return result.filePaths[0];
});

ipcMain.handle('library:removeFolder', async (_e, folder) => {
  const settings = await store.loadAppSettings();
  const folders = (settings.folders ?? []).filter((f) => f !== folder);
  await store.saveAppSettings({ ...settings, folders });
  return folders;
});

ipcMain.handle('library:scan', async () => {
  const settings = await store.loadAppSettings();
  const folders = Array.isArray(settings.folders) ? settings.folders : [];
  const songs = [];
  for (const folder of folders) {
    for (const song of await scanFolder(folder)) {
      songs.push({ ...song, root: folder, url: encodePathForUrl(song.path) });
      allowedPaths.add(song.path);     // it is in a folder he pointed us at
    }
  }
  return { folders, songs };
});

/* Tags for the songs on screen only. Reading a tag opens the file, and a folder
   of two thousand songs should appear at once rather than after all of them
   have been opened. */
ipcMain.handle('library:tags', async (_e, paths) => {
  const wanted = (Array.isArray(paths) ? paths : []).slice(0, 200)
    .filter((p) => allowedPaths.has(p))
    .map((p) => ({ path: p, name: path.basename(p) }));
  const tags = await readTags(wanted);
  return tags.map((t) => ({ ...t, label: songLabel({ name: path.basename(t.path) }, t) }));
});

/* ---- Recording ---------------------------------------------------------- */

ipcMain.handle('record:start', async (_e, { name, sampleRate, channels }) => {
  if (recording) return { error: 'A recording is already running.' };
  recording = new Recording(recordingsDir, {
    name,
    sampleRate: Number(sampleRate) || 48000,
    channels: Number(channels) === 2 ? 2 : 1,
  });
  try {
    const filePath = await recording.open();
    return { path: filePath };
  } catch (err) {
    recording = null;
    return { error: `The recording could not be started. ${err.message}` };
  }
});

/* The samples arrive as a transferred ArrayBuffer, so nothing is copied on the
   way across and nothing accumulates on either side. */
ipcMain.on('record:chunk', async (_e, buffer) => {
  if (!recording) return;
  try { await recording.append(Buffer.from(buffer)); } catch { /* disk full, handled on stop */ }
});

ipcMain.handle('record:stop', async () => {
  if (!recording) return null;
  const done = await recording.finish();
  recording = null;
  if (done) allowedPaths.add(done.path);
  return done ? { ...done, url: encodePathForUrl(done.path) } : null;
});

ipcMain.handle('record:list', async () => {
  const takes = await listRecordings(recordingsDir);
  for (const take of takes) allowedPaths.add(take.path);
  return takes.map((t) => ({ ...t, url: encodePathForUrl(t.path) }));
});

ipcMain.handle('record:remove', async (_e, target) => {
  const takes = await listRecordings(recordingsDir);
  if (!takes.some((t) => t.path === target)) return false;
  await shell.trashItem(target);      // the recycle bin, not gone for good
  return true;
});

ipcMain.handle('record:saveMixed', async (_e, { suggestedName, bytes }) => {
  const result = await dialog.showSaveDialog(win, {
    title: 'Save the mixed file',
    defaultPath: path.join(recordingsDir, `${suggestedName ?? 'Mixed'}.wav`),
    filters: [{ name: 'WAV audio', extensions: ['wav'] }],
  });
  if (result.canceled || !result.filePath) return null;
  await fsp.writeFile(result.filePath, Buffer.from(bytes));
  allowedPaths.add(result.filePath);
  return result.filePath;
});

ipcMain.handle('record:folder', async () => {
  await shell.openPath(recordingsDir);
  return recordingsDir;
});
