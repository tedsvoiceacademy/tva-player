/* A picture of every skin, so nobody has to install the app to find out what
   "Vintage" means. */
import { _electron as electron } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeMp3 } from './make-test-song.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = process.argv[2] ?? join(ROOT, 'skins');
await mkdir(outDir, { recursive: true });
const work = await mkdtemp(join(tmpdir(), 'tva-skin-'));
const musicDir = join(work, 'Music');
await mkdir(musicDir, { recursive: true });
const songPath = join(musicDir, 'Shenandoah (rehearsal mix).mp3');
await makeMp3(songPath, { seconds: 214, shape: true });
await mkdir(join(work, 'ud', 'Player Settings'), { recursive: true });
await writeFile(join(work, 'ud', 'Player Settings', 'settings.json'),
  JSON.stringify({ folders: [musicDir], recordingsDir: join(work, 'Takes') }));

const app = await electron.launch({
  args: [join(ROOT, 'apps/desktop'), '--no-sandbox', `--user-data-dir=${join(work, 'ud')}`, songPath],
  env: { ...process.env, OneDrive: '', OneDriveConsumer: '', OneDriveCommercial: '' },
});
const page = await app.firstWindow();
await page.setViewportSize({ width: 1180, height: 760 });
await page.waitForFunction(() => !document.getElementById('play').disabled, { timeout: 20000 });
await page.fill('#loop-a', '1:04.0'); await page.dispatchEvent('#loop-a', 'change');
await page.fill('#loop-b', '1:31.5'); await page.dispatchEvent('#loop-b', 'change');
await page.fill('#secname', 'the tag'); await page.click('#save-sec');
await page.evaluate(() => { document.querySelector('.deskwrap').scrollTop = 0; });
await page.waitForTimeout(2500);

const skins = await page.evaluate(() => window.__tvaSkins());
for (const id of skins) {
  await page.evaluate((s) => window.__tvaSetSkin(s), id);
  await page.waitForTimeout(350);
  await page.screenshot({ path: join(outDir, `${id}.png`), clip: { x: 288, y: 8, width: 884, height: 448 } });
}
console.log(`wrote ${skins.length} skins to ${outDir}`);
await app.close();
await rm(work, { recursive: true, force: true });
