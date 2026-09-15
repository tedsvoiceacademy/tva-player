/* Recordings, written to disk as they arrive.
 *
 * A lesson is not eight seconds. An hour of mono at 48 kHz is about 690 MB held
 * as Float32, so nothing is kept in memory: the worklet posts each chunk, the
 * renderer turns it into 16-bit samples, and this appends it to an open file.
 *
 * THE HEADER IS WRITTEN LAST, because a WAV header states its own length and
 * the length is not known until the recording stops. That leaves one hazard —
 * an app closed mid-lesson leaves a file whose header says zero — so the length
 * is recoverable from the file's own size, and repair() does exactly that on
 * the next start. A lesson is never lost because the app was closed.
 */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const core = require('@tva/practice-core');

/** Where takes live. Deliberately NOT inside OneDrive: a 350 MB lesson should
 *  not sync itself anywhere without being asked. */
function defaultRecordingsDir() {
  return path.join(os.homedir(), 'Music', 'TVA Player Recordings');
}

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
    + ` ${p(d.getHours())}.${p(d.getMinutes())}.${p(d.getSeconds())}`;
}

/** A name that is safe on Windows and still readable. */
function safeName(name) {
  return String(name ?? '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '').trim().slice(0, 80);
}

class Recording {
  constructor(dir, { name, sampleRate, channels }) {
    this.dir = dir;
    this.sampleRate = sampleRate;
    this.channels = channels;
    const base = safeName(name) || 'Recording';
    this.filePath = path.join(dir, `${base} ${stamp()}.wav`);
    this.handle = null;
    this.dataBytes = 0;
    /* Writes are chained rather than fired off in parallel. See append(). */
    this.queue = Promise.resolve();
  }

  async open() {
    await fsp.mkdir(this.dir, { recursive: true });
    this.handle = await fsp.open(this.filePath, 'w');
    // A placeholder header, so the audio can start at the right offset.
    await this.handle.write(core.wavHeader(this.sampleRate, this.channels, 0), 0, 44, 0);
    return this.filePath;
  }

  /* Append a chunk of samples.
   *
   * THE PLACE IN THE FILE IS CLAIMED BEFORE ANYTHING IS AWAITED. Chunks arrive
   * about every twenty milliseconds and the write is slower than that, so an
   * earlier version — which read the length, awaited the write, and only then
   * advanced it — had several chunks computing the SAME position and writing
   * over each other. The file came out the right length and the right shape,
   * and the audio inside it was mangled: measured against a steady 440 Hz tone
   * played into the microphone, the take had no pitch at all. A lesson would
   * have recorded to nonsense.
   *
   * The writes are also chained, so two of them are never in flight against the
   * same file handle at once. */
  async append(buffer) {
    if (!this.handle) return;
    const at = core.WAV_HEADER_BYTES + this.dataBytes;
    this.dataBytes += buffer.length;
    const handle = this.handle;
    this.queue = this.queue.then(() => handle.write(buffer, 0, buffer.length, at));
    return this.queue;
  }

  async finish() {
    if (!this.handle) return null;
    // Everything queued must be on disk before the header states the length.
    await this.queue.catch(() => {});
    const header = core.wavHeader(this.sampleRate, this.channels, this.dataBytes);
    await this.handle.write(header, 0, 44, 0);
    await this.handle.sync();
    await this.handle.close();
    this.handle = null;
    return {
      path: this.filePath,
      bytes: core.WAV_HEADER_BYTES + this.dataBytes,
      seconds: this.dataBytes / (this.sampleRate * this.channels * 2),
    };
  }

  get seconds() {
    return this.dataBytes / (this.sampleRate * this.channels * 2);
  }
}

/* Any recording left behind by an app that was closed while it was running.
 * Its header says zero bytes, so no player will open it; the real length is the
 * file's own size, which is all it takes to put right. */
async function repairUnfinished(dir) {
  let names = [];
  try { names = await fsp.readdir(dir); } catch { return []; }

  const fixed = [];
  for (const name of names) {
    if (!name.toLowerCase().endsWith('.wav')) continue;
    const full = path.join(dir, name);
    try {
      const stat = await fsp.stat(full);
      if (stat.size <= core.WAV_HEADER_BYTES) continue;

      const handle = await fsp.open(full, 'r+');
      const head = Buffer.alloc(core.WAV_HEADER_BYTES);
      await handle.read(head, 0, core.WAV_HEADER_BYTES, 0);

      if (!core.looksLikeWav(head)) { await handle.close(); continue; }
      const stated = head.readUInt32LE(40);
      const channels = head.readUInt16LE(22) || 1;
      const real = core.dataBytesForFileSize(stat.size, channels);

      if (stated === 0 || stated > real) {
        await handle.write(core.patchWavHeaderSizes(head, real), 0, core.WAV_HEADER_BYTES, 0);
        fixed.push({ path: full, seconds: real / (head.readUInt32LE(24) * channels * 2) });
      }
      await handle.close();
    } catch { /* a file being written by something else; leave it alone */ }
  }
  return fixed;
}

async function listRecordings(dir) {
  let names = [];
  try { names = await fsp.readdir(dir); } catch { return []; }
  const out = [];
  for (const name of names) {
    if (!name.toLowerCase().endsWith('.wav')) continue;
    try {
      const stat = await fsp.stat(path.join(dir, name));
      out.push({
        name: name.replace(/\.wav$/i, ''),
        path: path.join(dir, name),
        bytes: stat.size,
        madeAt: stat.mtime.toISOString(),
      });
    } catch { /* gone between listing and asking */ }
  }
  return out.sort((a, b) => Date.parse(b.madeAt) - Date.parse(a.madeAt));
}

module.exports = {
  Recording, defaultRecordingsDir, repairUnfinished, listRecordings, safeName,
};
