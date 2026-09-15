/* Microphone samples, handed out as they arrive.
 *
 * PORTED from ring-meter/public/ringmeter-worklet.js, which does the same job
 * for an eight-second measurement. Two things are different here because a
 * lesson is forty-five minutes, not eight seconds:
 *
 *  - NOTHING IS KEPT. The Ring Meter collects chunks and hands back the lot at
 *    the end. An hour of mono at 48 kHz is about 690 MB held as Float32, so
 *    here every chunk is posted straight out and forgotten, and the main
 *    process appends it to a file on disk.
 *  - THERE IS A ROLLING BUFFER. It keeps the last N seconds at all times, so
 *    the moment a student sings something worth keeping can be saved AFTER it
 *    has happened rather than before.
 *
 * Buffers are allocated once, never inside the audio callback. Allocating on
 * the audio thread is what makes a recording click.
 */
class RecorderProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = options?.processorOptions ?? {};
    this.recording = false;
    this.channels = Math.max(1, Math.min(2, opts.channels ?? 1));

    // The rolling buffer, one flat interleaved ring.
    this.ringSeconds = Math.max(0, opts.ringSeconds ?? 0);
    this.ringLength = Math.round(this.ringSeconds * sampleRate) * this.channels;
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

  /* Hand back the last `seconds` of sound, oldest first. */
  grab(seconds, id) {
    if (!this.ring || this.ringFilled === 0) {
      this.port.postMessage({ type: 'grabbed', id, samples: new Float32Array(0), channels: this.channels });
      return;
    }
    const want = Math.min(
      this.ringFilled,
      Math.round(Math.max(0, seconds) * sampleRate) * this.channels,
    );
    const out = new Float32Array(want);
    // The ring's oldest sample is `want` frames behind where it is writing now.
    let read = (this.ringAt - want + this.ringLength) % this.ringLength;
    for (let i = 0; i < want; i++) {
      out[i] = this.ring[read];
      read = read + 1 === this.ringLength ? 0 : read + 1;
    }
    this.port.postMessage({ type: 'grabbed', id, samples: out, channels: this.channels }, [out.buffer]);
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const left = input[0];
    if (!left) return true;
    const right = this.channels === 2 ? (input[1] ?? left) : null;
    const frames = left.length;

    // Interleave once, and use the same array for both jobs.
    const out = new Float32Array(frames * this.channels);
    if (this.channels === 1) {
      out.set(left);
    } else {
      for (let i = 0; i < frames; i++) {
        out[i * 2] = left[i];
        out[i * 2 + 1] = right[i];
      }
    }

    if (this.ring) {
      for (let i = 0; i < out.length; i++) {
        this.ring[this.ringAt] = out[i];
        this.ringAt = this.ringAt + 1 === this.ringLength ? 0 : this.ringAt + 1;
      }
      this.ringFilled = Math.min(this.ringLength, this.ringFilled + out.length);
    }

    if (this.recording) {
      this.port.postMessage({ type: 'chunk', samples: out, channels: this.channels }, [out.buffer]);
    }
    return true;
  }
}

/* How loud the input is, and whether it is touching the ceiling.
 *
 * Separate from the recorder on purpose: the meter must keep moving whether or
 * not anything is being recorded, because its job is to let a person set their
 * level BEFORE they press record.
 */
class LevelMeterProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.peak = 0;
    this.sumSquares = 0;
    this.count = 0;
    this.clipped = false;
    this.sinceSend = 0;
  }

  process(inputs) {
    const ch = inputs[0]?.[0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      const v = ch[i];
      const a = v < 0 ? -v : v;
      if (a > this.peak) this.peak = a;
      // Anything at or past full scale has already lost whatever was above it.
      if (a >= 0.999) this.clipped = true;
      this.sumSquares += v * v;
    }
    this.count += ch.length;
    this.sinceSend += ch.length;

    // About twenty times a second, which is as fast as an eye follows a meter.
    if (this.sinceSend >= sampleRate / 20) {
      this.port.postMessage({
        peak: this.peak,
        rms: this.count > 0 ? Math.sqrt(this.sumSquares / this.count) : 0,
        clipped: this.clipped,
      });
      this.peak = 0; this.sumSquares = 0; this.count = 0;
      this.clipped = false; this.sinceSend = 0;
    }
    return true;
  }
}

registerProcessor('recorder-processor', RecorderProcessor);
registerProcessor('level-meter-processor', LevelMeterProcessor);
