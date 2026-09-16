/* window.tva, on a phone.
 *
 * THE POINT OF THIS FILE IS THAT NOTHING ELSE CHANGES. The Windows app's
 * renderer only ever reaches the rest of the computer through window.tva —
 * thirty-odd named functions defined in the preload. So Android does not need a
 * second player: it needs a second implementation of that one list, and the
 * audio graph, the stretch engine, the worklets, the recorder, the export
 * worker and the practice maths are then the same files on both.
 *
 * Where a thing genuinely does not exist on a phone — a window to drag a file
 * into, the Windows default-apps panel, media keys — the function is still here
 * and answers honestly, rather than being missing and throwing.
 */
import { Capacitor, registerPlugin } from '../capacitor/core.js';
import { FilesWeb, TakesWeb, PlaybackWeb, webFileSrc } from './web-fallback.js';
import { songKey, songFileName } from '../practice-core.js';

/* The web implementation is not a stand-in for the phone; it is what runs when
   there is no phone. On Android these calls go to Files.java and Takes.java, and
   in a browser they go to the two objects in web-fallback.js — which is what
   makes the whole player drivable by the checks at 390 pixels. */
const native = () => Capacitor.isNativePlatform?.() ?? false;
/* CHOSEN NOW, not looked up later. Capacitor's proxy resolves a web plugin
   lazily, which puts an await between the press and the file picker — and
   Chromium refuses to open a file picker that is not inside the gesture that
   asked for it. The button would do nothing at all, silently, in a browser. */
const Files = native() ? registerPlugin('Files', { web: () => FilesWeb }) : FilesWeb;
const Takes = native() ? registerPlugin('Takes', { web: () => TakesWeb }) : TakesWeb;
const Playback = native() ? registerPlugin('Playback', { web: () => PlaybackWeb }) : PlaybackWeb;
const fileSrc = (path) => (native() ? Capacitor.convertFileSrc(path) : webFileSrc(path));

/* ---- what the app remembers ---------------------------------------------
 *
 * The Windows app keeps this in a folder inside OneDrive so two machines agree.
 * A phone has no such folder, so it goes in the WebView's own storage: it
 * survives closing the app and updating it, and it is the phone's own. Making
 * the phone and the desktop agree is a job of its own and is not pretended at
 * here — the app says where its settings live, the same as it does on Windows.
 */
const SETTINGS_KEY = 'tva.settings';
const SONGS_KEY = 'tva.songs';
/* Which folder, if any, is shared with the computer. Kept in the phone's own
   storage on purpose: a setting that says where the shared folder is cannot
   itself live in the shared folder. */
const SHARED_KEY = 'tva.sharedFolder';

function readJson(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key) ?? '') ?? fallback; } catch { return fallback; }
}
function writeJson(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage full */ }
}

/* ---- bytes ---------------------------------------------------------------
 *
 * Everything across the bridge is a string, so samples are base64 on the way
 * out and back. Done naively — one message per chunk — that is fifty messages a
 * second per microphone for the length of a lesson, each one encoded, parsed and
 * decoded. So chunks are GATHERED here and sent in lumps, which is the same
 * trade the MP3 encoder makes for the same reason.
 */
const LUMP_BYTES = 64 * 1024;
const LUMP_MS = 400;
const pending = new Map();      // key -> { parts: [Uint8Array], bytes, timer }

function toBase64(bytes) {
  let binary = '';
  const block = 0x8000;
  for (let i = 0; i < bytes.length; i += block) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + block));
  }
  return btoa(binary);
}

function fromBase64(text) {
  const binary = atob(text ?? '');
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

async function flushChunks(key) {
  const held = pending.get(key);
  if (!held || held.bytes === 0) return;
  clearTimeout(held.timer);
  const lump = new Uint8Array(held.bytes);
  let at = 0;
  for (const part of held.parts) { lump.set(part, at); at += part.length; }
  pending.delete(key);
  await Takes.chunk({ key, base64: toBase64(lump) });
}

async function flushAllChunks() {
  await Promise.all([...pending.keys()].map((key) => flushChunks(key)));
}

/* ---- the folder shared with the computer --------------------------------- */

function sharedFolder() {
  return readJson(SHARED_KEY, null);
}

async function readShared(path) {
  const folder = sharedFolder();
  if (!folder?.uri) return null;
  try {
    const got = await Files.readInTree({ tree: folder.uri, path });
    if (!got?.base64) return null;
    return JSON.parse(new TextDecoder().decode(fromBase64(got.base64)));
  } catch {
    /* The folder has gone — a phone signed out of OneDrive, a card pulled. The
       phone's own copy is used, and nothing is lost. */
    return null;
  }
}

async function writeShared(path, value) {
  const folder = sharedFolder();
  if (!folder?.uri || !folder.writable) return false;
  try {
    const bytes = new TextEncoder().encode(JSON.stringify(value, null, 2));
    const got = await Files.writeInTree({ tree: folder.uri, path, base64: toBase64(bytes) });
    return Boolean(got?.written);
  } catch { return false; }
}

/* ---- the songs the person has opened ------------------------------------- */

let songsOpenedHandler = () => {};

/* A song is a content:// URI rather than a path — see SongStream.java. Both are
   carried: `path` is what the rest of the app uses as a song's identity, and on
   Android that identity IS the URI. */
function asSong(entry, root) {
  return {
    path: entry.uri,
    name: entry.name,
    /* WHAT MAKES A SONG THE SAME SONG. Loops, notes and a speed are filed under
       this, and on Windows the main process works it out — so the phone has to
       work out the same one from the same two things, or a song set up on the
       desktop opens on the phone with none of it. Some providers report no size
       at all, and a song that never gets a size still gets a stable key from its
       name; it just will not match the desktop's. */
    songKey: songKey(entry.name ?? 'song', entry.size ?? 0),
    size: entry.size ?? 0,
    root: root ?? null,
    /* On the phone a song is served through SongStream, which is the only way a
       content:// URI or a file in Drive can reach an <audio src>. In a browser
       the picker has already handed back something playable. */
    url: entry.url ?? songUrl(entry.uri),
  };
}

function songUrl(uri) {
  /* The same encoding SongStream.urlFor writes, so the two cannot drift: URL-safe
     base64, no padding. */
  const bytes = new TextEncoder().encode(uri);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  const encoded = btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `https://localhost/_song/${encoded}`;
}

function rememberSongs(songs) {
  const known = readJson(SONGS_KEY, []);
  const byUri = new Map(known.map((s) => [s.path, s]));
  for (const song of songs) byUri.set(song.path, song);
  const all = [...byUri.values()].slice(-2000);
  writeJson(SONGS_KEY, all);
  return all;
}

/* ---- saving a take out ---------------------------------------------------
 *
 * Android's Save box asks for a name and a place, and takes the format from the
 * name it is given — there is no "Save as type" list in it the way there is on
 * Windows. So the format is chosen in the app first and the Save box is told
 * what to call the file. The rest of the export code is untouched: it still
 * opens something, writes lumps into it, and finishes or abandons it.
 */
const openExports = new Map();
let nextExportId = 1;

/* THE SHAPE OF A CALL IS PART OF THE CONTRACT, not just its name. The preload
   hands exportWrite two arguments and exportFinish one plain id; written here as
   objects they matched by name, returned nothing, and the saved file came out
   empty while every message on screen said it had worked. The check that
   compares the two surfaces now compares how many arguments each takes. */

const tva = {
  /* ---- songs ---- */
  openSongs() {
    /* Not async at the top: the picker has to be opened inside the press. */
    return Files.pickSongs().then((got) => {
      const songs = (got?.songs ?? []).map((s) => asSong(s));
      if (!songs.length) return [];
      rememberSongs(songs);
      songsOpenedHandler(songs);
      return songs.map((s) => s.path);
    });
  },
  onSongsOpened(handler) { songsOpenedHandler = handler; return () => { songsOpenedHandler = () => {}; }; },
  /* A phone has no window to drag a file into. Both still take what the
     preload's do, so the shape of the contract matches and not only the names. */
  pathForFile: (file) => (file ? '' : ''),
  openDropped: async (paths) => (paths ? 0 : 0),

  /* ---- what the app remembers about a song --------------------------------
   *
   * A song's loops, named parts, notes, speed and key. When a folder is shared
   * with the computer these are the SAME FILES the Windows app writes — one
   * small file per song, named after a hash of the song's key, worked out by
   * songFileName so both machines arrive at the same name.
   *
   * A copy is always kept on the phone as well. Not belt-and-braces: the shared
   * folder is in OneDrive, and a phone with no signal has to go on working. The
   * shared copy wins when it is there, because the other machine may have moved
   * something on since.
   */
  async loadSong(songKey) {
    const shared = await readShared(`songs/${await songFileName(songKey)}`);
    if (shared) return shared;
    return readJson(`tva.song.${songKey}`, null);
  },
  async saveSong(songFile) {
    if (!songFile?.songKey) return null;
    writeJson(`tva.song.${songFile.songKey}`, songFile);
    await writeShared(`songs/${await songFileName(songFile.songKey)}`, songFile);
    return songFile;
  },
  async listSongs() {
    const out = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith('tva.song.')) out.push(key.slice('tva.song.'.length));
    }
    return out;
  },

  /* ---- settings ---- */
  async loadSettings() { return readJson(SETTINGS_KEY, {}); },
  async saveSettings(settings) { writeJson(SETTINGS_KEY, settings ?? {}); return settings; },
  async revealFolder() { return false; },

  /* ---- things Windows has and a phone does not ---- */
  async openDefaultAppsSettings() { return false; },
  async readDefaultAppChoices() { return null; },
  async listShortcuts() { return []; },
  onShortcut() { return () => {}; },

  /* ---- the library ---- */
  async addFolder() {
    const got = await Files.pickFolder();
    if (!got?.folder) return null;
    const settings = await tva.loadSettings();
    const folders = Array.isArray(settings.folders) ? [...settings.folders] : [];
    if (!folders.some((f) => f.uri === got.folder.uri)) folders.push(got.folder);
    await tva.saveSettings({ ...settings, folders });
    return got.folder.name;
  },
  async removeFolder(folder) {
    const settings = await tva.loadSettings();
    const folders = (settings.folders ?? []).filter((f) => f.uri !== folder && f.name !== folder);
    await tva.saveSettings({ ...settings, folders });
    return folders;
  },
  async scanLibrary() {
    const settings = await tva.loadSettings();
    const folders = Array.isArray(settings.folders) ? settings.folders : [];
    const songs = [...readJson(SONGS_KEY, [])];
    const seen = new Set(songs.map((s) => s.path));
    for (const folder of folders) {
      const got = await Files.scanFolder({ uri: folder.uri }).catch(() => null);
      for (const entry of got?.songs ?? []) {
        if (seen.has(entry.uri)) continue;
        seen.add(entry.uri);
        songs.push(asSong(entry, folder.uri));
      }
    }
    return { folders: folders.map((f) => f.name ?? f.uri), songs };
  },
  /* Reading a tag means opening the file, and on a phone that can mean reaching
     across to Drive for every song in a list. The name is what is shown. */
  async readTags(paths) {
    const songs = readJson(SONGS_KEY, []);
    return (paths ?? []).map((path) => {
      const song = songs.find((s) => s.path === path);
      return { path, label: song?.name ?? path };
    });
  },

  /* ---- recording ---- */
  async startRecording({ name, sampleRate, tracks }) {
    pending.clear();
    const got = await Takes.start({ name, sampleRate, tracks }).catch((err) => ({ error: String(err?.message ?? err) }));
    if (got?.error) return { error: got.error };
    const paths = got?.paths ?? {};
    return { paths, path: Object.values(paths)[0] ?? null };
  },
  sendChunk(key, buffer) {
    const bytes = new Uint8Array(buffer);
    let held = pending.get(key);
    if (!held) { held = { parts: [], bytes: 0, timer: null }; pending.set(key, held); }
    held.parts.push(bytes);
    held.bytes += bytes.length;
    if (held.bytes >= LUMP_BYTES) { flushChunks(key); return; }
    if (!held.timer) held.timer = setTimeout(() => flushChunks(key), LUMP_MS);
  },
  async stopRecording() {
    await flushAllChunks();
    const got = await Takes.stop();
    const takes = (got?.takes ?? []).map((t) => ({ ...t, url: fileSrc(t.path) }));
    if (!takes.length) return null;
    return { ...takes[0], takes };
  },
  async listRecordings() {
    const got = await Takes.list();
    return (got?.takes ?? []).map((t) => ({ ...t, url: fileSrc(t.path) }));
  },
  async removeRecording(path) {
    const got = await Takes.remove({ path });
    return Boolean(got?.removed);
  },
  async openRecordingsFolder() {
    const got = await Takes.folderPath();
    return got?.path ?? '';
  },

  /* ---- saving a take out ---- */
  async exportFormats() { return ['mp3', 'wav']; },
  async exportPick({ suggestedName, format = 'mp3' } = {}) {
    const mime = format === 'wav' ? 'audio/wav' : 'audio/mpeg';
    const name = `${String(suggestedName ?? 'Take').replace(/[\\/:*?"<>|]/g, '')}.${format}`;
    const got = await Files.createDocument({ name, mime });
    if (!got?.uri) return null;
    return { filePath: got.uri, format };
  },
  async exportCopy({ from, to }) {
    try {
      await Files.truncateDocument({ uri: to });
      let at = 0;
      for (;;) {
        const part = await Takes.readRange({ path: from, start: at, length: 512 * 1024 });
        const bytes = fromBase64(part?.base64 ?? '');
        if (!bytes.length) break;
        await Files.appendToDocument({ uri: to, base64: part.base64 });
        at += bytes.length;
        if (bytes.length < 512 * 1024) break;
      }
      return { path: to };
    } catch (err) {
      return { error: `That could not be saved. ${err?.message ?? err}` };
    }
  },
  async exportOpen({ filePath }) {
    try {
      /* Android's Save box may have been pointed at a file that already exists,
         and appending to it would make nonsense of both. */
      await Files.truncateDocument({ uri: filePath });
      const id = nextExportId++;
      openExports.set(id, { filePath, bytes: 0 });
      return { id };
    } catch (err) {
      return { error: `That file could not be opened for writing. ${err?.message ?? err}` };
    }
  },
  async exportWrite(id, bytes) {
    const job = openExports.get(id);
    if (!job) return false;
    try {
      await Files.appendToDocument({ uri: job.filePath, base64: toBase64(new Uint8Array(bytes)) });
      job.bytes += bytes.length ?? 0;
      return true;
    } catch { return false; }
  },
  async exportFinish(id) {
    const job = openExports.get(id);
    if (!job) return null;
    openExports.delete(id);
    return { path: job.filePath, bytes: job.bytes };
  },
  async exportAbort(id) {
    const job = openExports.get(id);
    if (!job) return false;
    openExports.delete(id);
    await Files.deleteDocument({ uri: job.filePath }).catch(() => {});
    return true;
  },

  /* ---- what is playing, told to the phone ----------------------------------
   *
   * A page is something Android is entitled to freeze when it is not on the
   * screen, so pressing the power button mid-practice stopped the song. These
   * are the moments the phone has to be told about; PlaybackService says what it
   * does with them. They also put the song on the lock screen and give the pause
   * button on a pair of headphones something to talk to.
   */
  async nowPlaying(info) {
    const answer = info?.playing === false
      ? await Playback.paused(info ?? {})
      : await Playback.playing(info ?? {});
    return answer ?? {};
  },
  async playbackStopped() { await Playback.stopped(); },
  onPlaybackCommand(handler) {
    const held = Playback.addListener('command', (event) => handler(event?.action ?? ''));
    return () => { held?.remove?.(); };
  },
  async canKeepPlaying() {
    const answer = await Playback.canKeepPlaying();
    return Boolean(answer?.canKeepPlaying);
  },

  /* ---- sharing with the computer ---- */
  sharedFolder: () => sharedFolder(),
  async shareWithComputer() {
    const got = await Files.pickFolder();
    if (!got?.folder) {
      return { error: got?.unsupported
        ? 'This is not something a browser can remember. It works in the app on the phone.'
        : 'No folder was chosen.' };
    }
    /* ASKED, NOT ASSUMED. Not every provider gives a folder that can be written
       to, and one that cannot would take every part he marks and drop it. */
    const probe = await Files.canWriteTree({ tree: got.folder.uri });
    const folder = { ...got.folder, writable: Boolean(probe?.writable) };
    writeJson(SHARED_KEY, folder);
    return folder;
  },
  async stopSharing() {
    try { localStorage.removeItem(SHARED_KEY); } catch { /* nothing to remove */ }
    return true;
  },

  /* ---- start-up ---- */
  onReady(handler) {
    /* The Windows app is told what it was launched with. A phone is launched
       with nothing, so this fires once with what it already knows about. */
    setTimeout(async () => handler({
      version: '0.1.0',
      settingsRoot: 'this phone',
      recordingsDir: await tva.openRecordingsFolder(),
      songs: readJson(SONGS_KEY, []),
    }), 0);
    return () => {};
  },
  onTask() { return () => {}; },
};

/* The preload's own contract, taken literally: every name it defines exists
   here, and a missing one is a fault rather than a silent undefined. */
export const TVA_API_NAMES = Object.keys(tva);
window.tva = tva;

/* ---- the one piece of furniture that moves --------------------------------
 *
 * The song list is a column beside the case on Windows, and the stylesheet
 * already hides that column below 900 pixels — which on a phone left the list
 * unreachable rather than merely out of the way. So the SAME element is moved
 * into its own tab. Moved, not rebuilt: every button in it is still wired by
 * app.js, because it is still the element app.js wired.
 *
 * It runs before app.js because module scripts run in the order they appear,
 * and app.js reaches into the rail while it is starting up. */
if (document.documentElement.dataset.platform === 'android') {
  const rail = document.querySelector('.rail');
  const songsHost = document.getElementById('songs-host');
  if (rail && songsHost) songsHost.append(rail);

  /* The same again for the three sound switches. Two hundred pixels of the case
     on a screen that has eight hundred and forty, and every one of them is a
     thing you set and leave. */
  const switches = document.querySelector('.switches');
  const soundHost = document.getElementById('sound-host');
  if (switches && soundHost) soundHost.append(switches);

  /* The two buttons that choose the shared folder are wired here rather than in
     app.js, because they are the one part of Set-up that only exists on a phone.
     This module is deferred, like every module script, so the page is already
     parsed by the time it runs. */
  wireSharing();
}

function wireSharing() {
  const pick = document.getElementById('share-pick');
  const stop = document.getElementById('share-stop');
  const state = document.getElementById('share-state');
  if (!pick || !stop || !state) return;

  const paint = () => {
    const folder = sharedFolder();
    stop.hidden = !folder;
    pick.textContent = folder ? 'Choose a different folder' : 'Choose that folder';
    if (!folder) {
      state.textContent = 'Right now the phone keeps its own. Parts you mark here stay here.';
      return;
    }
    state.textContent = folder.writable
      ? `Sharing with “${folder.name}”. Parts you mark on either machine are on both.`
      : `“${folder.name}” can be read but not written to, so parts marked on the phone `
        + 'stay on the phone. Choosing the folder itself rather than something above it '
        + 'usually fixes this.';
  };

  pick.addEventListener('click', async () => {
    pick.disabled = true;
    try {
      const got = await tva.shareWithComputer();
      state.textContent = got?.error ?? '';
      if (!got?.error) paint();
    } finally { pick.disabled = false; }
  });

  stop.addEventListener('click', async () => {
    await tva.stopSharing();
    paint();
  });

  paint();
}

export default tva;
