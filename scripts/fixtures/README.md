# The three songs that cannot be generated

Everything else this project tests with is made on the spot by
`scripts/make-test-song.mjs` — that is why `.gitignore` says no audio sits in git.
These three are the exception, and the reason is narrow: **nothing here can encode
them.** There is no ffmpeg, no sox, no flac and no Python audio module on a build
runner or in a session container, and the only package that would provide one
downloads about 80 MB of platform binary on `npm ci` — in all four CI jobs, on
every run, for three small files that never change.

So they were made once and committed. About a megabyte between them.

## Why they exist at all

The app tells a person it can play "an MP3, an M4A, a WAV or a FLAC" —
`mediaErrorText` in `apps/desktop/src/renderer/audio/player.js`. Until these
existed, **no check had ever opened an M4A or a FLAC**, and Ted said he has both.
A format that is offered and never tested is a format that gets found out by the
person using it.

`Variable.mp3` covers a third gap of the same shape: the LAME port used by
`makeMp3` is constant-bitrate only, and most real music is variable. It also
carries an ID3 tag on the front, which is how music actually arrives and which no
generated fixture had.

## What is in them

Twenty seconds, stereo, 44.1 kHz — 440 Hz on the left and 660 Hz on the right, the
same tones every other fixture in this project uses, so a check can tell the two
sides apart. Twenty seconds rather than four minutes on purpose: what these test is
whether a FORMAT decodes and reaches the speed engine. Length is a different
question and the four-minute MP3 already answers it.

## Making them again

A source WAV first, from this project's own generator:

    node -e "import('./scripts/make-test-song.mjs').then(m =>
      m.makeSong('source.wav', { seconds: 20, sampleRate: 44100, left: 440, right: 660 }))"

Then, with any ffmpeg (`npx --package ffmpeg-static -c 'ffmpeg ...'` works without
installing anything permanently):

    ffmpeg -y -i source.wav -c:a aac -b:a 128k                 Take.m4a
    ffmpeg -y -i source.wav -c:a flac -compression_level 12    Take.flac
    ffmpeg -y -i source.wav -c:a libmp3lame -q:a 4             Variable.mp3

`-q:a 4` is what makes the MP3 variable rather than constant.

`scripts/fixtures.mjs` copies these into a run's temporary folder and refuses to
hand over a file whose first bytes are not the format it claims to be — a
truncated or placeholder file must not pass as coverage.
