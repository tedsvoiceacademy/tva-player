/* Take a picture of the app, so Ted never has to be the rendering engine.
 *
 * Run: xvfb-run -a node scripts/screenshot.mjs [out.png]
 *
 * It opens a generated song with the dynamics of a real one, marks and names
 * two parts, sets a speed, and shoots the window at its default size.
 */
import { _electron as electron } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeSong } from './make-test-song.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = process.argv[2] ?? join(ROOT, 'tva-player.png');

const work = await mkdtemp(join(tmpdir(), 'tva-shot-'));
const songPath = join(work, 'Shenandoah (rehearsal mix).mp3');
makeSong(songPath, { seconds: 214, shape: true });

const app = await electron.launch({
  args: [join(ROOT, 'apps/desktop'), '--no-sandbox',
    `--user-data-dir=${join(work, 'ud')}`, songPath],
  env: { ...process.env, OneDrive: '', OneDriveConsumer: '', OneDriveCommercial: '' },
});
const page = await app.firstWindow();
await page.setViewportSize({ width: 1180, height: 760 });
await page.waitForFunction(() => !document.getElementById('play').disabled, { timeout: 20000 });

await page.fill('#loop-a', '1:04.0'); await page.dispatchEvent('#loop-a', 'change');
await page.fill('#loop-b', '1:31.5'); await page.dispatchEvent('#loop-b', 'change');
await page.fill('#secname', 'the tag'); await page.click('#save-sec');
await page.fill('#loop-a', '0:46.0'); await page.dispatchEvent('#loop-a', 'change');
await page.fill('#loop-b', '1:02.0'); await page.dispatchEvent('#loop-b', 'change');
await page.fill('#secname', 'bar 40 to the end'); await page.click('#save-sec');

await page.evaluate(() => {
  const el = document.getElementById('speed');
  el.value = '85'; el.dispatchEvent(new Event('input', { bubbles: true }));
});
await page.waitForTimeout(2500);
await page.screenshot({ path: out });
await app.close();
await rm(work, { recursive: true, force: true });
console.log(`wrote ${out}`);
