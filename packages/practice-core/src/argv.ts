/* Opening files by double-clicking them in File Explorer.
 *
 * This is the app's headline feature and it has two failure modes that do not
 * show up in a browser and are easy to ship broken, so both live here as pure
 * functions with tests rather than inside the Electron main process.
 *
 * 1. THE ARGUMENT LIST HAS A DIFFERENT SHAPE PACKAGED THAN IT DOES IN
 *    DEVELOPMENT. Running from source, Windows hands over
 *    [electron.exe, ".", "C:\\song.mp3"]. Installed, it hands over
 *    [TVA Player.exe, "C:\\song.mp3"]. Code that blindly takes argv[2] works
 *    all through development and opens nothing once it is installed.
 *
 * 2. SELECTING SIX FILES IN EXPLORER AND PRESSING ENTER LAUNCHES SIX COPIES OF
 *    THE APP IN QUICK SUCCESSION. Only one survives the single-instance lock;
 *    the others hand their argument over and quit. Treated one at a time, each
 *    replaces the last and only the sixth file plays. They have to be gathered
 *    into one queue. See collectBurst.
 */

/** Extensions the app opens. Kept here so the installer, the file picker and
 *  the argument filter cannot drift apart. */
export const AUDIO_EXTENSIONS = [
  'mp3', 'm4a', 'wav', 'flac', 'aac', 'ogg', 'oga', 'opus', 'wma', 'aiff', 'aif',
] as const;

const EXT_SET = new Set<string>(AUDIO_EXTENSIONS);

export function isAudioPath(candidate: string): boolean {
  const dot = candidate.lastIndexOf('.');
  if (dot < 0 || dot === candidate.length - 1) return false;
  return EXT_SET.has(candidate.slice(dot + 1).toLowerCase());
}

/* Pull the openable files out of a process argument list, in the order they
   were given. Everything else is dropped: the executable itself, the "." that
   marks a development run, Chromium and Node switches, and the "--" separator.
   A path with spaces arrives as one argument already — the shell has done that
   work — so no quote handling belongs here. */
export function filterAudioArgs(argv: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 1; i < argv.length; i++) {   // index 0 is always the executable
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === '.' || arg === '--') continue;
    if (arg.startsWith('-')) continue;      // --inspect, --no-sandbox, --task=record
    if (!isAudioPath(arg)) continue;
    out.push(arg);
  }
  return out;
}

/** A task started from the taskbar jump list, e.g. "--task=record". */
export function taskFromArgs(argv: readonly string[]): string | null {
  for (const arg of argv) {
    if (arg && arg.startsWith('--task=')) {
      const value = arg.slice('--task='.length).trim();
      if (value) return value;
    }
  }
  return null;
}

/* Gather a burst of separate launches into one queue.
 *
 * Feed it each arrival with the time it happened. It returns null while the
 * burst may still be growing, and the whole gathered list once the burst has
 * gone quiet for `windowMs`. The caller is responsible for asking again after
 * the window has passed — see flush.
 */
export class BurstCollector {
  private pending: string[] = [];
  private lastAtMs = 0;

  constructor(private readonly windowMs = 250) {}

  /** Record an arrival. Returns the time at which flush() should next be tried. */
  add(paths: readonly string[], atMs: number): number {
    for (const p of paths) this.pending.push(p);
    this.lastAtMs = atMs;
    return atMs + this.windowMs;
  }

  /** If the burst has gone quiet, hand over everything gathered and reset.
   *  Otherwise returns null, meaning "not yet, ask again". */
  flush(atMs: number): string[] | null {
    if (this.pending.length === 0) return null;
    if (atMs - this.lastAtMs < this.windowMs) return null;
    const out = this.pending;
    this.pending = [];
    this.lastAtMs = 0;
    return out;
  }

  get size(): number {
    return this.pending.length;
  }
}
