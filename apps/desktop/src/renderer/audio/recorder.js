/* Recording, from the microphone to a file on disk.
 *
 * Nothing is held in memory. The worklet posts each chunk of samples, this
 * turns them into 16-bit and hands them straight to the main process with the
 * buffer TRANSFERRED, and the main process appends them to an open file. An
 * hour of mono at 48 kHz would be about 690 MB if it were kept.
 *
 * The rolling buffer is the other half: the microphone is always running into a
 * ring that holds the last two minutes, so a take can be saved AFTER the moment
 * has happened. Nobody remembers to press record first.
 */
import { getSharedAudioContext, resumeSharedAudio } from './context.js';
import { floatToInt16 } from '../practice-core.js';

const WORKLET_URL = new URL('../worklets/recorder-processor.js', import.meta.url).href;

let moduleAdded = null;
async function addWorklet(ctx) {
  if (!moduleAdded) moduleAdded = ctx.audioWorklet.addModule(WORKLET_URL);
  return moduleAdded;
}

export class Recorder {
  constructor(graph) {
    this.ctx = getSharedAudioContext();
    this.graph = graph;
    this.stream = null;
    this.source = null;
    this.node = null;
    this.meter = null;
    this.running = false;         // writing to a file right now
    this.startedAt = 0;
    this.onLevel = () => {};
    this.onSeconds = () => {};
    this.channels = 1;
    this.ringSeconds = 120;
  }

  get sampleRate() { return this.ctx.sampleRate; }

  /** Open an input and keep it running, so the meter moves and the rolling
   *  buffer fills before anything is recorded. */
  async listen({ stream, channels = 1 }) {
    await this.stop();
    /* Nothing in the graph runs while the audio engine is idle, and it starts
       idle. Without this the level meter sat at zero and the tuner read nothing
       until something was played — while the microphone appeared to be on. */
    await resumeSharedAudio();
    await addWorklet(this.ctx);

    this.stream = stream;
    this.channels = channels;
    this.source = this.ctx.createMediaStreamSource(stream);

    this.node = new AudioWorkletNode(this.ctx, 'recorder-processor', {
      numberOfInputs: 1, numberOfOutputs: 0,
      processorOptions: { channels, ringSeconds: this.ringSeconds },
    });
    this.node.port.onmessage = (event) => this.onMessage(event.data);

    this.meter = new AudioWorkletNode(this.ctx, 'level-meter-processor', {
      numberOfInputs: 1, numberOfOutputs: 0,
    });
    this.meter.port.onmessage = (event) => this.onLevel(event.data);

    this.source.connect(this.graph.micGain);
    this.graph.micGain.connect(this.node);
    this.graph.micGain.connect(this.meter);
    return true;
  }

  onMessage(data) {
    if (data?.type === 'chunk') {
      if (!this.running) return;
      const pcm = floatToInt16(data.samples);
      window.tva.sendChunk(pcm.buffer);          // transferred, not copied
      this.onSeconds(this.ctx.currentTime - this.startedAt);
      return;
    }
    if (data?.type === 'grabbed' && this._grab) {
      const done = this._grab; this._grab = null;
      done(data.samples);
    }
  }

  async start(name) {
    if (!this.node) throw new Error('No microphone is open.');
    const started = await window.tva.startRecording({
      name, sampleRate: this.sampleRate, channels: this.channels,
    });
    if (started?.error) throw new Error(started.error);
    this.startedAt = this.ctx.currentTime;
    this.running = true;
    this.node.port.postMessage({ type: 'start' });
    return started.path;
  }

  async finish() {
    if (!this.running) return null;
    this.running = false;
    this.node.port.postMessage({ type: 'stop' });
    // Let the last chunk cross before the header is written.
    await new Promise((r) => setTimeout(r, 120));
    return window.tva.stopRecording();
  }

  /** Save the last `seconds` from the rolling buffer, with no warning needed. */
  async saveLast(seconds, name) {
    if (!this.node) throw new Error('No microphone is open.');
    const samples = await new Promise((resolve) => {
      this._grab = resolve;
      this.node.port.postMessage({ type: 'grab', seconds, id: 1 });
    });
    if (!samples.length) throw new Error('There is nothing in the last few minutes to save.');

    const started = await window.tva.startRecording({
      name, sampleRate: this.sampleRate, channels: this.channels,
    });
    if (started?.error) throw new Error(started.error);
    const pcm = floatToInt16(samples);
    window.tva.sendChunk(pcm.buffer);
    await new Promise((r) => setTimeout(r, 120));
    return window.tva.stopRecording();
  }

  async stop() {
    if (this.running) await this.finish();
    try { this.source?.disconnect(); } catch {}
    /* ONLY disconnect what was actually connected. disconnect(undefined) is
       treated as disconnect() with no argument, which severs EVERY output of
       the node — so calling this before anything was connected tore the tuner
       and the monitor off the microphone bus. The recorder went on working
       perfectly, and the tuner beside it read silence for ever. */
    if (this.node) { try { this.graph.micGain.disconnect(this.node); } catch {} }
    if (this.meter) { try { this.graph.micGain.disconnect(this.meter); } catch {} }
    try { this.node?.port.close(); } catch {}
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.stream = null; this.source = null; this.node = null; this.meter = null;
  }
}
