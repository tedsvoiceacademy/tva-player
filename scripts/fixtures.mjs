/* The three songs that cannot be generated, handed to a check.
 *
 * Everything else here is made on the spot by make-test-song.mjs. These three are
 * committed because nothing available to this project can encode them — see
 * scripts/fixtures/README.md for the whole reason and the commands that made them.
 *
 * A FIXTURE IS CHECKED FOR BEING WHAT IT CLAIMS. A truncated download, a file
 * saved wrong, or a placeholder someone left behind would otherwise sail through
 * as coverage: the app would refuse to open it, the check would report "that file
 * would not open", and the format would still be untested while looking tested.
 * The installed-app harness already refuses to run a file that is not a program,
 * for the same reason and after the same kind of afternoon.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

/** Where the format's signature sits, and what it has to say. */
const FIXTURES = {
  'Take.m4a': { at: 4, magic: 'ftyp', what: 'an MP4 container, which is what an .m4a is' },
  'Take.flac': { at: 0, magic: 'fLaC', what: 'a FLAC stream' },
  /* Real music arrives with a tag on the front, and this one does too — the
     generated MP3s never had one. */
  'Variable.mp3': { at: 0, magic: 'ID3', what: 'an MP3 carrying an ID3 tag' },
};

export const FIXTURE_NAMES = Object.keys(FIXTURES);

/**
 * Copy a committed fixture into a run's own folder and hand back the path.
 * Throws, rather than returning something unusable, if it is not what it claims.
 */
export async function placeFixture(name, intoDir) {
  const spec = FIXTURES[name];
  if (!spec) throw new Error(`There is no fixture called ${name}.`);

  const bytes = await readFile(join(HERE, name));
  const found = bytes.subarray(spec.at, spec.at + spec.magic.length).toString('latin1');
  if (found !== spec.magic) {
    throw new Error(`scripts/fixtures/${name} is meant to be ${spec.what}, and it is not: `
      + `the bytes at ${spec.at} read ${JSON.stringify(found)} rather than `
      + `${JSON.stringify(spec.magic)}. It is damaged or was never the file it says.`);
  }

  const to = join(intoDir, name);
  await writeFile(to, bytes);
  return to;
}
