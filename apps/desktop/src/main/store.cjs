/* Where the app keeps what it remembers, and how two machines share it.
 *
 * Replaces the Supabase table the members site uses. One file per song, not one
 * database, for a reason that is entirely about OneDrive: a single database file
 * edited on a laptop and a desktop is a conflict copy waiting to happen, while a
 * folder of small files keyed on the song almost never collides. It is also
 * plain text he can open, and repairable if it ever goes wrong.
 *
 * Every write is atomic — write a temporary file, flush it, rename it over the
 * old one — so a file half-written when the machine sleeps is never left behind.
 */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const core = require('@tva/practice-core');

const APP_FOLDER = "Ted's Voice Academy";
const SETTINGS_FOLDER = 'Player Settings';

/* OneDrive sets these itself when it is installed and signed in. Preferring the
   personal one matches the folder Ted already works out of. */
function detectOneDrive() {
  for (const key of ['OneDriveConsumer', 'OneDrive', 'OneDriveCommercial']) {
    const value = process.env[key];
    if (value && fs.existsSync(value)) return value;
  }
  return null;
}

/** Where settings live by default, and why. Shown to him in Settings as a real
 *  path, never hidden — he should be able to find these files himself. */
function defaultRoot(appDataPath) {
  const oneDrive = detectOneDrive();
  if (oneDrive) return path.join(oneDrive, APP_FOLDER, SETTINGS_FOLDER);
  return path.join(appDataPath, SETTINGS_FOLDER);
}

/** The machine's own name, so a conflict notice can say which one wrote what. */
function machineName() {
  return String(os.hostname() || 'this computer').slice(0, 60);
}

/* A song key can contain anything a file name can, including characters Windows
   will not put in a path, so the file is named after a hash of it. The key
   itself is stored inside the file, which is what a conflict sweep reads. */
function fileNameForKey(songKey) {
  return crypto.createHash('sha256').update(songKey).digest('hex').slice(0, 32) + '.json';
}

class Store {
  constructor(root) {
    this.root = root;
    this.songsDir = path.join(root, 'songs');
    this.playlistsDir = path.join(root, 'playlists');
    this.machine = machineName();
  }

  async init() {
    await fsp.mkdir(this.songsDir, { recursive: true });
    await fsp.mkdir(this.playlistsDir, { recursive: true });
  }

  async writeAtomic(filePath, text) {
    const tmp = `${filePath}.${process.pid}.tmp`;
    const handle = await fsp.open(tmp, 'w');
    try {
      await handle.writeFile(text, 'utf8');
      await handle.sync();            // on disk, not just in the cache
    } finally {
      await handle.close();
    }
    await fsp.rename(tmp, filePath);  // the swap itself cannot half-happen
  }

  async readJson(filePath) {
    try {
      return JSON.parse(await fsp.readFile(filePath, 'utf8'));
    } catch {
      return null;                    // missing, or half-synced; the caller decides
    }
  }

  async loadSong(songKey) {
    const raw = await this.readJson(path.join(this.songsDir, fileNameForKey(songKey)));
    return core.sanitizeSongFile(raw, this.machine);
  }

  async saveSong(songFile) {
    const clean = core.sanitizeSongFile(
      { ...songFile, updatedAt: new Date().toISOString(), updatedBy: this.machine },
      this.machine,
    );
    if (!clean) return null;
    await this.writeAtomic(path.join(this.songsDir, fileNameForKey(clean.songKey)),
      JSON.stringify(clean, null, 2));
    return clean;
  }

  async listSongs(limit = 500) {
    let names = [];
    try { names = await fsp.readdir(this.songsDir); } catch { return []; }
    const out = [];
    for (const name of names) {
      if (!name.endsWith('.json') || name.includes('.conflict-')) continue;
      const file = core.sanitizeSongFile(
        await this.readJson(path.join(this.songsDir, name)), this.machine);
      if (file) out.push({ songKey: file.songKey, songName: file.songName, updatedAt: file.updatedAt });
      if (out.length >= limit) break;
    }
    return out.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  }

  /* OneDrive resolves a clash by keeping both, naming the loser after the
     machine that wrote it: "abc-DESKTOP-TED.json". Sweep those on startup, keep
     whichever was written last, and set the other aside rather than deleting it.
     Whole-file, never field by field — one person editing on two machines in
     sequence does not need anything cleverer, and a merge that invents a state
     neither machine ever had would be worse than losing the older edit. */
  async sweepConflicts() {
    let names = [];
    try { names = await fsp.readdir(this.songsDir); } catch { return []; }

    const resolved = [];
    for (const name of names) {
      const match = /^([0-9a-f]{32})-(.+)\.json$/.exec(name);
      if (!match) continue;
      const canonical = `${match[1]}.json`;
      if (!names.includes(canonical)) {
        await fsp.rename(path.join(this.songsDir, name), path.join(this.songsDir, canonical));
        resolved.push({ songName: canonical, keptFrom: match[2], note: 'no other copy existed' });
        continue;
      }
      const mine = core.sanitizeSongFile(
        await this.readJson(path.join(this.songsDir, canonical)), this.machine);
      const theirs = core.sanitizeSongFile(
        await this.readJson(path.join(this.songsDir, name)), this.machine);
      if (!theirs) { await fsp.unlink(path.join(this.songsDir, name)); continue; }

      const winner = mine ? core.newerOf(mine, theirs) : theirs;
      await this.writeAtomic(path.join(this.songsDir, canonical), JSON.stringify(winner, null, 2));
      const stamp = new Date().toISOString().slice(0, 10);
      await fsp.rename(path.join(this.songsDir, name),
        path.join(this.songsDir, `${match[1]}.conflict-${stamp}.json`));
      resolved.push({ songName: winner.songName, keptFrom: winner.updatedBy });
    }
    return resolved;
  }

  async loadAppSettings() {
    return (await this.readJson(path.join(this.root, 'settings.json'))) ?? {};
  }

  async saveAppSettings(settings) {
    await this.writeAtomic(path.join(this.root, 'settings.json'),
      JSON.stringify(settings ?? {}, null, 2));
  }
}

module.exports = { Store, defaultRoot, detectOneDrive, machineName, fileNameForKey };
