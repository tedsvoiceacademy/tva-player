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
const args = [
  '--no-sandbox',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${join(work, 'ud')}`,
  '--use-fake-device-for-media-stream',
  `--use-file-for-fake-audio-capture=${micFile}`,
  songPath,
];
/* Windows needs its own launcher for this.
 *
 * Node's spawn refuses a packaged windowed application outright — "spawn
 * UNKNOWN", measured on the build runner — so on Windows the app is started
 * through PowerShell's Start-Process, which is what actually knows how to
 * launch one. Everywhere else spawn is fine. */
const onWindows = process.platform === 'win32';
const env = { ...process.env, OneDrive: '', OneDriveConsumer: '', OneDriveCommercial: '' };
const outLog = join(work, 'app-out.txt');
const errLog = join(work, 'app-err.txt');

/* Start-Process joins its argument list into one command line, so an argument
   holding a space — a song called "Packaged Test.mp3" — has to carry its own
   double quotes or the app receives it as two arguments. */
const psArg = (a) => `'"${String(a).replace(/"/g, '\\"').replace(/'/g, "''")}"'`;
const psPath = (a) => `'${String(a).replace(/'/g, "''")}'`;

const child = onWindows
  ? spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      `Start-Process -FilePath ${psPath(exe)}`
      + ` -ArgumentList @(${args.map(psArg).join(',')})`
      + ` -RedirectStandardOutput ${psPath(outLog)}`
      + ` -RedirectStandardError ${psPath(errLog)}`,
    ], { env, stdio: 'inherit', windowsHide: true })
  : spawn(exe, args, { env, stdio: 'ignore' });

child.on('error', (err) => { console.error('The app would not start at all:', err); });

// Wait for the port to answer, rather than guessing how long start-up takes.
let browser = null;
for (let tries = 0; tries < 120 && !browser; tries++) {
  await new Promise((r) => setTimeout(r, 500));
  try {
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  } catch { /* not up yet */ }
}
if (!browser) {
  console.error('The app did not open a debugging port within 60 seconds.');
  /* Say WHY, rather than leaving the next person to guess. Everything the app
     printed on its way out, and whether it is even running. */
  const { readFile } = await import('node:fs/promises');
  for (const [label, file] of [['stdout', outLog], ['stderr', errLog]]) {
    const text = await readFile(file, 'utf8').catch(() => null);
    console.error(`--- app ${label} ---\n${text?.trim() || '(nothing)'}`);
  }
  if (onWindows) {
    const { execFileSync } = await import('node:child_process');
    try {
      const running = execFileSync('powershell.exe', ['-NoProfile', '-Command',
        "Get-Process -Name 'TVA Player' -ErrorAction SilentlyContinue | "
        + 'Select-Object -ExpandProperty Id'], { encoding: 'utf8' }).trim();
      console.error(`--- is it running? --- ${running ? `yes, as ${running}` : 'no'}`);
      const ports = execFileSync('powershell.exe', ['-NoProfile', '-Command',
        `Get-NetTCPConnection -LocalPort ${PORT} -ErrorAction SilentlyContinue | `
        + 'Select-Object -ExpandProperty State'], { encoding: 'utf8' }).trim();
      console.error(`--- is the port open? --- ${ports || 'no'}`);
    } catch (e) { console.error('--- could not ask Windows ---', e.message); }
  }
  try { child.kill(); } catch {}
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

  console.log('\n--- recording, from inside the package ---');
  /* The worklet is a separate file loaded by URL, which is the other thing an
     archive can break. */
  await page.click('.tab[data-tab="record"]');
  await page.waitForFunction(
    () => document.getElementById('mic-pick').options.length > 0, { timeout: 15000 });
  await page.click('#mic-open');
  await page.waitForFunction(
    () => !document.getElementById('rec-start').disabled, { timeout: 20000 });
  check('the microphone opens and its worklet loads', true);

  await page.click('#rec-start');
  await page.waitForTimeout(1800);
  await page.click('#rec-stop');
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

  console.log('\n--- the tuner, from inside the package ---');
  await page.waitForFunction(
    () => document.getElementById('t-note').textContent !== '—', { timeout: 20000 });
  check('the tuner names the note coming in',
    (await page.textContent('#t-note')) === 'A4', await page.textContent('#t-note'));

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

  console.log('\n--- a song too long to hold in memory ---');
  const refusal = await page.evaluate(async () => {
    // Pretend the open song is half an hour long and touch the speed knob.
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
} finally {
  await browser.close().catch(() => {});
  /* Start-Process launches a detached app, so killing the PowerShell that
     started it leaves the app running. Ask Windows to close it by name. */
  if (onWindows) {
    try {
      spawn('taskkill.exe', ['/IM', 'TVA Player.exe', '/F'], { stdio: 'ignore', windowsHide: true });
    } catch { /* already gone */ }
  }
  try { child.kill(); } catch {}
  await new Promise((r) => setTimeout(r, 1200));
  await rm(work, { recursive: true, force: true }).catch(() => {});
}

const failed = results.filter((r) => !r.passed);
console.log(`\n${results.length - failed.length}/${results.length} checks passed against the packaged app.`);
process.exit(failed.length ? 1 : 0);
