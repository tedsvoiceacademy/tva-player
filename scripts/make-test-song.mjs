/* A song with known contents, so an end-to-end test can check what came out.
   Left side 440 Hz, right side 660 Hz — different on purpose, so the balance
   control and the lead-quieter tail can each be told apart by ear or by maths. */
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/* A REAL MP3, not a WAV with a different name.
 *
 * Every check up to now fed the app a generated WAV, and Ted then installed it
 * and could not get an MP3 to play at all. A WAV is decoded by a different path
 * inside the browser and streams differently, so testing only with one proved
 * nothing about the format he actually uses. This encodes properly, with a pure
 * JavaScript LAME port that is a development dependency only and never ships
 * inside the app. */
export async function makeMp3(path, opts = {}) {
  const { Mp3Encoder } = await import('@breezystack/lamejs');
  /* rightGain turns one side down, which is how a check can tell that the two
     halves of the waveform picture really come from the two channels and not
     from the same one drawn twice. */
  const {
    seconds = 6, sampleRate = 44100, left = 440, right = 660, shape = false, rightGain = 1,
  } = opts;
  const frames = Math.round(seconds * sampleRate);
  const l = new Int16Array(frames);
  const r = new Int16Array(frames);
  for (let i = 0; i < frames; i++) {
    const t = i / sampleRate;
    const env = shape
      ? 0.25 + 0.75 * Math.abs(Math.sin(t * 0.21)) * (0.55 + 0.45 * Math.abs(Math.sin(t * 1.7)))
      : 1;
    l[i] = Math.round(Math.sin(2 * Math.PI * left * t) * 0.4 * env * 32767);
    r[i] = Math.round(Math.sin(2 * Math.PI * right * t) * 0.4 * env * rightGain * 32767);
  }

  const encoder = new Mp3Encoder(2, sampleRate, 128);
  const chunks = [];
  const BLOCK = 1152;
  for (let i = 0; i < frames; i += BLOCK) {
    const buf = encoder.encodeBuffer(l.subarray(i, i + BLOCK), r.subarray(i, i + BLOCK));
    if (buf.length) chunks.push(Buffer.from(buf));
  }
  const tail = encoder.flush();
  if (tail.length) chunks.push(Buffer.from(tail));

  writeFileSync(path, Buffer.concat(chunks));
  return path;
}

export function makeSong(path, {
  seconds = 6, sampleRate = 48000, left = 440, right = 660, shape = false,
} = {}) {
  const frames = seconds * sampleRate;
  const data = Buffer.alloc(frames * 4);
  for (let i = 0; i < frames; i++) {
    /* `shape` gives the file the loud and quiet passages a real song has, so a
       picture of the waveform shows what a person would actually see. The
       checks leave it off: a steady tone is what lets the balance and
       lead-quieter measurements have an exact expected answer. */
    const t = i / sampleRate;
    const env = shape
      ? 0.25 + 0.75 * Math.abs(Math.sin(t * 0.21)) * (0.55 + 0.45 * Math.abs(Math.sin(t * 1.7)))
      : 1;
    const l = Math.sin(2 * Math.PI * left * i / sampleRate) * 0.4 * env;
    const r = Math.sin(2 * Math.PI * right * i / sampleRate) * 0.4 * env;
    data.writeInt16LE(Math.round(l * 32767), i * 4);
    data.writeInt16LE(Math.round(r * 32767), i * 4 + 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + data.length, 4); header.write('WAVE', 8);
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20);
  header.writeUInt16LE(2, 22); header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 4, 28); header.writeUInt16LE(4, 32);
  header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(data.length, 40);
  writeFileSync(path, Buffer.concat([header, data]));
  return path;
}

/* Writing a song from the command line, ONLY when this file is the program
   being run.
 *
 * This guard was missing, and it cost a whole afternoon. scripts/installed-
 * harness.mjs is given the path of the installed application, and it imports
 * this file — so the moment it did, this line wrote a test tone OVER
 * "TVA Player.exe". Windows then could not start the app, because the app was
 * no longer a program. Every symptom followed from that: "spawn UNKNOWN", an
 * app that started and vanished, an empty log. Three wrong explanations were
 * written down before the line "wrote C:\...\TVA Player.exe" in the output
 * turned out to be this. */
const runDirectly = process.argv[1]
  && pathToFileURL(process.argv[1]).href === import.meta.url;
if (runDirectly && process.argv[2]) {
  makeSong(process.argv[2]);
  console.log('wrote', process.argv[2]);
}
