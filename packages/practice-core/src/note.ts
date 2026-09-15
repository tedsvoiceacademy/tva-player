/* Turning a frequency into a note a singer would recognise.
 *
 * The tuner reads a pitch off the microphone and has to say something useful
 * about it. "247.1 Hz" is not useful; "B3, 8 cents sharp" is. A cent is a
 * hundredth of a half step, and about five of them is the smallest difference
 * most people hear on a sustained note.
 */

const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const;

/** Concert A. Everything else is measured from here. */
export const A4_HZ = 440;

export type NoteReading = {
  /** "B3" — the note this pitch is closest to. */
  name: string;
  /** How far from that note, in cents. Negative is flat, positive is sharp. */
  cents: number;
  /** The exact frequency that note would be at. */
  exactHz: number;
};

export function noteFromHz(hz: number, a4 = A4_HZ): NoteReading | null {
  if (!Number.isFinite(hz) || hz <= 0) return null;

  // Half steps away from A4, which is MIDI note 69.
  const stepsFromA4 = 12 * Math.log2(hz / a4);
  const midi = Math.round(stepsFromA4) + 69;
  if (midi < 12 || midi > 120) return null;      // outside anything a voice does

  const exactHz = a4 * Math.pow(2, (midi - 69) / 12);
  const cents = Math.round(1200 * Math.log2(hz / exactHz));
  const name = `${NAMES[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`;
  return { name, cents, exactHz };
}

/** How a reading should be said out loud. */
export function tuningLabel(reading: NoteReading | null): string {
  if (!reading) return '—';
  const { name, cents } = reading;
  if (Math.abs(cents) <= 5) return `${name}, in tune`;
  return `${name}, ${Math.abs(cents)} cents ${cents > 0 ? 'sharp' : 'flat'}`;
}
