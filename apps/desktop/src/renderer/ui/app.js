/* Wiring the console to the player.
 *
 * The dials, the wave and the named-part rows are all drawn by this script, and
 * the knob technique is ported from the members player: each dial is a real
 * <input type="range"> laid over it at zero opacity, so the input stays the one
 * source of truth — arrow keys work, screen readers read it, and a test can
 * drive it the way a browser does.
 */
import { Player, PRACTICE_MAX_SECONDS } from '../audio/player.js';
import { Recorder } from '../audio/recorder.js';
import { Metronome } from '../audio/metronome.js';
import { listMicrophones, listOutputs, openMic, openSystemAudio, MAX_MIC_CHANNELS } from '../audio/mic.js';
import { setMicGain } from '../audio/graph.js';
import {
  sanitizePlayerSettings, DEFAULT_PLAYER_SETTINGS, sanitizeSections,
  emptySongFile, xToTime, dragToLoopRegion, isClickNotDrag,
  formatTime, parseTime, applyLoopEdit, nudgeLoop, MAX_SECTIONS,
  sanitizeNotes, addNote, detectPitchYin, noteFromHz,
  floatToInt16, interleave, looksLikeWav, dataBytesForFileSize, WAV_HEADER_BYTES,
  mixSlice, mixLengthFrames, mp3KbpsFor,
} from '../practice-core.js';

const $ = (id) => document.getElementById(id);
const player = new Player();
const recorder = new Recorder(player.graph);
const metronome = new Metronome(player.graph);

let library = { folders: [], songs: [] };
let takes = [];
let micOpen = false;
/* THE MICROPHONES, once Windows has said how many there are.
 *
 *   micChannels  how many inputs the open device handed over
 *   micUse       one per input: is there a microphone worth recording on it
 *   micGains     one per input, in decibels — kept per device, so plugging the
 *                interface back in next week finds the levels where they were
 *   micLive      the inputs in use, in order; a lane in the well each
 *   micSelected  WHICH LANE the gain buttons act on, named on the panel rather
 *                than remembered
 */
let micDeviceId = '';
let micChannels = 0;
let micUse = [];
let micGains = [];
let micLive = [];
let micSelected = 0;
const MIC_GAIN_MIN = -20;
const MIC_GAIN_MAX = 36;
let tunerTimer = null;

let song = null;
let file = null;
let settings = { ...DEFAULT_PLAYER_SETTINGS };
/* Zero in the app. Set only by a check — see __tvaSlowEngine. */
let slowEngineMs = 0;
let duration = 0;
let peaks = null;
let dragRegion = null;
let saveTimer = null;

/* The status line. When there is nothing to report it shows what is currently
   set instead of going blank, because a lit panel with an empty line under the
   clock reads as something being broken. */
function say(t) {
  $('msg').textContent = t || restingLine();
}

function restingLine() {
  if (!song) return 'Open a song to start.';
  const bits = [];
  if (settings.speed !== 1) bits.push(`${Math.round(settings.speed * 100)}% speed`);
  if (settings.halfSteps !== 0) bits.push(keyLabel(settings.halfSteps).toLowerCase());
  if (settings.balance !== 0) bits.push(balanceLabel(settings.balance).toLowerCase());
  if (settings.leadQuieter) bits.push('lead turned down');
  if (settings.looping && settings.loopA != null && settings.loopB != null) {
    bits.push(`looping ${formatTime(settings.loopA, true)}–${formatTime(settings.loopB, true)}`);
  }
  return bits.length ? bits.join(' · ') : 'Playing as recorded.';
}

/* ---- Labels, in the same words the members player uses ------------------ */

const speedLabel = (v) => (v === 1 ? 'Normal' : `${Math.round(v * 100)}% speed`);
const keyLabel = (n) => (n === 0
  ? 'As recorded'
  : `${n > 0 ? 'Up' : 'Down'} ${Math.abs(n)} half step${Math.abs(n) === 1 ? '' : 's'}`);
const balanceLabel = (b) => {
  const at = Math.round(b * 100);
  if (at === 0) return 'Both sides';
  if (at === 100) return 'Right side only';
  if (at === -100) return 'Left side only';
  return at > 0 ? `Left side ${at}% down` : `Right side ${-at}% down`;
};

/* ---- Saving ------------------------------------------------------------- */

/* Saving is held back for 900ms so that turning a dial does not write a file on
   every pixel. That delay made a real mess of switching songs, and it took a
   check going red once in several runs to see it: what got written was read at
   the moment the timer FIRED, so a change to one song that had not been written
   yet was saved into the next song's file instead, position and all — and the
   change to the first song was lost.
 *
 * So what to write is taken NOW, and opening a song writes any waiting one
 * first. */
let pendingSave = null;

function saveSoon() {
  if (!song) return;
  pendingSave = { ...file, settings, lastPositionSec: player.currentTime };
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, 900);
}

async function flushSave() {
  clearTimeout(saveTimer);
  const snapshot = pendingSave;
  pendingSave = null;
  if (!snapshot) return;
  const saved = await window.tva.saveSong(snapshot);
  // Only adopt it if it is still the song on screen.
  if (saved && song && song.songKey === saved.songKey) file = saved;
}

/* ---- The practice engine ------------------------------------------------
 *
 * Only started when something actually needs it, because it decodes the whole
 * song. Playing a song straight through never pays for that.
 *
 * Every call while one is already starting gets the same promise back — see
 * the comment on enterPracticeMode. Dragging a knob fires this on every pixel
 * of movement, and starting a decode per pixel is what froze the app. */
async function ensurePracticeMode() {
  if (player.mode === 'practice') return true;
  if (settings.speed === 1 && settings.halfSteps === 0 && !settings.looping) return false;

  if (duration > PRACTICE_MAX_SECONDS) {
    say(`This song is ${formatTime(duration)} long. Speed and key hold the whole song in `
      + `memory, so they stop at ${Math.round(PRACTICE_MAX_SECONDS / 60)} minutes. `
      + 'Everything else still works.');
    return false;
  }

  say('Getting the speed and key controls ready…');
  /* WHICH SONG THIS WAS STARTED FOR. Building the engine takes seconds, and a
     song can be opened in the middle of it. The player throws away an engine
     built for a song that has gone; this is the half that stops the page then
     painting a message about it. */
  const startedFor = song;
  let node;
  try {
    node = await player.enterPracticeMode(async (url) => {
      if (slowEngineMs > 0) await new Promise((r) => setTimeout(r, slowEngineMs));
      return (await fetch(url)).arrayBuffer();
    });
  } catch (err) {
    /* IT SAYS SO, AND THE SONG KEEPS PLAYING.
     *
     * This used to be an uncaught rejection. Switching engines pauses the song
     * before it does anything else, so a failure here took the sound away and
     * left no message and no way back — Ted had to kill the program from Task
     * Manager to hear anything again. The player puts itself back to normal
     * speed now; this is the part that tells him why the control refused,
     * instead of a dial that moves and a room that goes quiet. */
    if (song !== startedFor) return false;    // another song is open; nothing to say
    say(`${err?.message ?? 'The speed and key controls could not start.'} `
      + 'The song is still playing at normal speed.');
    settings = sanitizePlayerSettings({ ...settings, speed: 1, halfSteps: 0 });
    paintControls();
    return false;
  }
  if (song !== startedFor) return false;      // another song is open; nothing to say
  if (!node) { say('The speed and key controls could not start for this song.'); return false; }
  // Whatever the knobs say NOW, not what they said when this started.
  player.applyPractice(settings);
  pushLoop();
  say('');
  return true;
}

function applyAll() {
  player.setBalance(settings.balance);
  player.setVolume(settings.volume);
  player.setTail({ leadQuieter: settings.leadQuieter, oneSpeaker: $('onespk').checked });
  player.applyPractice(settings);
}

function pushLoop() {
  const on = settings.looping && settings.loopA != null && settings.loopB != null;
  player.setLoop(on ? settings.loopA : null, on ? settings.loopB : null);
  $('lamp-loop').classList.toggle('lit', on);
}

/* ---- Opening ------------------------------------------------------------ */

/* OPENING ONE SONG AT A TIME.
 *
 * Opening a song waits several times — for the last song's settings to be
 * written, for the file's length to arrive, for its stored settings to be read.
 * Two opens close together therefore INTERLEAVE, and the older one comes back
 * to life partway through the newer one and carries on setting things: the
 * length, the dials, and `peaks = null`, which blanks the wave of a song that
 * had already drawn it.
 *
 * It showed up as the waveform being blank now and again, which reads as the
 * app being slow rather than as a fault. So the opens are queued: the second
 * one starts when the first has finished, and nothing is ever half-applied. */
let openChain = Promise.resolve();

function openSong(next) {
  openChain = openChain.catch(() => {}).then(() => openSongNow(next));
  return openChain;
}

async function openSongNow(next) {
  /* THE NAME CHANGES BEFORE ANYTHING IS WAITED FOR. Putting the save first
     meant clicking a song in the list left the old song's name on the display
     until the file had been read — on a slow drive, noticeably. The old wave
     goes at the same moment, so the window never shows one song's name over
     another song's picture. */
  song = next;
  $('now-name').textContent = next.name.toUpperCase();
  peaks = null;
  drawWave();
  say('Opening that song…');

  await flushSave();               // whatever the last song was owed, before it goes

  try {
    const { duration: d } = await player.open(next, {
      timeoutMs: window.tva.openTimeoutMs ?? 15000,
      onSlow: () => say('Still opening that song. If it lives in OneDrive or Drive '
        + 'it may be downloading to the phone first.'),
    });
    duration = d;
  } catch (err) {
    // The real reason, not a guess at it.
    say(err?.message ?? 'That file would not open.');
    $('now-name').textContent = 'COULD NOT OPEN';
    $('play').disabled = true;
    song = null;
    paintRecord();
    /* AND THEN THE REAL REASON UNDERNEATH IT. A media element that cannot read
       a file says "no supported source" and nothing else, so the sentence above
       can only ever be a guess. Where the platform can walk the steps itself —
       can the file be described, does it have a length, do bytes come out of it
       — it says which one failed. Asked after the message rather than before it,
       so the app never sits silent while it finds out. */
    Promise.resolve(tellPlatform('whySongFailed', next)).then((why) => {
      if (why && song === null) say(why);
    }).catch(() => {});
    return;
  }

  file = (await window.tva.loadSong(next.songKey))
      ?? emptySongFile(next.songKey, next.name, 'this computer');
  settings = sanitizePlayerSettings(file.settings);

  applyAll();
  paintControls();
  paintLoop();
  paintSections();
  paintNotes();
  paintLibrary();
  if (file.bpm) $('bpm').value = String(file.bpm);
  if (Number.isFinite(file.countInBars)) $('countbars').value = String(file.countInBars);
  pushLoop();

  if (file.lastPositionSec > 0 && file.lastPositionSec < duration - 1) {
    player.seek(file.lastPositionSec);
    say(`Picking up where you left off, at ${formatTime(file.lastPositionSec)}`);
  } else {
    say('Ready. Press play.');
  }

  $('play').disabled = false;
  paintRecord();
  paintTimes(player.currentTime);
  drawWave();
  paintRuler();

  const openedKey = next.songKey;
  computePeaks(next.url).then((p) => {
    // A second song may have been opened while this one was being measured.
    if (p && song && song.songKey === openedKey) { peaks = p; drawWave(); }
  });

  // If the song was left with a speed or key set, get the engine ready now
  // rather than making the first knob touch wait for a whole decode.
  if (settings.speed !== 1 || settings.halfSteps !== 0 || settings.looping) ensurePracticeMode();
}

/* ---- Painting ----------------------------------------------------------- */

const SWEEP = 122.5;                       // three-quarters of a radius-26 circle

/* WHERE TWELVE O'CLOCK IS.
 *
 * Ted asked for Speed to run from a quarter speed to double, with normal
 * straight up. Those are not the same distance from 100, so a dial that maps
 * its range evenly would put normal at about four o'clock. A knob that carries
 * data-centre therefore bends in the middle: the lower half of the sweep covers
 * min→centre and the upper half covers centre→max. The VALUE the control
 * reports is untouched — only where the dial draws it changes. */
function knobFraction(knob, value) {
  const input = knob.querySelector('input');
  const min = Number(input.min), max = Number(input.max);
  if (!(max > min)) return 0;
  const centre = knob.dataset.centre === undefined ? null : Number(knob.dataset.centre);
  if (centre === null) return (value - min) / (max - min);
  if (value <= centre) return centre > min ? 0.5 * ((value - min) / (centre - min)) : 0;
  return max > centre ? 0.5 + 0.5 * ((value - centre) / (max - centre)) : 1;
}

function knobValue(knob, frac) {
  const input = knob.querySelector('input');
  const min = Number(input.min), max = Number(input.max);
  const centre = knob.dataset.centre === undefined ? null : Number(knob.dataset.centre);
  const f = Math.max(0, Math.min(1, frac));
  if (centre === null) return min + f * (max - min);
  return f <= 0.5 ? min + (f / 0.5) * (centre - min)
                  : centre + ((f - 0.5) / 0.5) * (max - centre);
}

function paintKnob(input) {
  const knob = input.closest('.knob');
  if (!knob) return;
  const frac = knobFraction(knob, Number(input.value));
  const from = knob.dataset.centre === undefined
    ? 0 : knobFraction(knob, Number(knob.dataset.centre));
  const lo = Math.min(frac, from);
  const fill = knob.querySelector('.k-fill');
  fill.style.strokeDasharray = `${Math.abs(frac - from) * SWEEP} 1000`;
  fill.style.transform = `rotate(${135 + lo * 270}deg)`;
  knob.querySelector('.k-ptr').style.transform = `rotate(${-135 + frac * 270}deg)`;
}

function paintControls() {
  $('speed').value = String(Math.round(settings.speed * 100));
  $('speed-val').textContent = speedLabel(settings.speed);
  $('key').value = String(settings.halfSteps);
  $('key-val').textContent = keyLabel(settings.halfSteps);
  $('balance').value = String(Math.round(settings.balance * 100));
  $('balance-val').textContent = balanceLabel(settings.balance);
  $('volume').value = String(Math.round(settings.volume * 100));
  $('volume-val').textContent = `${Math.round(settings.volume * 100)}%`;
  $('natural').checked = settings.naturalVoice;
  $('lead').checked = settings.leadQuieter;
  for (const k of document.querySelectorAll('.knob input')) paintKnob(k);
  paintChips();
}

function paintChips() {
  const at = Math.round(settings.balance * 100);
  for (const chip of document.querySelectorAll('.chip[data-balance]')) {
    chip.classList.toggle('on', Number(chip.dataset.balance) === at);
  }
}

function paintLoop() {
  const both = settings.loopA != null && settings.loopB != null;
  $('loop-a').value = settings.loopA == null ? '' : formatTime(settings.loopA, true);
  $('loop-b').value = settings.loopB == null ? '' : formatTime(settings.loopB, true);
  const onBtn = $('loop-on');
  onBtn.disabled = !both;
  onBtn.setAttribute('aria-pressed', String(settings.looping));
  onBtn.textContent = settings.looping ? 'Looping is on' : 'Looping is off';
  $('namerow').hidden = !both;
}

function paintSections() {
  const host = $('sections');
  host.textContent = '';
  const list = settings.sections ?? [];
  $('sections-empty').hidden = list.length > 0;

  list.forEach((sec, i) => {
    const row = document.createElement('div');
    row.className = 'item';

    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = sec.name;

    const when = document.createElement('span');
    when.className = 'when';
    when.textContent = `${formatTime(sec.a, true)} – ${formatTime(sec.b, true)}`;

    const left = document.createElement('span');
    left.className = 'itext';
    left.append(name, when);

    const play = document.createElement('button');
    play.type = 'button'; play.className = 'chip'; play.textContent = 'Play this loop';
    play.addEventListener('click', async () => {
      settings = sanitizePlayerSettings({ ...settings, loopA: sec.a, loopB: sec.b, looping: true });
      paintLoop(); drawWave();
      await ensurePracticeMode();
      pushLoop();
      player.seek(sec.a);
      await player.play();
      saveSoon();
    });

    const drop = document.createElement('button');
    drop.type = 'button'; drop.className = 'chip'; drop.textContent = 'Remove';
    drop.addEventListener('click', () => {
      const next = [...list]; next.splice(i, 1);
      settings = sanitizePlayerSettings({ ...settings, sections: next });
      paintSections(); saveSoon();
    });

    const acts = document.createElement('span');
    acts.className = 'iacts';
    acts.append(play, drop);
    row.append(left, acts);
    host.append(row);
  });
}

function paintTimes(now) {
  $('t-now').textContent = formatTime(now);
  $('t-total').textContent = formatTime(duration);
}

function paintRuler() {
  const ruler = $('ruler');
  ruler.textContent = '';
  if (duration <= 0) return;
  for (let i = 0; i <= 4; i++) {
    const s = document.createElement('span');
    s.textContent = formatTime((duration * i) / 4);
    ruler.append(s);
  }
}

/* ---- The wave ------------------------------------------------------------
 *
 * Twice the height of the members one, because a desktop window has the room
 * and marking a part by eye is the whole point of it being there. */

const PEAK_COUNT = 640;

/* Working out the shape of the song, without paying for a full decode.
 *
 * The members player gets this free: it decodes the whole song to play it
 * anyway. Here a song normally streams from disk and is never decoded at all,
 * so the wave would be a flat line — which is what the first build shipped.
 *
 * Decoding into an 8 kHz context instead of the usual 48 kHz gives a buffer a
 * sixth of the size, and the shape of a waveform drawn 640 bars wide is
 * identical either way. It runs after the song is already playing, so it never
 * delays the first note. */
/* ONE decode context for every song, rather than a fresh one per song.
 *
 * (An earlier comment here claimed a browser caps how many audio contexts may
 * exist and that exceeding it was making the speed and key engine render
 * silence. That was measured afterwards and is NOT true — thirty offline
 * contexts were created and rendered in a row with no trouble at all. The
 * claim is removed rather than left standing, because a wrong explanation in a
 * comment is worse than none: it sends the next person looking in the wrong
 * place. Reusing one context is still right, simply because making a new one
 * per song buys nothing.) */
let peakCtx = null;
function getPeakContext() {
  if (!peakCtx) {
    /* Two channels, because the wave is drawn a side at a time. */
    peakCtx = new OfflineAudioContext({ numberOfChannels: 2, length: 1, sampleRate: 8000 });
  }
  return peakCtx;
}

/* EACH SIDE IS MEASURED SEPARATELY.
 *
 * Ted: "The audio visualization window needs to be able to see both right and
 * left channels separately when a stereo track - not one image so it looks
 * mono." That matters here more than in most players, because Pan and Turn the
 * lead singer down both act on the difference between the sides — so seeing
 * that a part sits on one side is the reason to reach for the dial.
 *
 * Both sides are scaled by the SAME ceiling, not one each. Normalising them
 * apart would draw a quiet side as loud as a loud one, which is the one thing
 * this picture must not do. */
function channelPeaks(data, count) {
  const per = Math.max(1, Math.floor(data.length / count));
  const out = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    let top = 0;
    const start = i * per;
    for (let j = start; j < start + per && j < data.length; j++) {
      const v = Math.abs(data[j]);
      if (v > top) top = v;
    }
    out[i] = top;
  }
  return out;
}

async function computePeaks(url) {
  try {
    const bytes = await (await fetch(url)).arrayBuffer();
    const buf = await getPeakContext().decodeAudioData(bytes);
    const left = channelPeaks(buf.getChannelData(0), PEAK_COUNT);
    const right = buf.numberOfChannels > 1
      ? channelPeaks(buf.getChannelData(1), PEAK_COUNT) : null;

    let ceiling = 0.01;
    for (let i = 0; i < PEAK_COUNT; i++) {
      if (left[i] > ceiling) ceiling = left[i];
      if (right && right[i] > ceiling) ceiling = right[i];
    }
    for (let i = 0; i < PEAK_COUNT; i++) {
      left[i] /= ceiling;
      if (right) right[i] /= ceiling;
    }
    return { left, right };
  } catch {
    return null;   // a flat line is a worse wave, not a broken app
  }
}

/* THE WAVE IS PAINTED, NOT STYLED, so it is the one thing a skin cannot reach
   on its own — and with ten skins it is the likeliest place for a hard-coded
   navy-and-gold to survive unnoticed. Its colours come out of the same tokens
   as everything else, cached because reading computed style twenty times a
   second is real work for no gain. Changing skin clears the cache. */
let waveInk = null;

function waveColours() {
  if (waveInk) return waveInk;
  const css = getComputedStyle(document.documentElement);
  const v = (name, fallback) => (css.getPropertyValue(name).trim() || fallback);
  waveInk = {
    played: v('--wave-played', '#d4a84b'),
    ahead: v('--wave-ahead', '#33507f'),
    head: v('--wave-head', '#f5f0e1'),
    flat: v('--wave-flat', '#16294a'),
    loop: v('--wave-loop', '212, 168, 75'),
    live: v('--wave-live', '#56c39a'),
    liveRec: v('--rec-hi', '#e06060'),
    liveBed: v('--wave-flat', '#16294a'),
  };
  return waveInk;
}

/* ========================================================================
   WHAT THE MICROPHONES ARE HEARING, AS IT HAPPENS
   ========================================================================

   Ted: "Let me see the recording audio signal as it is generated so I can see
   what is recording in that visual way as well." A bar tells you how loud one
   moment is; it cannot show you the phrase you just sang, and with four
   microphones it cannot show you which of them the sound came from.

   So each microphone gets a lane under the song's own waveform, scrolling from
   the right, and the part that is actually being recorded is drawn in the
   record colour rather than the listening one.

   IT COSTS NO EXTRA AUDIO WORK. The level meter already measures the peak and
   the average of every channel twenty times a second, which is one column every
   fifty milliseconds — fast enough to watch a phrase go by. Nothing new is read
   off the audio thread to draw this.
*/
const LIVE_COL_PX = 2;
const LIVE_MAX_COLS = 900;      // about 45 seconds of history at 20 a second
const LIVE_LANE_PX = 17;
let liveCols = [];              // [{ p: [peak per mic], r: [rms per mic], rec: bool }]
let liveChannels = 0;
let liveNames = [];

function liveStripHeight(h) {
  if (!micOpen || liveChannels === 0) return 0;
  /* Never more than half the well. Eight microphones would otherwise leave the
     song a sliver, and the song is what the loop is marked on. */
  return Math.min(Math.round(h * 0.5), liveChannels * LIVE_LANE_PX + 2);
}

function pushLiveColumn(peaks, rms) {
  liveCols.push({ p: peaks, r: rms, rec: recorder.running });
  if (liveCols.length > LIVE_MAX_COLS) liveCols.splice(0, liveCols.length - LIVE_MAX_COLS);
}

function drawLiveStrip(g, w, top, height, ink) {
  const lanes = liveChannels;
  const laneH = (height - 2) / lanes;
  const columns = Math.floor(w / LIVE_COL_PX);
  const from = Math.max(0, liveCols.length - columns);

  g.fillStyle = ink.liveBed;
  g.fillRect(0, top + 2, w, height - 2);
  g.fillStyle = 'rgba(128,128,128,0.35)';
  g.fillRect(0, top, w, 1);

  for (let lane = 0; lane < lanes; lane++) {
    const laneTop = top + 2 + lane * laneH;
    const centre = laneTop + laneH / 2;
    const room = (laneH - 3) / 2;

    if (lanes > 1 && lane === micSelected) {
      g.fillStyle = `rgba(${ink.loop}, 0.14)`;
      g.fillRect(0, laneTop, w, laneH);
    }

    g.fillStyle = 'rgba(128,128,128,0.22)';
    g.fillRect(0, Math.round(centre), w, 1);

    for (let i = from; i < liveCols.length; i++) {
      const col = liveCols[i];
      const peak = col.p[lane] ?? 0;
      const x = w - (liveCols.length - i) * LIVE_COL_PX;
      if (x < 0) continue;
      const tall = Math.max(1, Math.min(room, peak * room) * 2);
      g.fillStyle = col.rec ? ink.liveRec : ink.live;
      g.fillRect(x, centre - tall / 2, LIVE_COL_PX - 0.5, tall);
    }

    /* The name goes ON the lane, with its gain, so nothing about which lane is
       which or what it is set to has to be remembered or hovered for. */
    g.font = '600 9px Consolas, ui-monospace, monospace';
    g.fillStyle = ink.head;
    g.globalAlpha = lane === micSelected || lanes === 1 ? 0.85 : 0.5;
    const name = liveNames[lane] ?? `MIC ${lane + 1}`;
    const db = micGains[micLive[lane]] ?? 0;
    const shown = micLive.length ? `${name}${db ? `  ${db > 0 ? '+' : ''}${db} dB` : ''}` : name;
    g.fillText(shown, 4, laneTop + Math.min(laneH - 3, 10));
    g.globalAlpha = 1;
  }
}

function drawWave() {
  const canvas = $('wave');
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (w === 0) return;
  canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
  const g = canvas.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);

  const played = duration > 0 ? player.currentTime / duration : 0;
  const ink = waveColours();

  /* WHILE THE MICROPHONE IS ON the song gives up the bottom of the well to a
     live picture of what is coming in. The well itself does not change size:
     at 1024 pixels wide the case has 124 pixels of bench under it, and taking
     any of that would push the tabs off the bottom of the screen — which is a
     fault this app has shipped once already. */
  const strip = liveStripHeight(h);
  const songH = h - strip;
  const mid = songH / 2;

  // The marked part, behind everything.
  const region = dragRegion
    ?? (settings.loopA != null && settings.loopB != null
      ? { a: settings.loopA, b: settings.loopB } : null);
  if (region && duration > 0) {
    const x1 = (region.a / duration) * w, x2 = (region.b / duration) * w;
    g.fillStyle = `rgba(${ink.loop}, ${dragRegion ? 0.3 : 0.18})`;
    g.fillRect(x1, 0, Math.max(1, x2 - x1), songH);
    g.fillStyle = `rgba(${ink.loop}, 0.8)`;
    g.fillRect(x1, 0, 1, songH); g.fillRect(x2 - 1, 0, 1, songH);
  }

  if (peaks) {
    const bw = w / peaks.left.length;
    const lanes = peaks.right
      ? [{ data: peaks.left, mid: songH * 0.27, room: songH * 0.24, tag: 'L' },
         { data: peaks.right, mid: songH * 0.73, room: songH * 0.24, tag: 'R' }]
      : [{ data: peaks.left, mid, room: songH * 0.44, tag: 'MONO' }];

    for (const lane of lanes) {
      for (let i = 0; i < lane.data.length; i++) {
        const tall = Math.max(1.5, lane.data[i] * lane.room * 2);
        g.fillStyle = (i / lane.data.length) <= played ? ink.played : ink.ahead;
        g.fillRect(i * bw, lane.mid - tall / 2, Math.max(1, bw - 0.6), tall);
      }
    }

    // The line between the two sides, and a word saying which is which.
    if (peaks.right) {
      g.fillStyle = 'rgba(128,128,128,0.35)';
      g.fillRect(0, mid, w, 1);
    }
    /* The lettering sits just INSIDE the top of its own lane. Placed above it,
       the baseline of the upper one landed off the top of the canvas and the
       letter never appeared at all. */
    g.font = '600 9px Consolas, ui-monospace, monospace';
    g.globalAlpha = 0.5;
    g.fillStyle = ink.head;
    for (const lane of lanes) g.fillText(lane.tag, 4, Math.max(9, lane.mid - lane.room + 8));
    g.globalAlpha = 1;
  } else {
    g.fillStyle = ink.flat;
    g.fillRect(0, mid - 1, w, 2);
  }

  g.fillStyle = ink.head;
  g.fillRect(Math.min(played * w, w - 2), 0, 2, songH);

  if (strip > 0) drawLiveStrip(g, w, songH, strip, ink);
}

/* ---- Events ------------------------------------------------------------- */

player.onTime = (now, total) => {
  if (Number.isFinite(total) && total > 0 && total !== duration) {
    duration = total; paintRuler();
  }
  paintTimes(now); drawWave();
  $('note-at').textContent = formatTime(now);
};
/* ---- telling the platform what is playing -------------------------------
 *
 * ASKED FOR RATHER THAN ASSUMED, because only one of the two machines needs it.
 * A page on Android is something the phone is entitled to freeze when it is not
 * on the screen, so pressing the power button mid-practice stopped the song —
 * and the fix is to tell Android what is playing, which is also what puts it on
 * the lock screen. Windows does not freeze an app that is playing and already
 * has the media keys, so it does not implement these at all and they are
 * deliberately optional.
 */
const tellPlatform = (name, ...args) => window.tva[name]?.(...args);

let saidCannotKeepPlaying = false;
function toldThePlatform(state) {
  if (state === 'playing') {
    Promise.resolve(tellPlatform('nowPlaying', {
      title: song ? song.name : 'TVA Player',
      playing: true,
      positionSec: player.currentTime,
      durationSec: duration,
    })).then((answer) => {
      /* Android 13 and later ask before an app may show a notification, and the
         notification is what makes the song survive the screen going off. Said
         once, in words, rather than leaving it a mystery later. */
      if (answer && answer.canKeepPlaying === false && !saidCannotKeepPlaying) {
        saidCannotKeepPlaying = true;
        say('Without permission to show a notification, the song stops when the '
          + 'screen goes off. You can turn notifications on for TVA Player in Settings.');
      }
    }).catch(() => {});
    return;
  }
  if (state === 'ended' || state === 'stopped') { tellPlatform('playbackStopped'); return; }
  tellPlatform('nowPlaying', {
    title: song ? song.name : 'TVA Player',
    playing: false,
    positionSec: player.currentTime,
  });
}

player.onState = (state) => {
  /* The speed engine was destroyed by the browser and the player has put the
     song back on normal playback. Said out loud, with the dials put back to
     match what is actually being heard. */
  if (state === 'engine-died') {
    say('The speed and key engine stopped, so the song is playing at normal speed '
      + 'again from where it was. Setting the speed again will start a fresh one.');
    settings = sanitizePlayerSettings({ ...settings, speed: 1, halfSteps: 0 });
    paintControls();
  }
  const playing = state === 'playing';
  /* A class, not the hidden attribute. Measured in the real window, both SVGs
     computed to display:block with hidden set, so the button showed the pause
     bars while its label said Play. */
  $('ico-play').classList.toggle('off', playing);
  $('ico-pause').classList.toggle('off', !playing);
  $('play').setAttribute('aria-label', playing ? 'Pause' : 'Play');
  $('lamp-play').classList.toggle('lit', playing);
  toldThePlatform(state);
  if (state === 'ended') {
    saveSoon();
    playNext(1).then((moved) => { if (!moved) say('That was the last one.'); });
  }
};

/* The lock screen, the notification, and the buttons on a pair of headphones.
   They reach the same functions the buttons on screen do — there is one play
   and one pause, not a second set that can disagree with the first. */
/* EVERY ORDER THE PHONE GIVES, kept. A song that stops has two very different
   causes — the phone told it to, or the sound simply went away — and they look
   identical from outside. The check on a real phone reads this to tell them
   apart. It is a short list of small objects and is never trimmed because it
   never grows: these arrive when a person presses something. */
window.__tvaNativeCommands = [];
tellPlatform('onPlaybackCommand', (action) => {
  window.__tvaNativeCommands.push({ action, at: Date.now() });
  if (action === 'play') { player.play().catch(() => {}); return; }
  if (action === 'pause') { player.pause(); saveSoon(); return; }
  if (action === 'stop') { player.stop(); saveSoon(); return; }
  if (action === 'next') { playNext(1); return; }
  if (action === 'previous') { playNext(-1); return; }
  if (action.startsWith('seek:')) {
    const ms = Number(action.slice(5));
    if (Number.isFinite(ms)) player.seek(ms / 1000);
  }
});

$('open').addEventListener('click', () => window.tva.openSongs());
$('play').addEventListener('click', async () => {
  if (player.playing) { player.pause(); saveSoon(); return; }
  try {
    await player.play();
  } catch (err) {
    say(err?.message ?? 'This song would not start playing.');
  }
});
$('stop').addEventListener('click', () => { player.stop(); saveSoon(); toldThePlatform('stopped'); });
$('back10').addEventListener('click', () => player.seek(player.currentTime - 10));
$('fwd10').addEventListener('click', () => player.seek(player.currentTime + 10));

/* Click to jump, drag to mark a part. Both on the wave, told apart by how far
   the pointer travelled — the same rule the members player uses. */
function wireWave() {
  const canvas = $('wave');
  let drag = null;
  const timeAt = (e) => {
    const r = canvas.getBoundingClientRect();
    return { t: xToTime(e.clientX - r.left, r.width, duration), x: e.clientX };
  };

  canvas.addEventListener('pointerdown', (e) => {
    if (!song) return;
    const { t, x } = timeAt(e);
    drag = { from: t, x, id: e.pointerId };
    try { canvas.setPointerCapture(e.pointerId); } catch {}
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    if (isClickNotDrag(e.clientX - drag.x)) return;
    dragRegion = dragToLoopRegion(drag.from, timeAt(e).t);
    drawWave();
  });

  const finish = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const moved = !isClickNotDrag(e.clientX - drag.x);
    const region = moved ? dragToLoopRegion(drag.from, timeAt(e).t) : null;
    drag = null; dragRegion = null;
    try { canvas.releasePointerCapture(e.pointerId); } catch {}

    if (region) {
      settings = sanitizePlayerSettings({
        ...settings, loopA: region.a, loopB: region.b, looping: true,
      });
      paintLoop(); drawWave(); saveSoon();
      ensurePracticeMode().then(pushLoop);
    } else {
      player.seek(timeAt(e).t); saveSoon();
    }
  };
  canvas.addEventListener('pointerup', finish);
  canvas.addEventListener('pointercancel', finish);
}

/* Turning a dial is a vertical drag, which is what a real one does under a
   finger. A full sweep takes 150px, so a small move is a small change.
 *
 * The drag works in dial positions rather than in values, so a dial that bends
 * in the middle turns evenly under the hand instead of racing through one half.
 *
 * DOUBLE-CLICK PUTS A DIAL BACK to what data-default says, which is what every
 * dial on a desk does and what Ted expected of these. */
function wireKnobs() {
  for (const knob of document.querySelectorAll('.knob')) {
    const input = knob.querySelector('input');
    const step = Number(input.step) || 1;
    const min = Number(input.min), max = Number(input.max);

    const put = (value) => {
      const next = Math.max(min, Math.min(max, Math.round(value / step) * step));
      if (String(next) === input.value) return;
      input.value = String(next);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    };

    knob.addEventListener('dblclick', (e) => {
      e.preventDefault();
      if (knob.dataset.default === undefined) return;
      put(Number(knob.dataset.default));
      say('');
    });

    let drag = null;
    knob.addEventListener('pointerdown', (e) => {
      if (e.detail > 1) return;          // leave the second click to dblclick
      drag = { y: e.clientY, from: knobFraction(knob, Number(input.value)), id: e.pointerId };
      try { knob.setPointerCapture(e.pointerId); } catch {}
      input.focus(); e.preventDefault();
    });
    knob.addEventListener('pointermove', (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      put(knobValue(knob, drag.from + (drag.y - e.clientY) / 150));
    });
    const end = (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      drag = null;
      try { knob.releasePointerCapture(e.pointerId); } catch {}
    };
    knob.addEventListener('pointerup', end);
    knob.addEventListener('pointercancel', end);
    input.addEventListener('input', () => paintKnob(input));
  }
}

$('speed').addEventListener('input', async (e) => {
  settings = sanitizePlayerSettings({ ...settings, speed: Number(e.target.value) / 100 });
  $('speed-val').textContent = speedLabel(settings.speed);
  saveSoon(); say('');
  if (await ensurePracticeMode()) player.applyPractice(settings);
});
$('key').addEventListener('input', async (e) => {
  settings = sanitizePlayerSettings({ ...settings, halfSteps: Number(e.target.value) });
  $('key-val').textContent = keyLabel(settings.halfSteps);
  saveSoon(); say('');
  if (await ensurePracticeMode()) player.applyPractice(settings);
});
$('balance').addEventListener('input', (e) => {
  settings = sanitizePlayerSettings({ ...settings, balance: Number(e.target.value) / 100 });
  $('balance-val').textContent = balanceLabel(settings.balance);
  player.setBalance(settings.balance); paintChips(); saveSoon(); say('');
});
$('volume').addEventListener('input', (e) => {
  settings = sanitizePlayerSettings({ ...settings, volume: Number(e.target.value) / 100 });
  $('volume-val').textContent = `${Math.round(settings.volume * 100)}%`;
  player.setVolume(settings.volume); saveSoon(); say('');
});

for (const chip of document.querySelectorAll('.chip[data-balance]')) {
  chip.addEventListener('click', () => {
    const at = Number(chip.dataset.balance);
    settings = sanitizePlayerSettings({ ...settings, balance: at / 100 });
    $('balance').value = String(at);
    $('balance-val').textContent = balanceLabel(settings.balance);
    paintKnob($('balance')); paintChips();
    player.setBalance(settings.balance); saveSoon();
  });
}

$('natural').addEventListener('change', async (e) => {
  settings = sanitizePlayerSettings({ ...settings, naturalVoice: e.target.checked });
  saveSoon();
  if (player.mode === 'practice') player.applyPractice(settings);
});
$('lead').addEventListener('change', (e) => {
  settings = sanitizePlayerSettings({ ...settings, leadQuieter: e.target.checked });
  player.setTail({ leadQuieter: settings.leadQuieter, oneSpeaker: $('onespk').checked });
  saveSoon();
});
/* This one describes his speakers, not the song, so it is kept per machine
   rather than per song — the same reason the members player keeps it apart. */
$('onespk').addEventListener('change', (e) => {
  player.setTail({ leadQuieter: settings.leadQuieter, oneSpeaker: e.target.checked });
  window.tva.saveSettings({ oneSpeaker: e.target.checked });
});

/* ---- The loop bench ----------------------------------------------------- */

function setLoopEnd(which, seconds) {
  const current = { a: settings.loopA ?? 0, b: settings.loopB ?? duration };
  const next = applyLoopEdit(current, which, seconds, duration);
  if (!next) {
    say(which === 'a'
      ? 'The start has to come before the end.'
      : 'The end has to come after the start.');
    paintLoop();
    return;
  }
  settings = sanitizePlayerSettings({ ...settings, loopA: next.a, loopB: next.b, looping: true });
  paintLoop(); drawWave(); saveSoon();
  ensurePracticeMode().then(pushLoop);
}

$('set-a').addEventListener('click', () => setLoopEnd('a', player.currentTime));
$('set-b').addEventListener('click', () => setLoopEnd('b', player.currentTime));

for (const box of [['loop-a', 'a'], ['loop-b', 'b']]) {
  $(box[0]).addEventListener('change', (e) => {
    const seconds = parseTime(e.target.value);
    if (seconds == null) {
      say('That time could not be read. Try something like 1:23 or 1:23.5.');
      paintLoop();
      return;
    }
    setLoopEnd(box[1], seconds);
  });
}

for (const btn of document.querySelectorAll('[data-nudge]')) {
  btn.addEventListener('click', () => {
    if (settings.loopA == null || settings.loopB == null) return;
    const next = nudgeLoop({ a: settings.loopA, b: settings.loopB },
      btn.dataset.nudge, Number(btn.dataset.by), duration);
    if (!next) return;
    settings = sanitizePlayerSettings({ ...settings, loopA: next.a, loopB: next.b });
    paintLoop(); drawWave(); saveSoon(); pushLoop();
  });
}

$('loop-on').addEventListener('click', async () => {
  settings = sanitizePlayerSettings({ ...settings, looping: !settings.looping });
  paintLoop(); saveSoon();
  if (settings.looping) await ensurePracticeMode();
  pushLoop();
});

$('loop-clear').addEventListener('click', () => {
  settings = sanitizePlayerSettings({ ...settings, loopA: null, loopB: null, looping: false });
  paintLoop(); drawWave(); pushLoop(); saveSoon();
});

$('save-sec').addEventListener('click', () => {
  const name = $('secname').value.trim();
  if (!name) { say('Type a name for the loop first.'); $('secname').focus(); return; }
  if (settings.loopA == null || settings.loopB == null) return;
  if ((settings.sections ?? []).length >= MAX_SECTIONS) {
    say(`That is as many saved loops as one song can hold (${MAX_SECTIONS}). Remove one first.`);
    return;
  }
  const next = [...(settings.sections ?? []), { name, a: settings.loopA, b: settings.loopB }];
  settings = sanitizePlayerSettings({ ...settings, sections: sanitizeSections(next) });
  $('secname').value = '';
  paintSections(); saveSoon(); say('');
});

/* ---- From the app ------------------------------------------------------- */

let firstArgSong = null;
window.tva.onSongsOpened((songs) => {
  if (!firstArgSong && songs.length) firstArgSong = songs[0];
  window.__tvaOpenedCount = (window.__tvaOpenedCount ?? 0) + songs.length;
  if (songs.length) openSong(songs[0]);
  /* A song you have just opened should be in your list. On Windows it changes
     nothing unless the song is inside a folder the app was pointed at; on a
     phone it is the whole of how you get back to it, because Google Drive does
     not offer a folder to scan and every song there arrives one at a time. */
  loadLibrary().catch(() => {});
});

window.tva.onShortcut((id) => {
  if (id === 'playPause') $('play').click();
  else if (id === 'stop') $('stop').click();
  else if (id === 'next') playNext(1);
  else if (id === 'previous') playNext(-1);
});

window.tva.onReady(async (info) => {
  // Read by the checks: which media keys the app really managed to claim.
  window.__tvaShortcuts = info.shortcutsRegistered ?? [];
  $('where').textContent = info.oneDrive
    ? `Version ${info.version}. Your marked parts, named parts and notes are kept in `
      + `${info.settingsRoot}, which OneDrive copies to your other computer. `
      + `Takes are kept on this computer only, in ${info.recordingsDir}.`
    : `Version ${info.version}. Settings kept in ${info.settingsRoot}. `
      + `Takes kept in ${info.recordingsDir}.`;

  if (info.repaired?.length) {
    say(`${info.repaired.length} recording${info.repaired.length === 1 ? ' was' : 's were'} `
      + 'left unfinished last time and have been repaired.');
  }

  await loadLibrary();
  await loadPlaylists();
  await refreshMics();
  await refreshTakes();
  paintDefaults().catch(() => {});
  if (info.conflicts?.length) {
    say(`${info.conflicts.length} song${info.conflicts.length === 1 ? ' was' : 's were'} changed `
      + 'on both computers. The newer version was kept and the older one set aside.');
  } else if (info.shortcutsTaken?.length) {
    say(`Another app is already using these keys, so they will not reach this one: `
      + `${info.shortcutsTaken.join(', ')}.`);
  }
  window.tva.loadSettings().then(async (s) => {
    /* Before anything is shown. The window is created hidden and revealed on
       ready-to-show, so applying it here means no flash of the wrong one. */
    const skin = applySkin(s?.skin ?? 'navy');
    paintSkins(skin.id);
    if (Number.isFinite(s?.latencyMs)) $('latency').value = String(s.latencyMs);
    if (s?.oneSpeaker) {
      $('onespk').checked = true;
      /* WHATEVER THE SONG SAYS, NOT false. This is read from disk and applied
         whenever it arrives, which can be after a song has already opened and
         set its own lead-quieter. Writing false here switched that back off
         behind the person's back. */
      player.setTail({ leadQuieter: settings.leadQuieter, oneSpeaker: true });
    }

    /* THE OUTPUT DEVICE WAS SAVED AND NEVER READ BACK. Choosing an interface or
       a pair of headphones held for that session and then quietly went back to
       whatever Windows is set to on the next start — which, on a machine with
       something plugged in, is its own "it won't play". */
    if (s?.outputDevice) {
      await refreshOutputs();
      $('out-pick').value = s.outputDevice;
      await player.setOutputDevice(s.outputDevice);
    }
  });

  /* THE NOTIFICATION PERMISSION, ASKED WHEN THE APP OPENS.
   *
   * It used to be asked from inside the first press of play, so Android's dialog
   * appeared over a song that had just started: "There was a pop up to allow
   * something. i didn't read it but assumed it was microphone." Android's own
   * wording only asks whether the app may send notifications, which tells nobody
   * why a music app wants one. So the app says what it is for first, and the
   * dialog follows a moment later. On Windows this function does not exist and
   * nothing happens. */
  if (typeof window.tva.askAboutNotifications === 'function') {
    say('In a moment the phone will ask whether this app may show a notification. '
      + 'Saying yes is what keeps a song playing when the screen goes off.');
    setTimeout(() => {
      Promise.resolve(window.tva.askAboutNotifications()).then((allowed) => {
        say(allowed ? '' : 'Songs will stop when the screen goes off. You can turn '
          + 'notifications on for TVA Player in the phone\u2019s Settings whenever you like.');
      }).catch(() => say(''));
    }, 2600);
  }
});

/* DRAGGING A SONG IN.
 *
 * Both handlers must cancel the event. Left alone, Electron treats a dropped
 * file as a link to follow and REPLACES the whole page with it — the app would
 * appear to vanish and be replaced by a download.
 *
 * dragenter and dragleave are counted rather than trusted one for one, because
 * moving the pointer across a child element fires a leave for the parent and
 * the outline would flicker off while the file is still over the window. */
function wireDrop() {
  let depth = 0;
  const surface = document.getElementById('tp');
  const show = (on) => surface.classList.toggle('dropping', on);

  window.addEventListener('dragover', (e) => { e.preventDefault(); });
  window.addEventListener('dragenter', (e) => {
    e.preventDefault();
    depth += 1;
    if (e.dataTransfer?.types?.includes('Files')) show(true);
  });
  window.addEventListener('dragleave', (e) => {
    e.preventDefault();
    depth = Math.max(0, depth - 1);
    if (depth === 0) show(false);
  });
  window.addEventListener('drop', async (e) => {
    e.preventDefault();
    depth = 0; show(false);
    const files = [...(e.dataTransfer?.files ?? [])];
    if (!files.length) return;
    const paths = files.map((f) => window.tva.pathForFile(f)).filter(Boolean);
    const opened = await window.tva.openDropped(paths);
    if (!opened) {
      say(files.length === 1
        ? 'That file is not a kind of audio this app can play.'
        : 'None of those files are a kind of audio this app can play.');
    }
  });
}

window.addEventListener('resize', () => { drawWave(); });

/* What the test harness reads to check the engine rather than the labels.
   The labels kept working all the way through the bug that froze the app, so a
   check that only reads the screen proves nothing about what is playing. */
/* SEEKING, for the checks. Tapping the wave is a pointer drag with capture on
   it, which a test can only approximate — and what matters is not the gesture
   but what happens after it: the media element asks for the song from a new
   offset, and that request has to be answered with the right bytes or the sound
   comes from the wrong place. This is the same call the wave makes. */
/* MAKE THE SPEED ENGINE FAIL ON PURPOSE, once.
 *
 * Ted changed the speed and the song went silent, with no message and no way
 * back short of killing the program. The app survives that now — but "it
 * survives" is a claim, and a claim needs a way to be tested. This lets a check
 * break the engine start deliberately and then look at what the app does with
 * it: does it say why, does the song carry on at normal speed, is the player
 * still in a state that can play. Without it the recovery path would never run
 * outside the fault itself. */
window.__tvaFailEngineOnce = () => { player.failEngineOnce = true; };
/* HOW LONG THE ENGINE TAKES TO BUILD, made a fixed size for the checks. The
   fault this exists for is a race between pressing play and the engine landing,
   and a race whose window depends on how fast the machine is is a check that
   passes on a fast runner and ships a broken app. It also stands for the real
   thing: a song in OneDrive that has to be downloaded before it can be decoded. */
window.__tvaSlowEngine = (ms) => { slowEngineMs = Number(ms) || 0; return slowEngineMs; };

window.__tvaSeek = (seconds) => { player.seek(seconds); return player.currentTime; };
window.__tvaMode = () => player.mode;
/* Everything a check needs to say WHY a song stopped, rather than only that it
   did. The element's own paused flag matters as much as the player's opinion:
   the two disagreeing is the shape of every fault in this area. */
window.__tvaPlayerState = () => ({
  mode: player.mode,
  playing: player.playing,
  practicePlaying: player._practicePlaying === true,
  elPaused: player.el ? player.el.paused : null,
  elEnded: player.el ? player.el.ended : null,
  elTime: player.el ? Number(player.el.currentTime.toFixed(2)) : null,
  practiceTime: Number(player.practiceTime.toFixed(2)),
  engineStarts: player.engineStarts,
  duration: Number((player.duration || 0).toFixed(2)),
});
window.__tvaGraph = () => player.graph;
window.__tvaNext = () => playNext(1);
/* Used only by the checks, to reach the "this song is too long for the speed
   control" path without encoding half an hour of audio first. It sets the same
   variable the real length sets, so the refusal it produces is the real one. */
window.__tvaFakeDuration = (seconds) => { duration = seconds; };
window.__tvaOpenFirstArg = () => (firstArgSong ? openSong(firstArgSong) : null);
window.__tvaEngineStarts = () => player.engineStarts;
window.__tvaSpeed = () => settings.speed;
/* 0 until the shape of the song has been worked out, then 1 for a mono file
   and 2 for a stereo one. A check that waits on pixels alone cannot tell a
   wave that has not arrived yet from a flat line, and passed on the flat one. */
window.__tvaWaveLanes = () => (peaks ? (peaks.right ? 2 : 1) : 0);
/* ---- hooks the checks drive ---------------------------------------------
 *
 * An interface with four microphone inputs cannot be plugged into a build
 * runner, and Chromium's fake microphone is one channel. So the checks build a
 * four-channel signal inside the page — four different notes, one per channel —
 * and hand it to the recorder through the same door a real interface uses. That
 * is the only way the multi-microphone path gets exercised at all. */
window.__tvaMicState = () => ({
  open: micOpen,
  channels: micChannels,
  live: [...micLive],
  use: [...micUse],
  gains: [...micGains],
  selected: micSelected,
  columns: liveCols.length,
  lanes: liveChannels,
});

window.__tvaFakeMics = async (count, hzPerChannel) => {
  const ctx = player.ctx;
  await ctx.resume();
  const merger = ctx.createChannelMerger(count);
  for (let c = 0; c < count; c++) {
    const osc = ctx.createOscillator();
    osc.frequency.value = hzPerChannel[c];
    const level = ctx.createGain();
    level.gain.value = 0.3;
    osc.connect(level).connect(merger, 0, c);
    osc.start();
  }

  micDeviceId = 'fake-interface';
  micChannels = count;
  await loadMicSettings(micDeviceId, count);
  await recorder.listen({ sourceNode: merger, channels: count, use: micUse });
  micOpen = true;
  liveCols = [];
  liveChannels = micLive.length;
  liveNames = micLive.length === 1 ? ['YOUR VOICE'] : micLive.map((c) => `MIC ${c + 1}`);
  for (const c of micLive) setMicGain(player.graph, c, micGains[c] ?? 0);
  $('level').hidden = false;
  $('meter-text').textContent = 'Keep out of the red';
  paintMicPanel();
  paintMicList('Fake interface');
  paintRecord();
  drawWave();
  return { channels: micChannels, live: [...micLive] };
};

window.__tvaSetMicGain = (channel, db) => {
  micGains[channel] = db;
  setMicGain(player.graph, channel, db);
  paintMicPanel();
  return micGains[channel];
};

window.__tvaSetMicUse = async (channel, on) => { await onMicUseChanged(channel, on); };

/* CAN THE END OF THIS PANEL BE REACHED?
 *
 * The one question behind "I can't scroll down to get to the place to add a
 * song", asked of a tab by name. It lives here rather than inside a check
 * because TWO checks ask it — scripts/phone-harness.mjs at nine screen and text
 * sizes in a desktop browser, and the instrumented test that runs the real app
 * on a real Android at a real system font size. Written twice, the two would
 * drift, and the one that drifted would be the one measuring nothing.
 *
 * It scrolls to the bottom of the page first, because the answer is about what
 * CAN be reached, not what happens to be on the screen. */
window.__tvaReach = (tab) => {
  const panel = document.querySelector(`[data-panel="${tab}"]`);
  if (!panel || panel.hidden) return null;
  window.scrollTo(0, document.documentElement.scrollHeight);
  const shown = [...panel.querySelectorAll('*')].filter((el) => el.offsetParent);
  const last = shown[shown.length - 1] ?? panel;
  const box = last.getBoundingClientRect();
  const tabs = document.querySelector('.tabs');
  const bar = tabs.getBoundingClientRect();
  /* On a phone the tab bar is pinned to the bottom of the screen, so anything
     behind it is out of reach; on Windows it sits in the page and the bottom of
     the window is the only floor there is. */
  const pinned = getComputedStyle(tabs).position === 'fixed';
  return {
    lastBottom: Math.round(box.bottom),
    floor: Math.round(pinned ? bar.top : window.innerHeight),
    sideways: document.documentElement.scrollWidth > window.innerWidth + 1,
    widest: Math.round(document.documentElement.scrollWidth),
    tabOnScreen: bar.bottom <= window.innerHeight + 1,
  };
};

window.__tvaSkins = () => SKINS.map((s) => s.id);
window.__tvaSkinNotes = () => SKINS.map((s) => s.what);
window.__tvaSetSkin = (id) => applySkin(id).id;

wireKnobs();
wireWave();
wireDrop();
paintRecord();
paintControls();
paintSections();
drawWave();

/* ========================================================================
   THE LIBRARY
   ======================================================================== */

async function loadLibrary() {
  library = await window.tva.scanLibrary();
  paintLibrary();
  paintFolders();
  // Titles are read only for what is on screen: opening two thousand files to
  // read their tags before showing anything would make the list arrive late.
  const shown = visibleSongs().slice(0, 150).map((s) => s.path);
  if (shown.length) {
    const tags = await window.tva.readTags(shown);
    const byPath = new Map(tags.map((t) => [t.path, t]));
    for (const s of library.songs) {
      const tag = byPath.get(s.path);
      if (tag) { s.label = tag.label; s.seconds = tag.seconds; }
    }
    paintLibrary();
  }
}

function visibleSongs() {
  const q = $('find').value.trim().toLowerCase();
  const all = library.songs ?? [];
  if (!q) return all;
  return all.filter((s) =>
    s.name.toLowerCase().includes(q)
    || (s.label ?? '').toLowerCase().includes(q)
    || s.folder.toLowerCase().includes(q));
}

function paintLibrary() {
  const host = $('songlist');
  host.textContent = '';
  const list = visibleSongs();
  $('songlist-empty').hidden = (library.folders ?? []).length > 0;

  if ((library.folders ?? []).length > 0 && list.length === 0) {
    const none = document.createElement('p');
    none.className = 'empty';
    none.textContent = $('find').value.trim()
      ? 'No song in your folders matches that.'
      : 'Those folders hold no songs this app can play.';
    host.append(none);
    return;
  }

  for (const s of list.slice(0, 600)) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'song' + (song && song.songKey === s.songKey ? ' on' : '');
    const main = document.createElement('span');
    main.textContent = s.label ?? s.name.replace(/\.[a-z0-9]+$/i, '');
    const sub = document.createElement('small');
    sub.textContent = s.seconds ? `${s.folder} · ${formatTime(s.seconds)}` : s.folder;
    row.append(main, sub);
    row.addEventListener('click', () => playFrom(list, list.indexOf(s)));
    host.append(row);
  }
}

function paintFolders() {
  const host = $('folders');
  host.textContent = '';
  for (const folder of library.folders ?? []) {
    const chip = document.createElement('button');
    chip.type = 'button'; chip.className = 'chip';
    chip.textContent = `${folder}  ✕`;
    chip.title = 'Stop listing songs from this folder';
    chip.addEventListener('click', async () => {
      await window.tva.removeFolder(folder);
      await loadLibrary();
    });
    host.append(chip);
  }
  if (!(library.folders ?? []).length) {
    const none = document.createElement('span');
    none.className = 'note';
    none.textContent = 'None yet.';
    host.append(none);
  }
}

$('add-folder').addEventListener('click', async () => {
  const added = await window.tva.addFolder();
  if (added) { say(`Reading ${added}…`); await loadLibrary(); say(''); }
});
$('find').addEventListener('input', paintLibrary);

/* ========================================================================
   TABS
   ======================================================================== */

for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => {
    for (const other of document.querySelectorAll('.tab')) {
      const on = other === tab;
      other.classList.toggle('on', on);
      other.setAttribute('aria-selected', String(on));
    }
    for (const panel of document.querySelectorAll('[data-panel]')) {
      panel.hidden = panel.dataset.panel !== tab.dataset.tab;
    }
    /* Back to the top. Without this a tab opened after another one had been
       scrolled showed its middle, with its own heading out of sight — which is
       how the take list came to look empty when it was not. */
    document.querySelector('.deskwrap').scrollTop = 0;
    /* ON A PHONE THE WHOLE PAGE SCROLLS, and the tab bar sits at the bottom of
       the screen — so tapping a tab has to bring its panel up to meet you, or
       you land on the case with the thing you asked for somewhere below it.
       That is what put "Open a song" 1,971 pixels down the page. */
    if (document.documentElement.dataset.platform === 'android') {
      const panel = document.querySelector(`[data-panel="${tab.dataset.tab}"]`);
      panel?.scrollIntoView({ block: 'start' });
    }
    if (tab.dataset.tab === 'takes') refreshTakes();
    if (tab.dataset.tab === 'setup') { refreshOutputs(); refreshMics(); }
  });
}

/* ========================================================================
   RECORDING
   ======================================================================== */

async function refreshMics() {
  const mics = await listMicrophones();
  const pick = $('mic-pick');
  const chosen = pick.value;
  pick.textContent = '';
  for (const mic of mics) {
    const opt = document.createElement('option');
    opt.value = mic.id; opt.textContent = mic.label;
    pick.append(opt);
  }
  if (chosen) pick.value = chosen;
  if (!mics.length) {
    const opt = document.createElement('option');
    opt.textContent = 'No microphone found';
    pick.append(opt);
  }
  return mics;
}

/* ========================================================================
   RECORDING, ON THE CONSOLE

   Ted, after installing it: "The recording feature lacks polish... Ugly, and
   hard to figure out quickly. Ideally, it would simply be an added layer to the
   playback interface... buttons like the transport buttons in the player part
   of the app."

   So there is no recording screen any more. Two buttons sit in the transport:
   red records the voice on its own, orange starts the song and records against
   it. Each one is its own start and stop, exactly the way play becomes pause —
   and for the same reason it is done with a CLASS and not the hidden attribute,
   which was measured not to take on these inline SVGs.

   Every button's look comes from one function. Painting them at each of the
   five call sites is how a state machine ends up disagreeing with itself.
   ======================================================================== */

/* Which button owns the take in progress: 'new', 'over', or null. */
let takeOwner = null;

function paintRecord() {
  const running = recorder.running;
  const live = micOpen;

  $('mic-open').classList.toggle('on', live);
  $('mic-open').setAttribute('aria-label',
    live ? 'Turn the microphone off' : 'Turn the microphone on');
  $('cell-last').hidden = !live;
  $('rec-last').disabled = !live || running;

  for (const [which, btn, name, icon, stopIcon, word] of [
    ['new', 'rec-new', 'name-new', 'ico-new', 'ico-new-stop', 'Record<br>new'],
    ['over', 'rec-over', 'name-over', 'ico-over', 'ico-over-stop', 'Overdub'],
  ]) {
    const mine = running && takeOwner === which;
    $(btn).classList.toggle('on', mine);
    $(btn).disabled = running && !mine;
    $(icon).classList.toggle('off', mine);
    $(stopIcon).classList.toggle('off', !mine);
    /* Written with its own break, like the resting words, so the cell does not
       grow the moment a take starts and push the dials onto a second row. */
    $(name).innerHTML = mine ? 'Stop &amp;<br>keep' : word;
  }

  /* Overdub is meaningless with nothing to sing over, so it says so by being
     dark rather than by letting you press it and then explaining. */
  if (!running) {
    $('rec-over').disabled = !song;
    $('rec-over').title = song ? '' : 'Open a song first';
  }

  $('lamp-rec').classList.toggle('lit', running);
}

/* Opening the microphone is no longer something to do first. Pressing either
   record button opens it, which is why the old numbered step one is gone. */
async function ensureMic() {
  if (micOpen) return true;
  try {
    micDeviceId = $('mic-pick').value || '';
    const opened = await openMic(micDeviceId || undefined);
    /* BUILT FROM WHAT CAME BACK, not from what was asked for. A two-input
       interface answers an eight-channel request with two, and everything from
       here on — the files, the lanes, the gain switch — counts those two. */
    micChannels = opened.channels;
    await loadMicSettings(micDeviceId, micChannels);
    await recorder.listen({
      stream: opened.stream, channels: micChannels, use: micUse,
    });
    micOpen = true;
    liveCols = [];
    liveChannels = micLive.length;
    liveNames = micLive.length === 1
      ? ['YOUR VOICE'] : micLive.map((c) => `MIC ${c + 1}`);
    for (const c of micLive) setMicGain(player.graph, c, micGains[c] ?? 0);
    await refreshMics();            // labels only arrive after permission
    $('level').hidden = false;
    $('meter-text').textContent = 'Keep out of the red';
    const warn = $('mic-warning');
    warn.hidden = !opened.processingWarning;
    warn.className = 'note warn';
    warn.textContent = opened.processingWarning ?? '';
    paintMicPanel();
    paintMicList(opened.label);
    startTuner();
    paintRecord();
    drawWave();
    return true;
  } catch (err) {
    say(`That microphone would not open. ${err?.message ?? err}`);
    return false;
  }
}

/* ---- the gain switch, one microphone at a time -------------------------- */

function micSettingsKey(deviceId) {
  return deviceId || 'default';
}

async function loadMicSettings(deviceId, channels) {
  const stored = (await window.tva.loadSettings())?.mics?.[micSettingsKey(deviceId)] ?? {};
  micUse = [];
  micGains = [];
  for (let c = 0; c < channels; c++) {
    micUse.push(stored.use?.[c] !== false);
    micGains.push(clampGain(Number(stored.gains?.[c]) || 0));
  }
  if (!micUse.some(Boolean)) micUse[0] = true;
  micLive = [];
  for (let c = 0; c < channels; c++) if (micUse[c]) micLive.push(c);
  micSelected = 0;
}

async function saveMicSettings() {
  const settings = await window.tva.loadSettings();
  const mics = { ...(settings.mics ?? {}) };
  mics[micSettingsKey(micDeviceId)] = { use: [...micUse], gains: [...micGains] };
  await window.tva.saveSettings({ ...settings, mics });
}

function clampGain(db) {
  return Math.max(MIC_GAIN_MIN, Math.min(MIC_GAIN_MAX, Math.round(db)));
}

function selectedChannel() {
  return micLive[micSelected] ?? micLive[0] ?? 0;
}

function paintMicPanel() {
  const several = micLive.length > 1;
  $('level').classList.toggle('many', several);
  $('level-title').textContent = several ? 'Your mics' : 'Your voice';
  $('mic-prev').hidden = !several;
  $('mic-next').hidden = !several;
  const channel = selectedChannel();
  $('gain-who').textContent = several ? `Mic ${channel + 1}` : 'Gain';
  const db = micGains[channel] ?? 0;
  $('gain-val').textContent = `${db > 0 ? '+' : ''}${db} dB`;
  /* Nothing to turn up when what is being listened to is the computer's own
     sound: that has no microphone and no preamp behind it. */
  const adjustable = micLive.length > 0;
  $('gain-down').disabled = !adjustable || db <= MIC_GAIN_MIN;
  $('gain-up').disabled = !adjustable || db >= MIC_GAIN_MAX;
  $('gain-who').textContent = adjustable ? $('gain-who').textContent : 'This computer';
}

function nudgeGain(step) {
  if (!micOpen) return;
  const channel = selectedChannel();
  const next = clampGain((micGains[channel] ?? 0) + step);
  if (next === micGains[channel]) return;
  micGains[channel] = next;
  setMicGain(player.graph, channel, next);
  paintMicPanel();
  drawWave();
  saveMicSettings();
  say(micLive.length > 1
    ? `Mic ${channel + 1} is now ${next > 0 ? '+' : ''}${next} dB. Turning a microphone up turns the room up with it.`
    : `The microphone is now ${next > 0 ? '+' : ''}${next} dB. Turning it up turns the room up with it.`);
}

$('gain-down').addEventListener('click', () => nudgeGain(-1));
$('gain-up').addEventListener('click', () => nudgeGain(1));
/* Back to no boost at all, the same gesture that resets a dial. */
$('gain-val').addEventListener('dblclick', () => {
  if (!micOpen) return;
  const channel = selectedChannel();
  micGains[channel] = 0;
  setMicGain(player.graph, channel, 0);
  paintMicPanel(); drawWave(); saveMicSettings();
});

function stepMic(by) {
  if (micLive.length < 2) return;
  micSelected = (micSelected + by + micLive.length) % micLive.length;
  paintMicPanel();
  drawWave();
}
$('mic-prev').addEventListener('click', () => stepMic(-1));
$('mic-next').addEventListener('click', () => stepMic(1));

/* The list in Set-up: which inputs this device has, and which of them to
   record. Written from what the device gave rather than from a guess. */
function paintMicList(deviceLabel) {
  const host = $('mic-list');
  host.textContent = '';
  if (!micOpen || micChannels === 0) {
    $('mic-count').textContent = 'Turn the microphone on to see how many inputs this device has.';
    return;
  }
  $('mic-count').textContent = micChannels === 1
    ? `${deviceLabel ?? 'This device'} gave one microphone input.`
    : `${deviceLabel ?? 'This device'} gave ${micChannels} microphone inputs, `
      + `and the app records up to ${MAX_MIC_CHANNELS} at once.`;

  for (let c = 0; c < micChannels; c++) {
    const line = document.createElement('label');
    line.className = 'micline';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = micUse[c];
    box.addEventListener('change', () => onMicUseChanged(c, box.checked));
    const name = document.createElement('span');
    name.className = 'micname';
    name.textContent = `Mic ${c + 1}`;
    const gain = document.createElement('span');
    gain.className = 'micgain';
    const db = micGains[c] ?? 0;
    gain.textContent = `${db > 0 ? '+' : ''}${db} dB`;
    const what = document.createElement('span');
    what.className = 'note';
    what.textContent = micUse[c] ? 'Recorded to its own file' : 'Not recorded';
    line.append(box, name, gain, what);
    host.append(line);
  }
}

/* Changing which inputs are recorded means re-opening the microphone: the
   number of files a take is written to is settled when recording starts, and
   the worklet is built around it. Refused mid-take rather than done badly. */
async function onMicUseChanged(channel, on) {
  if (recorder.running) {
    say('Stop the take first — which microphones are recorded is settled when a take starts.');
    paintMicList();
    return;
  }
  micUse[channel] = on;
  if (!micUse.some(Boolean)) { micUse[channel] = true; say('At least one microphone has to be recorded.'); }
  await saveMicSettings();
  await recorder.stop();
  micOpen = false;
  await ensureMic();
}

$('mic-open').addEventListener('click', async () => {
  if (recorder.running) return;
  $('mic-open').disabled = true;
  try {
    if (micOpen) {
      await recorder.stop();
      micOpen = false;
      liveChannels = 0;
      liveCols = [];
      liveNames = [];
      micLive = [];
      $('level').hidden = true;
      $('tuner').hidden = true;
      stopTuner();
      $('meter-text').textContent = 'Off';
      paintMicList();
      drawWave();
      say('');
    } else if (await ensureMic()) {
      say('Microphone on. Sing your loudest and keep the bar out of the red.');
    }
  } finally {
    $('mic-open').disabled = false;
    paintRecord();
  }
});

recorder.onLevel = ({ peak, rms, clipped, peaks, rmsEach, clippedEach }) => {
  /* THE BAR FOLLOWS THE MICROPHONE THE GAIN BUTTONS ACT ON, so the two agree.
     With one microphone that is the only one there is, and this behaves
     exactly as it did before. */
  const channel = selectedChannel();
  const onePeak = peaks?.[channel] ?? peak;
  const oneRms = rmsEach?.[channel] ?? rms;
  const meter = $('meter-fill').parentElement;
  $('meter-fill').style.width = `${Math.min(100, oneRms * 140)}%`;
  $('meter-peak').style.left = `${Math.min(99, onePeak * 100)}%`;
  /* Clipping warns on ANY microphone, not just the chosen one: a take ruined
     on mic 3 is ruined whether or not you were watching mic 3. */
  meter.classList.toggle('clipped', clipped);
  if (clipped) {
    const which = clippedEach ? clippedEach.findIndex(Boolean) : -1;
    $('meter-text').textContent = micLive.length > 1 && which >= 0
      ? `Mic ${which + 1} too loud` : 'Too loud';
  }

  if (micOpen && liveChannels > 0) {
    pushLiveColumn(
      micLive.map((c) => peaks?.[c] ?? peak),
      micLive.map((c) => rmsEach?.[c] ?? rms),
    );
    /* Redrawn here rather than on a timer of its own: this arrives twenty times
       a second, which is the rate the picture moves at anyway. While a song is
       playing the clock redraws it too, and drawing twice costs nothing. */
    if (!player.playing) drawWave();
  }
};
recorder.onSeconds = (s) => {
  if (recorder.running) say(`Recording ${formatTime(s)}. Press the same button again to keep it.`);
};

function recordingName() {
  return song ? song.name.replace(/\.[a-z0-9]+$/i, '') : 'Lesson';
}

async function beginTake(which) {
  if (recorder.running) return;
  if (!(await ensureMic())) return;
  const withSong = which === 'over';
  if (withSong && !song) { say('Open a song first, or use Record new.'); return; }
  try {
    await recorder.start(recordingName());
    takeOwner = which;
    paintRecord();
    if (withSong && !player.playing) await player.play();
    say(withSong ? 'Recording with the song. Press the orange button again to keep it.'
                 : 'Recording. Press the red button again to keep it.');
  } catch (err) {
    takeOwner = null;
    paintRecord();
    say(err?.message ?? 'The recording would not start.');
  }
}

async function endTake() {
  if (!recorder.running) return;
  const withSong = takeOwner === 'over';
  const done = await recorder.finish();
  takeOwner = null;
  paintRecord();
  if (withSong && player.playing) player.pause();
  const many = done?.takes?.length ?? 1;
  say(done
    ? (many > 1
      ? `Kept ${formatTime(done.seconds)} as ${many} takes — one for each mic, and one of them all mixed. They are under Takes.`
      : `Kept ${formatTime(done.seconds)} as a take. It is under Takes.`)
    : 'Nothing was recorded.');
  await refreshTakes();
}

for (const [id, which] of [['rec-new', 'new'], ['rec-over', 'over']]) {
  $(id).addEventListener('click', () => {
    if (recorder.running && takeOwner === which) endTake();
    else beginTake(which);
  });
}

$('rec-last').addEventListener('click', async () => {
  try {
    const done = await recorder.saveLast(120, `${recordingName()} (caught)`);
    say(done ? `Kept the last ${formatTime(done.seconds)}. It is under Takes.`
             : 'There was nothing to keep.');
    await refreshTakes();
  } catch (err) {
    say(err?.message ?? 'Nothing could be kept.');
  }
});

$('rec-system').addEventListener('click', async () => {
  try {
    const got = await openSystemAudio();
    await recorder.listen({ stream: got.stream, channels: 2, stereo: true });
    micOpen = true;
    micChannels = 2; micUse = [true, true]; micGains = [0, 0];
    micLive = []; micSelected = 0;          // no gain switch on the computer's own sound
    liveCols = [];
    liveChannels = 2;
    liveNames = ['LEFT', 'RIGHT'];
    $('level').hidden = false;
    $('meter-text').textContent = `Listening to ${got.label}.`;
    paintMicPanel();
    paintRecord();
    drawWave();
    say('Ready. Press Record new to capture what the computer is playing.');
  } catch (err) {
    say(err?.message ?? 'The computer’s sound could not be captured.');
  }
});

$('rec-folder').addEventListener('click', () => window.tva.openRecordingsFolder());

async function refreshTakes() {
  takes = await window.tva.listRecordings();
  const host = $('takes');
  host.textContent = '';
  $('takes-empty').hidden = takes.length > 0;

  for (const take of takes.slice(0, 60)) {
    const row = document.createElement('div');
    row.className = 'item';
    const left = document.createElement('span');
    left.className = 'itext';
    const name = document.createElement('span');
    /* The file name ends in the date and time it was made, and the line
       underneath already says that in words. Printed twice it read as a
       mistake, so the stamp comes off the name here and stays on the file. */
    name.className = 'name';
    name.textContent = take.name.replace(/\s+\d{4}-\d{2}-\d{2} \d{2}\.\d{2}\.\d{2}$/, '');
    const when = document.createElement('span');
    when.className = 'when';
    /* Down to the second is more than anybody needs and it stacked the row
       three lines deep. The date and the minute say which take this is. */
    when.textContent = new Date(take.madeAt)
      .toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
    left.append(name, when);

    const acts = document.createElement('span');
    acts.className = 'iacts';

    const play = document.createElement('button');
    play.type = 'button'; play.className = 'chip'; play.textContent = 'Play it';
    play.addEventListener('click', () => playTake(take));

    const mine = document.createElement('button');
    mine.type = 'button'; mine.className = 'chip'; mine.textContent = 'Save my voice…';
    mine.title = 'Save this take on its own, as an MP3 or a WAV';
    mine.addEventListener('click', () => exportTake(take, { withSong: false }, mine));

    const mix = document.createElement('button');
    mix.type = 'button'; mix.className = 'chip'; mix.textContent = 'Save with the song…';
    mix.title = 'Make one file of this take and the song together, to send to somebody';
    mix.addEventListener('click', () => exportTake(take, { withSong: true }, mix));

    const drop = document.createElement('button');
    drop.type = 'button'; drop.className = 'chip'; drop.textContent = 'Remove';
    drop.addEventListener('click', async () => {
      await window.tva.removeRecording(take.path);
      say('Moved to the recycle bin.');
      await refreshTakes();
    });

    acts.append(play, mine, mix, drop);
    row.append(left, acts);
    host.append(row);
  }
}

/* A take plays on its own bus, so the song can run underneath it with its own
   volume — which is the point of keeping the two files apart. */
let takeSource = null;
async function playTake(take) {
  try {
    if (takeSource) { try { takeSource.stop(); } catch {} takeSource = null; }
    const bytes = await (await fetch(take.url)).arrayBuffer();
    const buf = await player.ctx.decodeAudioData(bytes);
    const src = player.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(player.graph.takeGain);
    src.start();
    takeSource = src;
    say(`Playing ${take.name}. The song's own volume knob still works underneath it.`);
  } catch (err) {
    say(`That take would not play. ${err?.message ?? err}`);
  }
}

/* ========================================================================
   THE TUNER
   ======================================================================== */

/* The microphone can now be turned off again from the console, so the tuner
   needs a way to stop. It never had one: startTuner returned early if a timer
   existed and nothing ever cleared it. */
function stopTuner() {
  if (!tunerTimer) return;
  clearInterval(tunerTimer);
  tunerTimer = null;
  $('t-note').textContent = '—';
  $('t-cents').textContent = '';
}

function startTuner() {
  $('tuner').hidden = false;
  if (tunerTimer) return;
  const buf = new Float32Array(player.graph.tuner.fftSize);
  tunerTimer = setInterval(() => {
    player.graph.tuner.getFloatTimeDomainData(buf);
    const found = detectPitchYin(buf, player.ctx.sampleRate, 65, 1000);
    const reading = found && found.confidence > 0.6 ? noteFromHz(found.hz) : null;
    $('t-note').textContent = reading ? reading.name : '—';
    $('t-cents').textContent = reading
      ? (Math.abs(reading.cents) <= 5 ? 'in tune'
        : `${Math.abs(reading.cents)} cents ${reading.cents > 0 ? 'sharp' : 'flat'}`)
      : '';
    const needle = $('t-needle');
    const off = reading ? Math.max(-50, Math.min(50, reading.cents)) : 0;
    needle.style.left = `calc(${50 + off}% - 1.5px)`;
    needle.classList.toggle('good', Boolean(reading) && Math.abs(reading.cents) <= 5);
  }, 90);
}

/* ========================================================================
   NOTES
   ======================================================================== */

function paintNotes() {
  const host = $('notes');
  host.textContent = '';
  const list = file?.notes ?? [];
  $('notes-empty').hidden = list.length > 0;

  list.forEach((n, i) => {
    const row = document.createElement('div');
    row.className = 'item';
    const left = document.createElement('span');
    left.className = 'itext';
    const name = document.createElement('span');
    name.className = 'name'; name.textContent = n.text;
    const when = document.createElement('span');
    when.className = 'when'; when.textContent = formatTime(n.atSec, true);
    left.append(name, when);

    const acts = document.createElement('span');
    acts.className = 'iacts';
    const go = document.createElement('button');
    go.type = 'button'; go.className = 'chip'; go.textContent = 'Jump here';
    go.addEventListener('click', () => { player.seek(n.atSec); drawWave(); });
    const drop = document.createElement('button');
    drop.type = 'button'; drop.className = 'chip'; drop.textContent = 'Remove';
    drop.addEventListener('click', () => {
      const next = [...list]; next.splice(i, 1);
      file = { ...file, notes: sanitizeNotes(next) };
      paintNotes(); saveSoon();
    });
    acts.append(go, drop);
    row.append(left, acts);
    host.append(row);
  });
}

$('note-add').addEventListener('click', () => {
  if (!song) { say('Open a song first.'); return; }
  const next = addNote(file?.notes ?? [], player.currentTime, $('notetext').value);
  if (!next) { say('Type what you want to note first.'); $('notetext').focus(); return; }
  file = { ...file, notes: next };
  $('notetext').value = '';
  paintNotes(); saveSoon(); say('');
});

/* ========================================================================
   THE CLICK TRACK
   ======================================================================== */

metronome.onCountIn = (left) => {
  $('countin').textContent = left > 0 ? `count-in ${left}` : '';
};

$('click-on').addEventListener('click', async () => {
  const on = $('click-on').getAttribute('aria-pressed') === 'true';
  if (on) {
    metronome.stop();
    $('click-on').setAttribute('aria-pressed', 'false');
    $('click-on').textContent = 'Start the click';
    return;
  }
  const bpm = Number($('bpm').value) || 120;
  const beatsPerBar = Number($('bpb').value) || 4;
  const countInBars = Number($('countbars').value) || 0;
  await player.ctx.resume().catch(() => {});
  metronome.setVolume(0.5);
  metronome.start({
    bpm, beatsPerBar, countInBars,
    onSongStart: () => { if (song && !player.playing) player.play().catch(() => {}); },
  });
  $('click-on').setAttribute('aria-pressed', 'true');
  $('click-on').textContent = 'Stop the click';
  file = { ...file, bpm, countInBars };
  saveSoon();
});

/* ========================================================================
   SKINS

   Ted asked for his brand palettes, a light one, a plain one, a high-contrast
   one, "any other options that could help round out the choices people may
   want" — and for the finish to change with the colour, not just the hue.

   A skin is two attributes on <html> and nothing else: data-skin picks the
   palette, data-finish picks how the case is lit. Everything downstream is a
   token, so there is no per-skin code and no per-skin layout. The one thing
   that does not follow automatically is the waveform, which is painted rather
   than styled — so its colour cache is dropped here, and nowhere else.
   ======================================================================== */

const SKINS = [
  { id: 'navy', name: 'Studio navy', finish: 'glossy', case: '#132445', accent: '#d4a84b',
    what: 'The one it starts in — the studio\u2019s own navy and gold, lit like hardware.' },
  { id: 'avf', name: 'AVF', finish: 'glossy', case: '#17596a', accent: '#d4a039',
    what: 'The teal and amber of the Adaptive Voice Framework book.' },
  { id: 'pass', name: 'PASS', finish: 'glossy', case: '#0f4d5a', accent: '#3db58c',
    what: 'The deep teal and green of the PASS Profile platform.' },
  { id: 'vocalfit', name: 'Vocal Fit', finish: 'glossy', case: '#0c3c3c', accent: '#3ffc63',
    what: 'Dark green with the bright green accent, from the Vocal Fit artwork.' },
  { id: 'daylight', name: 'Daylight', finish: 'flat', case: '#efe9da', accent: '#8a6416',
    what: 'A warm cream case with dark text, for a room with the sun in it.' },
  { id: 'bright', name: 'Bright colours', finish: 'flat', case: '#f4f7fb', accent: '#c2185b',
    what: 'White, with the strongest colours in the set: pink names things, teal is the song, orange is recording.' },
  { id: 'paper', name: 'Paper grey', finish: 'matte', case: '#f1f2f4', accent: '#1f5f9e',
    what: 'The quietest light one — paper grey and a single blue, so nothing on screen competes with the singing.' },
  { id: 'grey', name: 'Studio grey', finish: 'matte', case: '#232528', accent: '#63a8e8',
    what: 'Neutral dark grey, the colour most recording software is.' },
  { id: 'contrast', name: 'High contrast', finish: 'flat', case: '#000000', accent: '#ffd400',
    what: 'Black and white with thick edges, for reading the console from across the room.' },
  { id: 'vintage', name: 'Vintage', finish: 'matte', case: '#45301e', accent: '#d59a3c',
    what: 'Warm brown and cream with no shine, like a hardware player on a shelf.' },
  { id: 'night', name: 'Night', finish: 'matte', case: '#0b0e12', accent: '#b8842f',
    what: 'Near-black with a dim amber, for working late without being dazzled.' },
  { id: 'stage', name: 'Stage', finish: 'glossy', case: '#1f1238', accent: '#e0489b',
    what: 'Deep violet and magenta, the one warm-bright colour the others leave out.' },
];

function applySkin(id) {
  const skin = SKINS.find((x) => x.id === id) ?? SKINS[0];
  const root = document.documentElement;
  /* The default palette lives in :root, so it is the ABSENCE of data-skin
     rather than a block of its own — one place for the defaults instead of
     two that can disagree. */
  if (skin.id === 'navy') root.removeAttribute('data-skin');
  else root.dataset.skin = skin.id;
  if (skin.finish === 'glossy') root.removeAttribute('data-finish');
  else root.dataset.finish = skin.finish;

  waveInk = null;               // the canvas is painted, not styled
  drawWave();
  for (const btn of document.querySelectorAll('.skin')) {
    btn.setAttribute('aria-pressed', String(btn.dataset.skin === skin.id));
  }
  /* What the chosen one is, printed under the row. A grid of coloured squares
     tells you how each looks and nothing about which to pick. */
  const note = $('skin-note');
  if (note) note.textContent = `${skin.name} — ${skin.what}`;
  return skin;
}

function paintSkins(current) {
  const host = $('skins');
  if (!host || host.children.length) return;
  for (const skin of SKINS) {
    const btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'skin'; btn.dataset.skin = skin.id;
    btn.setAttribute('aria-pressed', String(skin.id === current));
    btn.title = `${skin.name} — ${skin.what}`;

    const art = document.createElement('span');
    art.className = 'chipart';
    art.style.background = skin.case;
    const bar = document.createElement('i');
    bar.style.background = skin.accent;
    const dot = document.createElement('b');
    dot.style.background = skin.accent;
    art.append(bar, dot);

    const name = document.createElement('span');
    name.textContent = skin.name;
    btn.append(art, name);
    btn.addEventListener('click', async () => {
      const chosen = applySkin(skin.id);
      say(`${chosen.name}. ${chosen.what}`);
      const settings = await window.tva.loadSettings();
      await window.tva.saveSettings({ ...settings, skin: chosen.id });
    });
    host.append(btn);
  }
}

/* ========================================================================
   SET-UP
   ======================================================================== */

async function refreshOutputs() {
  const outs = await listOutputs();
  const pick = $('out-pick');
  const chosen = pick.value;
  pick.textContent = '';
  for (const out of outs) {
    const opt = document.createElement('option');
    opt.value = out.id; opt.textContent = out.label;
    pick.append(opt);
  }
  if (chosen) pick.value = chosen;
  if (!outs.length) {
    const opt = document.createElement('option');
    opt.textContent = 'Using whatever Windows is set to';
    pick.append(opt);
  }
}

$('out-pick').addEventListener('change', async (e) => {
  const ok = await player.setOutputDevice(e.target.value);
  say(ok ? 'Sound will play through that from now on.'
         : 'That output could not be selected, so sound stays where Windows has it.');
  const settings = await window.tva.loadSettings();
  await window.tva.saveSettings({ ...settings, outputDevice: e.target.value });
});

$('defaults-open').addEventListener('click', async () => {
  await window.tva.openDefaultAppsSettings();
  say('Windows Settings is open. Choose TVA Player for each kind of file you want it to open.');
  setTimeout(paintDefaults, 3000);
});

async function paintDefaults() {
  const choices = await window.tva.readDefaultAppChoices();
  if (!choices) return;
  const ours = choices.filter((c) => c.isOurs).map((c) => c.ext.toUpperCase());
  $('defaults-state').textContent = ours.length
    ? `Right now this app opens: ${ours.join(', ')}.`
    : 'Windows will not let an app do this by itself — it opens Settings so you can confirm it once.';
}
window.addEventListener('focus', () => { paintDefaults().catch(() => {}); });

/* ========================================================================
   THE QUEUE, AND LISTS HE SAVES
   ======================================================================== */

let queue = [];
let queueAt = -1;

/* Picking a song lines up everything else showing beneath it, so a folder
   plays through without another click. */
function playFrom(list, index) {
  queue = list;
  queueAt = index;
  paintUpNext();
  return openSong(list[index]);
}

function paintUpNext() {
  const next = queue[queueAt + 1];
  $('upnext').hidden = !next;
  if (next) $('upnext').textContent = `Next: ${next.label ?? next.name.replace(/\.[a-z0-9]+$/i, '')}`;
}

async function playNext(step = 1) {
  if (queue.length === 0) return false;
  const at = queueAt + step;
  if (at < 0 || at >= queue.length) return false;
  queueAt = at;
  paintUpNext();
  await openSong(queue[at]);
  await player.play().catch(() => {});
  return true;
}

$('play-all').addEventListener('click', () => {
  const list = visibleSongs();
  if (!list.length) { say('There are no songs to play.'); return; }
  playFrom(list, 0).then(() => player.play().catch(() => {}));
});

/* Saved lists are whatever is lined up now, kept under a name. They live in the
   same synced folder as everything else, so a list made on the laptop is there
   on the desktop. */
async function loadPlaylists() {
  const settings = await window.tva.loadSettings();
  const lists = settings.playlists ?? {};
  const pick = $('playlist-pick');
  pick.textContent = '';
  const first = document.createElement('option');
  first.value = ''; first.textContent = 'Open a playlist…';
  pick.append(first);
  for (const name of Object.keys(lists)) {
    const opt = document.createElement('option');
    opt.value = name; opt.textContent = name;
    pick.append(opt);
  }
  return lists;
}

/* Naming a list uses a box on the page, not window.prompt — Electron does not
   implement prompt() at all. It throws "prompt() is not supported", so the
   button would have appeared to do nothing whatsoever. */
$('playlist-save').addEventListener('click', () => {
  const list = queue.length ? queue : visibleSongs();
  if (!list.length) { say('Line some songs up first.'); return; }
  $('listnamerow').hidden = false;
  $('listname').value = '';
  $('listname').focus();
});

$('listname-no').addEventListener('click', () => { $('listnamerow').hidden = true; });

$('listname').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('listname-ok').click();
  if (e.key === 'Escape') $('listname-no').click();
});

$('listname-ok').addEventListener('click', async () => {
  const list = queue.length ? queue : visibleSongs();
  const name = $('listname').value.trim().slice(0, 40);
  if (!name) { say('Give the list a name first.'); $('listname').focus(); return; }
  const settings = await window.tva.loadSettings();
  const playlists = { ...(settings.playlists ?? {}), [name]: list.map((s) => s.path) };
  await window.tva.saveSettings({ ...settings, playlists });
  await loadPlaylists();
  $('playlist-pick').value = name;
  $('listnamerow').hidden = true;
  say(`Kept ${list.length} songs as "${name}".`);
});

$('playlist-pick').addEventListener('change', async (e) => {
  const name = e.target.value;
  if (!name) return;
  const lists = await loadPlaylists();
  $('playlist-pick').value = name;
  const paths = lists[name] ?? [];
  const byPath = new Map((library.songs ?? []).map((s) => [s.path, s]));
  const songs = paths.map((p) => byPath.get(p)).filter(Boolean);
  if (!songs.length) {
    say(`Nothing in "${name}" is in your folders any more.`);
    return;
  }
  say(`Playing "${name}" — ${songs.length} songs.`);
  await playFrom(songs, 0);
  await player.play().catch(() => {});
});


/* ========================================================================
   ONE FILE OF THE TAKE AND THE SONG TOGETHER
   ======================================================================== */

/* The take and the song are kept apart, which is what lets either be changed
 * afterwards. This gets one of them out of the app as a file, in the format he
 * picked, either on its own or with the song underneath it.
 *
 * THE SAVE BOX COMES FIRST and the file is written into as the encoding runs,
 * rather than a finished file being built in memory and then offered. A take of
 * a forty-five minute lesson is about 260 MB and the mix is twice that; the old
 * way held three of those at once and could not have saved a real lesson at all.
 *
 * The encoding itself happens in a worker, so the window keeps painting and the
 * number on the button keeps climbing while it runs.
 */

/* About 2.7 seconds at 48 kHz. Small enough that the page repaints between
   slices, large enough that the per-slice overhead disappears. */
const SLICE_FRAMES = 1 << 17;

function channelsOf(buffer) {
  const out = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) out.push(buffer.getChannelData(c));
  return out;
}

/* A take read straight out of its own file, without decoding it.
 *
 * This app wrote that file, so its shape is known rather than guessed: 44 bytes
 * of header and then 16-bit samples, which is exactly what both encoders want.
 * Nothing larger than one slice is ever in memory, so the length of the lesson
 * stops mattering. */
async function rawTakeReader(take) {
  const headBytes = await (await fetch(take.url, { headers: { Range: 'bytes=0-43' } })).arrayBuffer();
  const head = new Uint8Array(headBytes);
  if (!looksLikeWav(head)) return null;
  const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
  const channels = view.getUint16(22, true) || 1;
  const sampleRate = view.getUint32(24, true) || 48000;
  if (view.getUint16(34, true) !== 16) return null;    // not one of ours after all
  const totalFrames = Math.floor(dataBytesForFileSize(take.bytes, channels) / (channels * 2));
  return {
    sampleRate, channels, totalFrames,
    async read(startFrame, frames) {
      const from = WAV_HEADER_BYTES + startFrame * channels * 2;
      const to = from + frames * channels * 2 - 1;
      const bytes = await (await fetch(take.url, { headers: { Range: `bytes=${from}-${to}` } })).arrayBuffer();
      return new Int16Array(bytes);
    },
  };
}

/* Everything that has to be decoded first: a mix with the song, and a take
   whose own sample rate is one the MP3 encoder will not accept. */
function bufferReader({ song, take, sampleRate, channels, totalFrames, shiftFrames }) {
  return {
    sampleRate, channels, totalFrames,
    async read(startFrame, frames) {
      const slice = mixSlice(song, take, frames, startFrame, shiftFrames, 0.8, channels);
      return floatToInt16(interleave(slice));
    },
  };
}

async function buildExportReader(take, { withSong, rate }) {
  /* A take at any rate at all can go straight out: LAME resamples whatever it
     is handed, and a WAV states its own rate. So this is the path a take on its
     own always takes, and nothing is decoded. */
  if (!withSong) {
    const raw = await rawTakeReader(take);
    if (raw) return raw;
  }

  /* The mix has to be decoded, and decodeAudioData resamples to the rate of the
     context it is called on — which is how the song and the take arrive matched. */
  const probe = new OfflineAudioContext({ numberOfChannels: 2, length: 1, sampleRate: rate });
  const takeBuf = await probe.decodeAudioData(await (await fetch(take.url)).arrayBuffer());
  const takeCh = channelsOf(takeBuf);

  if (!withSong) {
    return bufferReader({
      song: [], take: takeCh, sampleRate: rate,
      channels: takeCh.length, totalFrames: takeBuf.length, shiftFrames: 0,
    });
  }

  const songBuf = await probe.decodeAudioData(await (await fetch(song.url)).arrayBuffer());
  /* Shifting the take EARLIER means skipping its first moments, which is how
     the delay between singing and the sound reaching the computer is taken out. */
  const shiftFrames = Math.round((Math.max(0, Number($('latency').value) || 0) / 1000) * rate);
  return bufferReader({
    song: channelsOf(songBuf), take: takeCh, sampleRate: rate,
    channels: 2, totalFrames: mixLengthFrames(songBuf.length, takeBuf.length), shiftFrames,
  });
}

async function exportTake(take, { withSong }, button) {
  if (withSong && !song) { say('Open the song this take was sung against first.'); return; }

  const picked = await window.tva.exportPick({
    suggestedName: withSong ? `${take.name} with the song` : take.name,
  });
  if (!picked) { say('Nothing was saved.'); return; }

  /* A take saved as a WAV on its own is the file it already is — same rate,
     same channels, same sixteen bits. Copying it is both instant and exact,
     where a round trip out through float and back would be neither. */
  if (!withSong && picked.format === 'wav') {
    const copied = await window.tva.exportCopy({ from: take.path, to: picked.filePath });
    say(copied?.error ? copied.error : `Saved as ${copied.path}.`);
    return;
  }

  const was = button.textContent;
  button.disabled = true;
  button.textContent = 'Saving… 0%';

  let jobId = null;
  let worker = null;
  let writes = Promise.resolve();
  try {
    const reader = await buildExportReader(take, { withSong, rate: player.ctx.sampleRate });

    const opened = await window.tva.exportOpen({ filePath: picked.filePath });
    if (!opened || opened.error) throw new Error(opened?.error ?? 'That file could not be opened.');
    jobId = opened.id;

    worker = new Worker('./workers/export-worker.js', { type: 'module' });
    const finished = new Promise((resolve, reject) => {
      worker.addEventListener('message', (event) => {
        const message = event.data;
        if (message.type === 'bytes') {
          /* Chained, so two lumps are never written to one handle at once, and
             a failure stops the whole export rather than one write. */
          writes = writes
            .then(() => window.tva.exportWrite(jobId, message.bytes))
            .then((ok) => { if (!ok) throw new Error('The file could not be written to.'); })
            .catch((err) => { reject(err); });
        } else if (message.type === 'done') resolve();
        else if (message.type === 'error') reject(new Error(message.message));
      });
      worker.addEventListener('error', (event) => {
        reject(new Error(event.message || 'The encoder stopped.'));
      });
    });
    finished.catch(() => {});      // handled below; this only keeps it quiet

    worker.postMessage({
      type: 'begin', format: picked.format,
      sampleRate: reader.sampleRate, channels: reader.channels,
      totalFrames: reader.totalFrames, kbps: mp3KbpsFor(reader.channels),
    });

    for (let start = 0; start < reader.totalFrames; start += SLICE_FRAMES) {
      const frames = Math.min(SLICE_FRAMES, reader.totalFrames - start);
      const samples = await reader.read(start, frames);
      worker.postMessage({ type: 'pcm', samples }, [samples.buffer]);
      button.textContent = `Saving… ${Math.round(((start + frames) / reader.totalFrames) * 100)}%`;
      await new Promise((r) => setTimeout(r, 0));   // let the window repaint
    }
    worker.postMessage({ type: 'end' });
    await finished;
    await writes;

    const saved = await window.tva.exportFinish(jobId);
    jobId = null;
    if (!saved || saved.error) throw new Error(saved?.error ?? 'That could not be saved.');
    say(`Saved as ${saved.path}.`);
  } catch (err) {
    /* A half-written MP3 left in his Music folder would look exactly like a take
       that went wrong, so it goes rather than being left to be puzzled over. */
    if (jobId !== null) { await window.tva.exportAbort(jobId); jobId = null; }
    say(`That could not be saved. ${err?.message ?? err}`);
  } finally {
    if (worker) worker.terminate();
    button.disabled = false;
    button.textContent = was;
  }
}

$('latency').addEventListener('change', async (e) => {
  const settings = await window.tva.loadSettings();
  await window.tva.saveSettings({ ...settings, latencyMs: Number(e.target.value) || 0 });
});
