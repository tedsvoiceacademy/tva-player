/* The audio graph every sound in the app passes through.
 *
 * PORTED from the members song player's buildTail()/routeTail(), and extended in
 * three ways the desktop app needs.
 *
 * 1. THE VOLUME MOVED. On the members page the volume sits at the end of the one
 *    tail. Here the track, a recorded take and the metronome each have their own
 *    level before a single master, so playing a take against the track with a
 *    separate volume for each is a graph that already exists rather than a
 *    rebuild.
 * 2. THE SOURCE IS SWAPPABLE. A song plays either straight from disk through an
 *    <audio> element, or through the stretch engine once a practice control is
 *    touched. Everything after the source is built once when the app starts.
 * 3. THE MICROPHONE NEVER REACHES THE SPEAKERS unless monitoring is explicitly
 *    switched on. With echo cancellation off — which is not negotiable for a
 *    voice tool — monitoring through speakers howls.
 *
 * The three tails stay mutually exclusive and only balL/balR are ever
 * re-pointed, exactly as the members version does it.
 */
import { balanceGains, MONO_SUM_GAIN, MIDDLE_CANCEL_GAIN } from '../practice-core.js';

export function buildGraph(ctx) {
  const splitter = ctx.createChannelSplitter(2);
  const balL = ctx.createGain();
  const balR = ctx.createGain();

  // Tail A: ordinary stereo, each side kept where it was recorded.
  const merger = ctx.createChannelMerger(2);

  // Tail B: one finished mix sent to both speakers. For a car or Bluetooth link
  // that carries only one side, which would otherwise break the balance slider.
  const monoSum = ctx.createGain();
  monoSum.gain.value = MONO_SUM_GAIN;

  // Tail C: one side subtracted from the other, which removes whatever was
  // recorded dead centre. The lead usually, and the bass and snare with it.
  const midL = ctx.createGain(); midL.gain.value = MIDDLE_CANCEL_GAIN;
  const midR = ctx.createGain(); midR.gain.value = -MIDDLE_CANCEL_GAIN;
  const midSum = ctx.createGain();

  const trackGain = ctx.createGain();
  const takeGain = ctx.createGain();
  const clickGain = ctx.createGain();
  const master = ctx.createGain();

  /* Where the microphone arrives. It feeds the recorder, the level meter and
     the tuner — and NOT the speakers, unless monitoring is explicitly switched
     on. With echo cancellation off, which is not negotiable for a voice tool,
     monitoring through speakers howls. */
  const micGain = ctx.createGain();
  const monitorGain = ctx.createGain();
  monitorGain.gain.value = 0;
  micGain.connect(monitorGain);

  /* For the tuner. Zero smoothing, because a reading that is averaged over time
     lags behind the note and tells a singer they are in tune after they have
     already left it.
   *
   * IT NEEDS A WAY OUT AS WELL AS A WAY IN. An analyser with an input but no
   * output is never pulled: it reads as silence for ever, which is exactly what
   * it did — the recorder was capturing the voice perfectly while the tuner
   * next to it showed nothing at all. So it empties into a gain of zero that
   * reaches the speakers, which makes it part of the running graph without
   * making a sound. */
  const tuner = ctx.createAnalyser();
  tuner.fftSize = 4096;
  tuner.smoothingTimeConstant = 0;
  const silent = ctx.createGain();
  silent.gain.value = 0;
  micGain.connect(tuner);
  tuner.connect(silent);

  splitter.connect(balL, 0);
  splitter.connect(balR, 1);
  merger.connect(trackGain);
  monoSum.connect(trackGain);
  midL.connect(midSum); midR.connect(midSum); midSum.connect(trackGain);

  trackGain.connect(master);
  takeGain.connect(master);
  clickGain.connect(master);
  monitorGain.connect(master);
  silent.connect(master);
  master.connect(ctx.destination);

  const graph = {
    ctx, splitter, balL, balR, merger, monoSum, midL, midR, midSum,
    trackGain, takeGain, clickGain, micGain, monitorGain, tuner, silent, master,
    _source: null,
  };
  routeTail(graph, { leadQuieter: false, oneSpeaker: false });
  return graph;
}

/** Point the two sides at whichever tail is wanted. The tails themselves are
 *  never rebuilt, so switching between them cannot click. */
export function routeTail(graph, { leadQuieter, oneSpeaker }) {
  try { graph.balL.disconnect(); graph.balR.disconnect(); } catch { /* not yet connected */ }
  if (leadQuieter) {
    graph.balL.connect(graph.midL);
    graph.balR.connect(graph.midR);
  } else if (oneSpeaker) {
    graph.balL.connect(graph.monoSum);
    graph.balR.connect(graph.monoSum);
  } else {
    graph.balL.connect(graph.merger, 0, 0);
    graph.balR.connect(graph.merger, 0, 1);
  }
}

/** Swap what is feeding the tail, without touching anything downstream. */
export function setSource(graph, node) {
  if (graph._source) { try { graph._source.disconnect(graph.splitter); } catch {} }
  graph._source = node ?? null;
  if (node) node.connect(graph.splitter);
}

export function applyBalance(graph, balance) {
  const { left, right } = balanceGains(balance);
  graph.balL.gain.value = left;
  graph.balR.gain.value = right;
}
