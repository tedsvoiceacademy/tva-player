/* Typing a loop's start and end, instead of only dragging for it.
 *
 * On the members site a member drags across the waveform and that is the only
 * way in, because a phone has no room for anything else. Ted asked for typed
 * in and out times on the desktop, which means accepting whatever a person
 * actually types into a box: "1:23", "1:23.5", "83.5", "0:07", ":45".
 */

/** Seconds as m:ss.t, the way the readout prints them. */
export function formatTime(seconds: number, withTenths = false): string {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const whole = Math.floor(seconds);
  const mins = Math.floor(whole / 60);
  const secs = whole % 60;
  const base = `${mins}:${secs.toString().padStart(2, '0')}`;
  if (!withTenths) return base;
  const tenths = Math.floor((seconds - whole) * 10);
  return `${base}.${tenths}`;
}

/* Read a typed time. Returns null when it cannot be read, so the caller can
   leave the box alone and say so, rather than silently jumping to zero. */
export function parseTime(text: string): number | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  // Plain seconds: "83", "83.5"
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);

  // m:ss, m:ss.t, and the leading-colon shorthand ":45"
  const m = /^(\d*):([0-5]?\d)(\.\d+)?$/.exec(trimmed);
  if (!m) return null;
  const mins = m[1] ? Number(m[1]) : 0;
  const secs = Number(m[2]);
  const frac = m[3] ? Number(m[3]) : 0;
  return mins * 60 + secs + frac;
}

/** The smallest loop worth having. Shorter than this and it is a stutter. */
export const MIN_LOOP_SECONDS = 0.15;

export type LoopEdit = { a: number; b: number };

/* Apply a typed or nudged edit to one end of a loop, keeping the pair valid.
   The end being moved is the one that gives way: pushing the start past the end
   is refused rather than silently swapping them, because a person watching the
   numbers should see what they asked for or see nothing happen. */
export function applyLoopEdit(
  current: LoopEdit,
  which: 'a' | 'b',
  seconds: number,
  duration: number,
): LoopEdit | null {
  if (!Number.isFinite(seconds) || !Number.isFinite(duration) || duration <= 0) return null;
  const clamped = Math.min(Math.max(seconds, 0), duration);
  const next = which === 'a' ? { a: clamped, b: current.b } : { a: current.a, b: clamped };
  if (next.b - next.a < MIN_LOOP_SECONDS) return null;
  return next;
}

/** Move one end by a fixed step, for the nudge buttons. */
export function nudgeLoop(
  current: LoopEdit,
  which: 'a' | 'b',
  stepSeconds: number,
  duration: number,
): LoopEdit | null {
  const from = which === 'a' ? current.a : current.b;
  return applyLoopEdit(current, which, from + stepSeconds, duration);
}
