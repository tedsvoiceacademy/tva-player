/* Turn the TypeScript in packages/ into the two shapes the app needs, and copy
   in the one library it depends on.
 *
 * practice-core is written to import nothing, so bundling it is a compile rather
 * than a dependency graph. It is emitted twice because the two halves of an
 * Electron app speak different dialects: the main process is CommonJS, and the
 * renderer is a sandboxed page loading ES modules.
 */
import esbuild from 'esbuild';
import { mkdir, copyFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DESKTOP = join(ROOT, 'apps/desktop');
const ENTRY = join(ROOT, 'packages/practice-core/src/index.ts');

await rm(join(DESKTOP, 'dist'), { recursive: true, force: true });
await mkdir(join(DESKTOP, 'dist/main'), { recursive: true });
await mkdir(join(DESKTOP, 'dist/renderer/vendor'), { recursive: true });

const shared = { bundle: true, platform: 'neutral', target: 'es2022', logLevel: 'info' };

await esbuild.build({ ...shared, entryPoints: [ENTRY], format: 'esm',
  outfile: join(DESKTOP, 'dist/renderer/practice-core.js') });

/* The renderer is served from the app's own origin under a strict policy, so it
   cannot reach into node_modules. The stretch library is copied in beside it.
   It carries its own WASM and worklet, so this one file is the whole of it —
   and copying it means THE PACKAGED APP HAS NO RUNTIME DEPENDENCIES AT ALL,
   which is what keeps the installer build simple.
 *
   npm may hoist the package to the root or leave it in the workspace, so both
   are tried rather than one being assumed. */
function vendorFile(relative) {
  const candidates = [
    join(ROOT, 'node_modules', relative),
    join(DESKTOP, 'node_modules', relative),
  ];
  const found = candidates.find((p) => existsSync(p));
  if (!found) throw new Error(`Cannot find ${relative}. Looked in:\n  ${candidates.join('\n  ')}`);
  return found;
}

const vendor = (name) => join(DESKTOP, 'dist/renderer/vendor', name);

await copyFile(vendorFile('signalsmith-stretch/SignalsmithStretch.mjs'),
  vendor('SignalsmithStretch.mjs'));

/* The MP3 encoder, for saving a take as something that can be emailed.
 *
 * A pure JavaScript port of LAME, so it stays a build-time dependency that is
 * COPIED rather than installed — the packaged app still has no node_modules of
 * its own. It is copied whole and unminified, with its licence beside it, which
 * is also what LGPL-3.0 asks of anything that ships it. */
await copyFile(vendorFile('@breezystack/lamejs/dist/lamejs.js'), vendor('lamejs.mjs'));
await copyFile(vendorFile('@breezystack/lamejs/LICENSE'), vendor('lamejs-LICENSE.txt'));

/* THE MAIN PROCESS IS BUNDLED, not copied.
 *
 * It keeps the packaged app free of node_modules — the property that made the
 * installer build work at all — while still letting the main process use a
 * library. Anything it imports is compiled into the one file. `electron` is
 * the exception: that is provided by the runtime, not by npm. */
await esbuild.build({
  entryPoints: [join(DESKTOP, 'src/main/index.cjs')],
  outfile: join(DESKTOP, 'dist/main/index.cjs'),
  bundle: true, platform: 'node', target: 'node20', format: 'cjs',
  external: ['electron'], logLevel: 'info',
});

/* The preload and the renderer are already plain JavaScript. */
const { cp } = await import('node:fs/promises');
await cp(join(DESKTOP, 'src/preload'), join(DESKTOP, 'dist/preload'), { recursive: true });
await cp(join(DESKTOP, 'src/renderer'), join(DESKTOP, 'dist/renderer'), { recursive: true });

console.log('built');
