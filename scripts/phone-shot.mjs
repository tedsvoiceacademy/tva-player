/* A picture of the phone build, at the size of a phone.
 *
 * Ted should not be the rendering engine — that lesson was learned on the Vocal
 * Fit page and cost five rounds of taste feedback for a wiring fault. So the
 * phone build is photographed here and the picture goes to him with the APK.
 *
 * Run: xvfb-run -a node scripts/phone-shot.mjs out.png
 */
import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { createReadStream, statSync, existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeMp3 } from './make-test-song.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WWW = join(ROOT, 'apps/android/www');
const out = process.argv[2] ?? join(ROOT, 'tva-player-phone.png');
const work = await mkdtemp(join(tmpdir(), 'tva-shot-'));
const song = join(work, 'Shenandoah (rehearsal mix).mp3');
await makeMp3(song, { seconds: 214 });

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.png': 'image/png', '.webp': 'image/webp', '.txt': 'text/plain' };
const server = createServer((request, response) => {
  const path = decodeURIComponent((request.url ?? '/').split('?')[0]);
  const target = join(WWW, path === '/' ? 'index.html' : path.replace(/^\/+/, ''));
  let stat;
  try { stat = statSync(target); } catch { response.writeHead(404).end('x'); return; }
  response.writeHead(200, {
    'Content-Type': MIME[extname(target).toLowerCase()] ?? 'application/octet-stream',
    'Content-Length': String(stat.size),
  });
  createReadStream(target).pipe(response);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));

const browser = await chromium.launch({
  executablePath: process.env.TVA_CHROME
    || (existsSync('/opt/pw-browsers/chromium-1194/chrome-linux/chrome')
      ? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' : undefined),
  args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required',
    '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
});
const page = await (await browser.newContext({
  viewport: { width: 390, height: 844 }, deviceScaleFactor: 2,
  hasTouch: true, permissions: ['microphone'],
})).newPage();
await page.goto(`http://127.0.0.1:${server.address().port}/index.html`);
await page.waitForTimeout(1200);
await page.click('.tab[data-tab="songs"]');
await page.click('#open');
await page.waitForSelector('input[data-tva-picker]', { state: 'attached' });
await page.setInputFiles('input[data-tva-picker]', song);
await page.waitForFunction(
  () => document.getElementById('now-name').textContent !== 'NO SONG OPEN', { timeout: 15000 });
await page.waitForTimeout(800);
await page.click('.tab[data-tab="loop"]');
await page.click('#play');
await page.waitForTimeout(1500);
await page.screenshot({ path: out });
await browser.close();
server.close();
await rm(work, { recursive: true, force: true });
console.log('wrote', out);
