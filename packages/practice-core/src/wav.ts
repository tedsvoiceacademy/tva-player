/* Writing a WAV file, in the pieces a long recording needs.
 *
 * PORTED from ring-meter/src/audio/wav.ts, and changed in two ways that matter.
 *
 * 1. IT NO LONGER RETURNS A FINISHED FILE. The Ring Meter grabs eight seconds
 *    and hands back a Blob. A lesson is forty-five minutes: an hour of mono at
 *    48 kHz is about 690 MB held as Float32, which is not something to keep in
 *    memory while it is being recorded. So this file gives out a header and a
 *    sample converter, and the recording is appended to an open file on disk as
 *    it arrives. The header's two length fields are written last, when the
 *    length is finally known.
 *
 * 2. IT HANDLES STEREO. The Ring Meter only ever records one microphone.
 *
 * Still uncompressed 16-bit PCM on purpose, for the reason the original gives:
 * a compressed format is a second thing to rule out when something sounds wrong.
 */

export const WAV_HEADER_BYTES = 44;

/* Build the 44 bytes that go at the front of the file. `dataBytes` may be 0
   while a recording is still running — patchWavHeaderSizes fills it in at the
   end, and repairs a file whose app was killed before it got there. */
export function wavHeader(sampleRate: number, channels: number, dataBytes = 0): Uint8Array {
  const bytes = new ArrayBuffer(WAV_HEADER_BYTES);
  const view = new DataView(bytes);
  const write = (at: number, text: string): void => {
    for (let i = 0; i < text.length; i++) view.setUint8(at + i, text.charCodeAt(i));
  };
  const bytesPerFrame = channels * 2;

  write(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  write(8, 'WAVE');
  write(12, 'fmt ');
  view.setUint32(16, 16, true);                      // PCM header size
  view.setUint16(20, 1, true);                       // PCM, no compression
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * bytesPerFrame, true); // byte rate
  view.setUint16(32, bytesPerFrame, true);           // block align
  view.setUint16(34, 16, true);                      // bits per sample
  write(36, 'data');
  view.setUint32(40, dataBytes, true);
  return new Uint8Array(bytes);
}

/* Write the two length fields into an existing header. Used when a recording
   stops, and again on startup for any file left behind by a crash — the length
   can always be recovered from the file's own size, so a killed recording is
   never a lost one. */
export function patchWavHeaderSizes(header: Uint8Array, dataBytes: number): Uint8Array {
  const out = header.slice(0, WAV_HEADER_BYTES);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  view.setUint32(4, 36 + dataBytes, true);
  view.setUint32(40, dataBytes, true);
  return out;
}

/** How many whole frames a file of this size holds, given its header. */
export function dataBytesForFileSize(fileBytes: number, channels: number): number {
  const raw = Math.max(0, fileBytes - WAV_HEADER_BYTES);
  const bytesPerFrame = channels * 2;
  return raw - (raw % bytesPerFrame);   // never leave half a frame on the end
}

/* Float samples to 16-bit, clamped. Rounding rather than truncating, and
   asymmetric limits, because -32768 is representable and +32768 is not. */
export function floatToInt16(samples: Float32Array): Int16Array {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i] ?? 0;
    const clamped = v < -1 ? -1 : v > 1 ? 1 : v;
    out[i] = Math.round(clamped < 0 ? clamped * 32768 : clamped * 32767);
  }
  return out;
}

/** Lace separate channels into the one stream a WAV file holds. */
export function interleave(channels: readonly Float32Array[]): Float32Array {
  if (channels.length === 0) return new Float32Array(0);
  const first = channels[0];
  if (!first) return new Float32Array(0);
  if (channels.length === 1) return first;
  const frames = first.length;
  const out = new Float32Array(frames * channels.length);
  for (let frame = 0; frame < frames; frame++) {
    for (let c = 0; c < channels.length; c++) {
      out[frame * channels.length + c] = channels[c]?.[frame] ?? 0;
    }
  }
  return out;
}

/** True if these bytes start a WAV file this app wrote. */
export function looksLikeWav(head: Uint8Array): boolean {
  if (head.length < WAV_HEADER_BYTES) return false;
  const tag = (at: number, text: string): boolean => {
    for (let i = 0; i < text.length; i++) if (head[at + i] !== text.charCodeAt(i)) return false;
    return true;
  };
  return tag(0, 'RIFF') && tag(8, 'WAVE') && tag(12, 'fmt ');
}
