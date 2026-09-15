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
import { makeSong, makeMp3 } from './make-test-song.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = process.argv[2] ?? join(ROOT, 'tva-player.png');

const work = await mkdtemp(join(tmpdir(), 'tva-shot-'));
const { mkdir, writeFile } = await import('node:fs/promises');

const musicDir = join(work, 'Music');
await mkdir(musicDir, { recursive: true });
const songPath = join(musicDir, 'Shenandoah (rehearsal mix).mp3');
await makeMp3(songPath, { seconds: 214, shape: true });
for (const name of ['Danny Boy (learning track).mp3', 'Lida Rose (tenor).mp3',
  'My Wild Irish Rose.mp3', 'Coney Island Baby.mp3', 'Sweet Adeline.mp3']) {
  await makeMp3(join(musicDir, name), { seconds: 150, shape: true });
}
await mkdir(join(work, 'ud', 'Player Settings'), { recursive: true });
await writeFile(join(work, 'ud', 'Player Settings', 'settings.json'),
  JSON.stringify({ folders: [musicDir], recordingsDir: join(work, 'Takes') }));

const micFile = join(work, 'mic.wav');
makeSong(micFile, { seconds: 30, left: 392, right: 392 });   // G4, so the tuner shows something

const app = await electron.launch({
  args: [join(ROOT, 'apps/desktop'), '--no-sandbox',
    `--user-data-dir=${join(work, 'ud')}`,
    '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
    `--use-file-for-fake-audio-capture=${micFile}`,
    songPath],
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
// Back to the top of the bench, so the picture shows what a person first sees.
await page.evaluate(() => { document.querySelector('.deskwrap').scrollTop = 0; });
await page.waitForTimeout(2500);
await page.screenshot({ path: out });

/* The record tab too, with the microphone on and a take in the list, so the
   half of the app that is not the player can be seen without installing it. */
await page.click('.tab[data-tab="record"]');
await page.click('#mic-open');
await page.waitForFunction(() => !document.getElementById('rec-start').disabled, { timeout: 20000 });
await page.click('#rec-start');
await page.waitForTimeout(2200);
await page.click('#rec-stop');
await page.waitForTimeout(1200);
const recOut = out.replace(/\.png$/, '-record.png');
await page.screenshot({ path: recOut });

await app.close();
await rm(work, { recursive: true, force: true });
console.log(`wrote ${out} and ${recOut}`);
