/* What one song's file on disk contains, and how it is made safe to read.
 *
 * This replaces the Supabase row that netlify/functions/members-player-settings.cjs
 * writes on the members site. There is one person here, so the member_id half of
 * that table's key falls away and what is left is songKey() — the file's name and
 * its exact byte count, which is the same on his laptop as on his desktop without
 * either machine knowing the other's folder layout. That is the whole reason the
 * OneDrive folder in §6 works.
 *
 * EVERY READ GOES THROUGH sanitizeSongFile. The members version's comment says
 * its sanitiser runs on the way in from storage because storage is not trusted;
 * a file that OneDrive was halfway through syncing when the app opened it is
 * exactly the case it meant.
 */

import {
  type PlayerSettings,
  sanitizePlayerSettings,
  DEFAULT_PLAYER_SETTINGS,
} from './player-settings.js';
import { type SongNote, sanitizeNotes } from './notes.js';

export const SONG_FILE_VERSION = 1;

export type SongFile = {
  schemaVersion: number;
  songKey: string;
  songName: string;
  /** ISO 8601. Used to settle a OneDrive conflict copy, newest wins. */
  updatedAt: string;
  /** Which machine wrote it last, so a conflict notice can name one. */
  updatedBy: string;
  settings: PlayerSettings;
  /** Where he stopped, so the song reopens there. */
  lastPositionSec: number;
  notes: SongNote[];
  /** Measured once on first decode, for matching levels between tracks. */
  lufs: number | null;
  /** For the metronome. */
  bpm: number | null;
  countInBars: number;
};

export const MAX_KEY = 400;
export const MAX_NAME = 200;
export const MAX_MACHINE_NAME = 60;

function str(value: unknown, max: number, fallback = ''): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : fallback;
}

/* A measurement, or nothing. Out of range counts as nothing on purpose: a
   loudness of +99 dB is not a loudness to clamp, it is a reading to take again.
   Controls behave the other way — see clampTo. */
function finiteOrNull(value: unknown, lo: number, hi: number): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  if (value < lo || value > hi) return null;
  return value;
}

/* A control the player always has a value for. There is no "unknown" count-in,
   so an out-of-range one is pulled back to the nearest usable setting rather
   than thrown away, matching how speed and volume behave in player-settings. */
function clampTo(value: unknown, lo: number, hi: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(hi, Math.max(lo, value));
}

export function emptySongFile(songKey: string, songName: string, machine: string): SongFile {
  return {
    schemaVersion: SONG_FILE_VERSION,
    songKey: songKey.slice(0, MAX_KEY),
    songName: songName.slice(0, MAX_NAME),
    updatedAt: '1970-01-01T00:00:00.000Z',
    updatedBy: machine.slice(0, MAX_MACHINE_NAME),
    settings: { ...DEFAULT_PLAYER_SETTINGS, sections: [] },
    lastPositionSec: 0,
    notes: [],
    lufs: null,
    bpm: null,
    countInBars: 2,
  };
}

/* Coerce whatever was parsed out of a file into a valid SongFile. Anything
   unrecognised is dropped rather than carried, so a field written by a newer
   version cannot survive a round trip through an older one and re-appear
   half-formed. A file too broken to have a song key is rejected outright. */
export function sanitizeSongFile(raw: unknown, machineFallback = 'unknown'): SongFile | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const o = raw as Record<string, unknown>;

  const songKey = str(o.songKey, MAX_KEY);
  if (!songKey) return null;

  const base = emptySongFile(songKey, str(o.songName, MAX_NAME), machineFallback);

  return {
    schemaVersion: SONG_FILE_VERSION,
    songKey,
    songName: base.songName,
    updatedAt: isIsoDate(o.updatedAt) ? (o.updatedAt as string) : base.updatedAt,
    updatedBy: str(o.updatedBy, MAX_MACHINE_NAME, machineFallback),
    settings: sanitizePlayerSettings(o.settings),
    lastPositionSec: finiteOrNull(o.lastPositionSec, 0, 86400) ?? 0,
    notes: sanitizeNotes(o.notes),
    lufs: finiteOrNull(o.lufs, -70, 0),
    bpm: finiteOrNull(o.bpm, 20, 400),
    countInBars: Math.round(clampTo(o.countInBars, 0, 8, 2)),
  };
}

function isIsoDate(value: unknown): boolean {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

/* Settle two copies of the same song's settings — which is what a OneDrive
   conflict copy is. Whole-file last-write-wins, never field by field: one
   person editing on two machines in sequence does not need anything cleverer,
   and a merge that invents a state neither machine ever had is worse than
   losing the older of two edits, which is kept on disk anyway. */
export function newerOf(left: SongFile, right: SongFile): SongFile {
  return Date.parse(right.updatedAt) > Date.parse(left.updatedAt) ? right : left;
}

/* THE NAME OF A SONG'S OWN FILE, worked out the same way on every machine.
 *
 * A song key can hold anything a file name can, including characters Windows
 * will not put in a path, so the file is named after a hash of the key and the
 * key itself is stored inside the file. The Windows app has always done this in
 * its main process with Node's crypto; the phone has to arrive at the SAME name
 * or a song set up on the desktop opens on the phone with none of its loops.
 *
 * So it lives here, computed through the Web Crypto that both a browser and Node
 * carry, and the maths harness checks the two agree rather than assuming it.
 */
/* THE ONLY TWO THINGS THIS PACKAGE REACHES OUTSIDE ITSELF, declared here by
 * hand rather than by pulling in a types package.
 *
 * tsconfig says "types": [] on purpose: not even Node's globals are available,
 * so nothing in here can quietly reach the file system, the network or the DOM.
 * Naming these two keeps that true — they are the same two in a browser, in an
 * Android WebView and in Node, which is what lets one function give the same
 * answer on every machine. */
declare const TextEncoder: { new (): { encode(text: string): Uint8Array } };
declare const crypto: { subtle: { digest(algorithm: string, data: Uint8Array): Promise<ArrayBuffer> } };

export async function songFileName(songKey: string): Promise<string> {
  const bytes = new TextEncoder().encode(songKey);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  let hex = '';
  for (const byte of new Uint8Array(digest)) hex += byte.toString(16).padStart(2, '0');
  return `${hex.slice(0, 32)}.json`;
}
