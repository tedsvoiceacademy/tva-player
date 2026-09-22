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
import { getSharedAudioContext, resumeSharedAudio, lastResumeFailure } from './context.js';
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
    /* Bumped every time the player is emptied for a new song. An engine takes
       seconds to build, and one that finishes after its song has gone must not
       be wired in — see the comment in _enterPracticeMode. */
    this.generation = 0;
  }

  /* ---- Opening ---------------------------------------------------------- */

  /**
   * @param song      the song to open
   * @param opts.timeoutMs how long to wait for it, and opts.onSlow is called
   *        part way so the person is told rather than left looking at nothing.
   */
  async open(song, opts = {}) {
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
    /* HOW LONG TO WAIT IS NOT THE SAME ON EVERY MACHINE. A song on a Windows
       disk is there or it is not; a song in OneDrive on a phone may not be on
       the phone at all yet, and opening it starts a download over whatever
       signal there is. Fifteen seconds is generous for a disk and far too
       little for that, so the platform says. */
    const waitMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 15000;
    await new Promise((resolve, reject) => {
      const done = () => { clearTimeout(timer); clearTimeout(slow); resolve(); };
      const timer = setTimeout(() => {
        clearTimeout(slow);
        reject(new Error('The song took too long to open. It may be a format this '
          + 'app cannot read, or the file may be somewhere it cannot reach.'));
      }, waitMs);
      /* Said part way rather than at the end. A person watching nothing happen
         for forty seconds has already decided the app is broken. */
      const slow = setTimeout(() => opts.onSlow?.(), Math.min(6000, waitMs / 2));
      el.addEventListener('loadedmetadata', done, { once: true });
      el.addEventListener('error', () => {
        clearTimeout(timer);
        clearTimeout(slow);
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

    /* ONLY WHILE THIS ELEMENT IS THE ONE MAKING THE SOUND.
     *
     * Moving onto the speed engine pauses the element, and a media element's
     * pause event arrives a moment LATER — after the engine has already started
     * and said it is playing. The display then read Play over a song that was
     * playing perfectly well. The same goes for its clock: an element that has
     * been left behind must not overwrite the engine's position. */
    const stillMine = () => this.el === el && this.mode === 'straight';
    el.addEventListener('timeupdate', () => {
      if (stillMine()) this.onTime(this.currentTime, this.duration);
    });
    el.addEventListener('durationchange', () => {
      if (stillMine()) this.onTime(this.currentTime, this.duration);
    });
    el.addEventListener('ended', () => { if (stillMine()) this.onState('ended'); });
    el.addEventListener('play', () => { if (stillMine()) this.onState('playing'); });
    el.addEventListener('pause', () => { if (stillMine()) this.onState('paused'); });

    this.onState('ready');
    return { duration: this.duration };
  }

  /* ---- Straight playback ------------------------------------------------ */

  /* Every reason a browser refuses to play, in words rather than a code. */
  async play() {
    const ctx = await resumeSharedAudio();
    /* THE SOUND OUTPUT ITSELF WOULD NOT START. This used to be swallowed, which
       left a play button that did nothing and no explanation anywhere. */
    if (ctx.state !== 'running') {
      throw new Error('The sound output would not start'
        + (lastResumeFailure ? `: ${lastResumeFailure}. ` : `; it is ${ctx.state}. `)
        + 'Choosing a different output under Set-up usually sorts this.');
    }
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
    const startedFor = this.song;
    const startedAt = this.generation;

    /* NOTHING THAT IS PLAYING IS TOUCHED UNTIL THE ENGINE IS READY.
     *
     * This used to pause the element FIRST and then spend several seconds
     * fetching the file, decoding it, compiling the stretch engine's WASM and
     * registering its worklet — and it wrote down, before all that, whether the
     * song was playing. Press play during the decode and the handover
     * disconnected a PLAYING element from the speakers and scheduled the engine
     * switched off, because the answer written down seconds earlier was "not
     * playing". Silence, no message, and nothing short of reopening the app
     * could reconnect it, because opening a song is the only thing that points
     * the graph back at an element.
     *
     * Ted hit exactly that: a song with 89% saved on it, play pressed while it
     * opened, and no sound — "then I closed it and reopened, opened a song and
     * it played."
     *
     * So the engine is built first and the handover is one block that reads
     * where the song actually is at the moment it happens. The song plays
     * normally throughout, and changing the speed no longer leaves a gap. */
    let built;
    try {
      built = await this._buildPracticeEngine(fetchBytes);
    } catch (err) {
      /* Nothing was changed, so there is nothing to put back: the song is still
         playing at normal speed, and the page says why the control refused. */
      throw new Error(`The speed and key engine would not start: ${err?.message ?? err}`);
    }

    /* AND THE SONG MAY HAVE MOVED ON WHILE IT BUILT. Opening another song
       during a build used to let the finished engine land on the new one —
       disconnecting ITS element, reporting the old song's length, and playing
       the old song's audio, with no way back, since both entry points
       short-circuit once the mode says 'practice'. An engine built for a song
       that is no longer open is thrown away instead. */
    if (startedAt !== this.generation || this.song !== startedFor || !this.el) {
      try { built.node.disconnect(); } catch { /* it never reached the graph */ }
      return null;
    }

    const at = this.currentTime;
    const wasPlaying = this.playing;          // NOW, not before the decode
    try {
      this.el.pause();
      this.buffer = built.buffer;
      this.stretch = built.node;
      this.mode = 'practice';
      this._practicePlaying = wasPlaying;
      setSource(this.graph, built.node);

      built.node.setUpdateInterval(0.05, (t) => {
        this.practiceTime = t;
        this.onTime(t, this.duration);
      });
      /* THE POSITION AND WHETHER IT IS RUNNING, IN ONE CALL. This was split into
         two for a while, on the theory that asking for both at once was what
         left the engine silent. It was not — the engine was already dead by this
         point, for the reason set out in _buildPracticeEngine — and splitting it
         changed nothing. One call, which is what the engine's own API expects. */
      built.node.schedule({ active: wasPlaying, input: at });
      this.practiceTime = at;
      this.onState(wasPlaying ? 'playing' : 'paused');
      return built.node;
    } catch (err) {
      /* THE HANDOVER ITSELF FAILED, which is the one path that can leave the
         graph half-swapped. The element goes back exactly where it was standing
         — same position, playing again if it was playing — and the page says
         why. A speed control that refuses is a nuisance; one that silently
         takes the sound away is a broken app. */
      this.stretch = null;
      this.buffer = null;
      this.mode = this.el ? 'straight' : 'idle';
      this._practicePlaying = false;
      if (this.el) {
        try {
          setSource(this.graph, this.elSource);
          if (Number.isFinite(at)) this.el.currentTime = at;
          if (wasPlaying) await this.el.play();
          this.onState(wasPlaying ? 'playing' : 'paused');
        } catch { /* the element is beyond helping; the message below still goes out */ }
      }
      throw new Error(`The speed and key engine would not start: ${err?.message ?? err}`);
    }
  }

  /** Decode the song and build the stretch node, touching nothing that is
   *  playing. Returns { node, buffer } for the caller to hand over in one go. */
  async _buildPracticeEngine(fetchBytes) {
    if (this.failEngineOnce) {
      // Set only by a check, to prove the app survives a failed engine start.
      this.failEngineOnce = false;
      throw new Error('deliberately broken for a check');
    }
    const bytes = await fetchBytes(this.song.url);
    const buffer = await this.ctx.decodeAudioData(bytes);

    const mod = await import('../vendor/SignalsmithStretch.mjs');
    /* ONE INPUT, NOT NONE — AND THIS IS THE WHOLE OF TED'S SILENT PLAYER.
     *
     * The node used to be built with numberOfInputs: 0, which is honest: it
     * plays a song held in memory and there is nothing to feed it. But the
     * stretch engine's own processor, on any block where it is not playing,
     * reaches for the live input it has not got:
     *
     *     let inputs = inputList[0];                 // undefined with no inputs
     *     if (!currentMapSegment.active) {
     *         outputList[0].forEach((_, c) => {
     *             let channelBuffer = inputs[c % inputs.length];   // throws
     *
     * A processor that throws is destroyed by the browser on the spot and never
     * runs again. So the engine died the first time it was asked to render while
     * paused — which is every time a song is opened with a speed already saved
     * on it, because the engine is built before anyone presses play. After that
     * it answered every question correctly: it reported its position, it accepted
     * a new speed, it said it was playing. It simply made no sound, ever, and
     * nothing but reopening the app could get any back. That is exactly what Ted
     * had: "I noticed the speed was at 89%... Still nothing, but then I closed it
     * and reopened, opened a song and it played."
     *
     * An input that is connected to nothing arrives as an empty array rather
     * than as undefined, so that line reads harmlessly and the processor lives.
     * The engine still takes its audio from the buffers handed to it: the branch
     * that would use a live input needs inputs.length above zero, and there is
     * nothing connected to it. NEVER SET THIS BACK TO ZERO. */
    const node = await mod.default(this.ctx, {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2],
    });

    /* AND IF IT DIES ANYWAY, SAY SO. This is reported nowhere else — not as an
       exception, not in the console — so without it a dead engine is a player
       that looks perfect and makes no sound. */
    /* WHAT KILLED IT, KEPT. A browser destroys a processor that throws and tells
       nobody — no exception, nothing in the console, and this event is the only
       place the reason appears. Thrown away, a dead engine on one machine and not
       another is a week of guessing; kept, the check that goes red says what
       threw. */
    node.onprocessorerror = (e) => this._engineDied(e?.message ?? String(e ?? 'no reason given'));

    const chans = [];
    for (let c = 0; c < buffer.numberOfChannels; c++) chans.push(buffer.getChannelData(c));
    // A mono recording is duplicated so the tail always has two sides to work
    // with, and the balance control still means something.
    if (chans.length === 1) chans.push(chans[0]);
    await node.addBuffers(chans);
    return { node, buffer };
  }

  /* THE ENGINE DIED, SO GO BACK TO PLAYING THE SONG NORMALLY.
   *
   * A browser destroys an audio processor that throws, and tells nobody: no
   * exception, nothing in the console, and a node that answers every question
   * correctly while making no sound at all. The cause of the one that bit Ted is
   * fixed above, and this is what happens if another ever turns up — the song
   * carries on at normal speed from where it was, and the page says so, rather
   * than the app going quiet with no way back. */
  _engineDied(why) {
    this.engineDiedWhy = why ?? null;
    const at = this.practiceTime;
    const wasPlaying = this._practicePlaying === true;
    this.stretch = null;
    this.buffer = null;
    this._practicePlaying = false;
    this.mode = this.el ? 'straight' : 'idle';
    if (this.el) {
      try {
        setSource(this.graph, this.elSource);
        if (Number.isFinite(at)) this.el.currentTime = Math.max(0, at);
        if (wasPlaying) this.el.play().catch(() => {});
      } catch { /* the element is beyond helping; the message still goes out */ }
    }
    this.onState('engine-died');
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
    /* Any engine still building belongs to the song that just went. */
    this.generation++;
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
