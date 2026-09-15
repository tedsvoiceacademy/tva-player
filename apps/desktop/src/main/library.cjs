/* The songs Ted can browse, rather than hunt for in File Explorer.
 *
 * He points the app at a folder once and everything playable inside it is
 * listed, including anything he adds to that folder later. Nothing is copied
 * and nothing is moved — the list is only a way of finding files that are
 * already where he keeps them.
 */
const fsp = require('node:fs/promises');
const path = require('node:path');

const core = require('@tva/practice-core');

/** Deep enough for "Music/Artist/Album", and not so deep that one wrong folder
 *  choice walks an entire drive. */
const MAX_DEPTH = 6;
const MAX_SONGS = 20000;

async function scanFolder(root, { maxSongs = MAX_SONGS } = {}) {
  const found = [];

  async function walk(dir, depth) {
    if (depth > MAX_DEPTH || found.length >= maxSongs) return;
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (found.length >= maxSongs) return;
      if (entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { await walk(full, depth + 1); continue; }
      if (!entry.isFile() || !core.isAudioPath(entry.name)) continue;
      try {
        const stat = await fsp.stat(full);
        found.push({
          path: full,
          name: entry.name,
          folder: path.basename(dir),
          bytes: stat.size,
          songKey: core.songKey(entry.name, stat.size),
        });
      } catch { /* vanished mid-scan */ }
    }
  }

  await walk(root, 0);
  return found;
}

/* Titles and durations, read from the files' own tags.
 *
 * Done separately from the scan and only for what is on screen, because reading
 * a tag opens every file and a folder of two thousand songs should appear at
 * once rather than after all of them have been opened. */
async function readTags(songs) {
  const { parseFile } = await import('music-metadata');
  const out = [];
  for (const song of songs) {
    try {
      const meta = await parseFile(song.path, { duration: true, skipCovers: true });
      out.push({
        path: song.path,
        title: meta.common?.title || null,
        artist: meta.common?.artist || null,
        seconds: meta.format?.duration ?? null,
      });
    } catch {
      out.push({ path: song.path, title: null, artist: null, seconds: null });
    }
  }
  return out;
}

/** What a song should be called in the list: its tag if it has one, its file
 *  name if it does not. Never a path, which tells a person nothing. */
function songLabel(song, tag) {
  if (tag?.title) return tag.artist ? `${tag.title} — ${tag.artist}` : tag.title;
  return song.name.replace(/\.[a-z0-9]+$/i, '');
}

module.exports = { scanFolder, readTags, songLabel, MAX_DEPTH, MAX_SONGS };
