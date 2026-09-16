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
import { listMicrophones, listOutputs, openMic, openSystemAudio } from '../audio/mic.js';
import {
  sanitizePlayerSettings, DEFAULT_PLAYER_SETTINGS, sanitizeSections,
  emptySongFile, xToTime, dragToLoopRegion, isClickNotDrag,
  formatTime, parseTime, applyLoopEdit, nudgeLoop, MAX_SECTIONS,
  sanitizeNotes, addNote, detectPitchYin, noteFromHz,
  wavHeader, floatToInt16, interleave,
} from '../practice-core.js';

const $ = (id) => document.getElementById(id);
const player = new Player();
const recorder = new Recorder(player.graph);
const metronome = new Metronome(player.graph);

let library = { folders: [], songs: [] };
let takes = [];
let micOpen = false;
let tunerTimer = null;

let song = null;
let file = null;
let settings = { ...DEFAULT_PLAYER_SETTINGS };
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
  const node = await player.enterPracticeMode(async (url) => (await fetch(url)).arrayBuffer());
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
  await flushSave();               // whatever the last song was owed, before it goes
  song = next;
  say('Opening that song…');
  $('now-name').textContent = next.name.toUpperCase();
  /* The old song's wave goes the moment its name does. Left until later, the
     window showed one song's name over another song's picture for as long as
     the file took to open — and a check that waited for the wave to appear was
     answered by the wave that was already there. */
  peaks = null;
  drawWave();

  try {
    const { duration: d } = await player.open(next);
    duration = d;
  } catch (err) {
    // The real reason, not a guess at it.
    say(err?.message ?? 'That file would not open.');
    $('now-name').textContent = 'COULD NOT OPEN';
    $('play').disabled = true;
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
  const mid = h / 2;

  // The marked part, behind everything.
  const region = dragRegion
    ?? (settings.loopA != null && settings.loopB != null
      ? { a: settings.loopA, b: settings.loopB } : null);
  if (region && duration > 0) {
    const x1 = (region.a / duration) * w, x2 = (region.b / duration) * w;
    g.fillStyle = dragRegion ? 'rgba(212,168,75,0.30)' : 'rgba(212,168,75,0.18)';
    g.fillRect(x1, 0, Math.max(1, x2 - x1), h);
    g.fillStyle = 'rgba(212,168,75,0.8)';
    g.fillRect(x1, 0, 1, h); g.fillRect(x2 - 1, 0, 1, h);
  }

  if (peaks) {
    const bw = w / peaks.left.length;
    const lanes = peaks.right
      ? [{ data: peaks.left, mid: h * 0.27, room: h * 0.24, tag: 'L' },
         { data: peaks.right, mid: h * 0.73, room: h * 0.24, tag: 'R' }]
      : [{ data: peaks.left, mid, room: h * 0.44, tag: 'MONO' }];

    for (const lane of lanes) {
      for (let i = 0; i < lane.data.length; i++) {
        const tall = Math.max(1.5, lane.data[i] * lane.room * 2);
        g.fillStyle = (i / lane.data.length) <= played ? '#d4a84b' : '#33507f';
        g.fillRect(i * bw, lane.mid - tall / 2, Math.max(1, bw - 0.6), tall);
      }
    }

    // The line between the two sides, and a word saying which is which.
    if (peaks.right) {
      g.fillStyle = 'rgba(255,255,255,0.10)';
      g.fillRect(0, mid, w, 1);
    }
    /* The lettering sits just INSIDE the top of its own lane. Placed above it,
       the baseline of the upper one landed off the top of the canvas and the
       letter never appeared at all. */
    g.font = '600 9px Consolas, ui-monospace, monospace';
    g.fillStyle = 'rgba(245,240,225,0.5)';
    for (const lane of lanes) g.fillText(lane.tag, 4, Math.max(9, lane.mid - lane.room + 8));
  } else {
    g.fillStyle = '#16294a';
    g.fillRect(0, mid - 1, w, 2);
  }

  g.fillStyle = '#f5f0e1';
  g.fillRect(Math.min(played * w, w - 2), 0, 2, h);
}

/* ---- Events ------------------------------------------------------------- */

player.onTime = (now, total) => {
  if (Number.isFinite(total) && total > 0 && total !== duration) {
    duration = total; paintRuler();
  }
  paintTimes(now); drawWave();
  $('note-at').textContent = formatTime(now);
};
player.onState = (state) => {
  const playing = state === 'playing';
  /* A class, not the hidden attribute. Measured in the real window, both SVGs
     computed to display:block with hidden set, so the button showed the pause
     bars while its label said Play. */
  $('ico-play').classList.toggle('off', playing);
  $('ico-pause').classList.toggle('off', !playing);
  $('play').setAttribute('aria-label', playing ? 'Pause' : 'Play');
  $('lamp-play').classList.toggle('lit', playing);
  if (state === 'ended') {
    saveSoon();
    playNext(1).then((moved) => { if (!moved) say('That was the last one.'); });
  }
};

$('open').addEventListener('click', () => window.tva.openSongs());
$('play').addEventListener('click', async () => {
  if (player.playing) { player.pause(); saveSoon(); return; }
  try {
    await player.play();
  } catch (err) {
    say(err?.message ?? 'This song would not start playing.');
  }
});
$('stop').addEventListener('click', () => { player.stop(); saveSoon(); });
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
  window.tva.loadSettings().then((s) => {
    if (Number.isFinite(s?.latencyMs)) $('latency').value = String(s.latencyMs);
    if (s?.oneSpeaker) {
      $('onespk').checked = true;
      player.setTail({ leadQuieter: false, oneSpeaker: true });
    }
  });
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
window.__tvaMode = () => player.mode;
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

wireKnobs();
wireWave();
wireDrop();
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
    if (tab.dataset.tab === 'record') refreshTakes();
    if (tab.dataset.tab === 'setup') refreshOutputs();
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

$('mic-open').addEventListener('click', async () => {
  try {
    $('mic-open').disabled = true;
    const opened = await openMic($('mic-pick').value || undefined);
    await recorder.listen({ stream: opened.stream, channels: 1 });
    micOpen = true;
    await refreshMics();            // labels only arrive after permission
    $('rec-start').disabled = false;
    $('rec-last').disabled = false;
    $('mic-open').textContent = 'Microphone is on';
    $('meter-text').textContent = `Listening to ${opened.label}. Sing at your loudest and keep the bar out of the red.`;
    const warn = $('mic-warning');
    warn.hidden = !opened.processingWarning;
    warn.className = 'note warn';
    warn.textContent = opened.processingWarning ?? '';
    startTuner();
  } catch (err) {
    $('meter-text').textContent = `That microphone would not open. ${err?.message ?? err}`;
  } finally {
    $('mic-open').disabled = false;
  }
});

recorder.onLevel = ({ peak, rms, clipped }) => {
  const meter = $('meter-fill').parentElement;
  $('meter-fill').style.width = `${Math.min(100, rms * 140)}%`;
  $('meter-peak').style.left = `${Math.min(99, peak * 100)}%`;
  meter.classList.toggle('clipped', clipped);
  if (clipped) {
    $('meter-text').textContent = 'Too loud — the take is being clipped. Back off the microphone or turn its level down.';
  }
};
recorder.onSeconds = (s) => { $('rec-time').textContent = `Recording ${formatTime(s)}`; };

function recordingName() {
  return song ? song.name.replace(/\.[a-z0-9]+$/i, '') : 'Lesson';
}

$('rec-start').addEventListener('click', async () => {
  try {
    await recorder.start(recordingName());
    $('rec-start').disabled = true;
    $('rec-stop').disabled = false;
    $('rec').classList.add('on');
    $('lamp-rec').classList.add('lit');
    if ($('rec-with-song').checked && song && !player.playing) await player.play();
    say('Recording.');
  } catch (err) {
    say(err?.message ?? 'The recording would not start.');
  }
});

$('rec-stop').addEventListener('click', async () => {
  const done = await recorder.finish();
  $('rec-start').disabled = !micOpen;
  $('rec-stop').disabled = true;
  $('rec').classList.remove('on');
  $('lamp-rec').classList.remove('lit');
  $('rec-time').textContent = '';
  if (player.playing && $('rec-with-song').checked) player.pause();
  say(done ? `Kept ${formatTime(done.seconds)} as a take.` : 'Nothing was recorded.');
  await refreshTakes();
});

$('rec-last').addEventListener('click', async () => {
  try {
    const done = await recorder.saveLast(120, `${recordingName()} (caught)`);
    say(done ? `Kept the last ${formatTime(done.seconds)}.` : 'There was nothing to keep.');
    await refreshTakes();
  } catch (err) {
    say(err?.message ?? 'Nothing could be kept.');
  }
});

$('rec').addEventListener('click', () => {
  if (recorder.running) $('rec-stop').click();
  else if (micOpen) $('rec-start').click();
  else {
    for (const tab of document.querySelectorAll('.tab')) {
      if (tab.dataset.tab === 'record') tab.click();
    }
    say('Turn the microphone on first.');
  }
});

$('rec-system').addEventListener('click', async () => {
  try {
    const got = await openSystemAudio();
    await recorder.listen({ stream: got.stream, channels: 2 });
    micOpen = true;
    $('rec-start').disabled = false;
    $('meter-text').textContent = `Listening to ${got.label}.`;
    say('Ready to record what the computer is playing.');
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

    const mix = document.createElement('button');
    mix.type = 'button'; mix.className = 'chip'; mix.textContent = 'Save it with the song';
    mix.title = 'Make one file of this take and the song together, to send to somebody';
    mix.addEventListener('click', () => saveMixed(take, mix));

    const drop = document.createElement('button');
    drop.type = 'button'; drop.className = 'chip'; drop.textContent = 'Remove';
    drop.addEventListener('click', async () => {
      await window.tva.removeRecording(take.path);
      say('Moved to the recycle bin.');
      await refreshTakes();
    });

    acts.append(play, mix, drop);
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
   afterwards. This makes a single file of the two for handing to somebody,
   without touching either original.
 *
 * The take is shifted back by however long the microphone takes to reach the
 * computer, so it sits where it was actually sung rather than a little late. */
async function saveMixed(take, button) {
  if (!song) { say('Open the song this take was sung against first.'); return; }
  const was = button.textContent;
  button.disabled = true;
  button.textContent = 'Mixing…';
  try {
    const rate = player.ctx.sampleRate;
    const [takeBytes, songBytes] = await Promise.all([
      (await fetch(take.url)).arrayBuffer(),
      (await fetch(song.url)).arrayBuffer(),
    ]);

    // One context for the render, at the rate everything else is running at.
    const probe = new OfflineAudioContext({ numberOfChannels: 2, length: 1, sampleRate: rate });
    const takeBuf = await probe.decodeAudioData(takeBytes);
    const songBuf = await probe.decodeAudioData(songBytes);

    const shiftSec = Math.max(0, Number($('latency').value) || 0) / 1000;
    const length = Math.max(songBuf.length, takeBuf.length);
    const ctx = new OfflineAudioContext({ numberOfChannels: 2, length, sampleRate: rate });

    const songSrc = ctx.createBufferSource(); songSrc.buffer = songBuf;
    const songVol = ctx.createGain(); songVol.gain.value = 0.8;
    songSrc.connect(songVol).connect(ctx.destination);
    songSrc.start(0);

    const takeSrc = ctx.createBufferSource(); takeSrc.buffer = takeBuf;
    const takeVol = ctx.createGain(); takeVol.gain.value = 1;
    takeSrc.connect(takeVol).connect(ctx.destination);
    // Shifting the take EARLIER means skipping its first moments, because a
    // source cannot start before the beginning of the file.
    takeSrc.start(0, shiftSec);

    const mixed = await ctx.startRendering();
    const channels = [];
    for (let c = 0; c < mixed.numberOfChannels; c++) channels.push(mixed.getChannelData(c));
    const pcm = floatToInt16(interleave(channels));
    const header = wavHeader(rate, channels.length, pcm.byteLength);

    const file = new Uint8Array(header.length + pcm.byteLength);
    file.set(header, 0);
    file.set(new Uint8Array(pcm.buffer), header.length);

    const saved = await window.tva.saveMixed({
      suggestedName: `${take.name} with the song`,
      bytes: file,
    });
    say(saved ? `Saved as ${saved}.` : 'Nothing was saved.');
  } catch (err) {
    say(`That could not be mixed. ${err?.message ?? err}`);
  } finally {
    button.disabled = false;
    button.textContent = was;
  }
}

$('latency').addEventListener('change', async (e) => {
  const settings = await window.tva.loadSettings();
  await window.tva.saveSettings({ ...settings, latencyMs: Number(e.target.value) || 0 });
});
