/* One AudioContext, for the life of the app.
 *
 * PORTED from the members site's src/lib/members/audio-engine.ts, which exists
 * because a fresh context per song left members tapping play between every
 * track. Electron mostly removes that particular reason, and the rule is kept
 * anyway for three that still hold:
 *
 *  - audioWorklet.addModule() is per context. Churning contexts means
 *    re-registering the stretch worklet and the recorder worklet mid-session.
 *  - setSinkId(), which is how the output device is chosen, works on a live
 *    context. A new one would land back on the default device.
 *  - a playlist moving to the next track must not click, and building a graph
 *    is the most expensive thing that could happen between two songs.
 *
 * The iOS priming the members version carries is deliberately NOT here. It
 * unlocks audio past the physical silent switch on an iPhone, and there is no
 * such switch on Windows. It was removed on purpose, not forgotten.
 */

let sharedCtx = null;

export function getSharedAudioContext() {
  if (sharedCtx && sharedCtx.state !== 'closed') return sharedCtx;
  sharedCtx = new AudioContext({ latencyHint: 'interactive' });
  return sharedCtx;
}

export async function resumeSharedAudio() {
  const ctx = getSharedAudioContext();
  if (ctx.state !== 'running') {
    try { await ctx.resume(); } catch { /* it will be resumed by the next play */ }
  }
  return ctx;
}

/** Closing it is exactly the mistake this file exists to prevent. */
export function closeSharedAudioContext() {
  throw new Error('The audio context is never closed. See the comment at the top of context.js.');
}
