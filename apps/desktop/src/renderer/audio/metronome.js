/* The click.
 *
 * Every beat is scheduled ahead of time at an exact moment, because a timer
 * that fires on the beat drifts — the browser is free to be late, and a click
 * that is late is worse than no click. The arithmetic lives in practice-core
 * where it can be checked without a speaker; this only makes the sound.
 */
import { getSharedAudioContext } from './context.js';
import { beatsFor, secondsPerBeat } from '../practice-core.js';

/* Two short wooden taps, the down-beat higher than the rest. Built once and
   reused, so nothing is allocated between beats. */
function makeTick(ctx, hz, seconds = 0.035) {
  const frames = Math.round(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(1, frames, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < frames; i++) {
    const t = i / ctx.sampleRate;
    // A tone under a fast decay: a click with no pitch is hard to play against.
    data[i] = Math.sin(2 * Math.PI * hz * t) * Math.exp(-t * 90);
  }
  return buf;
}

export class Metronome {
  constructor(graph) {
    this.ctx = getSharedAudioContext();
    this.graph = graph;
    this.down = makeTick(this.ctx, 1600);
    this.up = makeTick(this.ctx, 1050);
    this.timer = null;
    this.sources = [];
    this.running = false;
    this.onCountIn = () => {};
  }

  /* Start clicking. With countInBars set, it clicks that many bars first and
     calls back when the song itself should come in. */
  start({ bpm, beatsPerBar = 4, countInBars = 0, onSongStart = null }) {
    this.stop();
    this.running = true;

    const at0 = this.ctx.currentTime + 0.12;      // a moment to get ahead of itself
    const spb = secondsPerBeat(bpm);

    /* Scheduled a chunk at a time rather than all at once, so a long practice
       session does not build ten thousand nodes up front. */
    let scheduledTo = 0;
    const AHEAD = 2.0;

    const pump = () => {
      if (!this.running) return;
      const now = this.ctx.currentTime - at0;
      const { beats, songStartsAtSec } = beatsFor({
        bpm, beatsPerBar, countInBars, seconds: now + AHEAD,
      });
      for (const beat of beats) {
        if (beat.atSec < scheduledTo) continue;
        const src = this.ctx.createBufferSource();
        src.buffer = beat.downbeat ? this.down : this.up;
        src.connect(this.graph.clickGain);
        src.start(at0 + beat.atSec);
        this.sources.push(src);
      }
      scheduledTo = now + AHEAD;

      if (countInBars > 0 && onSongStart && !this._handedOver
          && now >= songStartsAtSec - 0.05) {
        this._handedOver = true;
        onSongStart();
      }
      const left = Math.ceil((songStartsAtSec - now) / spb);
      this.onCountIn(Math.max(0, left));

      this.timer = setTimeout(pump, 250);
    };
    this._handedOver = false;
    pump();
  }

  stop() {
    this.running = false;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    for (const src of this.sources) { try { src.stop(); } catch {} }
    this.sources = [];
    this.onCountIn(0);
  }

  setVolume(v) { this.graph.clickGain.gain.value = v; }
}
