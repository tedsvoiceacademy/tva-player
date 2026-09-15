/* Wiring the console to the player.
 *
 * The dials, the wave and the named-part rows are all drawn by this script, and
 * the knob technique is ported from the members player: each dial is a real
 * <input type="range"> laid over it at zero opacity, so the input stays the one
 * source of truth — arrow keys work, screen readers read it, and a test can
 * drive it the way a browser does.
 */
import { Player, PRACTICE_MAX_SECONDS } from '../audio/player.js';
import {
  sanitizePlayerSettings, DEFAULT_PLAYER_SETTINGS, sanitizeSections,
  emptySongFile, xToTime, dragToLoopRegion, isClickNotDrag,
  formatTime, parseTime, applyLoopEdit, nudgeLoop, MAX_SECTIONS,
} from '../practice-core.js';

const $ = (id) => document.getElementById(id);
const player = new Player();

let song = null;
let file = null;
let settings = { ...DEFAULT_PLAYER_SETTINGS };
let duration = 0;
let peaks = null;
let dragRegion = null;
let saveTimer = null;

const say = (t) => { $('msg').textContent = t; };

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

function saveSoon() {
  if (!song) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    file = await window.tva.saveSong({ ...file, settings, lastPositionSec: player.currentTime });
  }, 900);
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

async function openSong(next) {
  song = next;
  say('Opening that song…');
  $('now-name').textContent = next.name.toUpperCase();

  try {
    const { duration: d } = await player.open(next);
    duration = d;
  } catch {
    say('That file would not open. Try an MP3, an M4A or a WAV saved on this computer.');
    return;
  }

  file = (await window.tva.loadSong(next.songKey))
      ?? emptySongFile(next.songKey, next.name, 'this computer');
  settings = sanitizePlayerSettings(file.settings);

  applyAll();
  paintControls();
  paintLoop();
  paintSections();
  pushLoop();

  if (file.lastPositionSec > 0 && file.lastPositionSec < duration - 1) {
    player.seek(file.lastPositionSec);
    say(`Picking up where you left off, at ${formatTime(file.lastPositionSec)}`);
  } else {
    say('Ready. Press play.');
  }

  peaks = null;
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
const KNOB_CENTRE = { balance: 0.5 };      // Sides reads from the middle out

function paintKnob(input) {
  const knob = input.closest('.knob');
  if (!knob) return;
  const min = Number(input.min), max = Number(input.max);
  const frac = max > min ? (Number(input.value) - min) / (max - min) : 0;
  const from = KNOB_CENTRE[knob.dataset.knob] ?? 0;
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
    play.type = 'button'; play.className = 'chip'; play.textContent = 'Play this part';
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
async function computePeaks(url) {
  try {
    const bytes = await (await fetch(url)).arrayBuffer();
    const rough = new OfflineAudioContext({ numberOfChannels: 1, length: 1, sampleRate: 8000 });
    const buf = await rough.decodeAudioData(bytes);
    const data = buf.getChannelData(0);
    const per = Math.max(1, Math.floor(data.length / PEAK_COUNT));
    const out = new Float32Array(PEAK_COUNT);
    let ceiling = 0.01;
    for (let i = 0; i < PEAK_COUNT; i++) {
      let top = 0;
      const start = i * per;
      for (let j = start; j < start + per && j < data.length; j++) {
        const v = Math.abs(data[j]);
        if (v > top) top = v;
      }
      out[i] = top;
      if (top > ceiling) ceiling = top;
    }
    for (let i = 0; i < PEAK_COUNT; i++) out[i] /= ceiling;
    return out;
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
    const bw = w / peaks.length;
    for (let i = 0; i < peaks.length; i++) {
      const tall = Math.max(1.5, peaks[i] * (h - 14));
      g.fillStyle = (i / peaks.length) <= played ? '#d4a84b' : '#33507f';
      g.fillRect(i * bw, mid - tall / 2, Math.max(1, bw - 0.6), tall);
    }
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
  if (state === 'ended') saveSoon();
};

$('open').addEventListener('click', () => window.tva.openSongs());
$('play').addEventListener('click', async () => {
  if (player.playing) { player.pause(); saveSoon(); } else { await player.play(); }
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
   finger. A full sweep takes 150px, so a small move is a small change. */
function wireKnobs() {
  for (const knob of document.querySelectorAll('.knob')) {
    const input = knob.querySelector('input');
    let drag = null;
    knob.addEventListener('pointerdown', (e) => {
      drag = { y: e.clientY, start: Number(input.value), id: e.pointerId };
      try { knob.setPointerCapture(e.pointerId); } catch {}
      input.focus(); e.preventDefault();
    });
    knob.addEventListener('pointermove', (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const min = Number(input.min), max = Number(input.max);
      const step = Number(input.step) || 1;
      const raw = drag.start + (drag.y - e.clientY) * ((max - min) / 150);
      const next = Math.max(min, Math.min(max, Math.round(raw / step) * step));
      if (String(next) === input.value) return;
      input.value = String(next);
      input.dispatchEvent(new Event('input', { bubbles: true }));
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
  saveSoon();
  if (await ensurePracticeMode()) player.applyPractice(settings);
});
$('key').addEventListener('input', async (e) => {
  settings = sanitizePlayerSettings({ ...settings, halfSteps: Number(e.target.value) });
  $('key-val').textContent = keyLabel(settings.halfSteps);
  saveSoon();
  if (await ensurePracticeMode()) player.applyPractice(settings);
});
$('balance').addEventListener('input', (e) => {
  settings = sanitizePlayerSettings({ ...settings, balance: Number(e.target.value) / 100 });
  $('balance-val').textContent = balanceLabel(settings.balance);
  player.setBalance(settings.balance); paintChips(); saveSoon();
});
$('volume').addEventListener('input', (e) => {
  settings = sanitizePlayerSettings({ ...settings, volume: Number(e.target.value) / 100 });
  $('volume-val').textContent = `${Math.round(settings.volume * 100)}%`;
  player.setVolume(settings.volume); saveSoon();
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
  if (!name) { say('Give the part a name first.'); $('secname').focus(); return; }
  if (settings.loopA == null || settings.loopB == null) return;
  if ((settings.sections ?? []).length >= MAX_SECTIONS) {
    say(`That is as many parts as one song can hold (${MAX_SECTIONS}). Remove one first.`);
    return;
  }
  const next = [...(settings.sections ?? []), { name, a: settings.loopA, b: settings.loopB }];
  settings = sanitizePlayerSettings({ ...settings, sections: sanitizeSections(next) });
  $('secname').value = '';
  paintSections(); saveSoon(); say('');
});

/* ---- From the app ------------------------------------------------------- */

window.tva.onSongsOpened((songs) => {
  window.__tvaOpenedCount = (window.__tvaOpenedCount ?? 0) + songs.length;
  if (songs.length) openSong(songs[0]);
});

window.tva.onShortcut((id) => {
  if (id === 'playPause') $('play').click();
  else if (id === 'stop') $('stop').click();
});

window.tva.onReady((info) => {
  $('where').textContent = info.oneDrive
    ? `Version ${info.version} · loops and settings kept in ${info.settingsRoot}, which OneDrive syncs to your other computer`
    : `Version ${info.version} · loops and settings kept in ${info.settingsRoot}`;
  if (info.conflicts?.length) {
    say(`${info.conflicts.length} song${info.conflicts.length === 1 ? ' was' : 's were'} changed `
      + 'on both computers. The newer version was kept and the older one set aside.');
  } else if (info.shortcutsTaken?.length) {
    say(`Another app is already using these keys, so they will not reach this one: `
      + `${info.shortcutsTaken.join(', ')}.`);
  }
  window.tva.loadSettings().then((s) => {
    if (s?.oneSpeaker) {
      $('onespk').checked = true;
      player.setTail({ leadQuieter: false, oneSpeaker: true });
    }
  });
});

window.addEventListener('resize', () => { drawWave(); });

/* What the test harness reads to check the engine rather than the labels.
   The labels kept working all the way through the bug that froze the app, so a
   check that only reads the screen proves nothing about what is playing. */
window.__tvaMode = () => player.mode;
window.__tvaEngineStarts = () => player.engineStarts;
window.__tvaSpeed = () => settings.speed;

wireKnobs();
wireWave();
paintControls();
paintSections();
drawWave();
