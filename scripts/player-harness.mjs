/* The player's maths, checked without a browser, a speaker or a file.
 *
 * PORTED from the members site's scripts/members-player-harness.mjs, which says
 * of itself why it exists: clamping a stored value to a range, turning a drag
 * into a section and working out the two balance gains are all pure functions,
 * and all of them are the kind of thing that breaks quietly. A speed of 40 read
 * back out of a corrupt file would not throw; it would play the song at a speed
 * the engine was never meant to run.
 *
 * The desktop app adds four things the website never needed, and they are
 * checked here for the same reason: parsing the argument list Windows hands over
 * when a song is double-clicked, reading a typed loop time, notes pinned to a
 * moment, and the WAV header a recording is written into.
 *
 * Run: node scripts/player-harness.mjs
 *      node scripts/player-harness.mjs --negative-control
 *
 * The negative control compiles the same module with its clamp removed and
 * expects the range checks to go RED. A harness that cannot fail is not
 * evidence, and this project's sibling has shipped one before: a fake honoured
 * an on_conflict against any column at all, stayed green for weeks, and hid an
 * outage that threw on every grant.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const SRC = join(ROOT, 'packages/practice-core/src');
const NEGATIVE = process.argv.includes('--negative-control');

const results = [];
function check(name, passed, detail) {
  results.push({ name, passed });
  console.log(`${passed ? 'ok  ' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

/* The modules are TypeScript and this runs under plain node, so they are
   compiled in memory. Imports between them are rewritten to the same scheme so
   store-schema can pull in player-settings without a bundler. */
const compiled = new Map();
let clampBroken = 0;
async function load(name, { breakClamp = false } = {}) {
  const cacheKey = `${name}:${breakClamp}`;
  if (compiled.has(cacheKey)) return compiled.get(cacheKey);

  let src = readFileSync(join(SRC, `${name}.ts`), 'utf8');
  if (breakClamp) {
    /* Remove the clamp itself, not a caller, so every range check loses its
       guard. Only player-settings.ts has one; the others are pulled in as
       dependencies and pass through untouched. */
    const before = src;
    src = src.replace('return Math.min(hi, Math.max(lo, n));', 'return n;');
    if (src !== before) clampBroken++;
  }

  // Resolve relative imports by inlining each dependency as its own data: module.
  const deps = [...src.matchAll(/from '\.\/([a-z-]+)\.js'/g)].map((m) => m[1]);
  for (const dep of deps) {
    const mod = await load(dep, { breakClamp });
    src = src.replaceAll(`from './${dep}.js'`, `from '${mod.__url}'`);
  }

  const js = esbuild.transformSync(src, { loader: 'ts', format: 'esm' }).code;
  const url = `data:text/javascript;base64,${Buffer.from(js).toString('base64')}`;
  const mod = { ...(await import(url)), __url: url };
  compiled.set(cacheKey, mod);
  return mod;
}

const P = await load('player-settings', { breakClamp: NEGATIVE });
if (NEGATIVE && clampBroken === 0) {
  console.error('Negative control could not be applied — has clamp() in player-settings.ts changed?');
  process.exit(1);
}
const A = await load('argv');
const L = await load('loop-editing');
const N = await load('notes');
const S = await load('store-schema', { breakClamp: NEGATIVE });
const W = await load('wav');

console.log('--- what a stored song file is allowed to say ---');
{
  const d = P.sanitizePlayerSettings(null);
  check('junk becomes the defaults',
    d.speed === 1 && d.halfSteps === 0 && d.balance === 0 && d.volume === 1,
    'a file that cannot be read must not reach the audio graph');
  check('no section comes back from junk', Array.isArray(d.sections) && d.sections.length === 0);
  check('voices sound natural unless that was turned off', d.naturalVoice === true);
  check('the lead is left alone unless it was asked for', d.leadQuieter === false);

  const fast = P.sanitizePlayerSettings({ speed: 40 });
  check('a speed out of range is pulled back in', fast.speed === 1.2,
    `got ${fast.speed}; the engine is only asked for 0.5 to 1.2`);
  const slow = P.sanitizePlayerSettings({ speed: 0.01 });
  check('and so is a speed below the range', slow.speed === 0.5, `got ${slow.speed}`);

  const high = P.sanitizePlayerSettings({ halfSteps: 40 });
  check('a key shift out of range is pulled back in', high.halfSteps === 6, `got ${high.halfSteps}`);
  const fraction = P.sanitizePlayerSettings({ halfSteps: 2.6 });
  check('and a part-step lands on a whole one', fraction.halfSteps === 3, `got ${fraction.halfSteps}`);

  const hardLeft = P.sanitizePlayerSettings({ balance: -9 });
  check('balance stays between the two sides', hardLeft.balance === -1, `got ${hardLeft.balance}`);
  const loud = P.sanitizePlayerSettings({ volume: 8 });
  check('volume stays between silent and full', loud.volume === 1, `got ${loud.volume}`);

  const notNumbers = P.sanitizePlayerSettings({ speed: 'fast', volume: null, balance: NaN });
  check('a value that is not a number falls back rather than poisoning the graph',
    notNumbers.speed === 1 && notNumbers.volume === 1 && notNumbers.balance === 0);
}

console.log('\n--- a marked part has to make sense ---');
{
  const backwards = P.sanitizePlayerSettings({ loopA: 30, loopB: 10, looping: true });
  check('an end before its start is dropped, not stored',
    backwards.loopA === null && backwards.loopB === null && backwards.looping === false);

  const halfMarked = P.sanitizePlayerSettings({ loopA: 10, looping: true });
  check('looping cannot be on with only half a part marked', halfMarked.looping === false);

  const good = P.sanitizePlayerSettings({ loopA: 10, loopB: 30, looping: true });
  check('a real part survives', good.loopA === 10 && good.loopB === 30 && good.looping === true);
}

console.log('\n--- the parts he named ---');
{
  const secs = P.sanitizeSections([
    { name: 'the bridge', a: 10, b: 20 },
    { name: '', a: 1, b: 2 },
    { name: 'backwards', a: 20, b: 10 },
    { name: 'no times' },
    'not an object',
  ]);
  check('only the one that makes sense is kept', secs.length === 1 && secs[0].name === 'the bridge',
    `kept ${secs.length}`);

  const long = P.sanitizeSections([{ name: 'x'.repeat(200), a: 0, b: 1 }]);
  check('a very long name is cut to the limit', long[0].name.length === P.MAX_SECTION_NAME,
    `${long[0].name.length} characters`);

  const many = P.sanitizeSections(
    Array.from({ length: 400 }, (_, i) => ({ name: `part ${i}`, a: i, b: i + 1 })));
  check('a corrupt file cannot load an endless list',
    many.length === P.MAX_SECTIONS, `${many.length} kept`);
  check('the desktop list is longer than the phone one',
    P.MAX_SECTIONS > 12,
    'the members cap of 12 exists because a phone list stops being scannable');

  const withSections = { ...P.DEFAULT_PLAYER_SETTINGS, sections: [{ name: 'a', a: 0, b: 1 }] };
  check('named parts do not count as "back to normal"',
    P.isDefaultSettings(withSections) === true,
    'naming three parts and putting the sliders back is not finishing with the song');
}

console.log('\n--- which song a settings file belongs to ---');
{
  const a = P.songKey('My Song.mp3', 4096);
  check('the same file gives the same answer on the other machine',
    P.songKey('  MY SONG.mp3 ', 4096) === a,
    'this is what makes a laptop set-up show up on the desktop, with no paths shared');
  check('a different file does not collide',
    P.songKey('My Song.mp3', 4097) !== a, 'the byte count is part of it');
  check('two spaces read as one', P.songKey('my   song.mp3', 4096) === a);
}

console.log('\n--- drag across the wave ---');
{
  check('the left edge is the start', P.xToTime(0, 200, 60) === 0);
  check('the right edge is the end', P.xToTime(200, 200, 60) === 60);
  check('halfway is halfway', P.xToTime(100, 200, 60) === 30);
  check('a drag past the edge stays inside the song', P.xToTime(900, 200, 60) === 60);
  check('a song with no length cannot divide by zero', P.xToTime(50, 200, 0) === 0);

  check('a drag becomes a part in the right order',
    JSON.stringify(P.dragToLoopRegion(30, 10)) === JSON.stringify({ a: 10, b: 30 }),
    'dragging right to left has to work too');
  check('a twitch is not a part', P.dragToLoopRegion(10, 10.05) === null,
    'it is read as a tap to jump instead');
  check('a tap is a tap', P.isClickNotDrag(2) === true);
  check('and a drag is a drag', P.isClickNotDrag(40) === false);
}

console.log('\n--- the two sides ---');
{
  const middle = P.balanceGains(0);
  check('in the middle both sides play at full', middle.left === 1 && middle.right === 1,
    'so moving the slider back does not leave the song quieter than it started');
  const right = P.balanceGains(1);
  check('all the way right silences the left', right.left === 0 && right.right === 1);
  const left = P.balanceGains(-1);
  check('all the way left silences the right', left.left === 1 && left.right === 0);
  const part = P.balanceGains(0.5);
  check('halfway turns the other side half down', part.left === 0.5 && part.right === 1);
  check('a value past the end is held at the end',
    P.balanceGains(9).left === 0 && P.balanceGains(-9).right === 0);

  check('mixing both sides into one cannot clip', P.MONO_SUM_GAIN === 0.5,
    'two full-scale sides added at full would be twice full scale');
  check('taking the middle out cannot clip either', P.MIDDLE_CANCEL_GAIN === 0.5,
    'one side subtracted from the other has the same range');
}

console.log('\n--- double-clicking a song in File Explorer ---');
{
  check('a packaged launch finds the song',
    JSON.stringify(A.filterAudioArgs(['C:\\TVA Player.exe', 'C:\\Music\\song.mp3']))
      === JSON.stringify(['C:\\Music\\song.mp3']));
  check('a launch from source finds it too',
    JSON.stringify(A.filterAudioArgs(['electron.exe', '.', 'C:\\Music\\song.mp3']))
      === JSON.stringify(['C:\\Music\\song.mp3']),
    'taking argv[2] works all through development and opens nothing once installed');
  check('switches are not mistaken for songs',
    A.filterAudioArgs(['app.exe', '--inspect', '--no-sandbox', '--task=record']).length === 0);
  check('a path with spaces arrives whole',
    A.filterAudioArgs(['app.exe', 'C:\\My Music\\a song.mp3'])[0] === 'C:\\My Music\\a song.mp3');
  check('a network path opens',
    A.filterAudioArgs(['app.exe', '\\\\NAS\\music\\take.wav']).length === 1);
  check('a document is not a song',
    A.filterAudioArgs(['app.exe', 'C:\\notes.txt', 'C:\\a.mp3']).length === 1);
  check('every extension the installer registers is one the app will open',
    A.AUDIO_EXTENSIONS.every((e) => A.isAudioPath(`x.${e}`)),
    'the installer and the filter read the same list so they cannot drift apart');
  check('the extension is read whatever the case', A.isAudioPath('SONG.MP3') === true);
  check('a bare name with no extension is not a song', A.isAudioPath('song') === false);

  check('a jump list task is picked out', A.taskFromArgs(['app.exe', '--task=record']) === 'record');
  check('and no task means no task', A.taskFromArgs(['app.exe', 'a.mp3']) === null);

  /* Selecting six files in Explorer launches six copies of the app in quick
     succession. Handled one at a time, each replaces the last and only the
     sixth plays. */
  const burst = new A.BurstCollector(250);
  burst.add(['a.mp3'], 1000);
  burst.add(['b.mp3'], 1040);
  burst.add(['c.mp3'], 1090);
  check('a burst is not read while it is still arriving', burst.flush(1100) === null);
  const gathered = burst.flush(1400);
  check('the whole selection plays, not just the last file',
    JSON.stringify(gathered) === JSON.stringify(['a.mp3', 'b.mp3', 'c.mp3']),
    `got ${JSON.stringify(gathered)}`);
  check('and the collector empties after handing over', burst.flush(2000) === null);
}

console.log('\n--- typing a loop time ---');
{
  check('plain seconds', L.parseTime('83.5') === 83.5);
  check('minutes and seconds', L.parseTime('1:23') === 83);
  check('with tenths', Math.abs(L.parseTime('1:23.5') - 83.5) < 1e-9);
  check('the leading-colon shorthand', L.parseTime(':45') === 45);
  check('spaces around it are fine', L.parseTime('  1:23  ') === 83);
  check('sixty-one seconds is not a time', L.parseTime('1:61') === null,
    'refusing is right — jumping silently to zero is not');
  check('words are not a time', L.parseTime('the bridge') === null);
  check('an empty box is not a time', L.parseTime('') === null);

  check('the clock prints m:ss', L.formatTime(83) === '1:23');
  check('and pads the seconds', L.formatTime(65) === '1:05');
  check('and tenths when asked', L.formatTime(83.5, true) === '1:23.5');
  check('a time before the start prints as zero', L.formatTime(-5) === '0:00');

  const loop = { a: 10, b: 30 };
  check('an end typed past the song is held at the song\'s end',
    L.applyLoopEdit(loop, 'b', 999, 60).b === 60);
  check('a start typed past the end is refused, not swapped',
    L.applyLoopEdit(loop, 'a', 40, 60) === null,
    'a person watching the numbers should see what they asked for, or see nothing happen');
  check('a nudge moves one end', L.nudgeLoop(loop, 'a', -2, 60).a === 8);
  check('a nudge that would collapse the loop is refused',
    L.nudgeLoop({ a: 10, b: 10.2 }, 'a', 0.2, 60) === null);
}

console.log('\n--- notes pinned to a moment ---');
{
  const one = N.addNote([], 42, '  breath here  ');
  check('a note is kept with its time', one.length === 1 && one[0].atSec === 42);
  check('and trimmed', one[0].text === 'breath here');
  check('an empty note is refused', N.addNote([], 42, '   ') === null);
  check('a note before the start is refused', N.addNote([], -1, 'x') === null);

  const sorted = N.sortNotes([{ atSec: 30, text: 'c' }, { atSec: 10, text: 'a' }]);
  check('the list reads down the song', sorted[0].text === 'a' && sorted[1].text === 'c');

  const notes = [{ atSec: 10, text: 'a' }, { atSec: 30, text: 'b' }];
  check('the playhead finds the note it has passed', N.noteAt(notes, 20).text === 'a');
  check('and finds none before the first', N.noteAt(notes, 5) === null);

  const dirty = N.sanitizeNotes([
    { atSec: 5, text: 'good' }, { atSec: 'x', text: 'bad time' },
    { atSec: 1, text: '' }, 'not an object', null,
  ]);
  check('only a note that makes sense survives a file',
    dirty.length === 1 && dirty[0].text === 'good');
  check('a very long note is cut to the limit',
    N.sanitizeNotes([{ atSec: 0, text: 'x'.repeat(500) }])[0].text.length === N.MAX_NOTE_TEXT);
}

console.log('\n--- what a song file on disk may hold ---');
{
  const machine = 'ted-laptop';
  const empty = S.emptySongFile('song.mp3::4096', 'Song.mp3', machine);
  check('a new song file starts at the defaults',
    empty.settings.speed === 1 && empty.notes.length === 0 && empty.lastPositionSec === 0);

  const file = S.sanitizeSongFile({
    schemaVersion: 1, songKey: 'song.mp3::4096', songName: 'Song.mp3',
    updatedAt: '2026-09-15T10:00:00.000Z', updatedBy: machine,
    settings: { speed: 0.75, halfSteps: 3, sections: [{ name: 'the bridge', a: 12, b: 44 }] },
    lastPositionSec: 83.5, notes: [{ atSec: 42, text: 'breath here' }],
    lufs: -14.2, bpm: 132, countInBars: 2,
    somethingElse: 'should not be kept',
  }, machine);
  check('every real field survives the trip',
    file.settings.speed === 0.75 && file.settings.halfSteps === 3
      && file.settings.sections.length === 1 && file.lastPositionSec === 83.5
      && file.notes.length === 1 && file.lufs === -14.2 && file.bpm === 132);
  check('a field the player does not know is dropped', !('somethingElse' in file),
    'a field written by a newer version must not survive a round trip through an older one');

  check('a file with no song key is rejected outright',
    S.sanitizeSongFile({ settings: {} }) === null);
  check('and so is something that is not an object', S.sanitizeSongFile('nonsense') === null);

  const outOfRange = S.sanitizeSongFile({
    songKey: 'k', lufs: 99, bpm: 5000, countInBars: 99, lastPositionSec: -4,
  }, machine);
  check('a measurement out of range is dropped rather than believed',
    outOfRange.lufs === null && outOfRange.bpm === null);
  check('a count-in is pulled back to something playable', outOfRange.countInBars === 8,
    `got ${outOfRange.countInBars}`);
  check('a position before the start becomes the start', outOfRange.lastPositionSec === 0);

  const longKey = S.sanitizeSongFile({ songKey: 'k'.repeat(5000) }, machine);
  check('an absurd key is cut to the limit', longKey.songKey.length === S.MAX_KEY);

  /* The two halves have to agree. If the store keeps something the player then
     changes, the settings would quietly drift on every single save. */
  const round = P.sanitizePlayerSettings(file.settings);
  check('what the store keeps, the player accepts unchanged',
    round.speed === file.settings.speed && round.halfSteps === file.settings.halfSteps
      && round.balance === file.settings.balance && round.volume === file.settings.volume
      && round.sections.length === file.settings.sections.length
      && round.sections[0].name === 'the bridge');

  const older = { ...file, updatedAt: '2026-09-14T10:00:00.000Z' };
  const newer = { ...file, updatedAt: '2026-09-15T10:00:00.000Z' };
  check('a OneDrive conflict is settled by which was written last',
    S.newerOf(older, newer).updatedAt === newer.updatedAt
      && S.newerOf(newer, older).updatedAt === newer.updatedAt);
}

console.log('\n--- the file a recording is written into ---');
{
  const header = W.wavHeader(48000, 2, 0);
  check('the header is the length every WAV reader expects',
    header.length === W.WAV_HEADER_BYTES);
  check('and reads as a WAV', W.looksLikeWav(header) === true);
  check('random bytes do not', W.looksLikeWav(new Uint8Array(44)) === false);

  const view = new DataView(W.patchWavHeaderSizes(header, 96000).buffer);
  check('the length is written in when the recording stops',
    view.getUint32(40, true) === 96000 && view.getUint32(4, true) === 96036);

  const stereoView = new DataView(W.wavHeader(48000, 2).buffer);
  check('a stereo recording says so', stereoView.getUint16(22, true) === 2);
  check('and gets the byte rate right', stereoView.getUint32(28, true) === 48000 * 4);

  check('a killed recording can be repaired from the file size alone',
    W.dataBytesForFileSize(W.WAV_HEADER_BYTES + 96000, 2) === 96000,
    'so an app closed mid-lesson never loses the lesson');
  check('and half a frame on the end is dropped rather than written',
    W.dataBytesForFileSize(W.WAV_HEADER_BYTES + 96003, 2) === 96000);
  check('a file shorter than its own header is not negative',
    W.dataBytesForFileSize(10, 2) === 0);

  const loud = W.floatToInt16(new Float32Array([0, 1, -1, 9, -9, 0.5]));
  check('full scale is full scale', loud[1] === 32767 && loud[2] === -32768);
  check('a sample past full scale is clamped, not wrapped', loud[3] === 32767 && loud[4] === -32768,
    'wrapping would turn a loud note into a burst of noise');

  const laced = W.interleave([new Float32Array([1, 3]), new Float32Array([2, 4])]);
  check('two channels lace into one stream',
    JSON.stringify([...laced]) === JSON.stringify([1, 2, 3, 4]));
  check('one channel passes straight through',
    W.interleave([new Float32Array([1, 2])]).length === 2);
}

const failed = results.filter((r) => !r.passed);
console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
if (NEGATIVE) {
  const wanted = failed.length > 0;
  console.log(wanted
    ? `\nNegative control worked: ${failed.length} check(s) went red with the clamp removed.`
    : '\nNegative control FAILED: every check passed with the clamp removed, so they prove nothing.');
  process.exit(wanted ? 0 : 1);
}
process.exit(failed.length ? 1 : 0);
