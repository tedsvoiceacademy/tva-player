/* The same two plugins, when there is no phone underneath.
 *
 * WHY THIS EXISTS AT ALL: an APK cannot be driven by the checks. There is no
 * interface to plug in, no emulator on a build runner, and nothing that can read
 * back what a take sounds like. So the phone build is written to run in a plain
 * browser as well — Files and Takes answered out of the browser's own file
 * picker and its own memory — and everything above them, which is the whole of
 * the player, is then measured at 390 pixels the same way the Windows app is
 * measured at 1180.
 *
 * It is not a pretend implementation of a phone. It is the smallest honest
 * version of the same two jobs: choose a file, and write a recording somewhere
 * it can be read back from. What it cannot do — reaching into Drive, keeping
 * permission to a folder between runs — it says so rather than faking.
 */
const files = new Map();        // uri -> Blob
const takes = new Map();        // path -> { parts, sampleRate, channels, name, madeAt }
const openTakes = new Map();    // key -> path
const documents = new Map();    // uri -> Uint8Array[]

let nextId = 1;

function blobUrl(blob) { return URL.createObjectURL(blob); }

async function bytesOf(blob, start, length) {
  const slice = blob.slice(start, start + length);
  return new Uint8Array(await slice.arrayBuffer());
}

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

function wavHeaderBytes(sampleRate, channels, dataBytes) {
  const bytes = new ArrayBuffer(44);
  const view = new DataView(bytes);
  const write = (at, text) => { for (let i = 0; i < text.length; i++) view.setUint8(at + i, text.charCodeAt(i)); };
  const perFrame = channels * 2;
  write(0, 'RIFF'); view.setUint32(4, 36 + dataBytes, true); write(8, 'WAVE');
  write(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, channels, true); view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * perFrame, true); view.setUint16(32, perFrame, true);
  view.setUint16(34, 16, true); write(36, 'data'); view.setUint32(40, dataBytes, true);
  return new Uint8Array(bytes);
}

export const FilesWeb = {
  async pickSongs() {
    const chosen = await askForFiles(true, 'audio/*');
    const songs = chosen.map((file) => {
      const uri = blobUrl(file);
      files.set(uri, file);
      return { uri, name: file.name, size: file.size, url: uri };
    });
    return { songs };
  },
  /* A browser can be handed a folder, but it cannot be asked to remember one —
     so this says so instead of appearing to work and then losing it. */
  async pickFolder() { return { folder: null, unsupported: true }; },
  async scanFolder() { return { songs: [] }; },
  async describeUri({ uri }) {
    const file = files.get(uri);
    return { uri, name: file?.name ?? 'Song', size: file?.size ?? 0 };
  },
  async readRange({ uri, start = 0, length = 65536 }) {
    const file = files.get(uri) ?? documentBlob(uri) ?? takeBlob(uri);
    if (!file) return { base64: '' };
    return { base64: toBase64(await bytesOf(file, start, length)) };
  },
  async createDocument({ name }) {
    const uri = `doc:${nextId++}:${name}`;
    documents.set(uri, []);
    return { uri };
  },
  async appendToDocument({ uri, base64 }) {
    const held = documents.get(uri);
    if (held) held.push(fromBase64(base64));
  },
  async truncateDocument({ uri }) { documents.set(uri, []); },
  async deleteDocument({ uri }) { documents.delete(uri); },
};

function documentBlob(uri) {
  const parts = documents.get(uri);
  return parts ? new Blob(parts) : null;
}

function takeBlob(pathOrUrl) {
  const take = takes.get(pathOrUrl);
  if (!take) return null;
  const dataBytes = take.parts.reduce((n, p) => n + p.length, 0);
  return new Blob([wavHeaderBytes(take.sampleRate, take.channels, dataBytes), ...take.parts]);
}

export const TakesWeb = {
  async folderPath() { return { path: 'this browser' }; },
  async start({ name, sampleRate, tracks }) {
    openTakes.clear();
    const paths = {};
    const madeAt = new Date().toISOString();
    for (const track of tracks ?? [{ key: 'mic1', suffix: '' }]) {
      const path = `take:${nextId++}`;
      takes.set(path, {
        parts: [], sampleRate: sampleRate || 48000,
        channels: Number(track.channels) === 2 ? 2 : 1,
        name: `${name}${track.suffix ?? ''}`, madeAt,
      });
      openTakes.set(track.key, path);
      paths[track.key] = path;
    }
    return { paths };
  },
  async chunk({ key, base64 }) {
    const take = takes.get(openTakes.get(key));
    if (take) take.parts.push(fromBase64(base64));
  },
  async stop() {
    const done = [];
    for (const path of openTakes.values()) {
      const take = takes.get(path);
      if (!take) continue;
      const dataBytes = take.parts.reduce((n, p) => n + p.length, 0);
      done.push({
        path, bytes: 44 + dataBytes,
        seconds: dataBytes / (take.sampleRate * take.channels * 2),
      });
    }
    openTakes.clear();
    return { takes: done };
  },
  async list() {
    const out = [];
    for (const [path, take] of takes) {
      const dataBytes = take.parts.reduce((n, p) => n + p.length, 0);
      out.push({ name: take.name, path, bytes: 44 + dataBytes, madeAt: take.madeAt });
    }
    out.sort((a, b) => Date.parse(b.madeAt) - Date.parse(a.madeAt));
    return { takes: out };
  },
  async remove({ path }) { return { removed: takes.delete(path) }; },
  async readRange({ path, start = 0, length = 65536 }) {
    const blob = takeBlob(path);
    if (!blob) return { base64: '' };
    return { base64: toBase64(await bytesOf(blob, start, length)) };
  },
};

/* A take has no path a browser can fetch, so one is made for it on demand. The
   Android build uses Capacitor.convertFileSrc for the same job. */
export function webFileSrc(path) {
  const blob = takeBlob(path) ?? documentBlob(path);
  return blob ? blobUrl(blob) : path;
}

function askForFiles(multiple, accept) {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = multiple;
    input.accept = accept;
    input.style.position = 'fixed';
    input.style.left = '-9999px';
    document.body.append(input);
    input.addEventListener('change', () => {
      const chosen = [...(input.files ?? [])];
      input.remove();
      resolve(chosen);
    }, { once: true });
    /* The checks drive this directly with setInputFiles, so it has to be in the
       document and findable rather than clicked and forgotten. */
    input.dataset.tvaPicker = 'songs';
    input.click();
  });
}
