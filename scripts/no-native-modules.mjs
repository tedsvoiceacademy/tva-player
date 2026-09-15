/* Fail if anything that SHIPS INSIDE THE APP is a native module.
 *
 * Every native module in an Electron app is a recurring tax: node-gyp, a rebuild
 * for each Electron version, and a build that breaks on a machine nobody is
 * watching. This app deliberately has none — no better-sqlite3, no PortAudio
 * bindings. A guard is how that survives the first time one looks like an easy
 * win.
 *
 * Only the runtime dependencies are checked. Build tools are allowed to be
 * native — esbuild, rollup and electron-builder's compressor all are — because
 * they run here and in CI and never reach Ted's machine.
 */
import { execFileSync } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function shippedPackageNames() {
  let raw;
  try {
    raw = execFileSync('npm', ['ls', '--omit=dev', '--all', '--json', '-w', 'tva-player'],
      { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (err) {
    raw = err.stdout;   // npm exits non-zero when the tree has problems, and still prints it
  }

  const tree = JSON.parse(raw ?? '{}');

  /* A tree that does not match package.json would give a list of shipped
     packages that is simply wrong, and this script would then report a native
     module that is not shipped at all — which is what it did once. Say what is
     actually wrong instead. */
  if (tree.problems?.length) {
    console.error('The installed packages do not match package.json, so what ships cannot be');
    console.error('worked out. Run "npm install" and try again.\n');
    for (const problem of tree.problems.slice(0, 5)) console.error('  ' + problem);
    process.exit(1);
  }

  const names = new Set();
  const walk = (deps) => {
    for (const [name, node] of Object.entries(deps ?? {})) {
      names.add(name);
      walk(node.dependencies);
    }
  };
  walk(tree.dependencies);
  for (const ws of Object.values(tree.dependencies ?? {})) walk(ws.dependencies);
  return names;
}

const shipped = shippedPackageNames();
const found = [];

async function walk(dir, packageName, depth = 0) {
  if (depth > 8) return;
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') { await walkModules(full, depth + 1); continue; }
      await walk(full, packageName, depth + 1);
      continue;
    }
    if (entry.name === 'binding.gyp' || entry.name.endsWith('.node')) {
      found.push({ packageName, file: full.replace(ROOT + '/', '') });
    }
  }
}

async function walkModules(modulesDir, depth = 0) {
  let entries;
  try { entries = await readdir(modulesDir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('@')) {
      const scoped = await readdir(join(modulesDir, entry.name), { withFileTypes: true });
      for (const inner of scoped) {
        const name = `${entry.name}/${inner.name}`;
        if (shipped.has(name)) await walk(join(modulesDir, entry.name, inner.name), name, depth);
      }
      continue;
    }
    if (shipped.has(entry.name)) await walk(join(modulesDir, entry.name), entry.name, depth);
  }
}

await walkModules(join(ROOT, 'node_modules'));
await walkModules(join(ROOT, 'apps/desktop/node_modules'));

if (found.length) {
  console.error('A native module would ship inside the app. This app is built to have none:');
  for (const f of found.slice(0, 20)) console.error(`  ${f.packageName}  (${f.file})`);
  console.error('\nIf one is genuinely needed, that is a decision to take deliberately —');
  console.error('it means a rebuild on every Electron bump. See the plan, §3.4.');
  process.exit(1);
}
console.log(`ok   no native modules ship inside the app (${shipped.size} runtime packages checked)`);
