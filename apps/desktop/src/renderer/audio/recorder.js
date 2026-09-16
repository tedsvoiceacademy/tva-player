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
import { attachMic, detachMic } from './graph.js';
import { floatToInt16, interleave } from '../practice-core.js';

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
    this.using = [0];
    this.stereo = false;
    this.ringSeconds = 120;
  }

  get sampleRate() { return this.ctx.sampleRate; }

  /** Open an input and keep it running, so the meter moves and the rolling
   *  buffer fills before anything is recorded. */
  async listen({ stream, sourceNode = null, channels = 1, use = null, stereo = false }) {
    await this.stop();
    /* Nothing in the graph runs while the audio engine is idle, and it starts
       idle. Without this the level meter sat at zero and the tuner read nothing
       until something was played — while the microphone appeared to be on. */
    await resumeSharedAudio();
    await addWorklet(this.ctx);

    this.stream = stream;
    this.channels = Math.max(1, Math.min(8, channels));
    /* Which inputs have a microphone on them. Everything downstream counts
       these rather than the channel count, so an interface with four preamps
       and two microphones plugged in writes two files, not four. */
    this.using = [];
    for (let c = 0; c < this.channels; c++) if (!use || use[c] !== false) this.using.push(c);
    if (this.using.length === 0) this.using = [0];
    /* WHAT THE COMPUTER IS PLAYING IS ONE STEREO SIGNAL, not two microphones.
       Two files and a mix would be nonsense for it, so its two channels are
       laced back together into one stereo take. */
    this.stereo = Boolean(stereo);
    /* sourceNode is for the checks. Chromium's MediaStreamAudioDestinationNode
       is capped at two channels, so a four-microphone stream cannot be built
       inside a page at all — and without this, everything downstream of
       getUserMedia would go untested. Feeding a four-channel node straight in
       exercises the whole of it: the splitter, the per-microphone gains, the
       worklet, the files. What getUserMedia itself hands over is the one part
       that still needs a real interface, and the Windows checklist says so. */
    this.source = sourceNode ?? this.ctx.createMediaStreamSource(stream);

    /* Splitter, one gain per microphone, merger. Built here rather than in the
       graph's constructor because the number of microphones is not known until
       Windows has answered. */
    attachMic(this.graph, this.source, this.channels);

    /* channelCount and the two modes on BOTH worklet nodes, because a worklet
       node left alone is given two channels whatever is feeding it — four
       microphones would arrive as a stereo fold-down and two of them would
       never be recorded at all. */
    const shape = {
      numberOfInputs: 1,
      numberOfOutputs: 0,
      channelCount: this.channels,
      channelCountMode: 'explicit',
      channelInterpretation: 'discrete',
    };

    this.node = new AudioWorkletNode(this.ctx, 'recorder-processor', {
      ...shape,
      processorOptions: { channels: this.channels, use, ringSeconds: this.ringSeconds },
    });
    this.node.port.onmessage = (event) => this.onMessage(event.data);

    this.meter = new AudioWorkletNode(this.ctx, 'level-meter-processor', {
      ...shape,
      processorOptions: { channels: this.channels },
    });
    this.meter.port.onmessage = (event) => this.onLevel(event.data);

    this.graph.micGain.connect(this.node);
    this.graph.micGain.connect(this.meter);
    return true;
  }

  /** What this take is written as: one file per microphone, plus a mix of all
   *  of them once there is more than one. */
  trackList() {
    if (this.stereo) return [{ key: 'mic1', suffix: '', channels: 2 }];
    const on = this.using ?? [0];
    if (on.length === 1) return [{ key: `mic${on[0] + 1}`, suffix: '' }];
    const tracks = on.map((c) => ({ key: `mic${c + 1}`, suffix: ` (Mic ${c + 1})` }));
    tracks.push({ key: 'mix', suffix: ' (all mics mixed)' });
    return tracks;
  }

  onMessage(data) {
    if (data?.type === 'chunk') {
      if (!this.running) return;
      /* One message per microphone, each naming its own file. Sent rather than
         awaited: at 48 kHz this fires about every twenty milliseconds for the
         whole of a lesson, and four microphones is four of them. */
      const planar = data.planar ?? [];
      const indices = data.indices ?? [];
      if (this.stereo) {
        const laced = interleave([planar[0], planar[1] ?? planar[0]]);
        window.tva.sendChunk('mic1', floatToInt16(laced).buffer);
        this.onSeconds(this.ctx.currentTime - this.startedAt);
        return;
      }
      for (let i = 0; i < planar.length; i++) {
        const pcm = floatToInt16(planar[i]);
        window.tva.sendChunk(`mic${(indices[i] ?? i) + 1}`, pcm.buffer);
      }
      if (data.mix) window.tva.sendChunk('mix', floatToInt16(data.mix).buffer);
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
      name, sampleRate: this.sampleRate, tracks: this.trackList(),
    });
    if (started?.error) throw new Error(started.error);
    this.startedAt = this.ctx.currentTime;
    this.running = true;
    this.node.port.postMessage({ type: 'start' });
    return started.paths;
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

    /* ONE FILE, always. The rolling buffer holds the mix rather than every
       microphone separately — see the worklet — so what comes back is one
       mono signal however many microphones are on. */
    const started = await window.tva.startRecording({
      name, sampleRate: this.sampleRate, tracks: [{ key: 'mix', suffix: '' }],
    });
    if (started?.error) throw new Error(started.error);
    const pcm = floatToInt16(samples);
    window.tva.sendChunk('mix', pcm.buffer);
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
    detachMic(this.graph);
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.stream = null; this.source = null; this.node = null; this.meter = null;
  }
}
