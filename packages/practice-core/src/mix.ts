/* Putting a take and the song it was sung against into one file.
 *
 * PORTED FROM THE OFFLINEAUDIOCONTEXT THIS REPLACES, sample for sample. The old
 * version built a graph — song into a gain of 0.8, take into a gain of 1, both
 * into a two-channel destination — and rendered the whole thing in one go. That
 * works and sounds right; what it cannot do is a forty-five minute lesson,
 * because the rendered result is a third full-length buffer held in memory
 * alongside the two decoded ones. An hour of stereo at 48 kHz is about 1.4 GB
 * for the three of them.
 *
 * So the same arithmetic happens here instead, a slice at a time, and each
 * slice goes to the encoder and is thrown away. The maths is plain enough to
 * state in one line:
 *
 *     out[f] = song[f] * songGain + take[f + shift]
 *
 * Two details are inherited from Web Audio rather than chosen, and changing
 * either would change how an existing mix sounds:
 *
 * 1. A MONO SOURCE IS COPIED TO BOTH CHANNELS at full level, not at 0.707.
 *    That is what up-mixing does, and a take is usually mono.
 * 2. NOTHING IS CLAMPED HERE. The sum may go past ±1; floatToInt16 is what
 *    limits it, exactly as it did when the destination fed the same converter.
 */

/** Read one sample, treating anything outside the buffer as silence. */
function at(channel: Float32Array | undefined, frame: number): number {
  if (!channel || frame < 0 || frame >= channel.length) return 0;
  return channel[frame] ?? 0;
}

/* One channel of a source, up-mixed the way Web Audio would: a mono source
   feeds every output channel, a stereo one feeds its own. */
function sourceChannel(source: readonly Float32Array[], c: number): Float32Array | undefined {
  if (source.length === 0) return undefined;
  return source[c] ?? source[0];
}

/**
 * Mix `outFrames` frames starting at `startFrame`, into `outChannels` channels.
 *
 * `shiftFrames` moves the take EARLIER by skipping that many of its frames,
 * which is how the "line takes up by" box compensates for the delay between
 * singing and the sound reaching the computer.
 */
export function mixSlice(
  song: readonly Float32Array[],
  take: readonly Float32Array[],
  outFrames: number,
  startFrame: number,
  shiftFrames: number,
  songGain: number,
  outChannels = 2,
): Float32Array[] {
  const out: Float32Array[] = [];
  for (let c = 0; c < outChannels; c++) {
    const dst = new Float32Array(outFrames);
    const songCh = sourceChannel(song, c);
    const takeCh = sourceChannel(take, c);
    for (let i = 0; i < outFrames; i++) {
      const frame = startFrame + i;
      dst[i] = at(songCh, frame) * songGain + at(takeCh, frame + shiftFrames);
    }
    out.push(dst);
  }
  return out;
}

/** How long the mixed file is: whichever of the two runs longer. */
export function mixLengthFrames(songFrames: number, takeFrames: number): number {
  return Math.max(songFrames, takeFrames);
}

/* LAME RESAMPLES ANYTHING IT IS HANDED, which was worth measuring rather than
   assuming: fed a 96 kHz signal it writes a 48 kHz file of the same duration and
   the same pitch, and fed 37 kHz it writes 44.1. So nothing here has to pick a
   rate for it, and a take recorded on an interface running at 96 kHz needs no
   decoding on the way out. */

/** 128 kbps for one channel, 192 for two: transparent enough for a lesson. */
export function mp3KbpsFor(channels: number): number {
  return channels >= 2 ? 192 : 128;
}
