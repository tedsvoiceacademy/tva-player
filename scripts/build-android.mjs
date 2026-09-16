/* The phone build: the SAME renderer, with a different door to the machine.
 *
 * Nothing about the player is rewritten here. The audio graph, the worklets,
 * the stretch engine, the recorder, the export worker, the waveform and the
 * practice maths are the files the Windows app runs, copied as they are — so a
 * fix to how a loop is edited or how a take is written is a fix on both.
 *
 * Exactly three things differ, and all three are additions rather than edits:
 *
 *   1. bridge/tva-android.js defines window.tva over Capacitor plugins instead
 *      of over Electron's preload. It is loaded FIRST, because app.js reaches
 *      for window.tva while it is still starting up.
 *   2. ui/phone.css re-flows the same markup for a screen a fifth the width.
 *   3. <html data-platform="android">, which is what hides the handful of
 *      things that only exist on Windows.
 *
 * The page is assembled by inserting those into the shared index.html at named
 * anchors. Every insertion is checked, and a missing anchor stops the build
 * rather than quietly producing a page with no bridge in it — which would run,
 * look right, and be unable to open a single song.
 */
import esbuild from 'esbuild';
import { mkdir, copyFile, rm, cp, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RENDERER = join(ROOT, 'apps/desktop/src/renderer');
const ANDROID = join(ROOT, 'apps/android');
const WWW = join(ANDROID, 'www');

await rm(WWW, { recursive: true, force: true });
await mkdir(join(WWW, 'vendor'), { recursive: true });
await mkdir(join(WWW, 'capacitor'), { recursive: true });

/* The practice maths, compiled the same way the desktop build compiles it. */
await esbuild.build({
  entryPoints: [join(ROOT, 'packages/practice-core/src/index.ts')],
  outfile: join(WWW, 'practice-core.js'),
  bundle: true, platform: 'neutral', format: 'esm', target: 'es2022', logLevel: 'info',
});

/* The engine, verbatim. */
for (const folder of ['audio', 'worklets', 'workers', 'ui']) {
  await cp(join(RENDERER, folder), join(WWW, folder), { recursive: true });
}

function vendorFile(relative) {
  const candidates = [
    join(ROOT, 'node_modules', relative),
    join(ANDROID, 'node_modules', relative),
  ];
  const found = candidates.find((p) => existsSync(p));
  if (!found) throw new Error(`Cannot find ${relative}. Looked in:\n  ${candidates.join('\n  ')}`);
  return found;
}

await copyFile(vendorFile('signalsmith-stretch/SignalsmithStretch.mjs'),
  join(WWW, 'vendor/SignalsmithStretch.mjs'));
await copyFile(vendorFile('@breezystack/lamejs/dist/lamejs.js'), join(WWW, 'vendor/lamejs.mjs'));
await copyFile(vendorFile('@breezystack/lamejs/LICENSE'), join(WWW, 'vendor/lamejs-LICENSE.txt'));
/* Capacitor's own runtime, as one self-contained ES module — the same treatment
   the stretch engine gets, and for the same reason: the page is served from its
   own origin and cannot reach node_modules. */
await copyFile(vendorFile('@capacitor/core/dist/index.js'), join(WWW, 'capacitor/core.js'));

await cp(join(ANDROID, 'src/bridge'), join(WWW, 'bridge'), { recursive: true });
await cp(join(ANDROID, 'src/phone/ui'), join(WWW, 'ui'), { recursive: true, force: true });

/* ---- the page ----------------------------------------------------------- */

let page = await readFile(join(RENDERER, 'index.html'), 'utf8');

function insert(after, addition, what) {
  if (!page.includes(after)) {
    throw new Error(`The phone build could not find the ${what} anchor in index.html:\n  ${after}`);
  }
  if (page.includes(addition.trim())) return;      // already there
  page = page.replace(after, `${after}\n${addition}`);
}

insert('<link rel="stylesheet" href="./ui/skins.css">',
  '<link rel="stylesheet" href="./ui/phone.css">', 'stylesheet');
insert('<body>', '<script type="module" src="./bridge/tva-android.js"></script>', 'bridge');

const before = page;
page = page.replace('<html lang="en">', '<html lang="en" data-platform="android">');
if (page === before) throw new Error('The phone build could not find <html lang="en"> to mark as Android.');

await writeFile(join(WWW, 'index.html'), page);
console.log('built the phone web app into apps/android/www');
