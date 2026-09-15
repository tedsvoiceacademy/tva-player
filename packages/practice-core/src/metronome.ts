/* The click, worked out ahead of time.
 *
 * Web Audio schedules a sound at an exact moment in the future, and the only
 * reliable way to keep a click steady is to work out those moments in advance
 * and hand them over early — a timer that fires on the beat drifts, because the
 * browser is free to be late. So this does the arithmetic and nothing else, and
 * the part that makes the noise just plays what it is given.
 */

export const MIN_BPM = 30;
export const MAX_BPM = 260;
export const MAX_COUNT_IN_BARS = 8;

export type Beat = {
  /** Seconds from the moment the click was started. */
  atSec: number;
  /** True on the first beat of a bar, which is clicked higher. */
  downbeat: boolean;
  /** True while the count-in is still running, before the song comes in. */
  countIn: boolean;
};

export function secondsPerBeat(bpm: number): number {
  const safe = Math.min(MAX_BPM, Math.max(MIN_BPM, bpm));
  return 60 / safe;
}

/* Every beat from now until `seconds` from now, with the count-in in front.
 * The count-in beats come BEFORE zero in the sense that the song starts once
 * they are done, so the song's own start is returned alongside them. */
export function beatsFor(
  { bpm, beatsPerBar = 4, countInBars = 0, seconds }:
  { bpm: number; beatsPerBar?: number; countInBars?: number; seconds: number },
): { beats: Beat[]; songStartsAtSec: number } {
  const spb = secondsPerBeat(bpm);
  const bar = Math.max(1, Math.round(beatsPerBar));
  const countBeats = Math.max(0, Math.min(MAX_COUNT_IN_BARS, Math.round(countInBars))) * bar;
  const songStartsAtSec = countBeats * spb;

  const beats: Beat[] = [];
  const total = Math.max(0, seconds);
  for (let i = 0; ; i++) {
    const atSec = i * spb;
    if (atSec > songStartsAtSec + total) break;
    beats.push({
      atSec,
      downbeat: i % bar === 0,
      countIn: i < countBeats,
    });
    if (beats.length > 20000) break;          // a guard, not a limit anyone meets
  }
  return { beats, songStartsAtSec };
}

/** What a count-in should say on screen while it runs. */
export function countInLabel(beatsLeft: number, beatsPerBar = 4): string {
  if (beatsLeft <= 0) return '';
  const inBar = ((beatsLeft - 1) % beatsPerBar) + 1;
  return String(inBar);
}
