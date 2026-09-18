/* The app AS IT IS INSTALLED, not as it is in the source folder.
 *
 * Everything else here drives apps/desktop straight off disk. That is not what
 * Ted installs: packaging bundles the whole app into an asar archive, and the
 * way files are found inside one is different. The protocol that serves the
 * page, the worklet loaded by URL and the copied-in stretch library could each
 * break at that step and leave every other check green — which is precisely the
 * shape of the bug that left him with a window that did nothing.
 *
 * Run: xvfb-run -a node scripts/installed-harness.mjs <path to the app binary>
 */
import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeSong, makeMp3 } from './make-test-song.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/* Where the packaged app is. Given on the command line, or found in the usual
   place electron-builder leaves it. */
const given = process.argv.find((a) => !a.startsWith('-') && /tva|player|\.exe$/i.test(a)
  && a !== process.argv[0] && a !== process.argv[1]);
const candidates = [
  given,
  join(ROOT, 'release/linux-unpacked/tva-player'),
  join(ROOT, 'release/linux-unpacked/TVA Player'),
  join(ROOT, 'release/linux-unpacked/@tvadesktop'),
  join(ROOT, 'release/win-unpacked/TVA Player.exe'),
].filter(Boolean);
const exe = candidates.find((p) => existsSync(p));
if (!exe) {
  console.error('Cannot find the packaged app. Looked in:\n  ' + candidates.join('\n  '));
  process.exit(1);
}
/* THE FILE WE ARE ABOUT TO RUN IS STILL A PROGRAM.
 *
 * This looks paranoid and is not. This harness is handed the path of the
 * installed application, and one of its own imports used to write a test tone
 * to whatever was in argv[2] — so on every Windows run it replaced
 * "TVA Player.exe" with an eight-second sine wave before trying to start it.
 * Windows reported "spawn UNKNOWN", the app never appeared, and five rounds of
 * diagnosis went looking for a start-up crash in an app that was no longer
 * there. A Windows program begins "MZ" and an ELF binary begins 0x7F "ELF";
 * anything else means something has damaged it. */
const head = (await import('node:fs/promises')).readFile;
const first4 = (await head(exe)).subarray(0, 4);
const looksLikeProgram = first4.subarray(0, 2).toString('latin1') === 'MZ'
  || (first4[0] === 0x7f && first4.subarray(1, 4).toString('latin1') === 'ELF');
if (!looksLikeProgram) {
  console.error(`The file at ${exe} is not a program. It starts with `
    + `${[...first4].map((b) => b.toString(16).padStart(2, '0')).join(' ')}. `
    + 'Something has overwritten the installed application.');
  process.exit(1);
}

console.log(`Driving the packaged app at ${exe}\n`);

const results = [];
const check = (name, passed, detail) => {
  results.push({ name, passed });
  console.log(`${passed ? 'ok  ' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

const work = await mkdtemp(join(tmpdir(), 'tva-installed-'));
const musicDir = join(work, 'Music');
await mkdir(musicDir, { recursive: true });
const songPath = join(musicDir, 'Packaged Test.mp3');
await makeMp3(songPath, { seconds: 8, shape: true });

await mkdir(join(work, 'ud', 'Player Settings'), { recursive: true });
await writeFile(join(work, 'ud', 'Player Settings', 'settings.json'),
  JSON.stringify({ folders: [musicDir], recordingsDir: join(work, 'Takes') }));

const micFile = join(work, 'mic.wav');
makeSong(micFile, { seconds: 20, left: 440, right: 440 });

/* HOW THE PACKAGED APP IS DRIVEN.
 *
 * Playwright's own Electron launcher reads a "DevTools listening on ws://…"
 * line off the app's standard error. A packaged Windows app is built as a
 * windowed program with no console attached, so that line never arrives and
 * the launch times out — the app is running perfectly and Playwright simply
 * cannot see it. Measured on the build runner: the installer worked, the app
 * was there, and this was the only thing that failed.
 *
 * So the app is started as itself, told to open a debugging port, and attached
 * to over that port. It works the same way on both platforms, so there is one
 * path here rather than two. */
const PORT = 9333;
const logFile = join(work, 'electron.log');
const args = [
  '--no-sandbox',
  /* A packaged Windows app is a windowed program with no console, so anything
     it says on its way out is lost. Electron will write it to a file instead,
     which is the only way to see a start-up crash on Windows. */
  '--enable-logging=file',
  `--log-file=${logFile}`,
  '--log-level=0',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${join(work, 'ud')}`,
  '--use-fake-device-for-media-stream',
  `--use-file-for-fake-audio-capture=${micFile}`,
  songPath,
];
const onWindows = process.platform === 'win32';

/* STARTING THE PACKAGED APP ON WINDOWS.
 *
 * This took several rounds and two wrong explanations, both of which were
 * written down confidently and were false: that Node's spawn refuses packaged
 * windowed applications, and that an empty-valued environment variable was
 * breaking process creation. Removing the empty values changed nothing —
 * "spawn UNKNOWN" came back unchanged.
 *
 * So rather than guess a fourth time, several ways of starting it are tried in
 * turn and the one that works is printed. A run that fails then says which
 * methods were tried and how each one failed, which is evidence instead of
 * another theory.
 */
const env = { ...process.env };
for (const key of Object.keys(env)) {
  // The app must not write its settings into a real OneDrive folder.
  if (/^onedrive/i.test(key)) delete env[key];
}

const attempts = [
  {
    name: 'spawn, with the OneDrive variables removed',
    run: () => spawn(exe, args, { env, stdio: 'ignore', windowsHide: true }),
  },
  {
    name: 'spawn, inheriting the environment untouched',
    run: () => spawn(exe, args, { stdio: 'ignore', windowsHide: true }),
  },
  {
    name: 'cmd.exe start',
    when: onWindows,
    run: () => spawn('cmd.exe', ['/c', 'start', '', '/b', exe, ...args],
      { env, stdio: 'ignore', windowsHide: true }),
  },
  {
    name: 'spawn through a shell',
    when: onWindows,
    run: () => spawn(`"${exe}"`, args.map((a) => `"${a}"`),
      { env, stdio: 'ignore', windowsHide: true, shell: true }),
  },
];

/* WHAT COUNTS AS STARTED.
 *
 * Not "spawn did not throw". `cmd.exe start` hands the work to cmd and returns
 * at once whether or not the app ever appears, so the previous version of this
 * printed "Started with: cmd.exe start" about a run in which the app never ran.
 * That is a measurement that cannot fail, which is the thing this project keeps
 * having to root out.
 *
 * So each way of starting it gets its own wait for the debugging port. The app
 * has answered or it has not, and the ladder moves on.
 */
const { readFile } = await import('node:fs/promises');
const { execFileSync } = await import('node:child_process');

const ask = (script) => {
  try {
    return execFileSync('powershell.exe', ['-NoProfile', '-Command', script],
      { encoding: 'utf8' }).trim() || '(nothing)';
  } catch (e) { return `could not ask: ${e.message.split('\n')[0]}`; }
};

async function connectWithin(seconds) {
  for (let tries = 0; tries < seconds * 2; tries++) {
    await new Promise((r) => setTimeout(r, 500));
    try { return await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`); }
    catch { /* not up yet */ }
  }
  return null;
}

function stillRunning() {
  if (!onWindows) return 'not asked';
  return ask("$p = Get-Process -Name 'TVA Player' -ErrorAction SilentlyContinue; "
    + "if ($p) { $p.Id -join ',' } else { 'no' }");
}

let child = null;
let browser = null;
const tried = [];
for (const attempt of attempts) {
  if (attempt.when === false) continue;
  let started = null;
  try {
    started = attempt.run();
    await new Promise((resolve, reject) => {
      const ok = setTimeout(resolve, 400);
      started.once('error', (err) => { clearTimeout(ok); reject(err); });
    });
  } catch (err) {
    tried.push(`${attempt.name}: could not be started — ${err.code ?? err.message}`);
    continue;
  }

  browser = await connectWithin(40);
  if (browser) {
    child = started;
    console.log(`Started with: ${attempt.name}\n`);
    break;
  }

  /* It was launched and it did not answer. Say what the app itself said on the
     way out — on Windows that goes nowhere at all unless it is asked for, which
     is why the log file is in the arguments. */
  const log = await readFile(logFile, 'utf8').catch(() => null);
  tried.push(`${attempt.name}: launched, then no debugging port in 40s`
    + ` (running: ${stillRunning()})`
    + `\n      what the app logged: ${log?.trim().replace(/\n/g, '\n      ') || '(nothing was written)'}`);
  try { started.kill(); } catch {}
  if (onWindows) ask("Get-Process -Name 'TVA Player' -ErrorAction SilentlyContinue | Stop-Process -Force");
  await rm(logFile, { force: true });
}

if (!browser) {
  console.error('The app never came up. Every way of starting it was tried:');
  for (const line of tried) console.error(`  ${line}`);
  if (onWindows) {
    console.error('--- is the port open? --- ' + ask(
      `$c = Get-NetTCPConnection -LocalPort ${PORT} -ErrorAction SilentlyContinue; `
      + "if ($c) { $c.State -join ',' } else { 'no' }"));
  }
  process.exit(1);
}

const context = browser.contexts()[0];
const page = context.pages()[0] ?? await context.waitForEvent('page');
await page.waitForLoadState('domcontentloaded');

try {
  console.log('--- the packaged page is served at all ---');
  await page.waitForFunction(
    () => document.getElementById('now-name') !== null, { timeout: 20000 });
  check('the window loads its own page from inside the package', true,
    'the app:// protocol has to read out of the asar archive, not off the disk');

  await page.waitForFunction(
    () => document.getElementById('where').textContent.includes('Settings kept in'),
    { timeout: 20000 });
  check('and start-up reaches it', true);

  console.log('\n--- a song, opened the way Windows opens one ---');
  await page.waitForFunction(
    () => document.getElementById('now-name').textContent.includes('PACKAGED'), { timeout: 20000 });
  check('the song named on the command line opens', true,
    await page.textContent('#now-name'));
  await page.waitForFunction(() => !document.getElementById('play').disabled, { timeout: 15000 });
  check('its length is read', (await page.textContent('#t-total')) === '0:08',
    await page.textContent('#t-total'));

  await page.click('#play');
  await page.waitForFunction(
    () => document.getElementById('t-now').textContent !== '0:00', { timeout: 15000 });
  check('and it plays', true);
  await page.click('#play');

  console.log('\n--- the library, from inside the package ---');
  check('the folder in the settings was read and listed',
    (await page.$$('.raillist .song')).length === 1,
    `${(await page.$$('.raillist .song')).length} songs`);

  console.log('\n--- a song too long to hold in memory ---');
  /* THIS RUNS FIRST, before anything else touches the speed engine. The refusal
     only happens on the way INTO that engine, so once another check has started
     it there is nothing left to refuse and this one reads whatever message was
     last on screen. Re-opening the song ought to put it back, and does locally —
     but it went red on Windows anyway, and a check that depends on the order of
     everything before it is a check that will go red again. */
  const refusal = await page.evaluate(async () => {
    const before = document.getElementById('msg').textContent;
    window.__tvaFakeDuration(1900);
    const el = document.getElementById('speed');
    el.value = '70'; el.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 400));
    return { before, after: document.getElementById('msg').textContent };
  }).catch((e) => ({ error: String(e.message ?? e) }));
  check('a song too long for the speed control is refused in words',
    (refusal.after ?? '').includes('minutes'),
    refusal.error ?? refusal.after);

  /* Put the real song back. The pretend half-hour is a module variable, and
     leaving it set would hand every later check a song whose length is a lie. */
  await page.evaluate(async () => {
    document.getElementById('speed').value = '100';
    document.getElementById('speed').dispatchEvent(new Event('input', { bubbles: true }));
    await window.__tvaOpenFirstArg();
  });
  await page.waitForFunction(
    () => document.getElementById('t-total').textContent === '0:08', { timeout: 15000 });

  console.log('\n--- the stretch engine, from inside the package ---');
  /* The library is a file COPIED beside the page at build time, and its worklet
     is registered from a blob. Both have to survive being put in an archive. */
  const stretched = await page.evaluate(async () => {
    const SR = 48000, F0 = 440, SEMIS = 2, RATE = 0.75;
    const inLen = SR * 2;
    const chans = [new Float32Array(inLen), new Float32Array(inLen)];
    for (let i = 0; i < inLen; i++) {
      const v = Math.sin(2 * Math.PI * F0 * i / SR) * 0.5;
      chans[0][i] = v; chans[1][i] = v;
    }
    const ctx = new OfflineAudioContext({
      numberOfChannels: 2, length: Math.ceil(inLen / RATE) + SR, sampleRate: SR,
    });
    const mod = await import('./vendor/SignalsmithStretch.mjs');
    const node = await mod.default(ctx, { numberOfInputs: 0, outputChannelCount: [2] });
    await node.addBuffers(chans);
    node.connect(ctx.destination);
    node.schedule({ active: true, input: 0, rate: RATE, semitones: SEMIS,
                    formantCompensation: true, formantBaseHz: 0 });
    const out = (await ctx.startRendering()).getChannelData(0);
    const mid = out.slice(Math.floor(SR * 0.6), Math.floor(SR * 1.6));
    let best = 0, lag = 0;
    for (let t = Math.floor(SR / 1200); t <= Math.floor(SR / 200); t++) {
      let acc = 0; for (let i = 0; i + t < mid.length; i++) acc += mid[i] * mid[i + t];
      if (acc > best) { best = acc; lag = t; }
    }
    let peak = 0; for (let i = 0; i < out.length; i++) peak = Math.max(peak, Math.abs(out[i]));
    return { hz: lag ? SR / lag : 0, peak };
  }).catch((e) => ({ error: String(e.message ?? e) }));
  check('the speed and key engine loads out of the package and works',
    stretched.peak > 0.05 && Math.abs(stretched.hz - 493.9) < 20,
    stretched.error ?? `${stretched.hz?.toFixed(1)} Hz against a wanted 493.9`);

  console.log('\n--- changing the speed on a song that is playing ---');
  {
    /* THE FAULT TED HIT, ON THE COPY HE ACTUALLY RUNS.
     *
     * "if i changed speed, no longer would it play until I completely close it
     * down from task manager again." The check above proves the engine LOADS
     * out of the package. It does not prove that reaching for the speed knob
     * mid-song leaves the song playing — and that is the part that broke.
     *
     * Judged by the player's state rather than by the clock: an unwatched
     * window has its timers throttled, so the clock freezes and catches up in
     * jumps, and a check built on it accuses the app of faults it does not
     * have. What broke was the state — song paused, no engine, nothing said. */
    const state = () => page.evaluate(() => ({
      mode: window.__tvaMode?.(),
      speed: window.__tvaSpeed?.(),
      playing: document.getElementById('play').getAttribute('aria-label') === 'Pause',
      msg: document.getElementById('msg').textContent ?? '',
    }));

    await page.evaluate(() => window.__tvaSeek?.(0));
    if ((await page.getAttribute('#play', 'aria-label')) === 'Play') await page.click('#play');
    await page.waitForTimeout(500);
    check('a song is playing before the speed is touched', (await state()).playing);

    await page.evaluate(() => {
      const el = document.getElementById('speed');
      el.value = '80';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.waitForFunction(
      () => window.__tvaMode && window.__tvaMode() === 'practice', { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(600);
    const slowed = await state();
    check('changing the speed leaves it on a working engine', slowed.mode === 'practice',
      `mode is ${slowed.mode}`);
    check('and the song is still playing afterwards', slowed.playing,
      `transport says ${slowed.playing ? 'Pause' : 'Play'}, message: ${slowed.msg}`);

    /* AND WHEN THE ENGINE CANNOT START AT ALL. Switching engines pauses the song
       before it does anything else, so a failure part-way took the sound away,
       said nothing, and left a state no button could undo. */
    await page.dblclick('.knob[data-knob="speed"]').catch(() => {});
    await page.dblclick('.knob[data-knob="key"]').catch(() => {});
    await page.evaluate(async () => { await window.__tvaOpenFirstArg(); });
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
    const after = await state();
    check('a speed control that cannot start says so',
      /would not start|could not start/i.test(after.msg), after.msg);
    check('and the song is never left paused by it', after.playing,
      `transport says ${after.playing ? 'Pause' : 'Play'}`);
    check('and the player is back on an engine it can play from',
      after.mode === 'straight', `mode is ${after.mode}`);

    await page.dblclick('.knob[data-knob="speed"]').catch(() => {});
  }

  console.log('\n--- recording, from inside the package ---');
  /* The worklet is a separate file loaded by URL, which is the other thing an
     archive can break. */
  /* Recording lives on the console now, so this drives it there. The take list
     is behind the Takes tab, and Playwright waits for a VISIBLE element — so the
     tab has to be opened before the list is waited for. */
  await page.click('#rec-new');
  await page.waitForFunction(
    () => document.getElementById('lamp-rec').classList.contains('lit'), { timeout: 20000 });
  check('the microphone opens and its worklet loads', true);

  await page.waitForTimeout(1800);
  await page.click('#rec-new');
  await page.click('.tab[data-tab="takes"]');
  await page.waitForSelector('#takes .item', { timeout: 15000 });

  const take = await page.evaluate(async () => {
    const list = await window.tva.listRecordings();
    const bytes = await (await fetch(list[0].url)).arrayBuffer();
    const rate = new DataView(bytes).getUint32(24, true);
    const ctx = new OfflineAudioContext({ numberOfChannels: 1, length: 1, sampleRate: rate });
    const buf = await ctx.decodeAudioData(bytes);
    const d = buf.getChannelData(0);
    const seg = d.slice(Math.floor(rate * 0.4), Math.floor(rate * 0.9));
    let peak = 0; for (let i = 0; i < seg.length; i++) peak = Math.max(peak, Math.abs(seg[i]));
    let best = 0, lag = 0;
    for (let t = Math.floor(rate / 1200); t <= Math.floor(rate / 200); t++) {
      let acc = 0; for (let i = 0; i + t < seg.length; i++) acc += seg[i] * seg[i + t];
      if (acc > best) { best = acc; lag = t; }
    }
    return { seconds: buf.duration, peak, hz: lag ? rate / lag : 0 };
  });
  check('a take is recorded and holds the sound that went in',
    take.peak > 0.05 && Math.abs(take.hz - 440) < 12,
    `${take.seconds.toFixed(2)}s, peak ${take.peak.toFixed(3)}, ${take.hz.toFixed(1)} Hz against 440`);

  console.log('\n--- saving a take out, from inside the package ---');
  /* THE MP3 ENCODER IS A FILE COPIED BESIDE THE PAGE, like the stretch engine,
     and it is loaded by a WORKER rather than by the page — a second thing an
     archive can break, and one that would fail only at the moment Ted tries to
     save something. So the encoder is run out of the package, the bytes are
     written through the app's own export doors, and the file that lands is read
     back and measured. */
  const exported = await page.evaluate(async (target) => {
    const list = await window.tva.listRecordings();
    const head = new Uint8Array(await (await fetch(list[0].url, {
      headers: { Range: 'bytes=0-43' },
    })).arrayBuffer());
    const view = new DataView(head.buffer);
    const channels = view.getUint16(22, true) || 1;
    const sampleRate = view.getUint32(24, true) || 48000;
    const body = await (await fetch(list[0].url, {
      headers: { Range: `bytes=44-${list[0].bytes - 1}` },
    })).arrayBuffer();
    const samples = new Int16Array(body);

    const opened = await window.tva.exportOpen({ filePath: target });
    if (!opened || opened.error) return { error: opened?.error ?? 'could not open' };

    await new Promise((resolve, reject) => {
      const worker = new Worker('./workers/export-worker.js', { type: 'module' });
      let writes = Promise.resolve();
      worker.addEventListener('error', (e) => reject(new Error(e.message || 'worker failed')));
      worker.addEventListener('message', (event) => {
        if (event.data.type === 'bytes') {
          writes = writes.then(() => window.tva.exportWrite(opened.id, event.data.bytes));
        } else if (event.data.type === 'done') { writes.then(resolve, reject); worker.terminate(); }
        else if (event.data.type === 'error') reject(new Error(event.data.message));
      });
      worker.postMessage({
        type: 'begin', format: 'mp3', sampleRate, channels,
        totalFrames: samples.length / channels, kbps: 128,
      });
      worker.postMessage({ type: 'pcm', samples }, [samples.buffer]);
      worker.postMessage({ type: 'end' });
    });
    const saved = await window.tva.exportFinish(opened.id);
    if (!saved || saved.error) return { error: saved?.error ?? 'could not finish' };

    const file = await (await fetch(`app://player/song/${encodeURIComponent(saved.path)}`)).arrayBuffer();
    const size = file.byteLength;
    const ctx = new OfflineAudioContext({ numberOfChannels: 1, length: 1, sampleRate: 44100 });
    const buf = await ctx.decodeAudioData(file);
    const d = buf.getChannelData(0);
    const seg = d.slice(Math.floor(buf.sampleRate * 0.4), Math.floor(buf.sampleRate * 0.9));
    let peak = 0;
    for (let i = 0; i < seg.length; i++) peak = Math.max(peak, Math.abs(seg[i]));
    let best = 0; let lag = 0;
    for (let t = Math.floor(buf.sampleRate / 1200); t <= Math.floor(buf.sampleRate / 200); t++) {
      let acc = 0;
      for (let i = 0; i + t < seg.length; i++) acc += seg[i] * seg[i + t];
      if (acc > best) { best = acc; lag = t; }
    }
    return { size, seconds: buf.duration, peak, hz: lag ? buf.sampleRate / lag : 0 };
  }, join(work, 'Take from the installed app.mp3')).catch((e) => ({ error: String(e.message ?? e) }));

  check('a take saves out as an MP3 that holds the sound that was sung',
    !exported.error && exported.peak > 0.05 && Math.abs(exported.hz - 440) < 12,
    exported.error ?? `${exported.seconds?.toFixed(2)}s, peak ${exported.peak?.toFixed(3)}, ${exported.hz?.toFixed(1)} Hz against 440`);
  check('and the formats offered are the two the app can really make',
    JSON.stringify(await page.evaluate(() => window.tva.exportFormats())) === '["mp3","wav"]',
    JSON.stringify(await page.evaluate(() => window.tva.exportFormats())));

  console.log('\n--- the tuner, from inside the package ---');
  await page.waitForFunction(
    () => document.getElementById('t-note').textContent !== '—', { timeout: 20000 });
  check('the tuner names the note coming in',
    (await page.textContent('#t-note')) === 'A4', await page.textContent('#t-note'));

  console.log('\n--- several microphones at once, from inside the package ---');
  /* The worklet is a separate file loaded by URL and it now carries the whole
     multi-microphone path, so an archive breaking it would show up only when
     Ted plugged his interface in. Three channels are built inside the page and
     driven through the same door a Clarett goes through. */
  const several = await page.evaluate(async () => {
    document.getElementById('mic-open').click();
    await new Promise((r) => setTimeout(r, 400));
    const opened = await window.__tvaFakeMics(3, [220, 330, 440]);
    return opened;
  }).catch((e) => ({ error: String(e.message ?? e) }));
  check('three microphone inputs are taken, not folded down to one',
    !several.error && several.channels === 3 && several.live.length === 3,
    several.error ?? `${several.channels} channels`);

  const beforeSeveral = await page.evaluate(() => window.tva.listRecordings().then((l) => l.length));
  await page.click('#rec-new');
  await page.waitForFunction(
    () => document.getElementById('lamp-rec').classList.contains('lit'), { timeout: 15000 });
  await page.waitForTimeout(1400);
  await page.click('#rec-new');
  await page.waitForTimeout(700);
  const written = await page.evaluate(async (before) => {
    const list = await window.tva.listRecordings();
    return { made: list.length - before, names: list.slice(0, 4).map((t) => t.name) };
  }, beforeSeveral);
  check('one take writes a file per microphone plus a mixed one',
    written.made === 4
    && [1, 2, 3].every((n) => written.names.some((x) => x.includes(`(Mic ${n})`)))
    && written.names.some((x) => x.includes('all mics mixed')),
    `${written.made} files: ${written.names.join(' | ')}`);
  await page.evaluate(async () => {
    document.getElementById('mic-open').click();
    await new Promise((r) => setTimeout(r, 400));
  });

  console.log('\n--- the media keys ---');
  /* What the app itself reports it managed to claim. Asking Electron whether
     it HAS globalShortcut would pass on a build that never called it. */
  const keys = await page.evaluate(() => window.__tvaShortcuts ?? null);
  check('the app claims all four media keys',
    Array.isArray(keys) && keys.length === 4,
    keys ? keys.join(', ') : 'the app reported nothing at all');

  console.log('\n--- capturing what the computer is playing ---');
  /* ACTUALLY ASK FOR IT.
   *
   * The first version of this check only confirmed that Electron HAS
   * setDisplayMediaRequestHandler — which it always does — so it passed while
   * the app had never called it, and the button in the Record tab would have
   * failed every single time. A check that cannot fail is worse than no check,
   * and this one found a missing feature the moment it was made honest. */
  const loopback = await page.evaluate(async () => {
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
      const audio = stream.getAudioTracks().length;
      const video = stream.getVideoTracks().length;
      for (const t of stream.getTracks()) t.stop();
      return { audio, video };
    } catch (e) { return { error: String(e.name ?? e.message ?? e) }; }
  });
  /* What separates "wired" from "not wired" is WHICH failure comes back.
   *
   * With no handler the request is refused outright — NotSupportedError, the
   * browser saying nobody is listening. With the handler in place the request
   * is answered and capture is attempted, which on a machine with a real
   * desktop gives a track and on a headless build runner fails further along
   * (AbortError: there is no desktop sound to take). Both were confirmed by
   * running it each way. So the assertion is that it is not refused, and the
   * detail says how far it got. */
  const refused = loopback.error === 'NotSupportedError';
  check('asking for the computer’s own sound reaches the app',
    !refused,
    refused
      ? 'refused outright — nothing in the app answered the request'
      : loopback.error
        ? `answered, then ${loopback.error} — this machine has no desktop sound to give`
        : `${loopback.audio} sound track, ${loopback.video} picture track (the picture is thrown away)`);

} finally {
  await browser.close().catch(() => {});
  try { child.kill(); } catch {}
  await new Promise((r) => setTimeout(r, 1200));
  await rm(work, { recursive: true, force: true }).catch(() => {});
}

const failed = results.filter((r) => !r.passed);
console.log(`\n${results.length - failed.length}/${results.length} checks passed against the packaged app.`);
process.exit(failed.length ? 1 : 0);
