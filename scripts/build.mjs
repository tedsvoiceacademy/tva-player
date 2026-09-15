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

await esbuild.build({ ...shared, entryPoints: [ENTRY], format: 'cjs',
  outfile: join(DESKTOP, 'dist/main/practice-core.cjs') });

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
const STRETCH = 'signalsmith-stretch/SignalsmithStretch.mjs';
const candidates = [
  join(ROOT, 'node_modules', STRETCH),
  join(DESKTOP, 'node_modules', STRETCH),
];
const stretchSource = candidates.find((p) => existsSync(p));
if (!stretchSource) {
  throw new Error(`Cannot find ${STRETCH}. Looked in:\n  ${candidates.join('\n  ')}`);
}
await copyFile(stretchSource, join(DESKTOP, 'dist/renderer/vendor/SignalsmithStretch.mjs'));

/* Everything that is already plain JavaScript is copied rather than compiled. */
const { cp } = await import('node:fs/promises');
await cp(join(DESKTOP, 'src/main'), join(DESKTOP, 'dist/main'), { recursive: true });
await cp(join(DESKTOP, 'src/preload'), join(DESKTOP, 'dist/preload'), { recursive: true });
await cp(join(DESKTOP, 'src/renderer'), join(DESKTOP, 'dist/renderer'), { recursive: true });

console.log('built');
