/* DID ANY SOUND ACTUALLY COME OUT?
 *
 * Every check in this project used to read the app's opinion of itself — the
 * transport's aria-label, player.mode, the speed readout — and two faults shipped
 * straight through all of them:
 *
 *   * On Windows, opening a song that had a speed saved on it and pressing play
 *     while the engine was still building disconnected the playing song from the
 *     speakers and switched the engine off. The label said Play, the readout said
 *     89% speed, the app said nothing, and there was no sound at all.
 *   * On the phone, the app took audio focus away from its own web view a split
 *     second after the song started.
 *
 * Neither is visible in any label. So this taps the master bus — the one place
 * everything the app makes passes through on its way to the speakers — and reads
 * the real peak amplitude.
 *
 * TWO DETAILS, BOTH LEARNED THE HARD WAY.
 *
 * 1. AN ANALYSER NEEDS A WAY OUT AS WELL AS A WAY IN. Web Audio does not pull a
 *    node whose output goes nowhere, so an analyser with an input and no output
 *    reads silence for ever. It is emptied into a gain of zero that reaches the
 *    destination — the same trick graph.js uses for the tuner, and for the same
 *    reason.
 * 2. THE WINDOW'S TIMERS ARE THROTTLED when nobody is watching it, so a polling
 *    loop can be handed a second between turns. The analyser is therefore made as
 *    large as Web Audio allows (32768 samples, about two-thirds of a second at
 *    48 kHz), which means even a badly throttled poll still covers nearly all of
 *    the time it was asked to listen to.
 */

/** Listen at graph.master for `ms` and report the loudest thing heard.
 *  @returns {Promise<{peak:number, state:string, polls:number}>} */
export async function soundCameOut(page, ms = 1800) {
  return page.evaluate(async (listenFor) => {
    const graph = window.__tvaGraph?.();
    if (!graph) return { peak: 0, state: 'no graph', polls: 0 };
    const ctx = graph.ctx;

    const probe = ctx.createAnalyser();
    probe.fftSize = 32768;
    const drain = ctx.createGain();
    drain.gain.value = 0;
    graph.master.connect(probe);
    probe.connect(drain);
    drain.connect(ctx.destination);

    const samples = new Float32Array(probe.fftSize);
    let peak = 0;
    let polls = 0;
    const until = Date.now() + listenFor;
    while (Date.now() < until) {
      probe.getFloatTimeDomainData(samples);
      polls++;
      for (let i = 0; i < samples.length; i++) {
        const v = Math.abs(samples[i]);
        if (v > peak) peak = v;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    probe.getFloatTimeDomainData(samples);
    for (let i = 0; i < samples.length; i++) {
      const v = Math.abs(samples[i]);
      if (v > peak) peak = v;
    }

    try { graph.master.disconnect(probe); probe.disconnect(drain); drain.disconnect(); } catch { /* already gone */ }
    return { peak, state: ctx.state, polls };
  }, ms);
}

/* ANYTHING AT ALL, rather than a level. The test songs are shaped tones near
   full scale, so real playback reads in the tenths; a disconnected graph reads a
   hard zero. Well below the quietest thing the app can be asked to play, and far
   above the nothing that a fault produces. */
export const AUDIBLE = 0.01;

/** `sound came out (peak 0.3702)` — the same sentence in every check. */
export function heard(measured) {
  return `peak ${measured.peak.toFixed(4)}, context ${measured.state}`;
}
