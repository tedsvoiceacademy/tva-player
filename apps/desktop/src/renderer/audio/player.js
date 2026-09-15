/* Playing a song, the two different ways it has to be played.
 *
 * STRAIGHT PLAYBACK is the default and is what a media player needs: an <audio>
 * element streaming from disk. It starts in a fraction of a second whatever the
 * length, uses the same memory for a three-minute song and a ninety-minute
 * rehearsal recording, and gives correct seeking and duration for free.
 *
 * PRACTICE MODE is what the members player does: the whole file decoded into
 * memory and handed to the stretch engine, which is the only way to change the
 * speed without changing the key. It costs a decode before the first note — an
 * hour of stereo at 48 kHz is about 1.4 GB decoded — so it happens when a
 * practice control is touched, not when a song is opened.
 *
 * Both feed the same tail, so the balance and lead-quieter maths is shared and
 * cannot fork between them.
 */
import { getSharedAudioContext, resumeSharedAudio } from './context.js';
import { buildGraph, routeTail, setSource, applyBalance } from './graph.js';

/* Above this, practice mode is refused rather than attempted. The refusal says
   so in words; silently killing the app on a long file would be worse. */
export const PRACTICE_MAX_SECONDS = 25 * 60;

export class Player {
  constructor() {
    this.ctx = getSharedAudioContext();
    this.graph = buildGraph(this.ctx);
    this.mode = 'idle';          // 'straight' | 'practice'
    this.song = null;            // { path, name, bytes, songKey, url }
    this.el = null;              // the <audio> element, straight playback
    this.elSource = null;
    this.stretch = null;         // the stretch node, practice mode
    this.buffer = null;          // the decoded song, practice mode
    this.practiceTime = 0;
    this.onTime = () => {};
    this.onState = () => {};
    /* How many times the practice engine has actually been built. One per song
       is correct. It is counted rather than assumed because the bug that made
       this necessary — a fresh engine per pixel of knob movement — showed no
       symptom other than the app locking up, and a test cannot see that. */
    this.engineStarts = 0;
  }

  /* ---- Opening ---------------------------------------------------------- */

  async open(song) {
    this.stopAll();
    this.song = song;
    this.mode = 'straight';

    const el = new Audio();
    el.src = song.url;
    el.preload = 'auto';
    this.el = el;

    /* Wait for the song's length BEFORE wiring the element into the graph.
       An element connected to a suspended AudioContext stalls: its metadata
       never completes, duration stays at Infinity, and the clock and the
       waveform have nothing to scale against. The song still plays once the
       context resumes, which is what makes this one easy to miss.

       AND NEVER WAIT FOREVER. Without the timeout, a song that quietly fails to
       load leaves the app sitting on "Opening that song…" with the play button
       greyed out and nothing to tell the person what went wrong — which is how
       "I couldn't get it to play" looks from the inside. */
    await new Promise((resolve, reject) => {
      const done = () => { clearTimeout(timer); resolve(); };
      const timer = setTimeout(() => {
        reject(new Error('The song took too long to open. It may be a format this '
          + 'app cannot read, or the file may be somewhere it cannot reach.'));
      }, 15000);
      el.addEventListener('loadedmetadata', done, { once: true });
      el.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error(mediaErrorText(el)));
      }, { once: true });
    });

    // Some files report their length a moment later than their metadata.
    if (!Number.isFinite(el.duration)) {
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 2000);
        el.addEventListener('durationchange', () => {
          if (Number.isFinite(el.duration)) { clearTimeout(timer); resolve(); }
        });
      });
    }

    // createMediaElementSource may only ever be called once per element, which
    // is why a fresh element is made per song rather than the src being swapped.
    this.elSource = this.ctx.createMediaElementSource(el);
    setSource(this.graph, this.elSource);

    el.addEventListener('timeupdate', () => this.onTime(this.currentTime, this.duration));
    el.addEventListener('durationchange', () => this.onTime(this.currentTime, this.duration));
    el.addEventListener('ended', () => this.onState('ended'));
    el.addEventListener('play', () => this.onState('playing'));
    el.addEventListener('pause', () => this.onState('paused'));

    this.onState('ready');
    return { duration: this.duration };
  }

  /* ---- Straight playback ------------------------------------------------ */

  /* Every reason a browser refuses to play, in words rather than a code. */
  async play() {
    await resumeSharedAudio();
    if (this.mode === 'practice') {
      this._practicePlaying = true;
      this.stretch.schedule({ active: true });
      this.onState('playing');
      return;
    }
    try {
      await this.el.play();
    } catch (err) {
      /* play() returns a promise that REJECTS, and an unhandled rejection is
         silent: the button does nothing and the app looks broken with no
         explanation anywhere. */
      throw new Error(`This song would not start playing. ${err?.message ?? err}`);
    }
  }

  pause() {
    if (this.mode === 'practice') {
      this._practicePlaying = false;
      this.stretch.schedule({ active: false });
      this.onState('paused');
      return;
    }
    this.el.pause();
  }

  stop() {
    this.pause();
    this.seek(0);
  }

  seek(seconds) {
    const target = Math.max(0, Math.min(seconds, this.duration || 0));
    if (this.mode === 'practice') {
      this.practiceTime = target;
      this.stretch.schedule({ input: target });
    } else if (this.el) {
      this.el.currentTime = target;
    }
    this.onTime(target, this.duration);
  }

  get currentTime() {
    return this.mode === 'practice' ? this.practiceTime : (this.el ? this.el.currentTime : 0);
  }

  get duration() {
    if (this.mode === 'practice' && this.buffer) return this.buffer.duration;
    return this.el && Number.isFinite(this.el.duration) ? this.el.duration : 0;
  }

  get playing() {
    return this.mode === 'practice'
      ? this._practicePlaying === true
      : Boolean(this.el && !this.el.paused);
  }

  /* ---- Practice mode ---------------------------------------------------- */

/* Decode the song and hand it to the stretch engine, keeping the position.
   Returns the node, or null when the song is too long to hold in memory.

   ONE AT A TIME. Dragging a knob fires an input event on every pixel of
   movement, and the first version of this started a fresh decode on each one:
   twenty movements meant twenty copies of the whole song being decoded at
   once, which locked the app up solid. Ted hit it on his first try. The
   in-flight promise is handed back to every later caller, so a drag starts
   exactly one engine however far it travels. */
  async enterPracticeMode(fetchBytes) {
    if (this.mode === 'practice') return this.stretch;
    if (this._entering) return this._entering;
    if (this.duration > PRACTICE_MAX_SECONDS) return null;

    this._entering = this._enterPracticeMode(fetchBytes)
      .finally(() => { this._entering = null; });
    return this._entering;
  }

  async _enterPracticeMode(fetchBytes) {
    this.engineStarts++;
    const at = this.currentTime;
    const wasPlaying = this.playing;
    if (this.el) this.el.pause();

    const bytes = await fetchBytes(this.song.url);
    this.buffer = await this.ctx.decodeAudioData(bytes);

    const mod = await import('../vendor/SignalsmithStretch.mjs');
    const node = await mod.default(this.ctx, { numberOfInputs: 0, outputChannelCount: [2] });

    const chans = [];
    for (let c = 0; c < this.buffer.numberOfChannels; c++) chans.push(this.buffer.getChannelData(c));
    // A mono recording is duplicated so the tail always has two sides to work
    // with, and the balance control still means something.
    if (chans.length === 1) chans.push(chans[0]);
    await node.addBuffers(chans);

    this.stretch = node;
    this.mode = 'practice';
    this._practicePlaying = wasPlaying;
    setSource(this.graph, node);

    node.setUpdateInterval(0.05, (t) => {
      this.practiceTime = t;
      this.onTime(t, this.duration);
    });
    node.schedule({ active: wasPlaying, input: at });
    this.practiceTime = at;
    this.onState(wasPlaying ? 'playing' : 'paused');
    return node;
  }

  /** Speed, key and formants — the three the stretch engine owns. */
  applyPractice({ speed, halfSteps, naturalVoice }) {
    if (this.mode !== 'practice' || !this.stretch) return;
    this.stretch.schedule({
      rate: speed,
      semitones: halfSteps,
      formantCompensation: naturalVoice,
      formantBaseHz: 0,           // work the fundamental out rather than assume one
    });
  }

  setLoop(a, b) {
    if (this.mode !== 'practice' || !this.stretch) return;
    // Both the same means no loop, which is what the engine's own API asks for.
    this.stretch.schedule({ loopStart: a ?? 0, loopEnd: b ?? 0 });
  }

  /* ---- The controls that work in either mode ---------------------------- */

  setBalance(balance) { applyBalance(this.graph, balance); }
  setVolume(volume)   { this.graph.master.gain.value = volume; }
  setTail(opts)       { routeTail(this.graph, opts); }

  async setOutputDevice(deviceId) {
    if (typeof this.ctx.setSinkId !== 'function') return false;
    try { await this.ctx.setSinkId(deviceId); return true; } catch { return false; }
  }

  stopAll() {
    if (this.el) { this.el.pause(); this.el.removeAttribute('src'); this.el.load(); }
    if (this.stretch) { try { this.stretch.schedule({ active: false }); this.stretch.disconnect(); } catch {} }
    // The context itself is NOT closed — see context.js.
    setSource(this.graph, null);
    this.el = null; this.elSource = null; this.stretch = null; this.buffer = null;
    this.mode = 'idle'; this.practiceTime = 0; this._practicePlaying = false;
    this._entering = null; this.engineStarts = 0;
  }
}

/* What a media element's error code actually means, said out loud. */
function mediaErrorText(el) {
  const code = el?.error?.code;
  if (code === 1) return 'Opening that song was stopped before it finished.';
  if (code === 2) return 'That song could not be read from the disk.';
  if (code === 3) return 'That song is damaged, or is in a format this app cannot read.';
  if (code === 4) return 'This app cannot play that kind of file. Try an MP3, an M4A, a WAV or a FLAC.';
  return 'That file would not open.';
}
