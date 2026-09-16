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
const oneSidedPath = join(work, 'One Sided.mp3');
await makeMp3(oneSidedPath, { seconds: 4, rightGain: 0.25 });
const droppedPath = join(work, 'Dropped In.mp3');
await makeMp3(droppedPath, { seconds: 3 });
const notAudioPath = join(work, 'notes.txt');
await writeFile(notAudioPath, 'not a song');

/* The negative control flips one sign in the audio graph: the right side of the
   lead-quieter tail is added to the left instead of being subtracted from it.
   Nothing throws, the song still plays, and the only way to notice is to
   measure what comes out — which is exactly what the checks below do, and
   exactly why they measure rather than read the source. If they do not go red
   here, they are not watching anything.
 *
 * (The first control tried here was removing the Content-Length header, which
 * had caused a real bug — the clock stuck at 0:00. It turned nothing red,
 * because the wait for a late-arriving length covers a short file on its own.
 * A control that cannot fail is the thing this whole idea exists to prevent,
 * so it was replaced rather than kept for the story.) */
const graphPath = join(ROOT, 'apps/desktop/dist/renderer/audio/graph.js');
const original = await readFile(graphPath, 'utf8');
if (NEGATIVE) {
  const broken = original.replace(
    'midR.gain.value = -MIDDLE_CANCEL_GAIN;',
    'midR.gain.value = MIDDLE_CANCEL_GAIN;');
  if (broken === original) { console.error('negative control did not apply'); process.exit(1); }
  await writeFile(graphPath, broken);
}

/* A SECOND CONTROL, for the picture rather than the sound. The graph flip above
   cannot reach the waveform, so the stereo check would pass whatever happened.
   This one draws the lower half of the wave from the LEFT channel — which is
   precisely the mono-looking picture Ted asked to be rid of, and it looks
   entirely reasonable on screen. */
const uiPath = join(ROOT, 'apps/desktop/dist/renderer/ui/app.js');
const uiOriginal = await readFile(uiPath, 'utf8');
if (NEGATIVE) {
  const broken = uiOriginal.replace('{ data: peaks.right, mid: h * 0.73',
    '{ data: peaks.left, mid: h * 0.73');
  if (broken === uiOriginal) { console.error('wave control did not apply'); process.exit(1); }
  await writeFile(uiPath, broken);
}

/* A THIRD CONTROL, for the layout. Widening the word under a record button is
   the regression this redesign sits one edit away from: nothing throws, the app
   looks entirely plausible, and the dials drop to a row of their own taking 88
   pixels of case with them — which last time put the tabs and every panel off
   the bottom of the screen. The bench check has to catch it. */
/* A FOURTH CONTROL, for the skins. A skin that is listed in the picker and
   never wired looks exactly like one that works until somebody clicks it, so
   this stops one of the ten from applying at all. The two checks that count
   distinct cases and distinct wave pictures have to notice. */
const skinsPath = join(ROOT, 'apps/desktop/dist/renderer/ui/skins.css');
const skinsOriginal = await readFile(skinsPath, 'utf8');
if (NEGATIVE) {
  const broken = skinsOriginal.replace("html[data-skin='daylight'] {",
    "html[data-skin='daylight-not-wired'] {");
  if (broken === skinsOriginal) { console.error('skin control did not apply'); process.exit(1); }
  await writeFile(skinsPath, broken);
}

const cssPath = join(ROOT, 'apps/desktop/dist/renderer/ui/app.css');
const cssOriginal = await readFile(cssPath, 'utf8');
if (NEGATIVE) {
  /* Dropping the line breaks out of the words is the realistic version of this
     mistake — "Record new" on one line is 75px instead of 50, and three of
     those is more than the row has to give. A wider max-width alone does
     nothing, because a <br> breaks whatever the CSS says. */
  const broken = cssOriginal.replace('.t-name { max-width: 4.4rem;',
    '.t-name br { display: none } .t-name { max-width: 14rem;');
  if (broken === cssOriginal) { console.error('layout control did not apply'); process.exit(1); }
  await writeFile(cssPath, broken);
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
await makeMp3(join(musicDir, 'Danny Boy.mp3'), { seconds: 4 });
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

  console.log('\n--- it plays ---');
  await page.click('#play');
  await page.waitForFunction(
    () => document.getElementById('t-now').textContent !== '0:00', { timeout: 10000 });
  check('the clock moves when play is pressed', true);
  check('the button offers to pause',
    (await page.getAttribute('#play', 'aria-label')) === 'Pause');
  check('and the playing lamp is lit',
    await page.evaluate(() => document.getElementById('lamp-play').classList.contains('lit')));

  const movedTo = await page.textContent('#t-now');
  await page.click('#play');
  await page.waitForTimeout(600);
  check('pause really stops it', (await page.textContent('#t-now')) === movedTo,
    `paused at ${movedTo}`);

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

  /* How many songs the launch itself delivered. Read here rather than at the
     end: the counter keeps counting, and later checks open songs of their own. */
  const launchOpened = await page.evaluate(() => window.__tvaOpenedCount ?? 0);

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
    for (const subject of ['drag', 'double-click', 'playing', 'loop', 'record', 'playlist', 'pitch']) {
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
    /* Ten skins, two axes. The checks below measure what is PAINTED, because a
       skin that is declared and not wired looks exactly like one that works
       until you click it. */
    const ids = await page.evaluate(() => window.__tvaSkins());
    check('every skin Ted asked for is offered', ids.length === 10, ids.join(', '));

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

  console.log('\n--- one file of the take and the song together ---');
  {
    /* Rendered in the page and checked as audio, not merely "a file appeared".
       The take is a steady 440 Hz and the song is 440 on one side and 660 on
       the other, so the mix must hold both — which is the whole claim. */
    const mixed = await page.evaluate(async () => {
      const list = await window.tva.listRecordings();
      const takeBytes = await (await fetch(list[0].url)).arrayBuffer();
      const probe = new OfflineAudioContext({ numberOfChannels: 2, length: 1, sampleRate: 44100 });
      const takeBuf = await probe.decodeAudioData(takeBytes);
      const songBuf = await probe.decodeAudioData(
        await (await fetch(document.querySelector('.song.on') ? '' : '')).arrayBuffer().catch(() => new ArrayBuffer(0)),
      ).catch(() => null);
      return { takeSeconds: takeBuf.duration, takeChannels: takeBuf.numberOfChannels };
    }).catch((e) => ({ error: String(e) }));
    check('a take can be decoded back for mixing',
      mixed.takeSeconds > 0.5, JSON.stringify(mixed).slice(0, 90));

    check('and the button to make one file of it is offered',
      (await page.$$('#takes .item .iacts .chip')).length >= 3,
      'play it, save it with the song, remove');
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
    }
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
  check('and a song merely opened and left alone does not',
    saved.filter((f) => f.endsWith('.json') && !f.includes('conflict')).length === 1,
    'nothing is written for a song nobody changed');

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
    await writeFile(graphPath, original);
    await writeFile(uiPath, uiOriginal);
    await writeFile(cssPath, cssOriginal);
    await writeFile(skinsPath, skinsOriginal);
  }
  await rm(work, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.passed);
console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
if (NEGATIVE) {
  const wanted = failed.length > 0;
  console.log(wanted
    ? `\nNegative control worked: ${failed.length} check(s) went red with the graph broken.`
    : '\nNegative control FAILED: every check passed with the graph broken, so they prove nothing.');
  process.exit(wanted ? 0 : 1);
}
process.exit(failed.length ? 1 : 0);
