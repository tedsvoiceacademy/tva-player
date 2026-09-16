/* Microphone samples, handed out as they arrive.
 *
 * PORTED from ring-meter/public/ringmeter-worklet.js, which does the same job
 * for an eight-second measurement. Three things are different here because a
 * lesson is forty-five minutes on as many as eight microphones, not eight
 * seconds on one:
 *
 *  - NOTHING IS KEPT. The Ring Meter collects chunks and hands back the lot at
 *    the end. An hour of mono at 48 kHz is about 690 MB held as Float32, so
 *    here every chunk is posted straight out and forgotten, and the main
 *    process appends it to a file on disk.
 *  - CHANNELS STAY APART. Each microphone is posted as its own array, so each
 *    can be written to its own file. A mix of all of them is made here as well,
 *    in the one pass over the samples that is already happening.
 *  - THE ROLLING BUFFER HOLDS THE MIX ONLY. It keeps the last N seconds at all
 *    times, so a moment worth keeping can be saved AFTER it has happened. Held
 *    per channel it would cost 23 MB for every microphone; held as the mix it
 *    costs 23 MB whether one microphone is on or eight.
 *
 * Buffers are allocated once, never inside the audio callback. Allocating on
 * the audio thread is what makes a recording click.
 */
class RecorderProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = options?.processorOptions ?? {};
    this.recording = false;
    this.channels = Math.max(1, Math.min(8, opts.channels ?? 1));
    /* WHICH of those channels have a microphone worth recording on them. An
       interface with four preamps and two microphones plugged in would
       otherwise write two silent files for every lesson. */
    const use = Array.isArray(opts.use) ? opts.use : null;
    this.using = [];
    for (let c = 0; c < this.channels; c++) if (!use || use[c] !== false) this.using.push(c);
    if (this.using.length === 0) this.using = [0];

    // The rolling buffer: one mono ring holding the mix.
    this.ringSeconds = Math.max(0, opts.ringSeconds ?? 0);
    this.ringLength = Math.round(this.ringSeconds * sampleRate);
    this.ring = this.ringLength > 0 ? new Float32Array(this.ringLength) : null;
    this.ringAt = 0;
    this.ringFilled = 0;

    this.port.onmessage = (event) => {
      const data = event.data ?? {};
      if (data.type === 'start') this.recording = true;
      else if (data.type === 'stop') this.recording = false;
      else if (data.type === 'grab') this.grab(data.seconds ?? this.ringSeconds, data.id);
    };
  }

  /* Hand back the last `seconds` of the mix, oldest first. */
  grab(seconds, id) {
    if (!this.ring || this.ringFilled === 0) {
      this.port.postMessage({ type: 'grabbed', id, samples: new Float32Array(0) });
      return;
    }
    const want = Math.min(this.ringFilled, Math.round(Math.max(0, seconds) * sampleRate));
    const out = new Float32Array(want);
    // The ring's oldest sample is `want` frames behind where it is writing now.
    let read = (this.ringAt - want + this.ringLength) % this.ringLength;
    for (let i = 0; i < want; i++) {
      out[i] = this.ring[read];
      read = read + 1 === this.ringLength ? 0 : read + 1;
    }
    this.port.postMessage({ type: 'grabbed', id, samples: out }, [out.buffer]);
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const first = input[0];
    if (!first) return true;
    const frames = first.length;
    /* What ARRIVED, which can be fewer than were asked for — a device unplugged
       mid-lesson is the obvious way. Reading input.length rather than this
       .channels is what stops that reading a channel that is not there. */
    const live = Math.min(this.channels, input.length);

    const planar = [];
    for (const c of this.using) {
      const src = c < live ? input[c] : null;
      const copy = new Float32Array(frames);
      if (src) copy.set(src);
      planar.push(copy);
    }

    /* The mix is the average, not the sum: four microphones summed reach full
       scale at a quarter of the loudness each and clip a take that no single
       microphone was anywhere near clipping. */
    let mix;
    if (planar.length === 1) {
      mix = planar[0];
    } else {
      mix = new Float32Array(frames);
      for (const src of planar) {
        for (let i = 0; i < frames; i++) mix[i] += src[i];
      }
      const scale = 1 / planar.length;
      for (let i = 0; i < frames; i++) mix[i] *= scale;
    }

    if (this.ring) {
      for (let i = 0; i < frames; i++) {
        this.ring[this.ringAt] = mix[i];
        this.ringAt = this.ringAt + 1 === this.ringLength ? 0 : this.ringAt + 1;
      }
      this.ringFilled = Math.min(this.ringLength, this.ringFilled + frames);
    }

    if (this.recording) {
      /* With one microphone the mix IS that microphone, so it is sent once and
         the main process writes one file, exactly as it always did. */
      const payload = planar.length === 1
        ? { type: 'chunk', indices: this.using, planar, mix: null }
        : { type: 'chunk', indices: this.using, planar, mix };
      const transfers = planar.map((a) => a.buffer);
      if (payload.mix) transfers.push(payload.mix.buffer);
      this.port.postMessage(payload, transfers);
    }
    return true;
  }
}

/* How loud each microphone is, and whether any of them is touching the ceiling.
 *
 * Separate from the recorder on purpose: the meter must keep moving whether or
 * not anything is being recorded, because its job is to let a person set their
 * level BEFORE they press record.
 *
 * IT IS ALSO WHAT DRAWS THE LIVE WAVEFORM. Twenty readings a second per
 * microphone is one column of a scrolling picture every fifty milliseconds,
 * which is enough to watch a phrase go by — and it costs nothing, because the
 * numbers are already being worked out for the bars.
 */
class LevelMeterProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = options?.processorOptions ?? {};
    this.channels = Math.max(1, Math.min(8, opts.channels ?? 1));
    this.peak = new Float32Array(this.channels);
    this.sumSquares = new Float64Array(this.channels);
    this.clipped = new Uint8Array(this.channels);
    this.count = 0;
    this.sinceSend = 0;
  }

  process(inputs) {
    const input = inputs[0];
    const first = input?.[0];
    if (!first) return true;
    const live = Math.min(this.channels, input.length);

    for (let c = 0; c < live; c++) {
      const ch = input[c];
      if (!ch) continue;
      let peak = this.peak[c];
      let sum = this.sumSquares[c];
      for (let i = 0; i < ch.length; i++) {
        const v = ch[i];
        const a = v < 0 ? -v : v;
        if (a > peak) peak = a;
        // Anything at or past full scale has already lost whatever was above it.
        if (a >= 0.999) this.clipped[c] = 1;
        sum += v * v;
      }
      this.peak[c] = peak;
      this.sumSquares[c] = sum;
    }
    this.count += first.length;
    this.sinceSend += first.length;

    // About twenty times a second, which is as fast as an eye follows a meter.
    if (this.sinceSend >= sampleRate / 20) {
      const peaks = new Array(this.channels);
      const rmsEach = new Array(this.channels);
      const clippedEach = new Array(this.channels);
      let loudestPeak = 0;
      let loudestRms = 0;
      let anyClipped = false;
      for (let c = 0; c < this.channels; c++) {
        const peak = this.peak[c];
        const rms = this.count > 0 ? Math.sqrt(this.sumSquares[c] / this.count) : 0;
        peaks[c] = peak;
        rmsEach[c] = rms;
        clippedEach[c] = this.clipped[c] === 1;
        if (peak > loudestPeak) loudestPeak = peak;
        if (rms > loudestRms) loudestRms = rms;
        if (clippedEach[c]) anyClipped = true;
        this.peak[c] = 0; this.sumSquares[c] = 0; this.clipped[c] = 0;
      }
      /* peak, rms and clipped WITHOUT an index are the loudest microphone of
         the set, so everything that only wants one number — the bar in the
         case, the clipping warning — reads the same three fields it always
         did, and one microphone behaves exactly as it did before. */
      this.port.postMessage({
        peaks, rmsEach, clippedEach,
        peak: loudestPeak, rms: loudestRms, clipped: anyClipped,
      });
      this.count = 0; this.sinceSend = 0;
    }
    return true;
  }
}

registerProcessor('recorder-processor', RecorderProcessor);
registerProcessor('level-meter-processor', LevelMeterProcessor);
