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
import { mkdtemp, rm, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeSong } from './make-test-song.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const NEGATIVE = process.argv.includes('--negative-control');

const results = [];
const check = (name, passed, detail) => {
  results.push({ name, passed });
  console.log(`${passed ? 'ok  ' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

const work = await mkdtemp(join(tmpdir(), 'tva-player-'));
const songPath = join(work, 'Test Song.wav');
makeSong(songPath, { seconds: 6 });
const extraSongs = [join(work, 'Second.wav'), join(work, 'Third.wav')];
for (const p of extraSongs) makeSong(p, { seconds: 3 });

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
const userDataDir = join(work, 'user-data');

const app = await electron.launch({
  args: [
    join(ROOT, 'apps/desktop'),
    '--no-sandbox',
    '--autoplay-policy=no-user-gesture-required',
    `--user-data-dir=${userDataDir}`,
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
    (await page.textContent('#now-name')).includes('TEST SONG'),
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
    check('marking a part turns looping on by itself',
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

  console.log('\n--- it all fits on the screen ---');
  {
    /* Ted's first words about the members player were "doesn't all show on the
       same screen". A 1920x1080 laptop at 150% scaling gives a 720-pixel-tall
       window, so that is checked as well as the default size. The case must be
       whole at both: the transport, the wave and the knobs are the instrument,
       and reaching them must never need a scroll. */
    for (const size of [{ width: 1180, height: 760 }, { width: 1280, height: 720 }]) {
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
        };
      });
      const at = `${size.width}x${size.height}`;
      check(`the whole case is on screen at ${at}`,
        fit.rackBottom <= fit.windowH, `case ends at ${fit.rackBottom} of ${fit.windowH}`);
      check(`the window itself never scrolls at ${at}`, !fit.pageScrolls);
      check(`and nothing runs off the side at ${at}`, !fit.sideways);
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
  check('the song\'s settings are written to their own file',
    saved.filter((f) => f.endsWith('.json') && !f.includes('conflict')).length === 1,
    `${saved.length} file(s) in songs/`);

  if (saved.length) {
    const stored = JSON.parse(await readFile(join(settingsRoot, 'songs', saved[0]), 'utf8'));
    check('and it holds the speed that was set', stored.settings.speed === 0.75,
      `stored ${stored.settings.speed}`);
    check('and the song it belongs to', stored.songKey.startsWith('test song.wav::'),
      stored.songKey);
    check('and which machine wrote it', Boolean(stored.updatedBy));
  }

  console.log('\n--- selecting several files at once ---');
  const arrived = await page.evaluate(() => window.__tvaOpenedCount ?? 0);
  check('every file in the selection arrives, not just the last one',
    arrived === 3, `${arrived} of 3 songs reached the page`);
  check('the app can also be asked to open songs from a menu',
    await page.evaluate(() => typeof window.tva.openSongs === 'function'));
} finally {
  await app.close().catch(() => {});
  if (NEGATIVE) await writeFile(graphPath, original);
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
