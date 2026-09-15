/* Notes pinned to a moment in a song, and the markers that jump there.
 *
 * Ted asked for these in the first version: "breath here", "watch the vowel",
 * dropped at a spot and clicked later to jump straight back to it. They are
 * kept apart from loop sections on purpose — a section is a stretch of time he
 * repeats, a note is a single moment he wants to be reminded of.
 */

export type SongNote = {
  /** Where it sits, in seconds from the start of the song. */
  atSec: number;
  /** What he wrote. */
  text: string;
};

export const MAX_NOTES = 200;
export const MAX_NOTE_TEXT = 120;

export function sanitizeNotes(raw: unknown): SongNote[] {
  if (!Array.isArray(raw)) return [];
  const out: SongNote[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const o = item as Record<string, unknown>;
    const atSec =
      typeof o.atSec === 'number' && Number.isFinite(o.atSec) && o.atSec >= 0 ? o.atSec : null;
    if (atSec === null) continue;
    const text = typeof o.text === 'string' ? o.text.trim().slice(0, MAX_NOTE_TEXT) : '';
    if (!text) continue;
    out.push({ atSec, text });
    if (out.length >= MAX_NOTES) break;
  }
  return sortNotes(out);
}

/** Time order, so the list reads down the song the way the song plays. */
export function sortNotes(notes: readonly SongNote[]): SongNote[] {
  return [...notes].sort((x, y) => x.atSec - y.atSec);
}

export function addNote(
  notes: readonly SongNote[],
  atSec: number,
  text: string,
): SongNote[] | null {
  if (!Number.isFinite(atSec) || atSec < 0) return null;
  const clean = text.trim().slice(0, MAX_NOTE_TEXT);
  if (!clean) return null;
  if (notes.length >= MAX_NOTES) return null;
  return sortNotes([...notes, { atSec, text: clean }]);
}

/** The note the playhead has most recently passed, or null before the first. */
export function noteAt(notes: readonly SongNote[], seconds: number): SongNote | null {
  let found: SongNote | null = null;
  for (const n of sortNotes(notes)) {
    if (n.atSec <= seconds) found = n;
    else break;
  }
  return found;
}
