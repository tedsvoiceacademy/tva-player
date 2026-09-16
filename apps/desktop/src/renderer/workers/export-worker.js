/* Turning samples into a file, off the main thread.
 *
 * WHY A WORKER AT ALL. MP3 encoding is the slowest thing this app does — a
 * forty-five minute lesson is tens of seconds of solid arithmetic. On the page's
 * own thread that is a frozen window: no clock, no meter, no cancel, and a
 * progress number that cannot paint itself. Here the page stays alive and keeps
 * counting while this grinds.
 *
 * WHAT IT DOES NOT DO: decoding. decodeAudioData does not exist in a worker, so
 * the page decodes and mixes and this only encodes. That split also puts the
 * fast half (native decoding) where it belongs and the slow half here.
 *
 * Samples arrive as INTERLEAVED 16-bit, which is what a WAV file already is and
 * what a take on disk already holds — so the WAV path copies them through
 * untouched and only the MP3 path pays to pull the channels apart.
 */
import { wavHeader } from '../practice-core.js';
import { Mp3Encoder } from '../vendor/lamejs.mjs';

/* LAME reads 1152 frames per channel at a time. Slices do not arrive on that
   boundary, so whatever is left over waits here for the next one. */
const LAME_BLOCK = 1152;

let job = null;

/* Encoded bytes leave in lumps rather than as they are produced.
 *
 * LAME hands back about 400 bytes per block and a block is 24 milliseconds, so
 * a forty-five minute lesson would otherwise be a hundred thousand separate
 * writes, each one a message to the other process and back. Gathered into
 * quarter-megabyte lumps it is a few hundred. */
const LUMP_BYTES = 256 * 1024;
let pending = [];
let pendingBytes = 0;

function flushOut() {
  if (pendingBytes === 0) return;
  const out = new Uint8Array(pendingBytes);
  let at = 0;
  for (const part of pending) { out.set(part, at); at += part.length; }
  pending = [];
  pendingBytes = 0;
  self.postMessage({ type: 'bytes', bytes: out }, [out.buffer]);
}

function send(bytes) {
  if (!bytes || bytes.length === 0) return;
  pending.push(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
  pendingBytes += bytes.length;
  if (pendingBytes >= LUMP_BYTES) flushOut();
}

function beginWav({ sampleRate, channels, totalFrames }) {
  /* Unlike a recording, an export knows its own length before the first sample,
     so the header goes on the front with the real numbers in it and never has
     to be gone back to. */
  send(wavHeader(sampleRate, channels, totalFrames * channels * 2));
  return {
    push(samples) { send(new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength)); },
    end() {},
  };
}

function beginMp3({ sampleRate, channels, kbps }) {
  const encoder = new Mp3Encoder(channels, sampleRate, kbps);
  const left = new Int16Array(LAME_BLOCK);
  const right = new Int16Array(LAME_BLOCK);
  let held = 0;                         // frames waiting in left/right

  const flushBlock = () => {
    const out = channels === 2
      ? encoder.encodeBuffer(left.subarray(0, held), right.subarray(0, held))
      : encoder.encodeBuffer(left.subarray(0, held));
    held = 0;
    send(out);
  };

  return {
    push(samples) {
      const frames = samples.length / channels;
      for (let f = 0; f < frames; f++) {
        left[held] = samples[f * channels] ?? 0;
        if (channels === 2) right[held] = samples[f * channels + 1] ?? 0;
        held++;
        if (held === LAME_BLOCK) flushBlock();
      }
    },
    end() {
      if (held > 0) flushBlock();
      send(encoder.flush());
    },
  };
}

self.onmessage = (event) => {
  const message = event.data;
  try {
    if (message.type === 'begin') {
      pending = []; pendingBytes = 0;
      job = message.format === 'mp3' ? beginMp3(message) : beginWav(message);
      return;
    }
    if (message.type === 'pcm') {
      if (job) job.push(message.samples);
      return;
    }
    if (message.type === 'end') {
      if (job) job.end();
      job = null;
      flushOut();
      self.postMessage({ type: 'done' });
    }
  } catch (err) {
    job = null;
    self.postMessage({ type: 'error', message: String(err?.message ?? err) });
  }
};
