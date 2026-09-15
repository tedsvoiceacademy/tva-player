/* What the player remembers about a song, and the small pieces of maths it runs.
 *
 * PORTED from the members site (src/lib/members/player-settings.ts), which was
 * itself ported from the chorus app. Each port has kept the same property, and
 * this one keeps it too: NOTHING IN THIS FILE TOUCHES THE NETWORK, THE DOM, THE
 * FILE SYSTEM OR AN AUDIO NODE. The package's tsconfig sets "types": [] so even
 * Node's own globals are unavailable here. That is what lets the whole of it run
 * in Node, under scripts/player-harness.mjs, with no browser and no Electron.
 *
 * THE FIELDS ARE NAMED IN PLAIN WORDS — speed, halfSteps, balance, naturalVoice,
 * leadQuieter, not tempo, semitones, pan, formant. Ted, Sep 14 2026: "You
 * frequently say things that you somehow think everyone understands. They
 * don't." The surest way to keep a label plain is for the code underneath to
 * carry the same word, so nobody has to translate on the way to the screen.
 *
 * ONE DELIBERATE CHANGE from the members version: MAX_SECTIONS. See its comment.
 *
 * Storage lives elsewhere (apps/desktop/src/main/store.ts). This file only says
 * what a valid settings object is, which is what both sides need.
 */

export type LoopSection = {
  /** What the member called it: "the bridge", "bar 40 to the end". */
  name: string;
  /** Seconds. */
  a: number;
  b: number;
};

export type PlayerSettings = {
  /** 0.5 to 1.2. 1 is the recording's own speed; the key does not change. */
  speed: number;
  /** -6 to 6 half steps. */
  halfSteps: number;
  /** -1 (left side only) to 1 (right side only). 0 plays both. */
  balance: number;
  /** 0 to 1. */
  volume: number;
  /** Seconds, or null when no section is set. */
  loopA: number | null;
  loopB: number | null;
  looping: boolean;
  /** Keep voices sounding natural when the key is moved. */
  naturalVoice: boolean;
  /** Turn down whatever sits in the middle of the mix. */
  leadQuieter: boolean;
  /** Saved sections, newest last. */
  sections: LoopSection[];
};

export const DEFAULT_PLAYER_SETTINGS: PlayerSettings = {
  speed: 1,
  halfSteps: 0,
  balance: 0,
  volume: 1,
  loopA: null,
  loopB: null,
  looping: false,
  naturalVoice: true,
  leadQuieter: false,
  sections: [],
};

/* The members player caps this at 12, because a list longer than that stops
   being scannable on a phone. A desktop panel scrolls and has room for a real
   list, and a song Ted works in detail can easily have more named parts than a
   dozen. The cap still exists so a corrupt file cannot load ten thousand. */
export const MAX_SECTIONS = 60;
export const MAX_SECTION_NAME = 40;

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
}

/* Coerce arbitrary parsed JSON into a valid settings object, clamping each
   control to its allowed range and dropping anything malformed. Anything that
   cannot be made sense of falls back to the default for that field, so a
   corrupt or out-of-date stored value can never push the audio graph into a bad
   state. This runs on the way in from storage AND on the way in from the
   network, because neither is trusted. */
export function sanitizePlayerSettings(raw: unknown): PlayerSettings {
  const d = DEFAULT_PLAYER_SETTINGS;
  if (typeof raw !== 'object' || raw === null) return { ...d, sections: [] };
  const o = raw as Record<string, unknown>;

  const num = (v: unknown, fallback: number, lo: number, hi: number): number =>
    typeof v === 'number' && Number.isFinite(v) ? clamp(v, lo, hi) : fallback;

  const loopVal = (v: unknown): number | null =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;

  let loopA = loopVal(o.loopA);
  let loopB = loopVal(o.loopB);
  // A must be before B; if not, drop the section rather than store a bad one.
  if (loopA != null && loopB != null && loopB <= loopA) {
    loopA = null;
    loopB = null;
  }
  const looping = loopA != null && loopB != null ? o.looping === true : false;

  return {
    speed: num(o.speed, d.speed, 0.5, 1.2),
    halfSteps: Math.round(num(o.halfSteps, d.halfSteps, -6, 6)),
    balance: num(o.balance, d.balance, -1, 1),
    volume: num(o.volume, d.volume, 0, 1),
    loopA,
    loopB,
    looping,
    naturalVoice: o.naturalVoice === false ? false : true, // default on
    leadQuieter: o.leadQuieter === true,
    sections: sanitizeSections(o.sections),
  };
}

export function sanitizeSections(raw: unknown): LoopSection[] {
  if (!Array.isArray(raw)) return [];
  const out: LoopSection[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const o = item as Record<string, unknown>;
    const a = typeof o.a === 'number' && Number.isFinite(o.a) && o.a >= 0 ? o.a : null;
    const b = typeof o.b === 'number' && Number.isFinite(o.b) && o.b >= 0 ? o.b : null;
    if (a == null || b == null || b <= a) continue;
    const name = typeof o.name === 'string' ? o.name.trim().slice(0, MAX_SECTION_NAME) : '';
    if (!name) continue;
    out.push({ name, a, b });
    if (out.length >= MAX_SECTIONS) break;
  }
  return out;
}

/* True if these settings differ from the defaults, so the page can offer to put
   everything back and skip writing a row that says nothing. Saved sections do
   not count: a member who named three sections and then put the sliders back
   has not finished with the song. */
export function isDefaultSettings(s: PlayerSettings): boolean {
  const d = DEFAULT_PLAYER_SETTINGS;
  return (
    s.speed === d.speed &&
    s.halfSteps === d.halfSteps &&
    s.balance === d.balance &&
    s.volume === d.volume &&
    s.loopA === d.loopA &&
    s.loopB === d.loopB &&
    s.looping === d.looping &&
    s.naturalVoice === d.naturalVoice &&
    s.leadQuieter === d.leadQuieter
  );
}

/* ---- Which song these settings belong to ---------------------------------
 *
 * The member's own file never leaves their device, so there is no id handed
 * down from anywhere. The file's name and its exact byte length together are
 * stable across devices for the same file, which is what makes the settings
 * follow a member from a laptop to a phone. Two different songs colliding would
 * need the same name AND the same byte count.
 */
export function songKey(fileName: string, byteSize: number): string {
  const name = fileName.trim().toLowerCase().replace(/\s+/g, ' ');
  return `${name}::${byteSize}`;
}

/* ---- Drag across the wave → a section (pure) ----------------------------- */

export type LoopRegion = { a: number; b: number };

/* Convert a horizontal pixel position within the wave to a time in seconds,
   clamped to the song. `x` and `width` are CSS pixels from the left edge. */
export function xToTime(x: number, width: number, duration: number): number {
  if (width <= 0 || duration <= 0) return 0;
  const frac = clamp(x / width, 0, 1);
  return frac * duration;
}

/* Given a drag from one time to another, produce an ordered section (a < b), or
   null when the drag was too short to count — which is treated as a tap to jump
   instead. `minSeconds` guards against an accidental twitch. */
export function dragToLoopRegion(
  startSec: number,
  endSec: number,
  minSeconds = 0.15,
): LoopRegion | null {
  const a = Math.min(startSec, endSec);
  const b = Math.max(startSec, endSec);
  if (b - a < minSeconds) return null;
  return { a, b };
}

/* True when a pointer travel (in CSS pixels) is small enough to read the
   gesture as a tap (jump) rather than a drag (set a section). */
export function isClickNotDrag(dxPixels: number, thresholdPixels = 4): boolean {
  return Math.abs(dxPixels) < thresholdPixels;
}

/* ---- Balance, not pan ----------------------------------------------------
 *
 * At the middle both sides play at full; sliding toward one side turns the
 * OTHER side down. So on a practice recording with one part on one side and the
 * rest on the other, sliding toward your part keeps it up while the others
 * fade. `b` in [-1, 1]: -1 = left only, +1 = right only. Linear, so a side at
 * full stays at full and the song does not get quieter in the middle.
 */
export function balanceGains(b: number): { left: number; right: number } {
  const clamped = Math.max(-1, Math.min(1, b));
  return { left: clamped <= 0 ? 1 : 1 - clamped, right: clamped >= 0 ? 1 : 1 + clamped };
}

/* ---- One-speaker output ("car audio fix") --------------------------------
 *
 * Some car and Bluetooth links (Android Auto playing browser audio, notably)
 * carry only ONE side of the player's output to every speaker. With the normal
 * graph that breaks the balance slider: the middle plays just the left side,
 * and sliding right fades into silence. Sending one finished mix to both sides
 * fixes it, because the balance is applied first and the result goes out
 * identically. The trade-off is no left/right separation while it is on, which
 * is why it is a switch rather than the default. One preference for the member,
 * not one per song: it describes their speakers.
 *
 * Summing two full-scale sides at unity would clip, so the sum node uses this.
 */
export const MONO_SUM_GAIN = 0.5;

/* ---- Turning the lead down ----------------------------------------------
 *
 * Anything recorded dead in the middle of a stereo mix is identical on both
 * sides, so subtracting one side from the other removes it. That takes the lead
 * with it — and the bass and the snare, which are usually in the middle too.
 * A lead that was not recorded dead centre only gets quieter.
 *
 * This is true of every product that offers it, and the member-facing wording
 * says "quieter", never "gone". Two full-scale sides subtracted at unity can
 * reach twice full scale, so the difference is halved for the same reason the
 * mono sum is.
 */
export const MIDDLE_CANCEL_GAIN = 0.5;
