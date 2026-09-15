/* Wiring the page to the player.
 *
 * The page's look is deliberately plain for now. The console design is chosen
 * before it is built, because the members player was rebuilt three times when
 * that happened the other way round.
 */
import { Player, PRACTICE_MAX_SECONDS } from '../audio/player.js';
import {
  sanitizePlayerSettings, DEFAULT_PLAYER_SETTINGS, emptySongFile,
  xToTime, formatTime,
} from '../practice-core.js';

const $ = (id) => document.getElementById(id);
const player = new Player();

let song = null;
let file = null;                       // the song's settings file, as stored
let settings = { ...DEFAULT_PLAYER_SETTINGS };
let duration = 0;
let peaks = null;
let saveTimer = null;

const say = (text) => { $('msg').textContent = text; };

/* ---- Saving ------------------------------------------------------------- */

/* Debounced, the way the members player's saveSoon() is: a knob dragged across
   its range fires a hundred times, and each one would otherwise be a disk write. */
function saveSoon() {
  if (!song) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    file = await window.tva.saveSong({
      ...file,
      settings,
      lastPositionSec: player.currentTime,
    });
  }, 900);
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
  showSettings();

  if (file.lastPositionSec > 0 && file.lastPositionSec < duration - 1) {
    player.seek(file.lastPositionSec);
    say(`Ready. Picking up where you left off, at ${formatTime(file.lastPositionSec)}.`);
  } else {
    say('Ready. Press play.');
  }

  peaks = null;
  $('play').disabled = false;
  paintTimes(player.currentTime);
  drawWave();
}

/* ---- The controls ------------------------------------------------------- */

/* The stretch engine is only started when it is actually needed, because it
   costs a decode of the whole song. Playing a song straight through never pays
   for it. */
async function ensurePracticeMode() {
  if (player.mode === 'practice') return true;
  if (settings.speed === 1 && settings.halfSteps === 0 && !settings.looping) return false;

  if (duration > PRACTICE_MAX_SECONDS) {
    say(`This song is ${formatTime(duration)} long. The speed and key controls hold the whole `
      + `song in memory, so they are limited to ${Math.round(PRACTICE_MAX_SECONDS / 60)} minutes. `
      + 'Everything else still works.');
    return false;
  }

  say('Preparing the practice engine…');
  const node = await player.enterPracticeMode(async (url) => {
    const response = await fetch(url);
    return response.arrayBuffer();
  });
  say(node ? '' : 'The practice engine could not start for this song.');
  return Boolean(node);
}

function applyAll() {
  player.setBalance(settings.balance);
  player.setVolume(settings.volume);
  player.setTail({ leadQuieter: settings.leadQuieter, oneSpeaker: oneSpeaker() });
  player.applyPractice(settings);
}

const oneSpeaker = () => $('onespk').checked;

function showSettings() {
  $('speed').value = Math.round(settings.speed * 100);
  $('key').value = settings.halfSteps;
  $('balance').value = Math.round(settings.balance * 100);
  $('volume').value = Math.round(settings.volume * 100);
  $('natural').checked = settings.naturalVoice;
  $('lead').checked = settings.leadQuieter;
  paintReadouts();
}

function paintReadouts() {
  $('speed-out').textContent = settings.speed === 1
    ? 'Normal' : `${Math.round(settings.speed * 100)}% speed`;
  $('key-out').textContent = settings.halfSteps === 0
    ? 'As recorded'
    : `${settings.halfSteps > 0 ? 'Up' : 'Down'} ${Math.abs(settings.halfSteps)} half step`
      + `${Math.abs(settings.halfSteps) === 1 ? '' : 's'}`;
  const b = Math.round(settings.balance * 100);
  $('balance-out').textContent = b === 0 ? 'Both sides'
    : b === 100 ? 'Right side only' : b === -100 ? 'Left side only'
    : b > 0 ? `Left side ${b}% down` : `Right side ${-b}% down`;
  $('volume-out').textContent = `${Math.round(settings.volume * 100)}%`;
}

/* ---- The wave ----------------------------------------------------------- */

const PEAK_COUNT = 480;

function drawWave() {
  const canvas = $('wave');
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  canvas.width = w * dpr; canvas.height = h * dpr;
  const g = canvas.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);

  const played = duration > 0 ? player.currentTime / duration : 0;
  const mid = h / 2;

  if (peaks) {
    for (let i = 0; i < peaks.length; i++) {
      const x = (i / peaks.length) * w;
      const tall = Math.max(1, peaks[i] * (h - 8));
      g.fillStyle = (i / peaks.length) <= played ? '#d4a84b' : '#33507f';
      g.fillRect(x, mid - tall / 2, Math.max(1, w / peaks.length - 1), tall);
    }
  } else {
    g.fillStyle = '#16294a';
    g.fillRect(0, mid - 1, w, 2);
  }

  g.fillStyle = '#f5f0e1';
  g.fillRect(played * w, 0, 2, h);
}

function paintTimes(now) {
  $('t-now').textContent = formatTime(now);
  $('t-total').textContent = formatTime(duration);
}

/* ---- Events ------------------------------------------------------------- */

player.onTime = (now, total) => {
  // The length can arrive after the song has opened, so it is taken from every
  // update rather than read once.
  if (Number.isFinite(total) && total > 0) duration = total;
  paintTimes(now);
  drawWave();
};
player.onState = (state) => {
  $('play').textContent = state === 'playing' ? 'Pause' : 'Play';
  if (state === 'ended') saveSoon();
};

$('open').addEventListener('click', () => window.tva.openSongs());
$('play').addEventListener('click', async () => {
  if (player.playing) { player.pause(); saveSoon(); }
  else { await player.play(); }
});
$('stop').addEventListener('click', () => { player.stop(); saveSoon(); });
$('back10').addEventListener('click', () => player.seek(player.currentTime - 10));
$('fwd10').addEventListener('click', () => player.seek(player.currentTime + 10));

$('wave').addEventListener('click', (e) => {
  if (!song) return;
  const rect = e.currentTarget.getBoundingClientRect();
  player.seek(xToTime(e.clientX - rect.left, rect.width, duration));
  saveSoon();
});

$('speed').addEventListener('input', async (e) => {
  settings = sanitizePlayerSettings({ ...settings, speed: Number(e.target.value) / 100 });
  paintReadouts();
  if (await ensurePracticeMode()) player.applyPractice(settings);
  saveSoon();
});
$('key').addEventListener('input', async (e) => {
  settings = sanitizePlayerSettings({ ...settings, halfSteps: Number(e.target.value) });
  paintReadouts();
  if (await ensurePracticeMode()) player.applyPractice(settings);
  saveSoon();
});
$('balance').addEventListener('input', (e) => {
  settings = sanitizePlayerSettings({ ...settings, balance: Number(e.target.value) / 100 });
  paintReadouts(); player.setBalance(settings.balance); saveSoon();
});
$('volume').addEventListener('input', (e) => {
  settings = sanitizePlayerSettings({ ...settings, volume: Number(e.target.value) / 100 });
  paintReadouts(); player.setVolume(settings.volume); saveSoon();
});
$('natural').addEventListener('change', (e) => {
  settings = sanitizePlayerSettings({ ...settings, naturalVoice: e.target.checked });
  player.applyPractice(settings); saveSoon();
});
$('lead').addEventListener('change', (e) => {
  settings = sanitizePlayerSettings({ ...settings, leadQuieter: e.target.checked });
  player.setTail({ leadQuieter: settings.leadQuieter, oneSpeaker: oneSpeaker() }); saveSoon();
});
/* This one describes his speakers, not the song, so it is kept per machine
   rather than per song — the same reason the members player keeps it apart. */
$('onespk').addEventListener('change', (e) => {
  player.setTail({ leadQuieter: settings.leadQuieter, oneSpeaker: e.target.checked });
  window.tva.saveSettings({ oneSpeaker: e.target.checked });
});

window.addEventListener('resize', drawWave);

/* ---- From the app ------------------------------------------------------- */

window.tva.onSongsOpened((songs) => {
  /* Counted so the test harness can prove a multi-select in File Explorer
     arrives whole. Selecting six files launches six copies of the app in quick
     succession, and handled one at a time only the last would survive. */
  window.__tvaOpenedCount = (window.__tvaOpenedCount ?? 0) + songs.length;
  if (songs.length) openSong(songs[0]);
});

window.tva.onShortcut((id) => {
  if (id === 'playPause') $('play').click();
  else if (id === 'stop') $('stop').click();
});

window.tva.onReady((info) => {
  $('where').textContent = info.oneDrive
    ? `Version ${info.version}. Your loops and settings are kept in ${info.settingsRoot}, `
      + 'which OneDrive syncs to your other computer.'
    : `Version ${info.version}. Your loops and settings are kept in ${info.settingsRoot}.`;
  if (info.conflicts?.length) {
    say(`${info.conflicts.length} song${info.conflicts.length === 1 ? '' : 's'} had been changed `
      + 'on both computers. The newer version was kept and the older one set aside.');
  }
  if (info.shortcutsTaken?.length) {
    say(`Another app is already using these keys, so they will not reach this one: `
      + `${info.shortcutsTaken.join(', ')}.`);
  }
  window.tva.loadSettings().then((s) => {
    if (s?.oneSpeaker) { $('onespk').checked = true; player.setTail({ leadQuieter: false, oneSpeaker: true }); }
  });
});

drawWave();
