/* The app, launched and driven the way Windows launches it.
 *
 * This is the one test that covers the whole chain at once: the argument list
 * Windows hands over when a song is double-clicked, the protocol that streams it
 * to the page, the audio graph, the stretch engine, and the settings file that
 * comes back next time. Reading the source proves none of it.
 *
 * Run: node scripts/app-harness.mjs
 *      node scripts/app-harness.mjs --negative-control
 */
import { _electron as electron } from '@playwright/test';
import { mkdtemp, mkdir, rm, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeSong, makeMp3 } from './make-test-song.mjs';
import { soundCameOut, AUDIBLE, heard } from './sound-meter.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const NEGATIVE = process.argv.includes('--negative-control');

const results = [];
const check = (name, passed, detail) => {
  results.push({ name, passed });
  console.log(`${passed ? 'ok  ' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

const work = await mkdtemp(join(tmpdir(), 'tva-player-'));
/* A REAL MP3, because that is what Ted opens. Every check here used to run
   against a generated WAV, and he then installed the app and could not get an
   MP3 to play — a format the tests had never once loaded. */
const songPath = join(work, 'Test Song.mp3');
await makeMp3(songPath, { seconds: 6 });
const extraSongs = [join(work, 'Second.mp3'), join(work, 'Third.wav')];
await makeMp3(extraSongs[0], { seconds: 3 });
makeSong(extraSongs[1], { seconds: 3 });

/* One side deliberately quieter than the other, so the two halves of the
   waveform picture can be told apart. With a normal test tone both sides are
   identical and drawing the same channel twice would look perfect. */
/* THE SHAPES OF FILE THE SPEED ENGINE HAD NEVER BEEN GIVEN.
 *
 * Every song in this suite was a 128 kbps, 44.1 kHz, STEREO MP3 of two sine
 * tones. So player.js's mono branch — the line that duplicates a single channel
 * so the tail has two sides, three lines from the call that was leaving Ted with
 * a silent player — had never once run in a check. A voice memo, a
 * single-microphone take from this very app, or any mono recording would have run
 * it for the first time on his machine.
 *
 * These three are opened the way a dropped file is, rather than being put in the
 * music folder, because the library's contents are asserted elsewhere and adding
 * to them would move checks that have nothing to do with this. */
const monoPath = join(work, 'Mono Take.mp3');
await makeMp3(monoPath, { seconds: 40, channels: 1 });
const fortyEightPath = join(work, 'Forty Eight.mp3');
await makeMp3(fortyEightPath, { seconds: 40, sampleRate: 48000 });
const rawTakePath = join(work, 'Raw Take.wav');
makeSong(rawTakePath, { seconds: 40 });

const oneSidedPath = join(work, 'One Sided.mp3');
await makeMp3(oneSidedPath, { seconds: 4, rightGain: 0.25 });
const droppedPath = join(work, 'Dropped In.mp3');
await makeMp3(droppedPath, { seconds: 3 });
const notAudioPath = join(work, 'notes.txt');
await writeFile(notAudioPath, 'not a song');

/* ---- the negative controls ----------------------------------------------
 *
 * Six deliberate breakages, each one a mistake that leaves the app looking
 * entirely normal. A harness that cannot fail is not evidence, and the only way
 * to know these checks are watching anything is to break the thing they watch
 * and see them go red.
 *
 * THEY ARE STAGED AND WRITTEN TOGETHER, and that is not tidiness. Applied one
 * at a time, a control whose text has moved exits the run — leaving the ones
 * before it still broken in dist/. The next run then tests a build nobody
 * intended, quietly, and the giveaway is a control that "does not apply"
 * because the file was already broken. That happened; this is the fix.
 */
const edits = [];
/* One deliberate break. `key` names it so a single control can be run on its
   own, and `mustGoRed` names the checks it exists to turn red.
 *
 * WHY ONE AT A TIME MATTERS. Three of these live in the same file and two of
 * them mask the third: killing the stretch engine also stops a stale engine
 * wiring itself into the wrong song, so the check for that stayed green with its
 * own fault put back and looked like proof. A control that cannot be isolated
 * cannot be trusted. */
function control(relative, from, to, what, key, mustGoRed = []) {
  edits.push({ relative, from, to, what, key, mustGoRed });
}

const ONLY = (process.argv.find((a) => a.startsWith('--only=')) ?? '').slice('--only='.length);

/* THEY ARE STAGED AND WRITTEN TOGETHER, and that is not tidiness. Applied one
 * at a time, a control whose text has moved exits the run — leaving the ones
 * before it still broken in dist/. The next run then tests a build nobody
 * intended, quietly, and the giveaway is a control that "does not apply"
 * because the file was already broken. That happened; this is the fix.
 *
 * TWO CONTROLS CAN LIVE IN ONE FILE, so the second builds on the first rather
 * than on what is on disk. Written independently they both looked right and the
 * later write silently undid the earlier one — the lead-quieter check went green
 * in the control run, which is precisely the failure this whole idea exists to
 * catch. */
async function stageMutations() {
  const wanted = ONLY ? edits.filter((e) => e.key === ONLY) : edits;
  if (ONLY && !wanted.length) {
    console.error(`No control is called "${ONLY}". They are: ${edits.map((e) => e.key).join(', ')}.`);
    process.exit(1);
  }
  const staged = [];
  for (const edit of wanted) {
    const target = join(ROOT, edit.relative);
    const already = staged.find((m) => m.target === target);
    const original = already ? already.original : await readFile(target, 'utf8');
    const from_ = already ? already.broken : original;
    const broken = from_.replace(edit.from, edit.to);
    const applies = broken !== from_;
    if (already) {
      already.broken = broken;
      already.applies = already.applies && applies;
      already.what += `, ${edit.what}`;
    } else {
      staged.push({ target, original, broken, what: edit.what, applies });
    }
  }
  return { staged, mustGoRed: [...new Set(wanted.flatMap((e) => e.mustGoRed))] };
}

/* ONE — the audio graph. The right side of the lead-quieter tail is added to
   the left instead of being subtracted from it. Nothing throws, the song still
   plays, and the only way to notice is to measure what comes out.
   (The first control tried here was removing the Content-Length header, which
   had caused a real bug — the clock stuck at 0:00. It turned nothing red,
   because the wait for a late-arriving length covers a short file on its own.) */
control('apps/desktop/dist/renderer/audio/graph.js',
  'midR.gain.value = -MIDDLE_CANCEL_GAIN;',
  'midR.gain.value = MIDDLE_CANCEL_GAIN;', 'the audio graph', 'graph');

/* TWO — the picture rather than the sound. The graph flip cannot reach the
   waveform, so the stereo check would pass whatever happened. This draws the
   lower half of the wave from the LEFT channel — precisely the mono-looking
   picture Ted asked to be rid of, and it looks entirely reasonable on screen. */
control('apps/desktop/dist/renderer/ui/app.js',
  '{ data: peaks.right, mid: songH * 0.73',
  '{ data: peaks.left, mid: songH * 0.73', 'the stereo waveform', 'wave');

/* THREE — the layout. Dropping the line breaks out of the words under the
   record buttons is the realistic version of this mistake: "Record new" on one
   line is 75px instead of 50, three of those is more than the row has to give,
   and the dials drop to a row of their own taking 88 pixels of case with them.
   A wider max-width alone does nothing, because a <br> breaks whatever the CSS
   says. */
control('apps/desktop/dist/renderer/ui/app.css',
  '.t-name { max-width: 4.4rem;',
  '.t-name br { display: none } .t-name { max-width: 14rem;', 'the transport layout', 'layout');

/* FOUR — the skins. A skin listed in the picker and never wired looks exactly
   like one that works until somebody clicks it. */
control('apps/desktop/dist/renderer/ui/skins.css',
  "html[data-skin='daylight'] {",
  "html[data-skin='daylight-not-wired'] {", 'a wired skin', 'skin');

/* FIVE — the file that leaves the app. "Saved as C:\\..." appears whatever the
   encoder produced, so without this the export checks would prove only that a
   file of roughly the right size arrived. This feeds the MP3 encoder silence
   while the slicing, the writes, the progress and the message all carry on
   looking perfect. */
control('apps/desktop/dist/renderer/workers/export-worker.js',
  'left[held] = samples[f * channels] ?? 0;',
  'left[held] = 0;', 'the MP3 encoder', 'export');

/* SIX — the microphones. Splitting four inputs and then reading the SAME output
   of the splitter for every one of them is the realistic version of this
   mistake: connect(gain, c) becomes connect(gain, 0), one character, no error,
   and the app carries on perfectly. Four lanes move, four files are written,
   every one of them holds microphone one, and the gain switch appears to work
   because it really is changing a gain — just not the one it is named after.

   (The first thing tried here was leaving the worklet nodes at their default
   channel count and mode. It turned nothing red, because 'max' really does
   follow the input's four channels — so the setting is defensive rather than
   load-bearing, and a control has to break something that is.) */
control('apps/desktop/dist/renderer/audio/graph.js',
  'splitter.connect(gain, c);',
  'splitter.connect(gain, 0);', 'one microphone per input', 'mics');

/* SEVEN — the stretch engine itself, put back the way it silently died.
   Built with no inputs, its processor reaches for a live input it has not got
   the first time it renders a block while paused, throws, and is destroyed by
   the browser. Nothing is reported anywhere: the node still answers, still
   reports its position, still accepts a new speed. It just never makes a sound
   again. This is the fault that left Ted with a player that looked perfect and
   played nothing. */
control('apps/desktop/dist/renderer/audio/player.js',
  'numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2],',
  'numberOfInputs: 0, outputChannelCount: [2],', 'the stretch engine', 'engine',
  /* ONLY THE STOPPED-SONG CHECK, which is the one that cannot come out
     differently on a faster machine. The engine is destroyed by rendering one
     block while it is not playing; on a song that IS playing, whether that ever
     happens is a race, and it reproduced on the short file on the build runner
     and on the long one here. Built on a stopped song it is certain. Naming a
     racy check here would be a control that passes or fails on how fast the
     machine is, which is worse than not naming it. */
  ['and an engine built on a stopped song plays when play is pressed']);

/* EIGHT — the handover, decided before the song was playing rather than at the
   moment it happens. This is the old ordering in one line: the engine lands
   scheduled off while the song is playing, the element is pulled out of the
   graph, and the sound stops with every label still correct. */
control('apps/desktop/dist/renderer/audio/player.js',
  'const wasPlaying = this.playing;          // NOW, not before the decode',
  'const wasPlaying = false;', 'reading the state at the handover', 'handover',
  ['and the transport still says it is playing',
    'and it is still playing after the engine takes over']);

/* NINE — the guard that throws away an engine built for a song that has gone.
   Without it the finished build wires itself into whatever song is open now. */
control('apps/desktop/dist/renderer/audio/player.js',
  'if (startedAt !== this.generation || this.song !== startedFor || !this.el) {',
  'if (false) {', 'throwing away a stale engine', 'stale',
  ['and the engine built for the first one is thrown away, not wired in']);

/* TEN — a mono file handled as though every song had two channels. This is what
   the mistake really looks like: not a missing guard but an assumption, written
   once and true of every file anyone tested with. getChannelData(1) throws on a
   mono recording, the engine refuses to start, and the song plays on at normal
   speed with a message — which is far better than silence, and still not what the
   person asked for. */
control('apps/desktop/dist/renderer/audio/player.js',
  'if (chans.length === 1) chans.push(chans[0]);',
  'chans.push(buffer.getChannelData(1));', 'a mono recording', 'mono',
  ['a mono recording plays through the speed engine']);

let mutations = [];
let mustGoRed = [];
if (NEGATIVE) {
  ({ staged: mutations, mustGoRed } = await stageMutations());
  const dead = mutations.filter((m) => !m.applies);
  if (dead.length) {
    console.error(`A negative control no longer applies: ${dead.map((m) => m.what).join(', ')}.`);
    console.error('Nothing was written. Run "npm run build:code -w tva-player" and try again.');
    process.exit(1);
  }
  console.log(`Controls in force: ${mutations.map((m) => m.what).join(', ')}\n`);
  for (const m of mutations) await writeFile(m.target, m.broken);
}

/* Its own data directory, for two reasons that both bite on CI.
 *
 * The app holds a single-instance lock so that double-clicking a second song
 * opens it in the window already on screen rather than starting another copy.
 * That lock is per data directory, so two harness runs back to back — the
 * normal one and the negative control — would have the second instance see the
 * lock still held by a process that has not finished exiting, quit on the spot,
 * and time out having done nothing. It looks exactly like the app being broken.
 *
 * It also keeps each run's settings to itself, so one run cannot open a song
 * that the previous run had already saved a speed for. */
const userDataDir = join(work, 'ud');

/* A folder of songs, written into the settings before the app starts, so the
   library is exercised the way it is on a machine that already has one. */
const musicDir = join(work, 'Music');
await mkdir(musicDir, { recursive: true });
await makeMp3(join(musicDir, 'Shenandoah.mp3'), { seconds: 4 });
/* FOUR MINUTES, WHICH IS THE LENGTH TED ACTUALLY OPENS.
 *
 * The fault that left his player silent — the speed engine's worklet destroyed on
 * its first inactive render — did not reproduce on a short file. It turned up on
 * a thirty-second song here and on a six-second song on the build runner, on the
 * same code: whether the engine was ever asked for a block before it had finished
 * being handed the song depended on the machine. A suite whose longest song was
 * six seconds is how it shipped with every check green.
 *
 * The fix removes the crash rather than winning that race, so length should no
 * longer matter — and the way to know that is to run it at the length he uses.
 * Decoded, this is about 84 MB held in memory, with a second copy inside the
 * worklet, which is also what his own songs cost.
 *
 * It takes about ten seconds to encode and nothing asserts its length. */
await makeMp3(join(musicDir, 'Danny Boy.mp3'), { seconds: 240 });
/* Takes go into the work folder, not into the real Music folder. A test must
   never leave anything behind on the machine that ran it. */
const takesDir = join(work, 'Takes');
await mkdir(join(work, 'ud', 'Player Settings'), { recursive: true });
await writeFile(join(work, 'ud', 'Player Settings', 'settings.json'),
  JSON.stringify({ folders: [musicDir], recordingsDir: takesDir }, null, 2));

/* A STEADY 440 Hz TONE PLAYED INTO THE MICROPHONE.
 *
 * Chromium's built-in fake microphone turned out to be mostly silence with
 * bursts in it — measured, not assumed — so a take recorded from it has no
 * pitch to check. Handing Chromium a WAV to play instead gives the recorder a
 * known answer, which is the only way a recording test means anything. */
const micFile = join(work, 'mic-input.wav');
makeSong(micFile, { seconds: 20, left: 440, right: 440 });

const app = await electron.launch({
  args: [
    join(ROOT, 'apps/desktop'),
    '--no-sandbox',
    '--autoplay-policy=no-user-gesture-required',
    `--user-data-dir=${userDataDir}`,
    // Chromium's fake microphone emits a steady 440 Hz tone, which turns the
    // recorder into something with a right answer rather than a shrug.
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
    `--use-file-for-fake-audio-capture=${micFile}`,
    songPath, ...extraSongs,        // exactly how Windows hands over a multi-select
  ],
  env: { ...process.env, ONEDRIVE: '', OneDrive: '', OneDriveConsumer: '', OneDriveCommercial: '' },
});

const page = await app.firstWindow();
await page.waitForLoadState('domcontentloaded');

try {
  console.log('--- double-clicking a song in File Explorer ---');
  await page.waitForFunction(
    () => document.getElementById('now-name').textContent !== 'NO SONG OPEN', { timeout: 20000 });
  check('the song named on the command line opens by itself',
    (await page.textContent('#now-name')).includes('TEST SONG.MP3'),
    'no click needed — this is what double-clicking in Explorer does');

  await page.waitForFunction(() => !document.getElementById('play').disabled, { timeout: 10000 });
  check('and the play button becomes usable', true);
  check('the song\'s length is read', (await page.textContent('#t-total')) === '0:06',
    `clock reads ${await page.textContent('#t-total')}`);

  /* HOW MANY SONGS THE LAUNCH ITSELF DELIVERED, read here and nowhere later.
     The counter keeps counting, and checks further down open files of their own —
     read at the end it reported "6 of 3", which is three later checks doing their
     job rather than anything being wrong. Taken at the top, no check that is added
     below can move it. It waits, because the command line's songs arrive together
     a moment after start-up rather than with the first one. */
  const launchOpened = await page.evaluate(async () => {
    for (let i = 0; i < 100 && (window.__tvaOpenedCount ?? 0) < 3; i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    return window.__tvaOpenedCount ?? 0;
  });

  console.log('\n--- it plays ---');
  await page.click('#play');
  await page.waitForFunction(
    () => document.getElementById('t-now').textContent !== '0:00', { timeout: 10000 });
  check('the clock moves when play is pressed', true);
  check('the button offers to pause',
    (await page.getAttribute('#play', 'aria-label')) === 'Pause');
  check('and the playing lamp is lit',
    await page.evaluate(() => document.getElementById('lamp-play').classList.contains('lit')));

  /* AND SOUND ACTUALLY COMES OUT. Every check above this line reads a label the
     app writes about itself, and both faults that reached Ted left every one of
     those labels correct while the speakers stayed silent. This listens at the
     master bus — see scripts/sound-meter.mjs. */
  {
    const playing = await soundCameOut(page, 1200);
    check('and sound actually comes out', playing.peak > AUDIBLE, heard(playing));
  }

  const movedTo = await page.textContent('#t-now');
  await page.click('#play');
  await page.waitForTimeout(600);
  check('pause really stops it', (await page.textContent('#t-now')) === movedTo,
    `paused at ${movedTo}`);
  {
    const paused = await soundCameOut(page, 900);
    check('and the sound stops with it', paused.peak <= AUDIBLE, heard(paused));
  }

  console.log('\n--- dragging a knob ---');
  {
    /* THE BUG TED HIT ON HIS FIRST TRY. Turning a knob fires an input event on
       every pixel of movement. The first build started a fresh copy of the
       practice engine on each one — twenty movements meant the whole song being
       decoded twenty times at once, and the app locked up solid.

       So this drags the speed knob the way a hand does, forty events in a row,
       and then requires the app to still be answering AND to have landed on the
       value the knob was left at. Checking the readout alone would not have
       caught it: the readout was the one thing that kept working. */
    const before = Date.now();
    await page.evaluate(async () => {
      const el = document.getElementById('speed');
      for (let v = 100; v >= 60; v--) {
        el.value = String(v);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise((r) => setTimeout(r, 8));
      }
    });
    await page.waitForFunction(
      () => document.getElementById('speed-val').textContent === '60% speed', { timeout: 20000 });
    const dragMs = Date.now() - before;

    // Still answering, and answering quickly.
    const alive = Date.now();
    await page.evaluate(() => document.title);
    check('the app still answers after a knob is dragged across its range',
      Date.now() - alive < 2000, `${Date.now() - alive}ms to answer, drag took ${dragMs}ms`);

    await page.waitForFunction(
      () => window.__tvaMode && window.__tvaMode() === 'practice', { timeout: 25000 });
    check('one engine is started for the whole drag, not one per movement',
      await page.evaluate(() => window.__tvaEngineStarts?.() === 1),
      `${await page.evaluate(() => window.__tvaEngineStarts?.())} engine(s) started`);
    check('and the song ends up at the speed the knob was left at',
      await page.evaluate(() => window.__tvaSpeed?.() === 0.6),
      `engine is at ${await page.evaluate(() => window.__tvaSpeed?.())}`);
  }

  console.log('\n--- the speed control, and what it leaves behind ---');
  {
    /* TED'S OWN SEQUENCE, AND THE CHECK THAT WAS MISSING.
     *
     * "if i changed speed, no longer would it play until I completely close it
     * down from task manager again". Every speed check above this one asks what
     * the SETTING is — the readout says 60%, the engine reports 0.6 — and every
     * one of them was green while the music stopped. The number changing and the
     * sound continuing are two different claims, and only the first was checked.
     *
     * NOT MEASURED BY THE CLOCK. A window nothing is looking at gets its timers
     * throttled, so the clock freezes and catches up in jumps, and a check built
     * on it accuses the app of faults it does not have. What IS reliable, and is
     * what actually broke, is the state the control leaves the player in: which
     * engine it is on, whether an engine exists, and whether the transport still
     * believes it is playing. Ted's fault left the song paused, no engine, the
     * mode unchanged and not a word said. */
    const state = () => page.evaluate(() => ({
      mode: window.__tvaMode?.(),
      speed: window.__tvaSpeed?.(),
      engines: window.__tvaEngineStarts?.(),
      playing: document.getElementById('play').getAttribute('aria-label') === 'Pause',
      msg: document.getElementById('msg').textContent ?? '',
    }));

    await page.dblclick('.knob[data-knob="speed"]').catch(() => {});
    await page.evaluate(() => window.__tvaSeek?.(0));
    if ((await page.getAttribute('#play', 'aria-label')) === 'Play') await page.click('#play');
    await page.waitForTimeout(500);
    const playing = await state();
    check('a song is playing before the speed is touched', playing.playing,
      `transport says ${playing.playing ? 'Pause' : 'Play'}`);

    await page.evaluate(() => {
      const el = document.getElementById('speed');
      el.value = '80';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.waitForFunction(
      () => window.__tvaMode && window.__tvaMode() === 'practice', { timeout: 25000 }).catch(() => {});
    await page.waitForTimeout(500);
    const slowed = await state();
    check('changing the speed leaves it on a working engine', slowed.mode === 'practice',
      `mode is ${slowed.mode}`);
    check('and the transport still believes it is playing', slowed.playing,
      `transport says ${slowed.playing ? 'Pause' : 'Play'}, message: ${slowed.msg}`);

    /* AND AGAIN, because a switch that survives once and dies on the second
       change is the same fault with a longer fuse. */
    await page.evaluate(() => {
      const el = document.getElementById('key');
      el.value = '2';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.waitForTimeout(800);
    const keyed = await state();
    check('and changing the key on top of it changes nothing for the worse',
      keyed.mode === 'practice' && keyed.playing,
      `mode ${keyed.mode}, transport says ${keyed.playing ? 'Pause' : 'Play'}`);
  }

  console.log('\n--- when the speed engine cannot start ---');
  {
    /* THE FAULT ITSELF, PUT BACK ON PURPOSE.
     *
     * Switching engines pauses the song before it does anything else, so a
     * failure part-way took the sound away, said nothing, and left the app in a
     * state no button could undo — Ted had to kill the program from Task
     * Manager. This breaks the engine start deliberately and requires four
     * things of the app: it says why, it says the song is still going, the
     * player is back on an engine it can play from, and the dial is not stuck
     * where it failed. */
    /* BOTH DIALS BACK, AND THE APP TOLD ABOUT IT. Setting the value without
       dispatching the event changes the dial and not the song, so the song was
       reopened still transposed and went straight back onto the engine — which
       is why this check had nothing left to break. */
    await page.dblclick('.knob[data-knob="speed"]').catch(() => {});
    await page.dblclick('.knob[data-knob="key"]').catch(() => {});
    await page.evaluate(() => {
      const el = document.getElementById('key');
      el.value = '0';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.waitForTimeout(400);
    /* FROM A CLEAN START. The engine only fails on its way IN, and the block
       above left the player already running it, so the song is reopened —
       plain playback, no engine, exactly where Ted was when he reached for the
       speed knob. */
    await page.evaluate(() => window.__tvaOpenFirstArg?.());
    await page.waitForFunction(
      () => window.__tvaMode && window.__tvaMode() === 'straight', { timeout: 20000 });
    await page.evaluate(() => window.__tvaSeek?.(0));
    if ((await page.getAttribute('#play', 'aria-label')) === 'Play') await page.click('#play');
    await page.waitForTimeout(600);

    await page.evaluate(() => {
      window.__tvaFailEngineOnce();
      const el = document.getElementById('speed');
      el.value = '70';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.waitForTimeout(2000);

    const after = await page.evaluate(() => ({
      msg: document.getElementById('msg').textContent ?? '',
      mode: window.__tvaMode?.(),
      speed: window.__tvaSpeed?.(),
      playing: document.getElementById('play').getAttribute('aria-label') === 'Pause',
    }));

    check('the app says the speed control could not start',
      /would not start|could not start/i.test(after.msg), after.msg);
    check('and it says the song is still playing at normal speed',
      /normal speed/i.test(after.msg), after.msg);
    check('and the player is back on an engine it can play from',
      after.mode === 'straight', `mode is ${after.mode}`);
    check('and the dial is back to normal rather than stuck where it failed',
      after.speed === 1, `speed is ${after.speed}`);
    check('and the song was never left paused', after.playing,
      `transport says ${after.playing ? 'Pause' : 'Play'}`);

    await page.dblclick('.knob[data-knob="speed"]').catch(() => {});
  }

  console.log('\n--- the speed engine on a song of a real length ---');
  {
    /* THE ENGINE DIED THE MOMENT IT WAS BUILT, AND SAID NOTHING.
     *
     * It was created with no inputs, which is honest — it plays a song held in
     * memory and there is nothing to feed it. But its processor reaches for a
     * live input it has not got the first time it renders a block while paused.
     * It throws, the browser destroys the processor on the spot, and that is
     * reported nowhere: no exception, nothing in the console. The node carries on
     * answering. It reports its position, it accepts a new speed, it says it is
     * playing. It simply never makes another sound, and nothing but reopening the
     * app gets any back — which is exactly what Ted found.
     *
     * A LONG SONG ON PURPOSE. Whether the engine is asked for a block before it
     * has finished being handed the song depends on how much song there is. On
     * the six-second file the rest of these checks use it does not reproduce at
     * all, which is precisely how this shipped with 190 checks green. Ted's songs
     * are three to five minutes. */
    await page.evaluate(() => window.__tvaSlowEngine(0));
    const longSong = page.locator('#songlist .song', { hasText: 'Danny' });
    await longSong.click();
    await page.waitForFunction(
      () => !document.getElementById('play').disabled
        && document.getElementById('now-name').textContent.includes('DANNY'),
      { timeout: 40000 }).catch(() => {});
    /* DECIDED FROM THE PLAYER, NOT FROM THE BUTTON'S LABEL. The label is painted
       by an event and can still be showing the last song's state for a moment
       after a new one opens, so a check that reads it can decide not to press
       play and then measure the silence it caused itself. */
    if (!(await page.evaluate(() => window.__tvaPlayerState().playing))) await page.click('#play');
    await page.waitForFunction(
      () => window.__tvaPlayerState().playing, { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(800);
    {
      const m = await soundCameOut(page, 700);
      const st = await page.evaluate(() => ({
        ...window.__tvaPlayerState(),
        msg: document.getElementById('msg').textContent,
        name: document.getElementById('now-name').textContent,
        vol: window.__tvaGraph().master.gain.value,
        track: window.__tvaGraph().trackGain.gain.value,
      }));
      check('the long song plays', m.peak > AUDIBLE, `${heard(m)} ${JSON.stringify(st)}`);
    }

    await page.evaluate(() => {
      const el = document.getElementById('speed');
      el.value = '89';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.waitForFunction(
      () => window.__tvaMode && window.__tvaMode() === 'practice',
      { timeout: 60000 }).catch(() => {});
    const on = await soundCameOut(page, 1500);
    const mode = await page.evaluate(() => window.__tvaMode());
    /* ON THE ENGINE, AND MAKING A SOUND. Both, because either alone can be true
       while the app is broken: an engine that died is put back onto plain
       playback, which sounds right and is not what was asked for; and an engine
       that landed switched off is on the right mode and silent. */
    check('and the speed engine actually makes a sound',
      on.peak > AUDIBLE && mode === 'practice', `${heard(on)}, mode ${mode}`);

    /* AND THE SAME AGAIN WITH THE SONG STOPPED, which is the case that cannot
     * come out differently on a faster machine.
     *
     * The engine is destroyed by rendering ONE block while it is not playing. If
     * the song is playing when the engine is built, whether that ever happens is
     * a race between the first block and the samples being handed over — it
     * reproduced on a six-second file on the build runner and on a thirty-second
     * one here, which is a check that passes or fails on how fast the machine is.
     *
     * Built on a stopped song, the engine is switched off by definition, so the
     * first block it renders is an inactive one and the fault is certain. It is
     * also Ted's own sequence: the song opens with a speed already on it, and he
     * presses play afterwards. */
    await page.dblclick('.knob[data-knob="speed"]').catch(() => {});
    await page.waitForTimeout(300);
    if (await page.evaluate(() => window.__tvaPlayerState().playing)) await page.click('#play');
    await page.evaluate(() => { window.__tvaSeek(0); });
    await page.waitForTimeout(300);

    await page.evaluate(() => {
      const el = document.getElementById('speed');
      el.value = '85';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.waitForFunction(
      () => window.__tvaMode && window.__tvaMode() === 'practice',
      { timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(600);
    if (!(await page.evaluate(() => window.__tvaPlayerState().playing))) await page.click('#play');
    const woken = await soundCameOut(page, 1500);
    const wokenMode = await page.evaluate(() => window.__tvaMode());
    check('and an engine built on a stopped song plays when play is pressed',
      woken.peak > AUDIBLE && wokenMode === 'practice', `${heard(woken)}, mode ${wokenMode}`);

    await page.dblclick('.knob[data-knob="speed"]').catch(() => {});
    await page.waitForTimeout(300);
    if (await page.evaluate(() => window.__tvaPlayerState().playing)) await page.click('#play');
  }

  console.log('\n--- a song with a speed saved on it, and play pressed while it opens ---');
  {
    /* THE STATE TED'S APP IS IN EVERY MORNING, and the one state the checks went
     * out of their way never to be in.
     *
     * "At first it said nothing. I noticed the speed was at 89% so I double
     * clicked to reset the speed to 100%. Still nothing, but then I closed it and
     * reopened, opened a song and it played."
     *
     * A song that has a speed saved on it starts building the engine the moment
     * it opens — several seconds of fetching, decoding, compiling and registering
     * a worklet. The handover used to decide whether the song was playing at the
     * START of all that. Press play during it and the finished handover
     * disconnected a PLAYING element from the speakers and scheduled the engine
     * switched off: silence, no message, every label still correct, and only
     * reopening the app could reconnect it.
     *
     * Play is pressed WITHOUT waiting, on purpose. The first version of this
     * check waited 2500 ms after opening, which waits out the exact window the
     * fault lives in. It passed, and the app was broken. */
    // Back on the song the rest of this block reopens — the block above left
    // the long one open.
    await page.evaluate(() => window.__tvaOpenFirstArg());
    await page.waitForFunction(
      () => document.getElementById('now-name').textContent.includes('TEST SONG')
        && !document.getElementById('play').disabled,
      { timeout: 30000 }).catch(() => {});
    await page.evaluate(() => window.__tvaSlowEngine(2000));

    await page.evaluate(() => {
      const el = document.getElementById('speed');
      el.value = '89';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.waitForFunction(
      () => window.__tvaMode && window.__tvaMode() === 'practice',
      { timeout: 40000 }).catch(() => {});
    await page.waitForTimeout(1200);          // the 900 ms save, with room

    await page.evaluate(() => { window.__tvaOpenFirstArg(); });
    await page.waitForFunction(
      () => !document.getElementById('play').disabled && window.__tvaMode() === 'straight',
      { timeout: 40000 }).catch(() => {});
    /* READ ONCE. Asserting on one reading and then printing a second one is how a
       check comes out red with a detail line saying the right answer, which is
       the least useful failure there is. */
    const cameBack = await page.evaluate(() => window.__tvaSpeed());
    check('the saved speed comes back with the song', cameBack === 0.89,
      `speed is ${cameBack}`);

    await page.evaluate(() => window.__tvaSeek(0));
    await page.click('#play');                // pressed WHILE the engine is building
    const during = await soundCameOut(page, 1200);
    check('it plays while the speed engine is still being built',
      during.peak > AUDIBLE, heard(during));

    await page.waitForFunction(
      () => window.__tvaMode() === 'practice', { timeout: 40000 }).catch(() => {});
    /* READ THE MOMENT THE ENGINE LANDS. This is the instant the handover used to
       flip the transport back to Play with the song still running — so it is read
       before the listening below, which on a six-second song can outlast it. */
    const transport = await page.getAttribute('#play', 'aria-label');
    check('and the transport still says it is playing', transport === 'Pause',
      `transport says ${transport}`);
    const after = await soundCameOut(page, 1500);
    const onEngine = await page.evaluate(() => window.__tvaMode());
    check('and it is still playing after the engine takes over',
      after.peak > AUDIBLE && onEngine === 'practice',
      `${heard(after)}, mode ${onEngine}`);

    await page.evaluate(() => window.__tvaSlowEngine(0));
    if ((await page.getAttribute('#play', 'aria-label')) === 'Pause') await page.click('#play');
    await page.dblclick('.knob[data-knob="speed"]').catch(() => {});
    await page.waitForTimeout(400);
  }

  console.log('\n--- another song opened while an engine is still building ---');
  {
    /* A BUILD THAT LANDS ON THE WRONG SONG. Emptying the player for a new song
     * cleared the guard that stops two builds at once, but not the build itself.
     * It finished a few seconds later and wired ITSELF in: the new song's element
     * was disconnected, the clock reported the OLD song's length, and pressing
     * play played the old song's audio. Neither entry point could recover,
     * because both give up the moment the mode says 'practice'. */
    await page.evaluate(() => window.__tvaSlowEngine(2500));

    await page.evaluate(() => { window.__tvaOpenFirstArg(); });
    await page.waitForFunction(
      () => !document.getElementById('play').disabled && window.__tvaMode() === 'straight',
      { timeout: 40000 }).catch(() => {});
    const first = await page.textContent('#now-name');

    // A build is started for THIS song, and is still running a moment later.
    await page.evaluate(() => {
      const el = document.getElementById('speed');
      el.value = '75';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.waitForTimeout(400);
    check('a speed engine is being built for the first song',
      (await page.evaluate(() => window.__tvaMode())) === 'straight',
      'still on plain playback, so the build has not landed yet');

    /* And another song is opened before that build can land — by clicking it in
       the library, which is what a person does, and which opens AND plays it. */
    await page.click('#songlist .song:last-child');
    await page.waitForFunction(
      (was) => document.getElementById('now-name').textContent !== was,
      first, { timeout: 20000 });
    const second = await page.textContent('#now-name');
    check('the song that was opened second is the one that is open',
      second !== first && second.length > 0, `${first} -> ${second}`);

    await page.waitForTimeout(4000);          // longer than the build it left behind
    const held = await page.evaluate(() => ({
      name: document.getElementById('now-name').textContent,
      mode: window.__tvaMode(),
      total: document.getElementById('t-total').textContent,
    }));
    check('and the engine built for the first one is thrown away, not wired in',
      held.name === second && held.mode !== 'practice',
      `${held.name}, mode ${held.mode}, length ${held.total}`);

    await page.evaluate(() => window.__tvaSeek(0));
    if ((await page.getAttribute('#play', 'aria-label')) === 'Play') await page.click('#play');
    const still = await soundCameOut(page, 1200);
    check('and the song that is open still makes a sound',
      still.peak > AUDIBLE, heard(still));

    await page.evaluate(() => window.__tvaSlowEngine(0));
    await page.click('#play').catch(() => {});
    await page.evaluate(() => window.__tvaOpenFirstArg());
    await page.waitForFunction(
      () => document.getElementById('now-name').textContent.includes('TEST SONG'),
      { timeout: 20000 });
    await page.waitForTimeout(500);
    await page.dblclick('.knob[data-knob="speed"]').catch(() => {});
    await page.waitForTimeout(400);
  }

  console.log('\n--- the kinds of file Ted actually has, through the speed engine ---');
  {
    /* NOT PLAIN PLAYBACK — THE ENGINE. Plain playback is the browser's own
     * decoder and was never where the fault was. What had never been exercised is
     * the app's own handover: decoding a file, pulling its channels out, and
     * handing them to the stretch engine.
     *
     * Three shapes of file, none of which existed anywhere in this project until
     * now:
     *
     *   MONO — player.js duplicates the single channel so the tail has two sides
     *     and the balance control still means something. That line had never run.
     *   48 kHz — a file whose rate differs from the one the sound card is running
     *     at, so the browser resamples it on the way in.
     *   WAV — the format his own recordings come out of. There was a WAV in the
     *     suite, but it only ever went past the engine, never through it.
     *
     * Each one has to make a REAL SOUND and be ON THE ENGINE. Either alone can be
     * true while the app is broken: an engine that died is put back onto plain
     * playback, which sounds right and is not what was asked for. */
    const throughTheEngine = async (path, shown, speed) => {
      await page.click('#stop').catch(() => {});
      await page.evaluate((p) => window.tva.openDropped([p]), path);
      await page.waitForFunction(
        (n) => document.getElementById('now-name').textContent.includes(n)
          && !document.getElementById('play').disabled,
        shown, { timeout: 30000 }).catch(() => {});
      /* Decided from the player, not from the button's label: the label is
         painted by an event and can still show the last song's state. */
      if (!(await page.evaluate(() => window.__tvaPlayerState().playing))) await page.click('#play');
      await page.waitForFunction(
        () => window.__tvaPlayerState().playing, { timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(600);

      await page.evaluate((v) => {
        const el = document.getElementById('speed');
        el.value = String(v);
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }, speed);
      await page.waitForFunction(
        () => window.__tvaMode && window.__tvaMode() === 'practice',
        { timeout: 60000 }).catch(() => {});

      const sound = await soundCameOut(page, 1200);
      const state = await page.evaluate(() => window.__tvaPlayerState());
      const rate = await page.evaluate(() => window.__tvaGraph().ctx.sampleRate);
      const msg = await page.textContent('#msg');
      return { sound, mode: state.mode, state, rate, msg };
    };

    const setBalance = async (at) => page.evaluate((v) => {
      const el = document.getElementById('balance');
      el.value = String(v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }, at);

    {
      const got = await throughTheEngine(monoPath, 'MONO TAKE', 85);
      check('a mono recording plays through the speed engine',
        got.sound.peak > AUDIBLE && got.mode === 'practice',
        `${heard(got.sound)}, ${JSON.stringify(got.state)}, sample rate ${got.rate}`
        + `${got.msg ? `, message: ${got.msg}` : ''}`);

      /* AND OUT OF BOTH SIDES. The whole reason a single channel is duplicated is
         that the balance control still has two sides to work with; a mono song
         that went silent at one end of that control would be a mono song a person
         could not use. */
      await setBalance(-100);
      const leftOnly = await soundCameOut(page, 900);
      await setBalance(100);
      const rightOnly = await soundCameOut(page, 900);
      await setBalance(0);
      check('and it is audible with the balance hard over either way',
        leftOnly.peak > AUDIBLE && rightOnly.peak > AUDIBLE,
        `left ${leftOnly.peak.toFixed(4)}, right ${rightOnly.peak.toFixed(4)}`);
      await page.dblclick('.knob[data-knob="speed"]').catch(() => {});
    }

    {
      const got = await throughTheEngine(fortyEightPath, 'FORTY EIGHT', 90);
      check('a 48 kHz file plays through the speed engine',
        got.sound.peak > AUDIBLE && got.mode === 'practice',
        `${heard(got.sound)}, ${JSON.stringify(got.state)}, sample rate ${got.rate}`
        + `${got.msg ? `, message: ${got.msg}` : ''}`);
      await page.dblclick('.knob[data-knob="speed"]').catch(() => {});
    }

    {
      const got = await throughTheEngine(rawTakePath, 'RAW TAKE', 80);
      check('a WAV, which is what his own recordings are, plays through it too',
        got.sound.peak > AUDIBLE && got.mode === 'practice',
        `${heard(got.sound)}, ${JSON.stringify(got.state)}, sample rate ${got.rate}`
        + `${got.msg ? `, message: ${got.msg}` : ''}`);
      await page.dblclick('.knob[data-knob="speed"]').catch(() => {});
    }

    // Back to the song the rest of the checks expect.
    await page.click('#stop').catch(() => {});
    await page.evaluate(() => window.__tvaOpenFirstArg());
    await page.waitForFunction(
      () => document.getElementById('now-name').textContent.includes('TEST SONG'),
      { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(400);
  }

  console.log('\n--- the dials themselves ---');
  {
    /* DOUBLE-CLICK PUTS A DIAL BACK. Ted asked for it and every dial on a desk
       does it. The drag above left Speed at 60%, so this has something real to
       undo rather than confirming a dial that was already at its default. */
    await page.dblclick('.knob[data-knob="speed"]');
    await page.waitForFunction(
      () => document.getElementById('speed-val').textContent === 'Normal', { timeout: 10000 });
    check('double-clicking a dial puts it back to normal',
      await page.evaluate(() => window.__tvaSpeed?.() === 1),
      `speed is ${await page.evaluate(() => window.__tvaSpeed?.())}`);

    /* WHERE TWELVE O'CLOCK IS. Speed runs 25% to 200%, and Ted asked for normal
       to sit straight up. Those are not the same distance from 100, so a dial
       mapping its range evenly would draw normal at about four o'clock. This
       reads the pointer's actual rotation off the screen: straight up is 0deg,
       and the sweep runs -135deg to +135deg. */
    const pointerAngle = (id) => page.evaluate((knobId) => {
      const line = document.querySelector(`.knob[data-knob="${knobId}"] .k-ptr`);
      const m = /rotate\((-?[\d.]+)deg\)/.exec(line.style.transform ?? '');
      return m ? Number(m[1]) : null;
    }, id);

    check('normal speed sits straight up on the dial, not off to one side',
      Math.abs(await pointerAngle('speed')) < 0.01,
      `pointer at ${await pointerAngle('speed')}deg`);

    await page.evaluate(() => {
      const el = document.getElementById('speed');
      el.value = '25';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    check('a quarter speed is reachable, and is the far end of the dial',
      await page.evaluate(() => window.__tvaSpeed?.() === 0.25)
        && Math.abs((await pointerAngle('speed')) + 135) < 0.01,
      `speed ${await page.evaluate(() => window.__tvaSpeed?.())}, pointer ${await pointerAngle('speed')}deg`);

    await page.evaluate(() => {
      const el = document.getElementById('speed');
      el.value = '200';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    check('and double speed is the other end',
      await page.evaluate(() => window.__tvaSpeed?.() === 2)
        && Math.abs((await pointerAngle('speed')) - 135) < 0.01,
      `speed ${await page.evaluate(() => window.__tvaSpeed?.())}, pointer ${await pointerAngle('speed')}deg`);

    await page.dblclick('.knob[data-knob="speed"]');
    await page.waitForFunction(
      () => document.getElementById('speed-val').textContent === 'Normal', { timeout: 10000 });

    check('the pitch dial says Pitch, which is what Ted asked it to say',
      (await page.textContent('.knob[data-knob="key"] .k-name')).trim() === 'Pitch');
  }

  console.log('\n--- marking a part and naming it ---');
  {
    await page.fill('#loop-a', '0:01.0');
    await page.dispatchEvent('#loop-a', 'change');
    await page.fill('#loop-b', '0:03.5');
    await page.dispatchEvent('#loop-b', 'change');
    check('a typed time is read and shown back',
      (await page.inputValue('#loop-a')) === '0:01.0'
        && (await page.inputValue('#loop-b')) === '0:03.5',
      `got ${await page.inputValue('#loop-a')} to ${await page.inputValue('#loop-b')}`);
    check('marking a part turns repeating on by itself',
      (await page.getAttribute('#loop-on', 'aria-pressed')) === 'true');

    await page.click('[data-nudge="a"][data-by="0.1"]');
    check('a nudge moves one end by a tenth of a second',
      (await page.inputValue('#loop-a')) === '0:01.1',
      `got ${await page.inputValue('#loop-a')}`);

    await page.click('#save-sec');
    check('a part with no name is refused',
      (await page.textContent('#msg')).includes('name'),
      await page.textContent('#msg'));

    await page.fill('#secname', 'the bridge');
    await page.click('#save-sec');
    await page.waitForSelector('#sections .item', { timeout: 5000 });
    check('a named part appears in the list',
      (await page.textContent('#sections .item .name')) === 'the bridge');
    check('with the times it was marked at',
      (await page.textContent('#sections .item .when')).includes('0:01.1'),
      await page.textContent('#sections .item .when'));

    await page.click('#loop-clear');
    check('clearing the marks empties the boxes',
      (await page.inputValue('#loop-a')) === '' && (await page.inputValue('#loop-b')) === '');
    check('but keeps the part that was named',
      (await page.$$('#sections .item')).length === 1);
  }

  console.log('\n--- the practice engine, inside the real app ---');
  /* The engine compiles its WASM from bytes it carries and registers its worklet
     from a blob. Under a content security policy those are the two things most
     likely to be refused, and refused quietly — the song would keep playing at
     its own speed with the control appearing to work. So the engine is actually
     run here, on a known tone, and the pitch of what comes out is measured. */
  const stretched = await page.evaluate(async () => {
    const SR = 48000, F0 = 440, SEMIS = 2, RATE = 0.75;
    const inLen = SR * 2;
    const chans = [new Float32Array(inLen), new Float32Array(inLen)];
    for (let i = 0; i < inLen; i++) {
      const v = Math.sin(2 * Math.PI * F0 * i / SR) * 0.5;
      chans[0][i] = v; chans[1][i] = v;
    }
    const ctx = new OfflineAudioContext({ numberOfChannels: 2, length: Math.ceil(inLen / RATE) + SR, sampleRate: SR });
    const mod = await import('./audio/../vendor/SignalsmithStretch.mjs');
    const node = await mod.default(ctx, { numberOfInputs: 0, outputChannelCount: [2] });
    await node.addBuffers(chans);
    node.connect(ctx.destination);
    node.schedule({ active: true, input: 0, rate: RATE, semitones: SEMIS,
                    formantCompensation: true, formantBaseHz: 0 });
    const out = (await ctx.startRendering()).getChannelData(0);
    const mid = out.slice(Math.floor(SR * 0.6), Math.floor(SR * 1.6));
    let best = 0, bestLag = 0;
    for (let lag = Math.floor(SR / 1200); lag <= Math.floor(SR / 200); lag++) {
      let acc = 0; for (let i = 0; i + lag < mid.length; i++) acc += mid[i] * mid[i + lag];
      if (acc > best) { best = acc; bestLag = lag; }
    }
    let peak = 0; for (let i = 0; i < out.length; i++) peak = Math.max(peak, Math.abs(out[i]));
    return { hz: bestLag ? SR / bestLag : 0, want: F0 * Math.pow(2, SEMIS / 12), peak };
  });
  /* This measurement came back silent once in several runs and could not be
     reproduced on its own — twelve renders in a row in an otherwise idle page
     were all fine. So it stays strict, and gathers evidence when it does fail,
     rather than being softened into something that cannot fail. */
  if (!(stretched.peak > 0.05)) {
    const why = await page.evaluate(async () => {
      const out = { ctxState: null, moduleLoaded: false, error: null };
      try {
        const ctx = new OfflineAudioContext({ numberOfChannels: 2, length: 4410, sampleRate: 44100 });
        out.ctxState = ctx.state;
        const mod = await import('./vendor/SignalsmithStretch.mjs');
        out.moduleLoaded = typeof mod.default === 'function';
        const node = await mod.default(ctx, { numberOfInputs: 0, outputChannelCount: [2] });
        out.nodeMade = Boolean(node);
      } catch (e) { out.error = String(e.message ?? e); }
      return out;
    });
    console.log(`    silent render — diagnosis: ${JSON.stringify(why)}`);
  }

  const cents = 1200 * Math.log2(stretched.hz / stretched.want);
  check('the stretch engine runs under the app\'s security policy',
    stretched.peak > 0.05,
    'WASM compiled from carried bytes, worklet registered from a blob — a default policy refuses both');
  check('and moves the key by the number of half steps it was given',
    Math.abs(cents) < 50,
    `${stretched.hz.toFixed(1)} Hz against a wanted ${stretched.want.toFixed(1)} Hz, ${cents.toFixed(1)} cents off`);

  console.log('\n--- the two sides, measured rather than assumed ---');
  /* The tail graph is the ported half of the members player, and the part a
     person cannot check by looking: what "make the lead quieter" does is
     arithmetic between two channels. Rendered offline so it does not depend on
     this machine having a sound card. */
  const tail = await page.evaluate(async () => {
    const { buildGraph, routeTail, applyBalance, setSource } = await import('./audio/graph.js');
    const SR = 48000, LEN = SR / 2;

    async function render(build) {
      const ctx = new OfflineAudioContext({ numberOfChannels: 2, length: LEN, sampleRate: SR });
      const graph = buildGraph(ctx);
      // Left 440, right 660, plus a tone at 220 in the MIDDLE of both.
      const buf = ctx.createBuffer(2, LEN, SR);
      const l = buf.getChannelData(0), r = buf.getChannelData(1);
      for (let i = 0; i < LEN; i++) {
        const middle = Math.sin(2 * Math.PI * 220 * i / SR) * 0.3;
        l[i] = Math.sin(2 * Math.PI * 440 * i / SR) * 0.3 + middle;
        r[i] = Math.sin(2 * Math.PI * 660 * i / SR) * 0.3 + middle;
      }
      const src = ctx.createBufferSource(); src.buffer = buf;
      setSource(graph, src); build(graph); src.start();
      const out = await ctx.startRendering();
      return [out.getChannelData(0), out.getChannelData(1)];
    }

    // How much of a given frequency is present, by one Goertzel pass.
    const energyAt = (data, hz) => {
      const w = 2 * Math.PI * hz / SR, coeff = 2 * Math.cos(w);
      let s1 = 0, s2 = 0;
      for (let i = 0; i < data.length; i++) { const s = data[i] + coeff * s1 - s2; s2 = s1; s1 = s; }
      return Math.sqrt(s1 * s1 + s2 * s2 - coeff * s1 * s2) / data.length;
    };

    const plain = await render((g) => { applyBalance(g, 0); routeTail(g, { leadQuieter: false, oneSpeaker: false }); });
    const right = await render((g) => { applyBalance(g, 1); routeTail(g, { leadQuieter: false, oneSpeaker: false }); });
    const noLead = await render((g) => { applyBalance(g, 0); routeTail(g, { leadQuieter: true, oneSpeaker: false }); });
    const oneSpk = await render((g) => { applyBalance(g, 0); routeTail(g, { leadQuieter: false, oneSpeaker: true }); });

    return {
      plainLeft440: energyAt(plain[0], 440), plainRight660: energyAt(plain[1], 660),
      plainMiddle: energyAt(plain[0], 220),
      rightTailLeft: energyAt(right[0], 440),
      noLeadMiddle: energyAt(noLead[0], 220), noLead440: energyAt(noLead[0], 440),
      oneSpkLeftHas660: energyAt(oneSpk[0], 660), oneSpkRightHas440: energyAt(oneSpk[1], 440),
    };
  });

  check('normally each side comes out where it was recorded',
    tail.plainLeft440 > 0.05 && tail.plainRight660 > 0.05);
  check('sliding all the way to one side silences the other',
    tail.rightTailLeft < tail.plainLeft440 * 0.02,
    `left fell from ${tail.plainLeft440.toFixed(4)} to ${tail.rightTailLeft.toFixed(4)}`);
  check('"make the lead quieter" takes out what sits in the middle',
    tail.noLeadMiddle < tail.plainMiddle * 0.05,
    `the middle tone fell from ${tail.plainMiddle.toFixed(4)} to ${tail.noLeadMiddle.toFixed(4)}`);
  check('and leaves what was recorded to one side',
    tail.noLead440 > tail.plainLeft440 * 0.3,
    'a lead recorded off-centre only gets quieter, which is why the label never says "remove"');
  check('"same mix on both speakers" puts both sides on each speaker',
    tail.oneSpkLeftHas660 > 0.02 && tail.oneSpkRightHas440 > 0.02,
    'for a car or Bluetooth link that carries only one side');

  console.log('\n--- the start-up message reaches the page ---');
  {
    /* THE BUG THAT MADE TED SAY "I couldn't get it to play". The app told the
       page it was ready only if the page happened to still be loading, and by
       then that had already happened — so no settings arrived, no library
       loaded, and a song double-clicked in Explorer was dropped on the floor.
       The window looked completely normal. Anything that depends on start-up
       is checked here, because "the window opened" proves nothing. */
    const footer = await page.textContent('#where');
    check('the app tells the page where its settings are', footer.includes('Settings kept in'),
      footer.slice(0, 70));
    check('and the library it found on start-up is listed',
      (await page.$$('.raillist .song')).length === 2,
      `${(await page.$$('.raillist .song')).length} songs in the rail`);
    const label = await page.textContent('.raillist .song');
    check('with each song named, not shown as a path',
      !label.includes('\\') && !label.includes('/'), label);

    await page.fill('#find', 'danny');
    check('and searchable', (await page.$$('.raillist .song')).length === 1);
    await page.fill('#find', '');
  }

  console.log('\n--- one song after another ---');
  {
    await page.click('.raillist .song');     // the first in the list
    await page.waitForFunction(
      () => !document.getElementById('play').disabled, { timeout: 15000 });
    check('a song picked from the list opens',
      (await page.textContent('#now-name')).includes('DANNY'),
      await page.textContent('#now-name'));
    check('and the rest of the list is lined up behind it',
      !(await page.getAttribute('#upnext', 'hidden')),
      await page.textContent('#upnext'));
    check('with the next one named',
      (await page.textContent('#upnext')).includes('Shenandoah'),
      await page.textContent('#upnext'));

    /* The end of a song has to start the next one, or "play them all" is only
       a button that plays one song. */
    const moved = await page.evaluate(async () => {
      const before = document.getElementById('now-name').textContent;
      await window.__tvaNext();
      return { before, after: document.getElementById('now-name').textContent };
    });
    check('and reaching the end moves on to it',
      moved.after !== moved.before && moved.after.includes('SHENANDOAH'),
      `${moved.before} -> ${moved.after}`);

    // Back to the song the rest of the checks expect.
    await page.evaluate(() => window.__tvaOpenFirstArg());
    await page.waitForFunction(
      () => document.getElementById('now-name').textContent.includes('TEST SONG'),
      { timeout: 15000 });
  }

  console.log('\n--- keeping a list ---');
  {
    await page.click('#play-all');
    await page.click('#playlist-save');
    check('naming a list asks for the name on the page',
      !(await page.getAttribute('#listnamerow', 'hidden')),
      'Electron has no prompt() at all — using one would do nothing at all');
    await page.fill('#listname', 'Sunday set');
    await page.click('#listname-ok');
    await page.waitForFunction(
      () => [...document.getElementById('playlist-pick').options].some((o) => o.value === 'Sunday set'),
      { timeout: 5000 });
    check('and the list is kept and offered back', true);
    check('with the songs that were lined up',
      (await page.textContent('#msg')).includes('songs as "Sunday set"'),
      await page.textContent('#msg'));

    // Back to the song the later checks are about.
    await page.evaluate(() => window.__tvaOpenFirstArg());
    await page.waitForFunction(
      () => document.getElementById('now-name').textContent.includes('TEST SONG'),
      { timeout: 15000 });
  }

  console.log('\n--- the tabs ---');
  {
    for (const [tab, panel] of [['takes', 'takes'], ['notes', 'notes'], ['click', 'click'],
      ['setup', 'setup'], ['help', 'help'], ['loop', 'loop']]) {
      await page.click(`.tab[data-tab="${tab}"]`);
      const shown = await page.evaluate(() =>
        [...document.querySelectorAll('[data-panel]')]
          .filter((el) => el.getBoundingClientRect().height > 0)
          .map((el) => el.dataset.panel));
      check(`only the ${tab} panel shows when its tab is picked`,
        shown.length === 1 && shown[0] === panel,
        `showing ${JSON.stringify(shown)}`);
    }
  }

  console.log('\n--- the wave shows both sides of a stereo song ---');
  {
    /* Ted: "The audio visualization window needs to be able to see both right
       and left channels separately when a stereo track - not one image so it
       looks mono."
     *
       This reads the PICTURE, not the numbers behind it. The song has its right
       side at a quarter of the left, so the lower half of the wave must be
       visibly shorter than the upper half. Checking the peaks array instead
       would pass with both halves drawn from the same channel, which is the
       exact fault being fixed.
     *
       Playback is stopped first, and everything is read in ONE go. Left
       playing, a song reaching its end opens the next one by itself and wipes
       the wave — which is what happened between two reads here and reported
       this as broken when it was not. */
    await page.click('#stop');
    await page.evaluate((p) => window.tva.openDropped([p]), oneSidedPath);
    await page.waitForFunction(
      () => document.getElementById('now-name').textContent.includes('ONE SIDED'),
      { timeout: 15000 });
    await page.waitForFunction(() => window.__tvaWaveLanes?.() > 0, { timeout: 25000 });

    const wave = await page.evaluate(() => {
      const c = document.getElementById('wave');
      const g = c.getContext('2d');
      const img = g.getImageData(0, 0, c.width, c.height).data;
      let top = 0, bottom = 0;
      const half = Math.floor(c.height / 2);
      for (let y = 0; y < c.height; y++) {
        for (let x = 20; x < c.width - 4; x++) {   // past the L/R lettering
          if (img[(y * c.width + x) * 4 + 3] > 0) { if (y < half) top++; else bottom++; }
        }
      }
      return { top, bottom, lanes: window.__tvaWaveLanes(), song: document.getElementById('now-name').textContent };
    });
    check('a stereo song is drawn as two lanes', wave.lanes === 2,
      `${wave.lanes} lane(s), song is ${wave.song}`);
    check('the two channels are drawn separately, not as one mono picture',
      wave.top > 0 && wave.bottom > 0 && wave.bottom < wave.top * 0.6,
      `top half ${wave.top} pixels, bottom half ${wave.bottom}`);

    /* TWO SONGS OPENED AT ONCE. Opening a song waits several times over, so two
       opens close together used to interleave: the older one came back partway
       through the newer one and blanked its wave. It looked like the app being
       slow, and it took this check going red at random to find. */
    await page.evaluate((paths) => {
      window.tva.openDropped([paths[0]]);
      window.tva.openDropped([paths[1]]);
    }, [droppedPath, oneSidedPath]);
    await page.waitForFunction(
      () => document.getElementById('now-name').textContent.includes('ONE SIDED'),
      { timeout: 15000 });
    await page.waitForTimeout(1500);
    const after = await page.evaluate(() => ({
      lanes: window.__tvaWaveLanes(),
      song: document.getElementById('now-name').textContent,
      total: document.getElementById('t-total').textContent,
    }));
    check('opening two songs at once still leaves the second one drawn',
      after.lanes === 2 && after.song.includes('ONE SIDED'),
      `${after.lanes} lane(s), ${after.song}, ${after.total}`);
  }

  console.log('\n--- dragging a song into the window ---');
  {
    /* THE THING THAT MUST NOT HAPPEN. Left to itself, Electron treats a dropped
       file as a page to go to and replaces the whole app with it. */
    const before = page.url();
    const flagged = await page.evaluate(() => {
      const dt = new DataTransfer();
      dt.items.add(new File(['x'], 'dropped.mp3', { type: 'audio/mpeg' }));
      window.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, bubbles: true }));
      const showing = document.getElementById('tp').classList.contains('dropping');
      window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true }));
      return showing;
    });
    await page.waitForTimeout(300);
    check('the window says so while a song is held over it', flagged);
    check('and dropping one does not replace the app with the file',
      page.url() === before, page.url());
    check('and the outline goes away again',
      !(await page.evaluate(() => document.getElementById('tp').classList.contains('dropping'))));

    const opened = await page.evaluate((p) => window.tva.openDropped([p]), droppedPath);
    check('a song dropped in is opened', opened === 1, `${opened} opened`);
    await page.waitForFunction(
      () => document.getElementById('now-name').textContent.includes('DROPPED IN'),
      { timeout: 15000 });
    check('and it is the one on screen', true, await page.textContent('#now-name'));

    const ignored = await page.evaluate((p) => window.tva.openDropped([p]), notAudioPath);
    check('something that is not audio is refused rather than opened', ignored === 0);

    /* Back to the song the rest of these checks are about. Without this they
       carry on against whatever this block happened to leave open, and three of
       them failed for that reason alone. */
    await page.evaluate((p) => window.tva.openDropped([p]), songPath);
    await page.waitForFunction(
      () => document.getElementById('now-name').textContent.includes('TEST SONG'),
      { timeout: 15000 });
  }

  console.log('\n--- the things Ted could not work out ---');
  {
    /* THE THREE DOTS. "There are 3 dots in the upper right that glow green at
       various times. I don't understand what they are, or what they are for."
       A lamp with no word on it names nothing, so each one has to carry its own
       word — and reading the text is the only way to know it is really there. */
    const lampWords = await page.evaluate(() =>
      [...document.querySelectorAll('.lamp')].map((el) => el.textContent.trim()));
    check('each light by the song name says what it is',
      lampWords.length === 3 && lampWords.every((w) => w.length > 2),
      lampWords.join(', '));

    /* THE HELP HE WENT LOOKING FOR. "When I DO have a question, where are the
       instructions, help menu, information hover buttons?" Everything printed
       on one page, so nothing is behind a hover. */
    await page.click('.tab[data-tab="help"]');
    const help = (await page.textContent('[data-panel="help"]')).toLowerCase();
    for (const subject of ['drag', 'double-click', 'playing', 'loop', 'record', 'playlist', 'pitch',
      'mp3', 'save as type']) {
      check(`help answers a question about ${subject}`, help.includes(subject));
    }

    /* THE WORD IS LOOP. "use the term 'loop' or 'looping', not 'the part you
       are repeating' - again, wordy and thus confusing, when the actual word is
       ideal, simple and clear." */
    await page.click('.tab[data-tab="loop"]');
    const loopPanel = await page.textContent('[data-panel="loop"]');
    check('the loop bench calls a loop a loop', loopPanel.toLowerCase().includes('loop'));
    check('and never calls it "the part you are repeating"',
      !loopPanel.toLowerCase().includes('the part you are repeating'), loopPanel.slice(0, 60));

    /* THE RECORDER IS PART OF THE INSTRUMENT NOW. The numbered steps this used
       to measure are gone: Ted's second look said the form under the player was
       "Ugly, and hard to figure out quickly... Ideally, it would simply be an
       added layer to the playback interface... buttons like the transport
       buttons." So what is measured is that they really ARE transport buttons —
       same row, same centre line, same chrome — rather than a panel restyled to
       look like one. */
    await page.setViewportSize({ width: 1180, height: 760 });
    await page.click('.tab[data-tab="loop"]');
    const seat = await page.evaluate(() => {
      const r = (sel) => document.querySelector(sel).getBoundingClientRect();
      const t = r('.transport'), p = r('#play'), v = r('#rec-new'), b = r('#rec-over');
      const mid = (x) => x.top + x.height / 2;
      const round = (sel) => {
        const c = getComputedStyle(document.querySelector(sel));
        return parseFloat(c.borderTopLeftRadius) >= parseFloat(c.width) / 2 - 1;
      };
      return {
        inside: v.left >= t.left - 1 && b.right <= t.right + 1,
        offPlay: Math.max(Math.abs(mid(v) - mid(p)), Math.abs(mid(b) - mid(p))),
        red: Math.round(v.width), orange: Math.round(b.width), gold: Math.round(p.width),
        allRound: round('#back10') && round('#rec-new') && round('#rec-over'),
        words: [...document.querySelectorAll('.transport .t-name')]
          .map((e) => e.textContent.replace(/\s+/g, ' ').trim()),
      };
    });
    check('both record buttons sit inside the transport row', seat.inside);
    check('and on the same centre line as play, though they carry a word',
      seat.offPlay <= 1, `${seat.offPlay.toFixed(1)}px off`);
    check('they are round, like the rest of the transport — not pills or chips',
      seat.allRound);
    check('the orange one is bigger than the red and smaller than the gold play button',
      seat.red === 40 && seat.orange > seat.red && seat.orange < seat.gold,
      `${seat.red} / ${seat.orange} / ${seat.gold}`);
    check('each carries the word Ted chose',
      seat.words.some((w) => /record\s*new/i.test(w)) && seat.words.includes('Overdub'),
      seat.words.join(', '));

    /* The words are set in the dials' own class, so SPEED and RECORD NEW cannot
       drift apart into two different-looking labels. */
    const gold = await page.evaluate(() => {
      const c = (sel) => getComputedStyle(document.querySelector(sel));
      const a = c('.transport .t-name'), b = c('.knob[data-knob="speed"] .k-name');
      return {
        same: a.color === b.color && a.fontSize === b.fontSize
          && a.letterSpacing === b.letterSpacing && a.textTransform === b.textTransform,
        how: `${a.color} at ${a.fontSize}`,
      };
    });
    check('and is set exactly like SPEED and PITCH under the dials', gold.same, gold.how);

    /* THE BUDGET THE WHOLE LAYOUT RESTS ON. Four more buttons went into a row
       that had 836px to share with the dials, and a row that wraps costs 88px
       of case — which last time put the tabs and every panel off the bottom of
       the screen. Measured in the widest state there is: microphone live, so
       the extra tool is showing. */
    await page.evaluate(() => { window.__tvaRackIdle = Math.round(
      document.querySelector('.rack').getBoundingClientRect().height); });
    await page.click('#mic-open');
    await page.waitForFunction(
      () => !document.getElementById('level').hasAttribute('hidden'), { timeout: 20000 });
    const bench = await page.evaluate(() => {
      const t = document.querySelector('.transport').getBoundingClientRect();
      const k = document.querySelector('.bank').getBoundingClientRect();
      const b = document.querySelector('.bench').getBoundingClientRect();
      const tallest = Math.max(...[...document.querySelector('.bench').children]
        .map((e) => e.getBoundingClientRect().height));
      return {
        oneRow: Math.round(b.height) <= Math.round(tallest) + 2,
        clear: Math.round(k.left - t.right),
        transport: Math.round(t.width), bank: Math.round(k.width),
        keepShowing: !document.getElementById('cell-last').hasAttribute('hidden'),
        rack: Math.round(document.querySelector('.rack').getBoundingClientRect().height),
        idle: window.__tvaRackIdle,
        deskH: Math.round(document.querySelector('.deskwrap').clientHeight),
        sideways: document.documentElement.scrollWidth > window.innerWidth + 1,
      };
    });
    check('the bench is still one row with every record tool showing',
      bench.oneRow && bench.keepShowing,
      `transport ${bench.transport}px, dials ${bench.bank}px`);
    check('and the transport clears the dials',
      bench.clear >= 8, `${bench.clear}px between them`);
    check('turning the microphone on does not make the case taller',
      bench.rack === bench.idle, `${bench.idle}px idle, ${bench.rack}px live`);
    check('and nothing is pushed off the side', !bench.sideways);
    check('there is still room to work under the case',
      bench.deskH >= 90, `${bench.deskH}px of bench`);

    /* THE LEVEL IS ON THE INSTRUMENT. Ted asked for it "in the lit display with
       a clear, simple label", which means inside the case — not in a panel
       below it wearing a different set of clothes. */
    const meterHome = await page.evaluate(() => {
      const m = document.getElementById('meter-fill');
      const level = document.getElementById('level').getBoundingClientRect();
      const tabs = document.querySelector('.tabs').getBoundingClientRect();
      return {
        inCase: Boolean(m.closest('.rack')),
        parentIsMeter: m.parentElement.classList.contains('meter'),
        aboveTabs: level.bottom <= tabs.top,
        labelled: document.querySelector('#level .tlab').textContent.trim(),
      };
    });
    check('the level bar is part of the case, above the tabs',
      meterHome.inCase && meterHome.aboveTabs);
    check('it carries a plain label', meterHome.labelled.length > 3, meterHome.labelled);
    check("and the recorder's clipping still lands on the bar itself",
      meterHome.parentIsMeter, 'onLevel toggles .clipped on this element\u2019s parent');

    /* THE TAKES TAB IS A LIST, NOT A PROCEDURE. */
    await page.click('.tab[data-tab="takes"]');
    const takesTab = await page.evaluate(() => ({
      steps: document.querySelectorAll('[data-panel="takes"] .steps, [data-panel="takes"] .num').length,
      selects: document.querySelectorAll('[data-panel="takes"] select').length,
      micInSetup: Boolean(document.getElementById('mic-pick').closest('[data-panel="setup"]')),
      hasFolder: Boolean(document.querySelector('[data-panel="takes"] #rec-folder')),
      hasLatency: Boolean(document.querySelector('[data-panel="takes"] #latency')),
    }));
    check('the Takes tab has no numbered steps left in it', takesTab.steps === 0);
    check('and no microphone chooser — it is picked once, under Set-up',
      takesTab.selects === 0 && takesTab.micInSetup);
    check('it holds the folder button and the fine settings',
      takesTab.hasFolder && takesTab.hasLatency);
    await page.click('.tab[data-tab="loop"]');
  }

  console.log('\n--- the skins ---');
  {
    /* Twelve skins, two axes. The checks below measure what is PAINTED, because
       a skin that is declared and not wired looks exactly like one that works
       until you click it. */
    const ids = await page.evaluate(() => window.__tvaSkins());
    check('every skin Ted asked for is offered', ids.length === 12, ids.join(', '));

    /* THREE LIGHT ONES, measured rather than named. Ted asked for two more
       light backgrounds on top of Daylight, and a skin can be called anything
       — so this reads the case colour it actually paints. */
    const lightness = await page.evaluate(async (list) => {
      const out = [];
      for (const id of list) {
        window.__tvaSetSkin(id);
        await new Promise((r) => setTimeout(r, 30));
        const css = getComputedStyle(document.documentElement);
        const hex = css.getPropertyValue('--case-mid').trim();
        const n = (at) => parseInt(hex.slice(at, at + 2), 16) / 255;
        out.push({ id, light: 0.2126 * n(1) + 0.7152 * n(3) + 0.0722 * n(5) });
      }
      return out;
    }, ids);
    const light = lightness.filter((x) => x.light > 0.6).map((x) => x.id);
    check('three of them have a light background, for a room with the sun in it',
      light.length >= 3, light.join(', ') || 'none');

    /* Ted, on the members site: a name a newcomer cannot decode needs a line
       that decodes it. "Vintage" and "Stage" are exactly that, so every skin
       carries a sentence and the chosen one's is PRINTED rather than hovered. */
    const described = await page.evaluate(() => {
      const skins = window.__tvaSkins();
      window.__tvaSetSkin(skins[0]);
      return {
        all: window.__tvaSkinNotes?.() ?? [],
        shown: document.getElementById('skin-note')?.textContent ?? '',
      };
    });
    check('every skin says in words what it is for',
      described.all.length === 12 && described.all.every((w) => w.length > 25),
      `${described.all.length} described`);
    check('and the chosen one\'s line is printed under the row, not hidden in a hover',
      described.shown.length > 25, described.shown.slice(0, 60));

    /* A picture of the wave under each, so the canvas — which is painted rather
       than styled, and is therefore the one thing a skin cannot reach on its
       own — is proved to follow along. */
    const looks = [];
    for (const id of ids) {
      looks.push(await page.evaluate(async (skin) => {
        window.__tvaSetSkin(skin);
        await new Promise((r) => setTimeout(r, 120));
        const css = (sel, prop) => getComputedStyle(document.querySelector(sel))[prop];
        const c = document.getElementById('wave');
        const g = c.getContext('2d');
        const px = g.getImageData(0, 0, c.width, c.height).data;
        let ink = 0;
        for (let i = 0; i < px.length; i += 4) {
          if (px[i + 3] > 0) ink = (ink * 31 + px[i] * 65536 + px[i + 1] * 256 + px[i + 2]) % 2147483647;
        }
        /* The lit panels and the case are painted with GRADIENTS, so their
           computed backgroundColor is transparent and measuring text against
           it measures text against black. The backdrop each one actually sits
           on is the token that draws it, so that is what is read. */
        const token = (name) => getComputedStyle(document.documentElement)
          .getPropertyValue(name).trim();
        return {
          skin,
          rackImage: css('.rack', 'backgroundImage').slice(0, 40),
          readoutBg: token('--glass-low'),
          caseSurface: token('--case-mid'),
          clock: css('.r-clock', 'color'),
          cream: css('.swx b', 'color'),
          caseBg: css('.rack', 'backgroundImage'),
          rackShadow: css('.rack', 'boxShadow').slice(0, 70),
          playShadow: css('.tbtn.main', 'boxShadow').slice(0, 70),
          waveInk: ink,
        };
      }, id));
    }

    /* The PALETTE, not the painted background — the two differ, and comparing
       the painted one let a skin whose colours never applied still look
       distinct because its finish did. */
    const cases = new Set(looks.map((x) => `${x.caseSurface}|${x.readoutBg}`));
    check('each skin really repaints the case', cases.size === ids.length,
      `${cases.size} different cases across ${ids.length} skins`);

    const waves = new Set(looks.map((x) => x.waveInk));
    check('and the waveform follows the skin, not just the panels',
      waves.size === ids.length,
      `${waves.size} different wave pictures across ${ids.length} skins`);

    /* READABLE, not merely pretty. This is the one judgement my eye cannot be
       trusted with, so it is arithmetic: WCAG relative luminance, 4.5:1. */
    const channels = (colour) => {
      const hex = colour.trim().replace('#', '');
      if (/^[0-9a-f]{6}$/i.test(hex)) {
        return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
      }
      return colour.match(/[\d.]+/g).slice(0, 3).map(Number);
    };
    const ratio = (a, b) => {
      const lum = (colour) => {
        const [r, g, bl] = channels(colour)
          .map((v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
        return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
      };
      const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m);
      return (x + 0.05) / (y + 0.05);
    };
    const unreadable = looks
      .map((x) => ({ skin: x.skin, clock: ratio(x.clock, x.readoutBg), body: ratio(x.cream, x.caseSurface) }))
      .filter((x) => x.clock < 4.5 || x.body < 4.5);
    check('every skin is readable — 4.5:1 or better, measured not judged',
      unreadable.length === 0,
      unreadable.map((x) => `${x.skin} ${x.clock.toFixed(1)}/${x.body.toFixed(1)}`).join(', ')
        || `worst ${Math.min(...looks.map((x) => Math.min(
          ratio(x.clock, x.readoutBg), ratio(x.cream, x.caseSurface)))).toFixed(1)}:1`);

    /* FINISH IS ITS OWN AXIS, or "colour and finish" quietly became "colour". */
    const glossy = looks.find((x) => x.skin === 'navy');
    const matte = looks.find((x) => x.skin === 'grey');
    const flat = looks.find((x) => x.skin === 'contrast');
    const finishOf = (x) => `${x.rackShadow}|${x.playShadow}|${x.rackImage.startsWith('url')}`;
    check('a matte skin is lit differently, not just coloured differently',
      finishOf(matte) !== finishOf(glossy) && !matte.rackImage.startsWith('url'),
      `glossy grain ${glossy.rackImage.startsWith('url')}, matte grain ${matte.rackImage.startsWith('url')}`);
    check('and a flat one differs from both',
      finishOf(flat) !== finishOf(glossy) && finishOf(flat) !== finishOf(matte),
      `flat "${flat.rackShadow.slice(0, 34)}" vs matte "${matte.rackShadow.slice(0, 34)}"`);

    /* IT IS REMEMBERED. Clicking a swatch has to write the choice, or it is
       gone the next time the app opens. */
    await page.click('.tab[data-tab="setup"]');
    await page.waitForSelector('.skin[data-skin="vintage"]', { timeout: 5000 });
    await page.click('.skin[data-skin="vintage"]');
    await page.waitForTimeout(600);
    const savedSkin = JSON.parse(
      await readFile(join(userDataDir, 'Player Settings', 'settings.json'), 'utf8')).skin;
    check('choosing one from the swatches writes it down', savedSkin === 'vintage', savedSkin);
    check('and the swatch shows which one is on',
      (await page.getAttribute('.skin[data-skin="vintage"]', 'aria-pressed')) === 'true');

    await page.evaluate(() => window.__tvaSetSkin('navy'));
    await page.click('.tab[data-tab="loop"]');
  }

  console.log('\n--- notes pinned to a moment ---');
  {
    await page.click('.tab[data-tab="notes"]');
    await page.fill('#notetext', 'breath here');
    await page.click('#note-add');
    await page.waitForSelector('#notes .item', { timeout: 5000 });
    check('a note is pinned and listed',
      (await page.textContent('#notes .item .name')) === 'breath here');
    await page.fill('#notetext', '   ');
    await page.click('#note-add');
    check('an empty note is refused', (await page.textContent('#msg')).includes('Type what'));
    await page.click('#notes .item .iacts .chip:last-child');
    check('and a note can be removed', (await page.$$('#notes .item')).length === 0);
  }

  console.log('\n--- recording, from the player itself ---');
  {
    /* THE POINT OF THE REDESIGN. Ted pressed record and was sent to a form in
       another tab: "Ugly, and hard to figure out quickly." So this stays on the
       LOOP tab throughout and never opens the recorder's own page — because
       after this change there is no recorder page to open. */
    await page.click('.tab[data-tab="loop"]');
    await page.click('#rec-new');
    await page.waitForFunction(
      () => document.getElementById('lamp-rec').classList.contains('lit'), { timeout: 20000 });
    check('pressing Record new opens the microphone and starts, with nothing to set up first',
      true, 'the old step one is gone');

    check('the button now offers to stop and keep the take',
      (await page.textContent('#name-new')).replace(/\s+/g, ' ').includes('Stop'),
      await page.textContent('#name-new'));
    check('and the other record button cannot start a second take',
      await page.evaluate(() => document.getElementById('rec-over').disabled));

    // The meter has to move, or a person cannot set their level.
    await page.waitForFunction(() => {
      const w = document.getElementById('meter-fill').style.width;
      return w && parseFloat(w) > 1;
    }, { timeout: 10000 });
    check('and the level meter moves with the sound coming in', true);

    await page.waitForTimeout(1800);
    await page.click('#rec-new');
    await page.waitForFunction(
      () => !document.getElementById('lamp-rec').classList.contains('lit'), { timeout: 10000 });

    /* The list lives in a panel that is hidden until its tab is opened, and
       waitForSelector waits for VISIBLE — so without this click it would wait
       for ever against a list that is perfectly correct. */
    await page.click('.tab[data-tab="takes"]');
    await page.waitForSelector('#takes .item', { timeout: 10000 });
    check('a take is recorded and listed', (await page.$$('#takes .item')).length >= 1);

    /* What is actually IN the file, not merely that a file exists. Chromium's
       fake microphone sings a steady 440 Hz, so the take can be checked by
       reading it back and measuring its pitch — which covers the worklet, the
       transfer to the main process, the write to disk and the header. */
    const takeInfo = await page.evaluate(async () => {
      const list = await window.tva.listRecordings();
      if (!list.length) return null;
      const bytes = await (await fetch(list[0].url)).arrayBuffer();
      /* Decoded at the file's own rate. Resampling a take on the way in would
         change the very thing being measured. */
      const rate = new DataView(bytes).getUint32(24, true);
      const ctx = new OfflineAudioContext({ numberOfChannels: 1, length: 1, sampleRate: rate });
      const buf = await ctx.decodeAudioData(bytes);
      const d = buf.getChannelData(0);
      const from = Math.floor(buf.sampleRate * 0.4);
      const seg = d.slice(from, from + Math.floor(buf.sampleRate * 0.5));
      let peak = 0; for (let i = 0; i < seg.length; i++) peak = Math.max(peak, Math.abs(seg[i]));
      let best = 0, lag = 0;
      for (let t = Math.floor(buf.sampleRate / 1200); t <= Math.floor(buf.sampleRate / 200); t++) {
        let acc = 0; for (let i = 0; i + t < seg.length; i++) acc += seg[i] * seg[i + t];
        if (acc > best) { best = acc; lag = t; }
      }
      return { seconds: buf.duration, peak, hz: lag ? buf.sampleRate / lag : 0, name: list[0].name };
    });
    check('the take is a real audio file of about the right length',
      takeInfo && takeInfo.seconds > 1 && takeInfo.seconds < 4,
      `${takeInfo?.seconds?.toFixed(2)} seconds`);
    check('and it holds the sound the microphone was hearing',
      takeInfo && takeInfo.peak > 0.05 && Math.abs(takeInfo.hz - 440) < 12,
      `peak ${takeInfo?.peak?.toFixed(3)}, pitch ${takeInfo?.hz?.toFixed(1)} Hz against 440`);
    check('and it is named after the song it was sung against',
      takeInfo && takeInfo.name.startsWith('Test Song'), takeInfo?.name);

    /* THE TWO BUTTONS HAVE TO DIFFER, or splitting them bought nothing. The
       tick box that used to say "play the song too" is gone; this is what
       replaced it, so this is what has to be measured. */
    await page.click('.tab[data-tab="loop"]');
    const apart = await page.evaluate(async () => {
      const clock = () => document.getElementById('t-now').textContent;
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const run = async (id) => {
        document.getElementById('stop').click(); await wait(400);
        const before = clock();
        document.getElementById(id).click(); await wait(1500);
        const during = clock();
        document.getElementById(id).click(); await wait(800);
        return { before, during };
      };
      const red = await run('rec-new');
      const orange = await run('rec-over');
      return { red, orange };
    });
    check('Record new records the voice and leaves the song where it was',
      apart.red.during === apart.red.before,
      `clock went ${apart.red.before} -> ${apart.red.during}`);
    check('Overdub starts the song as well',
      apart.orange.during !== apart.orange.before,
      `clock went ${apart.orange.before} -> ${apart.orange.during}`);
  }

  console.log('\n--- saving a take out, in the format he picks ---');
  {
    /* The Save box is a Windows dialog, so it is answered here from the MAIN
       process rather than the page — which also lets the check read what the
       box was actually offered, instead of trusting that the filters are right. */
    await app.evaluate(({ dialog }) => {
      globalThis.__saveCalls = [];
      globalThis.__saveNext = null;
      dialog.showSaveDialog = async (_win, options) => {
        globalThis.__saveCalls.push(options);
        const filePath = globalThis.__saveNext;
        return filePath ? { canceled: false, filePath, filterIndex: 1 } : { canceled: true };
      };
    });
    const answerSaveBox = (target) =>
      app.evaluate((_electron, value) => { globalThis.__saveNext = value; }, target);

    /* Reads a file the app has written, back through the app's own protocol,
       and measures what is in it. "A file appeared" proves nothing: the whole
       point is whether the sound survived the encoder. */
    const measure = async (filePath) => page.evaluate(async (target) => {
      const url = `app://player/song/${encodeURIComponent(target)}`;
      const response = await fetch(url);
      if (!response.ok) return { error: `fetch ${response.status}` };
      const bytes = await response.arrayBuffer();
      /* The size is read BEFORE decoding. decodeAudioData takes ownership of the
         buffer and detaches it, so afterwards byteLength is 0 — which made the
         "smaller than the take" check compare zero against everything and pass
         whatever the encoder had done. */
      const size = bytes.byteLength;
      if (size === 0) return { error: 'empty file' };
      const ctx = new OfflineAudioContext({ numberOfChannels: 1, length: 1, sampleRate: 44100 });
      const buf = await ctx.decodeAudioData(bytes);
      const d = buf.getChannelData(0);
      const from = Math.floor(buf.sampleRate * 0.4);
      const seg = d.slice(from, from + Math.floor(buf.sampleRate * 0.5));
      let peak = 0;
      for (let i = 0; i < seg.length; i++) peak = Math.max(peak, Math.abs(seg[i]));
      let best = 0; let lag = 0;
      for (let t = Math.floor(buf.sampleRate / 1200); t <= Math.floor(buf.sampleRate / 200); t++) {
        let acc = 0;
        for (let i = 0; i + t < seg.length; i++) acc += seg[i] * seg[i + t];
        if (acc > best) { best = acc; lag = t; }
      }
      return { seconds: buf.duration, bytes: size, peak, hz: lag ? buf.sampleRate / lag : 0 };
    }, filePath);

    await page.click('.tab[data-tab="takes"]');
    await page.waitForSelector('#takes .item', { timeout: 10000 });

    const row = await page.evaluate(() => {
      const chips = [...document.querySelectorAll('#takes .item .iacts .chip')]
        .slice(0, 4).map((c) => c.textContent);
      const acts = document.querySelector('#takes .item .iacts');
      const edges = [...acts.querySelectorAll('.chip')]
        .map((c) => Math.round(c.getBoundingClientRect().right));
      const tops = [...acts.querySelectorAll('.chip')]
        .map((c) => Math.round(c.getBoundingClientRect().top));
      return { chips, rowRight: Math.round(acts.getBoundingClientRect().right + 1), edges, tops };
    });
    check('a take row offers to save the voice on its own as well as with the song',
      row.chips.length === 4 && /Save my voice/.test(row.chips[1]) && /Save with the song/.test(row.chips[2]),
      row.chips.join(' | '));
    check('and not one of the four buttons is cut off',
      row.edges.every((right) => right <= row.rowRight),
      `row ends at ${row.rowRight}, buttons at ${row.edges.join(', ')}`);
    check('and they sit on one line, rather than three with the fourth below',
      new Set(row.tops).size === 1,
      `tops at ${row.tops.join(', ')}`);

    /* 1. The voice on its own, as an MP3. This is the whole of the new feature:
          a take the app recorded, out as something he can email. */
    /* The message line is cleared first every time. Without that, the wait
       below reads the PREVIOUS save's "Saved as …" and carries on measuring a
       file that has not been written yet — which is exactly what happened the
       first time this ran, and it looked like an encoder fault. */
    const clearMessage = () => page.evaluate(() => { document.getElementById('msg').textContent = ''; });
    const waitForSave = () => page.waitForFunction(
      () => /^Saved as /.test(document.getElementById('msg').textContent), { timeout: 60000 });

    const mp3Target = join(work, 'Just my voice.mp3');
    await clearMessage();
    await answerSaveBox(mp3Target);
    await page.click('#takes .item .iacts .chip:nth-child(2)');
    await waitForSave();

    const offered = await app.evaluate(() => globalThis.__saveCalls.at(-1));
    check('the Save box offers MP3 and WAV, and nothing that cannot be made',
      offered.filters.length === 2
      && offered.filters[0].extensions[0] === 'mp3'
      && offered.filters[1].extensions[0] === 'wav',
      JSON.stringify(offered.filters));

    const asMp3 = await measure(mp3Target);
    check('the MP3 holds the sound that was sung, at the pitch it was sung at',
      !asMp3.error && asMp3.peak > 0.05 && Math.abs(asMp3.hz - 440) < 12,
      `peak ${asMp3.peak?.toFixed(3)}, pitch ${asMp3.hz?.toFixed(1)} Hz against 440`);
    check('and it is the length of the take, not a fragment of it',
      !asMp3.error && asMp3.seconds > 1 && asMp3.seconds < 4.3,
      `${asMp3.seconds?.toFixed(2)} seconds`);
    /* The take the row is showing, which is the NEWEST — not whichever name
       the folder listing happened to hand back first. Three takes were recorded
       above, and comparing against the wrong one made a correct copy look
       thirty kilobytes short. */
    const takePath = await page.evaluate(async () => (await window.tva.listRecordings())[0].path);
    const takeBytes = (await readFile(takePath)).length;
    check('and it is far smaller than the take it came from',
      asMp3.bytes < takeBytes / 2,
      `${Math.round(asMp3.bytes / 1024)} KB against ${Math.round(takeBytes / 1024)} KB`);

    /* 2. The voice on its own, as a WAV. Same rate, same channels, same sixteen
          bits — so it must come out byte for byte, not merely close. */
    const wavTarget = join(work, 'Just my voice.wav');
    await clearMessage();
    await answerSaveBox(wavTarget);
    await page.click('#takes .item .iacts .chip:nth-child(2)');
    await waitForSave();
    const copied = await readFile(wavTarget);
    const original_ = await readFile(takePath);
    check('a take saved as a WAV is the take, byte for byte',
      copied.length === original_.length && copied.equals(original_),
      `${copied.length} bytes against ${original_.length}`);

    /* 3. The take and the song in one file, which is the path that goes through
          the slice-by-slice mixing. */
    const mixTarget = join(work, 'With the song.mp3');
    await clearMessage();
    await answerSaveBox(mixTarget);
    await page.click('#takes .item .iacts .chip:nth-child(3)');
    await waitForSave();
    const mixed = await measure(mixTarget);
    check('the take and the song come out as one file with sound in it',
      !mixed.error && mixed.peak > 0.05, JSON.stringify(mixed).slice(0, 90));
    check('and it runs as long as the song, not just as long as the take',
      !mixed.error && mixed.seconds > 5, `${mixed.seconds?.toFixed(2)} seconds against a 6 second song`);

    /* 4. Cancelling the Save box does nothing at all. */
    await answerSaveBox(null);
    await clearMessage();
    await page.click('#takes .item .iacts .chip:nth-child(2)');
    await page.waitForFunction(
      () => document.getElementById('msg').textContent.length > 0, { timeout: 10000 });
    check('cancelling the Save box saves nothing and says so',
      (await page.textContent('#msg')) === 'Nothing was saved.',
      await page.textContent('#msg'));

    /* 5. A save that goes wrong takes its part-written file with it. Left
          behind in his Music folder, a half MP3 looks exactly like a take that
          went wrong — which is a worse outcome than no file. */
    const abandoned = join(work, 'Abandoned.mp3');
    await page.evaluate(async (target) => {
      const opened = await window.tva.exportOpen({ filePath: target });
      await window.tva.exportWrite(opened.id, new Uint8Array(4096));
      await window.tva.exportAbort(opened.id);
    }, abandoned);
    const left = (await readdir(work)).includes('Abandoned.mp3');
    check('an abandoned save leaves no part-written file behind', left === false);

    /* 6. A TAKE RECORDED AT AN UNUSUAL RATE. An interface running at 96 kHz is
          the case that would quietly produce a file at the wrong speed, and the
          reason there is no resampling step in the app at all is that LAME does
          it — measured here rather than taken on trust. A tone that comes back
          at 440 Hz went in and out at the right speed. */
    const odd = await page.evaluate(() => new Promise((resolve) => {
      const worker = new Worker('./workers/export-worker.js', { type: 'module' });
      const parts = [];
      worker.addEventListener('message', async (event) => {
        if (event.data.type === 'bytes') { parts.push(event.data.bytes); return; }
        worker.terminate();
        let length = 0;
        for (const part of parts) length += part.length;
        const file = new Uint8Array(length);
        let at = 0;
        for (const part of parts) { file.set(part, at); at += part.length; }
        try {
          const ctx = new OfflineAudioContext({ numberOfChannels: 1, length: 1, sampleRate: 44100 });
          const buf = await ctx.decodeAudioData(file.buffer);
          const d = buf.getChannelData(0);
          const from = Math.floor(buf.sampleRate * 0.3);
          const seg = d.slice(from, from + Math.floor(buf.sampleRate * 0.5));
          let best = 0; let lag = 0;
          for (let t = Math.floor(buf.sampleRate / 1200); t <= Math.floor(buf.sampleRate / 200); t++) {
            let acc = 0;
            for (let i = 0; i + t < seg.length; i++) acc += seg[i] * seg[i + t];
            if (acc > best) { best = acc; lag = t; }
          }
          resolve({ bytes: length, seconds: buf.duration, hz: lag ? buf.sampleRate / lag : 0 });
        } catch (err) { resolve({ bytes: length, error: String(err) }); }
      });
      const rate = 96000;
      const seconds = 2;
      worker.postMessage({
        type: 'begin', format: 'mp3', sampleRate: rate, channels: 1,
        totalFrames: rate * seconds, kbps: 128,
      });
      const samples = new Int16Array(rate * seconds);
      for (let i = 0; i < samples.length; i++) {
        samples[i] = Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 12000);
      }
      worker.postMessage({ type: 'pcm', samples }, [samples.buffer]);
      worker.postMessage({ type: 'end' });
    }));
    check('a take from a 96 kHz interface still comes out at the pitch it was sung',
      !odd.error && Math.abs(odd.hz - 440) < 12,
      `pitch ${odd.hz?.toFixed(1)} Hz against 440`);
    check('and at the speed it was sung, not half or double',
      !odd.error && Math.abs(odd.seconds - 2) < 0.15,
      `${odd.seconds?.toFixed(2)} seconds against 2`);
  }

  console.log('\n--- the tuner ---');
  {
    check('the tuner appears once the microphone is on',
      !(await page.getAttribute('#tuner', 'hidden')) === true
        || (await page.isVisible('#tuner')));
    await page.waitForFunction(
      () => document.getElementById('t-note').textContent !== '\u2014', { timeout: 15000 });
    const note = await page.textContent('#t-note');
    check('and it names the note being sung', note === 'A4',
      `read ${note}; the fake microphone sings 440 Hz, which is A4`);
  }

  console.log('\n--- four microphones at once ---');
  {
    /* AN INTERFACE CANNOT BE PLUGGED INTO A BUILD RUNNER, so a four-channel
       signal is built inside the page — 220, 330, 440 and 550 Hz, one note per
       channel — and handed to the recorder through the same door a Clarett or a
       Scarlett goes through. Each note is what identifies its own file
       afterwards, which is what makes this a measurement rather than a count of
       files that appeared. */
    await page.click('.tab[data-tab="loop"]');
    await page.evaluate(async () => {
      if (window.__tvaMicState().open) document.getElementById('mic-open').click();
      await new Promise((r) => setTimeout(r, 400));
    });
    const opened = await page.evaluate(() => window.__tvaFakeMics(4, [220, 330, 440, 550]));
    check('all four inputs are taken, not just the first two',
      opened.channels === 4 && opened.live.length === 4,
      `${opened.channels} channels, ${opened.live.length} recorded`);

    const before = (await readdir(takesDir)).length;
    await page.click('#rec-new');
    await page.waitForFunction(
      () => document.getElementById('lamp-rec').classList.contains('lit'), { timeout: 15000 });
    await page.waitForTimeout(1600);
    await page.click('#rec-new');
    await page.waitForFunction(
      () => !document.getElementById('lamp-rec').classList.contains('lit'), { timeout: 10000 });
    await page.waitForTimeout(400);

    const made = (await readdir(takesDir)).filter((n) => n.endsWith('.wav'));
    const fromThisTake = made.length - before;
    check('one take writes a file for every microphone, and one more of them mixed',
      fromThisTake === 5, `${fromThisTake} new files`);
    const stamp = /(\d{4}-\d{2}-\d{2} \d{2}\.\d{2}\.\d{2})\.wav$/;
    const newest = made.map((f) => stamp.exec(f)?.[1] ?? '').sort().at(-1);
    const thisTake = made.filter((f) => f.includes(newest));
    check('and each file says which microphone it is, in its own name',
      [1, 2, 3, 4].every((n) => thisTake.some((f) => f.includes(`(Mic ${n})`)))
      && thisTake.some((f) => f.includes('(all mics mixed)')),
      thisTake.join(' | '));
    check('and every file of one take carries the same time, so they sit together',
      thisTake.length === 5, `${thisTake.length} files stamped ${newest}`);

    /* The notes. A file named "(Mic 3)" holding 220 Hz would mean the channels
       were crossed, and every file holding the same note would mean Web Audio
       folded the four down to one before the app ever saw them — which is what
       happens if the channel count and interpretation are left at their
       defaults, and it is the single most likely way this breaks. */
    const pitches = await page.evaluate(async () => {
      const list = await window.tva.listRecordings();
      const out = [];
      for (const take of list.slice(0, 5)) {
        const bytes = await (await fetch(take.url)).arrayBuffer();
        const rate = new DataView(bytes).getUint32(24, true);
        const ctx = new OfflineAudioContext({ numberOfChannels: 1, length: 1, sampleRate: rate });
        const buf = await ctx.decodeAudioData(bytes);
        const d = buf.getChannelData(0);
        const seg = d.slice(Math.floor(rate * 0.4), Math.floor(rate * 1.0));
        let peak = 0;
        for (let i = 0; i < seg.length; i++) peak = Math.max(peak, Math.abs(seg[i]));
        let best = 0; let lag = 0;
        for (let t = Math.floor(rate / 900); t <= Math.floor(rate / 150); t++) {
          let acc = 0;
          for (let i = 0; i + t < seg.length; i++) acc += seg[i] * seg[i + t];
          if (acc > best) { best = acc; lag = t; }
        }
        out.push({ name: take.name, peak, hz: lag ? rate / lag : 0 });
      }
      return out;
    });
    const noteFor = (n) => pitches.find((x) => x.name.includes(`(Mic ${n})`));
    const wanted = { 1: 220, 2: 330, 3: 440, 4: 550 };
    const rightNote = [1, 2, 3, 4].every((n) => {
      const got = noteFor(n);
      return got && got.peak > 0.02 && Math.abs(got.hz - wanted[n]) < 12;
    });
    check('each microphone\'s own file holds that microphone and no other',
      rightNote,
      [1, 2, 3, 4].map((n) => `Mic ${n}: ${noteFor(n)?.hz?.toFixed(0) ?? '—'} Hz`).join(', '));

    const mixed = pitches.find((x) => x.name.includes('all mics mixed'));
    check('and the mixed file holds all four of them at once',
      mixed && mixed.peak > 0.02,
      `peak ${mixed?.peak?.toFixed(3)}`);
    check('the mix is an average rather than a sum, so four microphones cannot clip it',
      mixed && mixed.peak < 0.95,
      `peak ${mixed?.peak?.toFixed(3)} — summed, four at 0.3 each would be near full scale`);
  }

  console.log('\n--- turning one microphone up ---');
  {
    /* THE GAIN HAS TO REACH THE FILE, not just the number on the panel. Mic 2
       is put up 12 dB, which is four times the amplitude, and the take it
       writes is measured against mic 1's — which was left alone. */
    /* Driven through the buttons rather than the state, because what is being
       checked includes that the buttons are wired, that the panel says which
       microphone they act on, and that the setting is written down. */
    await page.click('#mic-next');
    check('the panel names the microphone the gain buttons act on',
      (await page.textContent('#gain-who')) === 'Mic 2',
      await page.textContent('#gain-who'));
    /* SIX DECIBELS, NOT TWELVE. Twelve doubles twice, and the test signal sits
       at 0.3 — so mic 2 would arrive at 1.19, be clamped to full scale on the
       way into the file, and the measured ratio would be 3.33 because of the
       clamping rather than 4 because of the gain. The check would have passed
       and measured the wrong thing. */
    for (let i = 0; i < 6; i++) await page.click('#gain-up');
    const shown = await page.textContent('#gain-val');
    const state = await page.evaluate(() => window.__tvaMicState());
    check('and the gain it is set to', state.gains[1] === 6 && shown === '+6 dB',
      `${shown} on mic ${state.selected + 1}`);

    await page.click('#rec-new');
    await page.waitForFunction(
      () => document.getElementById('lamp-rec').classList.contains('lit'), { timeout: 15000 });
    await page.waitForTimeout(1400);
    await page.click('#rec-new');
    await page.waitForFunction(
      () => !document.getElementById('lamp-rec').classList.contains('lit'), { timeout: 10000 });
    await page.waitForTimeout(400);

    const levels = await page.evaluate(async () => {
      const list = await window.tva.listRecordings();
      const out = {};
      for (const take of list.slice(0, 5)) {
        const which = /\(Mic (\d)\)/.exec(take.name);
        if (!which) continue;
        const bytes = await (await fetch(take.url)).arrayBuffer();
        const rate = new DataView(bytes).getUint32(24, true);
        const ctx = new OfflineAudioContext({ numberOfChannels: 1, length: 1, sampleRate: rate });
        const buf = await ctx.decodeAudioData(bytes);
        const d = buf.getChannelData(0);
        let peak = 0;
        for (let i = Math.floor(rate * 0.4); i < Math.min(d.length, rate * 1.0); i++) {
          peak = Math.max(peak, Math.abs(d[i]));
        }
        if (out[which[1]] === undefined) out[which[1]] = peak;
      }
      return out;
    });
    const ratio = levels['2'] / (levels['1'] || 1);
    check('turning one microphone up changes what that microphone records',
      ratio > 1.75 && ratio < 2.25,
      `mic 2 is ${ratio.toFixed(2)}x mic 1 after +6 dB, which is 2x in amplitude`);
    check('and leaves the others where they were',
      Math.abs(levels['1'] - levels['3']) < 0.05,
      `mic 1 ${levels['1']?.toFixed(3)}, mic 3 ${levels['3']?.toFixed(3)}`);

    await page.waitForTimeout(300);
    const saved = JSON.parse(await readFile(
      join(work, 'ud', 'Player Settings', 'settings.json'), 'utf8'));
    check('the gain is remembered against that interface, not just for now',
      saved.mics?.['fake-interface']?.gains?.[1] === 6,
      JSON.stringify(saved.mics ?? {}).slice(0, 80));
  }

  console.log('\n--- seeing what is being recorded ---');
  {
    /* Ted: "Let me see the recording audio signal as it is generated." A lane
       per microphone, under the song's own wave. Read off the CANVAS, because
       the whole point is a picture — and read in the strip's own band, so the
       song's waveform cannot pass this check on its behalf. */
    const strip = await page.evaluate(() => {
      const canvas = document.getElementById('wave');
      const g = canvas.getContext('2d');
      const dpr = window.devicePixelRatio || 1;
      const h = canvas.clientHeight;
      const state = window.__tvaMicState();
      const bandTop = Math.round((h - Math.min(h * 0.5, state.lanes * 17 + 2)) * dpr);
      const px = g.getImageData(0, bandTop + 4, canvas.width, canvas.height - bandTop - 8).data;
      let painted = 0;
      for (let i = 0; i < px.length; i += 4) if (px[i + 3] > 0) painted++;
      return { lanes: state.lanes, columns: state.columns, painted, h };
    });
    check('there is a lane for every microphone that is on', strip.lanes === 4, `${strip.lanes} lanes`);
    check('and the signal coming in is drawn there as it arrives',
      strip.columns > 20 && strip.painted > 500,
      `${strip.columns} columns of history, ${strip.painted} pixels painted`);

    const heights = await page.evaluate(() => ({
      rack: Math.round(document.querySelector('.rack').getBoundingClientRect().height),
      well: Math.round(document.querySelector('.well').getBoundingClientRect().height),
    }));
    await page.evaluate(async () => {
      document.getElementById('mic-open').click();
      await new Promise((r) => setTimeout(r, 500));
    });
    const quiet = await page.evaluate(() => ({
      rack: Math.round(document.querySelector('.rack').getBoundingClientRect().height),
      well: Math.round(document.querySelector('.well').getBoundingClientRect().height),
    }));
    check('and the case is exactly as tall with four microphones on as with none',
      heights.rack === quiet.rack && heights.well === quiet.well,
      `${heights.rack}px live against ${quiet.rack}px idle`);
  }

  console.log('\n--- the click track ---');
  {
    await page.click('.tab[data-tab="click"]');
    await page.fill('#bpm', '90');
    await page.click('#click-on');
    check('the click starts', (await page.getAttribute('#click-on', 'aria-pressed')) === 'true');
    await page.click('#click-on');
    check('and stops', (await page.getAttribute('#click-on', 'aria-pressed')) === 'false');
    await page.click('.tab[data-tab="loop"]');
  }

  console.log('\n--- it all fits on the screen ---');
  {
    /* Ted's first words about the members player were "doesn't all show on the
       same screen". A 1920x1080 laptop at 150% scaling gives a 720-pixel-tall
       window, so that is checked as well as the default size. The case must be
       whole at both: the transport, the wave and the knobs are the instrument,
       and reaching them must never need a scroll. */
    /* 1024x733 is in this list because the build runner's screen is that size,
       and a fault that only appears there cost a whole round: one element with
       no minimum width squeezed itself into a column of single letters, the
       case grew to fill the window, and every tab and panel was pushed off the
       bottom of the screen. */
    for (const size of [{ width: 1180, height: 760 }, { width: 1280, height: 720 },
      { width: 1024, height: 733 }]) {
      await page.setViewportSize(size);
      await page.waitForTimeout(250);
      const fit = await page.evaluate(() => {
        const rack = document.querySelector('.rack').getBoundingClientRect();
        const play = document.getElementById('play').getBoundingClientRect();
        return {
          rackBottom: Math.round(rack.bottom),
          windowH: window.innerHeight,
          pageScrolls: document.documentElement.scrollHeight > window.innerHeight + 1,
          sideways: document.documentElement.scrollWidth > window.innerWidth + 1,
          playH: Math.round(play.height),
          hint: (document.querySelector('.wavehint')?.textContent ?? '').toLowerCase(),
          deskH: Math.round(document.querySelector('.deskwrap').clientHeight),
          tabsBottom: Math.round(document.querySelector('.tabs').getBoundingClientRect().bottom),
        };
      });
      const at = `${size.width}x${size.height}`;
      check(`the whole case is on screen at ${at}`,
        fit.rackBottom <= fit.windowH, `case ends at ${fit.rackBottom} of ${fit.windowH}`);
      check(`the window itself never scrolls at ${at}`, !fit.pageScrolls);
      check(`and nothing runs off the side at ${at}`, !fit.sideways);
      /* The case fitting is not the same as the rest of the app being usable.
         At 1024 the case fitted with two pixels to spare and the tabs and every
         panel were off the bottom of the screen, which no check here noticed. */
      check(`the tabs are on screen at ${at}`, fit.tabsBottom <= fit.windowH,
        `tabs end at ${fit.tabsBottom} of ${fit.windowH}`);
      check(`and there is room to work under them at ${at}`, fit.deskH >= 90,
        `${fit.deskH}px of bench`);

      /* The take row at every width, not just the one it was designed at. Four
         buttons is what pushed this over: at half the panel's width the last of
         them wrapped to a line of its own, which reads as a fault rather than a
         layout, and that is why the Takes tab is one column now. */
      await page.click('.tab[data-tab="takes"]');
      const takeRow = await page.evaluate(() => {
        const acts = document.querySelector('#takes .item .iacts');
        if (!acts) return null;
        const chips = [...acts.querySelectorAll('.chip')];
        return {
          count: chips.length,
          tops: chips.map((c) => Math.round(c.getBoundingClientRect().top)),
          overflow: chips.some((c) =>
            c.getBoundingClientRect().right > acts.getBoundingClientRect().right + 1),
        };
      });
      check(`a take's four buttons stay on one line at ${at}`,
        takeRow && takeRow.count === 4 && new Set(takeRow.tops).size === 1 && !takeRow.overflow,
        takeRow ? `${takeRow.count} buttons, tops ${takeRow.tops.join(', ')}` : 'no take row');
      await page.click('.tab[data-tab="loop"]');
    }
    /* AND THE SAME AT 1024 WITH FOUR MICROPHONES ON, which is the combination
       that can only get worse: the lit panel grows by 46 pixels to hold the two
       buttons that choose which microphone the gain acts on, and 1024 is the
       width where the case last ran off the side of the window. */
    await page.setViewportSize({ width: 1024, height: 733 });
    await page.evaluate(() => window.__tvaFakeMics(4, [220, 330, 440, 550]));
    await page.waitForTimeout(300);
    const tight = await page.evaluate(() => ({
      sideways: document.documentElement.scrollWidth > window.innerWidth + 1,
      rackBottom: Math.round(document.querySelector('.rack').getBoundingClientRect().bottom),
      rackRight: Math.round(document.querySelector('.rack').getBoundingClientRect().right),
      tabsBottom: Math.round(document.querySelector('.tabs').getBoundingClientRect().bottom),
      deskH: Math.round(document.querySelector('.deskwrap').clientHeight),
      windowH: window.innerHeight,
      windowW: window.innerWidth,
    }));
    check('four microphones on a 1024-wide screen still fit inside the window',
      !tight.sideways && tight.rackRight <= tight.windowW,
      `case ends at ${tight.rackRight} of ${tight.windowW}`);
    check('and the tabs and the bench are still there under it',
      tight.tabsBottom <= tight.windowH && tight.deskH >= 90,
      `tabs at ${tight.tabsBottom} of ${tight.windowH}, ${tight.deskH}px of bench`);
    await page.evaluate(async () => {
      document.getElementById('mic-open').click();
      await new Promise((r) => setTimeout(r, 400));
    });
    await page.setViewportSize({ width: 1180, height: 760 });

    const hint = await page.textContent('.wavehint');
    check('the drag gesture is printed on the page, not hidden in a tooltip',
      hint.toLowerCase().includes('drag across'),
      'the members site learned this the hard way — a hover tooltip is invisible on a phone');
    const title = await page.getAttribute('#wave', 'title');
    check('and it is not ONLY in a tooltip', title === null);
  }

  console.log('\n--- what it remembers ---');
  await page.evaluate(() => {
    const el = document.getElementById('speed');
    el.value = '75';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForFunction(
    () => document.getElementById('speed-val').textContent === '75% speed', { timeout: 10000 });
  await page.waitForTimeout(1400);        // the save is debounced by 900ms
  const footer = await page.textContent('#where');
  check('it says where the settings are kept', footer.includes('kept in'), footer.slice(0, 90));

  /* The path is worked out here rather than scraped out of the footer's
     wording. Reading it off the screen made this check fail the moment that
     sentence was reworded, which is a test breaking on something it was never
     meant to be watching. */
  const settingsRoot = join(userDataDir, 'Player Settings');
  check('and that is where they really are', footer.includes(settingsRoot), settingsRoot);
  const saved = await readdir(join(settingsRoot, 'songs')).catch(() => []);

  /* Every song opened gets its own file, which is the point of the design — so
     the one for THIS song is found by reading them rather than by assuming
     there is only ever one. */
  let stored = null;
  for (const name of saved) {
    if (!name.endsWith('.json')) continue;
    const parsed = JSON.parse(await readFile(join(settingsRoot, 'songs', name), 'utf8'));
    if (parsed.songKey?.startsWith('test song.mp3::')) stored = parsed;
  }
  /* A song gets a file once something about it is set — not merely for having
     been opened. Several songs were opened during these checks and only this
     one was changed, so one file is exactly right. */
  check('a song that was set up gets a settings file of its own', Boolean(stored),
    `${saved.length} file(s) in songs/`);
  /* AND A SONG MERELY OPENED AND LEFT ALONE GETS NOTHING. Named rather than
     counted: a song that was PLAYED is entitled to a file, because remembering
     where you got to is the point of it, and one of the checks above plays a
     second song. Counting the files made that read as a fault. These two are
     opened by the multi-select and never touched again, so a file for either of
     them would mean the app is writing for songs nobody changed. */
  const untouched = [];
  for (const name of saved) {
    if (!name.endsWith('.json') || name.includes('conflict')) continue;
    const parsed = JSON.parse(await readFile(join(settingsRoot, 'songs', name), 'utf8'));
    if (/^(second\.mp3|third\.wav)::/.test(parsed.songKey ?? '')) untouched.push(parsed.songKey);
  }
  check('and a song merely opened and left alone does not',
    untouched.length === 0,
    untouched.length ? `written for ${untouched.join(', ')}` : 'nothing is written for a song nobody changed');

  if (stored) {
    check('holding the speed that was set', stored.settings.speed === 0.75,
      `stored ${stored.settings.speed}`);
    check('and the song it belongs to', stored.songKey.startsWith('test song.mp3::'),
      stored.songKey);
    check('and which machine wrote it', Boolean(stored.updatedBy));
  }

  console.log('\n--- selecting several files at once ---');
  check('every file in the selection arrives, not just the last one',
    launchOpened === 3, `${launchOpened} of 3 songs reached the page`);
  check('the app can also be asked to open songs from a menu',
    await page.evaluate(() => typeof window.tva.openSongs === 'function'));
} finally {
  await app.close().catch(() => {});
  if (NEGATIVE) {
    for (const m of mutations) await writeFile(m.target, m.original);
  }
  await rm(work, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.passed);
console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
if (NEGATIVE) {
  /* NAMED, NOT COUNTED. "Something went red" is a weak bar — a control can break
     something unrelated and still look like proof. These are the checks the
     controls above exist for, and if one of them stayed green with its fault put
     back, then it is measuring nothing and the run says so. */
  const red = new Set(failed.map((r) => r.name));
  /* ENFORCED ONLY WHEN ONE CONTROL IS RUN ON ITS OWN. With every fault put back
     at once they mask each other — killing the stretch engine also stops a stale
     engine wiring itself into the wrong song, so the check for that stays green
     and would look like proof of nothing. The run with everything broken still
     has to go red; which check goes red for which fault is settled one at a
     time, which is what the `--only=` runs in CI are for. */
  const stayedGreen = ONLY ? mustGoRed.filter((name) => !red.has(name)) : [];
  const wanted = failed.length > 0 && stayedGreen.length === 0;
  console.log(wanted
    ? `\nNegative control worked: ${failed.length} check(s) went red with the app broken.`
    : stayedGreen.length
      ? `\nNegative control FAILED: these stayed green with their fault put back, `
        + `so they prove nothing:\n  ${stayedGreen.join('\n  ')}`
      : '\nNegative control FAILED: every check passed with the app broken, so they prove nothing.');
  process.exit(wanted ? 0 : 1);
}
process.exit(failed.length ? 1 : 0);
