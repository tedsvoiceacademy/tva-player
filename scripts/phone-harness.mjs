/* The phone build, driven at the size of a phone.
 *
 * An APK cannot be driven by a check: there is no emulator on a build runner and
 * no way to hear what a take sounds like. What CAN be driven is the thing the
 * APK contains — the page, the audio engine, the recorder, the export — because
 * the phone build is written to run in a plain browser as well, with Files and
 * Takes answered from web-fallback.js instead of from Java.
 *
 * So this covers everything above the two plugins, at 390 pixels, with a real
 * song and a real microphone signal: the layout, the reach of a thumb, the
 * stretch engine, a recorded take's pitch, and an MP3 read back. What it does
 * not cover is Android's own file picker and the streaming of a content:// URI,
 * and the checklist says so rather than this pretending otherwise.
 *
 * Run: node scripts/phone-harness.mjs
 *      node scripts/phone-harness.mjs --negative-control
 */
import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { createReadStream, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeSong, makeMp3 } from './make-test-song.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WWW = join(ROOT, 'apps/android/www');
const NEGATIVE = process.argv.includes('--negative-control');

function chromeToUse() {
  if (process.env.TVA_CHROME) return process.env.TVA_CHROME;
  const inContainer = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
  return existsSync(inContainer) ? inContainer : undefined;
}

const results = [];
const check = (name, passed, detail) => {
  results.push({ name, passed });
  console.log(`${passed ? 'ok  ' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

const work = await mkdtemp(join(tmpdir(), 'tva-phone-'));
const songPath = join(work, 'Shenandoah.mp3');
await makeMp3(songPath, { seconds: 8 });
const micFile = join(work, 'mic.wav');
makeSong(micFile, { seconds: 20, left: 440, right: 440 });

/* THE NEGATIVE CONTROL takes the phone stylesheet out of the page. Everything
   still works — every button, every tab, every sound — and the app is unusable
   on a phone: the case keeps its desktop widths, the layout runs off the side
   and the tabs sit where a thumb cannot reach. If the layout checks below do
   not go red, they are measuring nothing. */
const cssPath = join(WWW, 'ui/phone.css');
const cssOriginal = await readFile(cssPath, 'utf8');
if (NEGATIVE) {
  await writeFile(cssPath, '/* control: the phone layout removed */\n');
}

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.png': 'image/png',
  '.webp': 'image/webp', '.wasm': 'application/wasm', '.txt': 'text/plain',
};

const server = createServer((request, response) => {
  const path = decodeURIComponent((request.url ?? '/').split('?')[0]);
  const target = join(WWW, path === '/' ? 'index.html' : path.replace(/^\/+/, ''));
  if (!target.startsWith(WWW)) { response.writeHead(403).end('no'); return; }
  let stat;
  try { stat = statSync(target); } catch { response.writeHead(404).end('not found'); return; }
  response.writeHead(200, {
    'Content-Type': MIME[extname(target).toLowerCase()] ?? 'application/octet-stream',
    'Content-Length': String(stat.size),
    /* The stretch engine compiles its WASM from bytes it carries and registers
       its worklet from a blob, and the phone page is no different. */
    'Cross-Origin-Opener-Policy': 'same-origin',
  });
  createReadStream(target).pipe(response);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch({
  /* The container this was written in carries a Chromium of its own, which is
     not the build this Playwright pins. Named when it is there, and left to
     Playwright's own when it is not — which is the case on a build runner. */
  executablePath: chromeToUse(),
  args: [
    '--no-sandbox',
    '--autoplay-policy=no-user-gesture-required',
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
    `--use-file-for-fake-audio-capture=${micFile}`,
  ],
});
/* A Pixel-sized window, which is the screen this whole build is for. */
/* hasTouch without isMobile. isMobile turns on Chromium's mobile emulation,
   which reports a visual viewport of its own — the checks were then measuring
   445 pixels while claiming to measure 390. Touch is what the layout cares
   about; the rest was making the measurement lie. */
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  hasTouch: true,
  permissions: ['microphone'],
});
const page = await context.newPage();
page.on('console', (m) => { if (m.type() === 'error') console.log('   console:', m.text().slice(0, 160)); });
page.on('pageerror', (err) => check(`the page threw: ${err.message}`, false, (err.stack ?? '').split('\n').slice(0, 3).join(' | ')));

try {
  await page.goto(`${origin}/index.html`);
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(600);

  console.log('--- the same player, a different door ---');
  {
    /* THE CONTRACT. The Windows renderer only ever reaches the machine through
       window.tva, so the phone needs that same list and nothing else. A missing
       name is not a crash at start-up — it is a button that does nothing on the
       day it is pressed. */
    const wanted = [...(await readFile(join(ROOT, 'apps/desktop/src/preload/index.cjs'), 'utf8'))
      .matchAll(/^ {2}([a-zA-Z]+):/gm)].map((m) => m[1]);
    const got = await page.evaluate(() => Object.keys(window.tva ?? {}));
    const missing = wanted.filter((name) => !got.includes(name));
    check('everything the Windows app can ask for, the phone build answers',
      missing.length === 0, missing.length ? `missing: ${missing.join(', ')}` : `${wanted.length} of them`);

    /* AND IN THE SAME SHAPE. exportWrite takes two arguments in the preload and
       was written here as one object: every name matched, nothing was written,
       and the app said "Saved as…" over an empty file. Names alone were not the
       contract. */
    const preload = await readFile(join(ROOT, 'apps/desktop/src/preload/index.cjs'), 'utf8');
    const arity = (source, name) => {
      const found = new RegExp(`(?:^|[\\s{,])${name}\\s*[:(]\\s*(?:async\\s*)?\\(([^)]*)\\)`, 'm').exec(source);
      if (!found) return null;
      const args = found[1].trim();
      return args === '' ? 0 : args.split(',').length;
    };
    const bridge = await readFile(join(ROOT, 'apps/android/src/bridge/tva-android.js'), 'utf8');
    const wrongShape = wanted.filter((name) => {
      const a = arity(preload, name);
      const b = arity(bridge, name);
      return a !== null && b !== null && a !== b;
    });
    check('and takes the same arguments for each of them',
      wrongShape.length === 0,
      wrongShape.length ? `different shape: ${wrongShape.join(', ')}` : 'every one');

    check('and it knows it is on a phone',
      (await page.getAttribute('html', 'data-platform')) === 'android');
    check('so the things that only exist on Windows are not offered',
      await page.evaluate(() => {
        const windowsOnly = [...document.querySelectorAll('[data-only="windows"]')];
        return windowsOnly.length > 0 && windowsOnly.every((el) => el.offsetParent === null);
      }));
  }

  console.log('\n--- it fits a phone ---');
  {
    for (const size of [{ width: 390, height: 844 }, { width: 360, height: 740 }]) {
      await page.setViewportSize(size);
      await page.waitForTimeout(250);
      const fit = await page.evaluate(() => ({
        sideways: document.documentElement.scrollWidth > window.innerWidth + 1,
        widest: Math.round(document.documentElement.scrollWidth),
        window: window.innerWidth,
      }));
      check(`nothing runs off the side at ${size.width}px`, !fit.sideways,
        `page is ${fit.widest} wide in a ${fit.window} window`);
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(250);

    /* The song list is a COLUMN on Windows and that column is already hidden
       below 900 pixels — so without its own tab there is no way to reach a song
       at all on a phone. It is the same element, moved. */
    const songs = await page.evaluate(() => {
      const tab = document.querySelector('.tab[data-tab="songs"]');
      const rail = document.querySelector('.rail');
      return {
        hasTab: Boolean(tab) && tab.offsetParent !== null,
        railInPanel: Boolean(rail?.closest('[data-panel="songs"]')),
      };
    });
    check('the song list has a tab of its own, since its column is gone', songs.hasTab);
    check('and it is the same list, moved rather than built twice', songs.railInPanel);

    /* A fingertip is about 44 pixels across. Anything smaller is a button you
       press twice. */
    await page.click('.tab[data-tab="songs"]');
    const small = await page.evaluate(() => {
      const wanted = [...document.querySelectorAll(
        '.tabs .tab, .transport .tbtn, [data-panel="songs"] .chip, [data-panel="songs"] .pill')]
        .filter((el) => el.offsetParent !== null);
      return {
        counted: wanted.length,
        tooSmall: wanted
          .map((el) => ({ what: el.textContent.trim().slice(0, 18) || el.id, box: el.getBoundingClientRect() }))
          .filter((x) => x.box.height < 44 || x.box.width < 40)
          .map((x) => `${x.what} ${Math.round(x.box.width)}x${Math.round(x.box.height)}`),
      };
    });
    check('everything you press is at least a fingertip across',
      /* Counted as well as measured. With the song list hidden this found
         nothing to measure and passed on an empty set, which is the one way a
         check like this can be worse than no check. */
      small.counted >= 12 && small.tooSmall.length === 0,
      small.tooSmall.slice(0, 4).join(', ') || `${small.counted} of them`);

    /* THE CASE IS WHOLE WHEN THE APP OPENS — still the rule, but only at the top
       of the page. The page itself scrolls on a phone, which is the opposite of
       what Windows does and took two rounds to learn: pinned, the panel below is
       whatever is left over, and on a small screen with Android's text size
       turned up that was twelve pixels. */
    const whole = await page.evaluate(() => {
      /* At the TOP of the page, which is where the app opens and where this
         rule applies. Tapping a tab deliberately scrolls its panel up to meet
         your thumb, so measuring after one of those would be asking a different
         question and getting a frightening answer to it. */
      window.scrollTo(0, 0);
      const rack = document.querySelector('.rack').getBoundingClientRect();
      return { top: Math.round(rack.top), bottom: Math.round(rack.bottom), window: window.innerHeight };
    });
    check('the whole case is there when the app opens',
      whole.top >= 0 && whole.bottom <= whole.window,
      `case runs ${whole.top} to ${whole.bottom} of ${whole.window}`);

    /* The three sound switches are 200 pixels of a phone screen and every one of
       them is a thing you set and leave, so they get a tab. WITH their
       sentences: three bare words would have fitted and said nothing. */
    const sound = await page.evaluate(() => {
      const panel = document.querySelector('[data-panel="sound"]');
      const moved = Boolean(document.querySelector('[data-panel="sound"] .switches'));
      const cards = [...(panel?.querySelectorAll('.sw-card, .swx') ?? [])];
      return { moved, cards: cards.length, words: cards.map((c) => c.textContent.trim().length) };
    });
    check('the sound switches have a tab of their own, so the case fits', sound.moved);
    check('and each still says in words what it does',
      sound.cards >= 3 && sound.words.every((n) => n > 60),
      `${sound.cards} switches, shortest ${Math.min(...sound.words)} characters`);

    const tabsAt = await page.evaluate(() => {
      const tabs = document.querySelector('.tabs').getBoundingClientRect();
      return { bottom: Math.round(tabs.bottom), window: window.innerHeight };
    });
    check('and the tabs are down where a thumb reaches',
      tabsAt.bottom > tabsAt.window * 0.6,
      `tabs end at ${tabsAt.bottom} of ${tabsAt.window}`);
  }

  console.log('\n--- a song, from the phone\'s own picker ---');
  {
    /* Android's picker shows every provider at once — the phone, OneDrive, each
       Drive account. In a browser it is the browser's picker, and either way the
       app is handed something to play rather than a path it went looking for. */
    await page.click('.tab[data-tab="songs"]');
    await page.click('#open');
    /* The file input the picker put in the page, filled directly. Waiting for
       Chromium's own chooser dialog is the obvious thing and it does not arrive
       under xvfb — but the input being there, and a chosen file reaching the
       app through it, is the whole of what this is checking. */
    await page.waitForSelector('input[data-tva-picker]', { state: 'attached', timeout: 15000 });
    await page.setInputFiles('input[data-tva-picker]', songPath);
    await page.waitForFunction(
      () => document.getElementById('now-name').textContent !== 'NO SONG OPEN', { timeout: 15000 });
    check('a song opens from the picker', true, await page.textContent('#now-name'));
    await page.waitForFunction(() => !document.getElementById('play').disabled, { timeout: 10000 });
    check('and its length is read', (await page.textContent('#t-total')) === '0:08',
      `clock reads ${await page.textContent('#t-total')}`);

    await page.click('#play');
    await page.waitForFunction(
      () => document.getElementById('t-now').textContent !== '0:00', { timeout: 10000 });
    check('it plays', true);
  }

  console.log('\n--- playing on with the screen off ---');
  {
    /* A page is something Android may freeze when it is not on the screen, and
       pressing the power button mid-practice stopped the song. The fix is to
       tell the phone what is playing — a foreground service, audio focus and a
       media session — and the part that can break here, invisibly, is whether
       the page SAYS anything at the right moments. Whether the phone then
       honours it is the one thing only a phone can answer, and the checklist
       says so.

       Also checked: that the four functions exist at all on the phone build.
       They are optional in the shared code, because Windows does not need them
       — so "optional" must not quietly become "absent" here. */
    const has = await page.evaluate(() => [
      'nowPlaying', 'playbackStopped', 'onPlaybackCommand', 'canKeepPlaying',
    ].filter((name) => typeof window.tva[name] !== 'function'));
    check('the phone build really implements all four playback calls',
      has.length === 0, has.join(', ') || 'all of them');

    const told = await page.evaluate(async () => {
      const web = await import('./bridge/web-fallback.js');
      web.PlaybackWeb.said.length = 0;
      document.getElementById('play').click();          // pause — it was playing
      await new Promise((r) => setTimeout(r, 400));
      document.getElementById('play').click();          // play again
      await new Promise((r) => setTimeout(r, 600));
      document.getElementById('stop').click();
      await new Promise((r) => setTimeout(r, 400));
      return web.PlaybackWeb.said.map((x) => x.what);
    });
    check('it tells the phone when it pauses, when it plays and when it stops',
      told.includes('paused') && told.includes('playing') && told.includes('stopped'),
      told.join(' → ') || 'said nothing');
    check('and the song it names goes with it',
      await page.evaluate(async () => {
        const web = await import('./bridge/web-fallback.js');
        return web.PlaybackWeb.said.some((x) => (x.title ?? '').length > 3);
      }));

    /* The lock screen, the notification and the buttons on a pair of headphones
       all arrive as the same command. Pressed, they must reach the same play and
       pause the buttons on screen reach — not a second set that can disagree. */
    const fromLockScreen = await page.evaluate(async () => {
      const web = await import('./bridge/web-fallback.js');
      web.PlaybackWeb.pretendCommand('play');
      await new Promise((r) => setTimeout(r, 900));
      const playing = document.getElementById('lamp-play').classList.contains('lit');
      web.PlaybackWeb.pretendCommand('pause');
      await new Promise((r) => setTimeout(r, 500));
      const paused = !document.getElementById('lamp-play').classList.contains('lit');
      return { playing, paused };
    });
    check('a play from outside the app starts it', fromLockScreen.playing);
    check('and a pause from outside stops it', fromLockScreen.paused);
  }

  console.log('\n--- the practice controls, on a phone ---');
  {
    /* The stretch engine is WASM compiled from bytes it carries, with its
       worklet registered from a blob. Whether that survives being served from
       somewhere other than Electron is exactly the kind of thing that is fine
       in theory and broken in fact. */
    const stretched = await page.evaluate(async () => {
      const SR = 48000; const inLen = SR * 2;
      const chans = [new Float32Array(inLen), new Float32Array(inLen)];
      for (let i = 0; i < inLen; i++) {
        const v = Math.sin((2 * Math.PI * 440 * i) / SR) * 0.5;
        chans[0][i] = v; chans[1][i] = v;
      }
      const ctx = new OfflineAudioContext({
        numberOfChannels: 2, length: Math.ceil(inLen / 0.75) + SR, sampleRate: SR,
      });
      const mod = await import('./vendor/SignalsmithStretch.mjs');
      const node = await mod.default(ctx, { numberOfInputs: 0, outputChannelCount: [2] });
      await node.addBuffers(chans);
      node.connect(ctx.destination);
      node.schedule({ active: true, input: 0, rate: 0.75, semitones: 2,
                      formantCompensation: true, formantBaseHz: 0 });
      const out = (await ctx.startRendering()).getChannelData(0);
      const mid = out.slice(Math.floor(SR * 0.6), Math.floor(SR * 1.6));
      let best = 0; let lag = 0;
      for (let t = Math.floor(SR / 1200); t <= Math.floor(SR / 200); t++) {
        let acc = 0;
        for (let i = 0; i + t < mid.length; i++) acc += mid[i] * mid[i + t];
        if (acc > best) { best = acc; lag = t; }
      }
      let peak = 0;
      for (let i = 0; i < out.length; i++) peak = Math.max(peak, Math.abs(out[i]));
      return { hz: lag ? SR / lag : 0, peak };
    }).catch((e) => ({ error: String(e.message ?? e) }));
    check('the speed and key engine runs in the phone build',
      !stretched.error && stretched.peak > 0.05 && Math.abs(stretched.hz - 493.9) < 20,
      stretched.error ?? `${stretched.hz?.toFixed(1)} Hz against a wanted 493.9`);
  }

  console.log('\n--- recording on the phone ---');
  {
    await page.click('.tab[data-tab="loop"]');
    await page.click('#rec-new');
    await page.waitForFunction(
      () => document.getElementById('lamp-rec').classList.contains('lit'), { timeout: 20000 });
    check('the microphone opens and a take starts', true);
    await page.waitForTimeout(1800);
    await page.click('#rec-new');
    await page.waitForFunction(
      () => !document.getElementById('lamp-rec').classList.contains('lit'), { timeout: 10000 });

    await page.click('.tab[data-tab="takes"]');
    await page.waitForSelector('#takes .item', { timeout: 10000 });
    const take = await page.evaluate(async () => {
      const list = await window.tva.listRecordings();
      const bytes = await (await fetch(list[0].url)).arrayBuffer();
      const rate = new DataView(bytes).getUint32(24, true);
      const ctx = new OfflineAudioContext({ numberOfChannels: 1, length: 1, sampleRate: rate });
      const buf = await ctx.decodeAudioData(bytes);
      const d = buf.getChannelData(0);
      const seg = d.slice(Math.floor(rate * 0.4), Math.floor(rate * 0.9));
      let peak = 0;
      for (let i = 0; i < seg.length; i++) peak = Math.max(peak, Math.abs(seg[i]));
      let best = 0; let lag = 0;
      for (let t = Math.floor(rate / 1200); t <= Math.floor(rate / 200); t++) {
        let acc = 0;
        for (let i = 0; i + t < seg.length; i++) acc += seg[i] * seg[i + t];
        if (acc > best) { best = acc; lag = t; }
      }
      return { seconds: buf.duration, peak, hz: lag ? rate / lag : 0 };
    });
    check('and the take holds the sound the microphone was hearing',
      take.peak > 0.05 && Math.abs(take.hz - 440) < 12,
      `${take.seconds.toFixed(2)}s, peak ${take.peak.toFixed(3)}, ${take.hz.toFixed(1)} Hz against 440`);
  }

  console.log('\n--- saving a take out of the phone ---');
  {
    /* Android's Save box takes a name and a place but has no "Save as type"
       list, so the format is chosen in the app and the rest of the export path —
       open something, write lumps into it, finish or abandon it — is the code
       the Windows app runs. */
    const saved = await page.evaluate(async () => {
      const list = await window.tva.listRecordings();
      const picked = await window.tva.exportPick({ suggestedName: list[0].name, format: 'mp3' });
      if (!picked) return { error: 'nothing picked' };
      const head = new Uint8Array(await (await fetch(list[0].url)).arrayBuffer());
      const rate = new DataView(head.buffer).getUint32(24, true);
      const channels = new DataView(head.buffer).getUint16(22, true) || 1;
      const samples = new Int16Array(head.buffer, 44, Math.floor((head.length - 44) / 2));

      const opened = await window.tva.exportOpen({ filePath: picked.filePath });
      if (opened?.error) return { error: opened.error };
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
        worker.postMessage({ type: 'begin', format: 'mp3', sampleRate: rate, channels,
          totalFrames: samples.length / channels, kbps: 128 });
        const copy = new Int16Array(samples);
        worker.postMessage({ type: 'pcm', samples: copy }, [copy.buffer]);
        worker.postMessage({ type: 'end' });
      });
      const done = await window.tva.exportFinish(opened.id);
      if (!done || done.error) return { error: done?.error ?? 'no file' };

      const back = await window.tva.exportCopy ? null : null;
      const part = await (await import('./bridge/web-fallback.js')).FilesWeb
        .readRange({ uri: done.path, start: 0, length: 5 * 1024 * 1024 });
      const binary = atob(part.base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const size = bytes.length;
      const ctx = new OfflineAudioContext({ numberOfChannels: 1, length: 1, sampleRate: 44100 });
      const buf = await ctx.decodeAudioData(bytes.buffer);
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
    }).catch((e) => ({ error: String(e.message ?? e) }));
    check('a take saves out as an MP3 that still holds the singing',
      !saved.error && saved.peak > 0.05 && Math.abs(saved.hz - 440) < 12,
      saved.error ?? `${Math.round(saved.size / 1024)} KB, ${saved.hz?.toFixed(1)} Hz against 440`);
  }

  console.log('\n--- the same loops and notes as the computer ---');
  {
    /* THE CLAIM IS THAT BOTH MACHINES READ AND WRITE THE SAME FILE, so this
       acts as the other machine: a song file is written into the shared folder
       exactly as the Windows app would write it — one small file per song, named
       by songFileName so the two agree — and then the song is opened on the
       phone and the loop it came with has to be there. */
    await page.click('.tab[data-tab="set-up"]').catch(async () => {
      await page.click('.tab[data-tab="setup"]');
    });
    /* Through the button, not the function under it: whether the two buttons in
       Set-up are wired, and whether the line under them then says the right
       thing, is the part a person actually meets. */
    await page.click('#share-pick');
    await page.waitForTimeout(500);
    const shared = await page.evaluate(() => window.tva.sharedFolder());
    check('a folder can be shared with the computer',
      Boolean(shared?.uri) && shared.writable === true, shared?.name ?? 'none chosen');
    check('and Set-up says in words what that means now',
      (await page.textContent('#share-state')).includes('either machine'),
      (await page.textContent('#share-state')).slice(0, 70));

    const seeded = await page.evaluate(async () => {
      const core = await import('./practice-core.js');
      const web = await import('./bridge/web-fallback.js');
      const list = await window.tva.scanLibrary();
      const song = list.songs[0];
      const name = await core.songFileName(song.songKey);
      /* Written the way the desktop writes it: the whole song file, with a
         marked part in it that the phone has never seen. */
      web.seedSharedFile(`songs/${name}`, JSON.stringify({
        schemaVersion: 1,
        songKey: song.songKey,
        songName: song.name,
        updatedAt: '2026-01-01T00:00:00.000Z',
        updatedBy: 'the desktop',
        settings: { speed: 1, semitones: 0, balance: 0, volume: 1,
          naturalVoice: true, leadQuieter: false, oneSpeaker: false,
          loopA: 2.5, loopB: 4.5, looping: false, sections: [] },
        lastPositionSec: 0, notes: [], lufs: null, bpm: null, countInBars: 2,
      }, null, 2));
      return { fileName: name, key: song.songKey };
    });

    /* Re-opened, because the loops are read when a song is opened. */
    await page.click('.tab[data-tab="songs"]');
    await page.click('#songs-host .song');
    await page.waitForTimeout(1500);
    const arrived = await page.evaluate(() => ({
      a: document.getElementById('loop-a')?.value ?? '',
      b: document.getElementById('loop-b')?.value ?? '',
    }));
    check('a part marked on the computer is there when the song opens on the phone',
      arrived.a === '0:02.5' && arrived.b === '0:04.5',
      `loop reads ${arrived.a} to ${arrived.b}, from ${seeded.fileName}`);

    /* And the other way. Marked here, the same file has to change — that is
       what makes it a shared folder rather than a folder it reads from. */
    await page.click('.tab[data-tab="loop"]');
    await page.evaluate(() => {
      const a = document.getElementById('loop-a');
      const b = document.getElementById('loop-b');
      a.value = '0:01.0'; a.dispatchEvent(new Event('change', { bubbles: true }));
      b.value = '0:03.0'; b.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.waitForTimeout(2000);
    const written = await page.evaluate(async (fileName) => {
      const web = await import('./bridge/web-fallback.js');
      const text = web.readSharedFile(`songs/${fileName}`);
      if (!text) return { missing: true };
      const file = JSON.parse(text);
      return { a: file.settings.loopA, b: file.settings.loopB, by: file.updatedBy };
    }, seeded.fileName);
    check('and a part marked on the phone is written back into the same file',
      !written.missing && Math.abs(written.a - 1) < 0.2 && Math.abs(written.b - 3) < 0.2,
      written.missing ? 'the file was not written' : `loop ${written.a} to ${written.b}`);

    await page.evaluate(() => window.tva.stopSharing());
  }

  console.log('\n--- everything is reachable, on every phone ---');
  {
    /* THE CHECK THAT WAS MISSING, and the reason Ted could not get to a song
       twice over. Every check here ran at one screen size with the default text
       size — and a phone is neither. Android's own Font size and Display size
       settings scale everything in a web view, plenty of people turn them up,
       and screens run from 360 pixels wide to 412.
       Measured before the fix: the Loop panel had 251 pixels for 362 pixels of
       content on a Pixel, twelve pixels on a 360x640 screen with larger text,
       and two tabs off the bottom. "I can't scroll beyond that."
       So this opens every tab at nine combinations and asks the only question
       that matters: can the last thing in it be reached. */
    const sizes = [
      { width: 390, height: 844, what: 'a Pixel' },
      { width: 360, height: 640, what: 'a small phone' },
      { width: 412, height: 915, what: 'a big phone' },
    ];
    const zooms = [1, 1.3, 1.5];
    const tabs = await page.evaluate(() =>
      [...document.querySelectorAll('.tabs .tab')].map((t) => t.dataset.tab));

    let worst = null;
    let checked = 0;
    for (const size of sizes) {
      for (const zoom of zooms) {
        await page.setViewportSize(size);
        await page.evaluate((z) => {
          document.documentElement.style.fontSize = `${Math.round(15 * z)}px`;
        }, zoom);
        await page.waitForTimeout(200);

        for (const tab of tabs) {
          const button = await page.$(`.tabs .tab[data-tab="${tab}"]`);
          if (!button || !(await button.isVisible())) continue;
          /* The bar scrolls sideways, so the tab may need bringing into view —
             which is itself part of being reachable. */
          await button.scrollIntoViewIfNeeded();
          await button.click();
          await page.waitForTimeout(120);
          /* THE APP'S OWN MEASUREMENT, not a second copy of it written here.
             window.__tvaReach lives beside the renderer's other hooks and the
             instrumented Android test calls exactly the same one, so the check
             that runs in a browser and the check that runs on a phone cannot
             come to disagree about what "reachable" means. */
          const reach = await page.evaluate((name) => window.__tvaReach(name), tab);
          if (!reach) continue;
          checked++;
          const ok = reach.lastBottom <= reach.floor + 1 && !reach.sideways && reach.tabOnScreen;
          if (!ok && !worst) {
            worst = `${tab} on ${size.what} at text x${zoom}: the last thing in it ends at `
              + `${reach.lastBottom}, past the tab bar at ${reach.floor}`
              + (reach.sideways ? `, and it is ${reach.widest}px wide in a ${size.width}px screen` : '')
              + (reach.tabOnScreen ? '' : ', and the tab bar is off the bottom');
          }
        }
      }
    }
    await page.evaluate(() => { document.documentElement.style.fontSize = ''; });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(200);

    check('every tab can be scrolled to its end, on every screen and text size',
      worst === null && checked >= 50,
      worst ?? `${checked} tab-and-screen combinations, all reachable`);
  }

  console.log('\n--- with a real number of songs in it ---');
  {
    /* THE FAULT TED HIT, and the one every check here had missed because they
       ran against an empty library. On Windows the song list is a fixed side
       column: the list scrolls inside it and "Open a song" is pinned at its
       foot. Moved into a tab on a phone, that scrolling went with it — and with
       forty songs the button was 2,168 pixels down, below every one of them,
       seven screens into a panel 243 pixels tall. "I couldn't scroll to the song
       upload."
       So the library is seeded and the page reloaded, which is the only way to
       meet the app the way he met it. */
    await page.evaluate(() => {
      const songs = [];
      for (let i = 1; i <= 40; i++) {
        songs.push({ path: `content://seeded/${i}`, name: `Practice track number ${i}.mp3`,
          size: 1000 + i, songKey: `practice track number ${i}.mp3::${1000 + i}`,
          url: 'about:blank', root: null });
      }
      localStorage.setItem('tva.songs', JSON.stringify(songs));
    });
    await page.reload();
    await page.waitForTimeout(1500);
    await page.click('.tab[data-tab="songs"]');
    await page.waitForTimeout(400);

    const reach = await page.evaluate(() => {
      const open = document.getElementById('open').getBoundingClientRect();
      return {
        rows: document.querySelectorAll('.song').length,
        top: Math.round(open.top), bottom: Math.round(open.bottom),
        window: window.innerHeight,
      };
    });
    check('the song list really fills up', reach.rows >= 40, `${reach.rows} songs listed`);
    /* STILL THE QUESTION HE ASKED — "where do I add a song" — but the answer
       changed shape. The page scrolls on a phone now, so the button no longer
       has to be on screen because nothing moves; it has to be on screen because
       tapping the tab brings its panel up to meet you, and because the button
       sits at the head of the list rather than under forty rows of it. */
    check('and Open a song is on the screen as soon as the tab is tapped',
      reach.top >= 0 && reach.bottom <= reach.window,
      `the button sits at ${reach.top}..${reach.bottom} of ${reach.window}`);

    const search = await page.evaluate(() => {
      const box = document.getElementById('find').getBoundingClientRect();
      return { top: Math.round(box.top), bottom: Math.round(box.bottom), window: window.innerHeight };
    });
    check('and so is the search box, which is how a long list gets short',
      search.top >= 0 && search.bottom <= search.window,
      `search sits at ${search.top}..${search.bottom}`);

    /* A hidden label with nowhere to be is not nothing: absolutely positioned
       with no top or left, it went wherever the reordered page left it — which
       was past the bottom, adding 29 pixels of scroll to a page that is supposed
       to hold still.
       THIS USED TO ASK WHETHER THE PAGE SCROLLED AT ALL, which was the right
       question while the case was pinned and is the wrong one now: a phone has
       one scrolling page on purpose. So it asks the thing the fault was actually
       about — whether anything you cannot see is making the page longer than the
       things you can. */
    const tail = await page.evaluate(() => {
      let lowest = 0;
      for (const el of document.querySelectorAll('body *')) {
        if (!el.offsetParent) continue;
        const box = el.getBoundingClientRect();
        if (getComputedStyle(el).position === 'fixed') continue;
        lowest = Math.max(lowest, box.bottom + window.scrollY);
      }
      return {
        lowest: Math.round(lowest),
        page: document.documentElement.scrollHeight,
        /* #tp keeps a gap under everything so the fixed tab bar is not sitting
           on top of the last row. That gap is meant to be there. */
        allowed: Math.round(parseFloat(getComputedStyle(document.getElementById('tp')).paddingBottom)) + 8,
      };
    });
    check('and nothing invisible is making the page longer than what is on it',
      tail.page <= tail.lowest + tail.allowed,
      `page is ${tail.page} tall, the lowest visible thing ends at ${tail.lowest}, `
      + `and ${tail.allowed}px of clearance is expected under it`);
  }

  console.log('\n--- how it looks ---');
  {
    await page.click('.tab[data-tab="set-up"]').catch(async () => {
      await page.click('.tab[data-tab="setup"]');
    });
    const skins = await page.evaluate(async () => {
      const ids = window.__tvaSkins();
      const cases = new Set();
      for (const id of ids) {
        window.__tvaSetSkin(id);
        await new Promise((r) => setTimeout(r, 20));
        cases.add(getComputedStyle(document.documentElement).getPropertyValue('--case-mid').trim());
      }
      window.__tvaSetSkin(ids[0]);
      return { count: ids.length, distinct: cases.size };
    });
    check('all twelve skins work on the phone too',
      skins.count === 12 && skins.distinct === 12,
      `${skins.distinct} different cases across ${skins.count} skins`);
  }
} finally {
  await browser.close().catch(() => {});
  server.close();
  if (NEGATIVE) await writeFile(cssPath, cssOriginal);
  await rm(work, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.passed);
console.log(`\n${results.length - failed.length}/${results.length} checks passed on a phone-sized screen.`);
if (NEGATIVE) {
  const bit = failed.length > 0;
  console.log(bit
    ? `\nNegative control worked: ${failed.length} check(s) went red with the phone layout removed.`
    : '\nNegative control FAILED: everything passed without the phone layout, so it proves nothing.');
  process.exit(bit ? 0 : 1);
}
process.exit(failed.length ? 1 : 0);
