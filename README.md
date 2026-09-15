# TVA Player

A Windows audio player and practice recorder for Ted's Voice Academy.

It is an ordinary media player — double-click a song in File Explorer and it
opens — with the practice controls from the members site built in: slow a song
down without changing its key, move the key without changing the speed, turn one
side of a mix down, turn the lead down, and mark, name and repeat a part of a
song.

**Installing it: see [docs/TED-README.md](docs/TED-README.md).**

## How it is put together

| Folder | What is in it |
|---|---|
| `packages/practice-core` | The maths and the data model. Imports nothing — not Node, not the DOM — so all of it runs under `scripts/player-harness.mjs` with no browser. |
| `apps/desktop/src/main` | The window, the files, the registry, the updates. **No audio happens here.** |
| `apps/desktop/src/preload` | The only way the page can reach the rest of the computer, one named function at a time. |
| `apps/desktop/src/renderer` | The audio graph and the interface. It has no file system at all. |
| `scripts` | The checks, and the build. |

Three rules hold the rest together:

1. **`practice-core` imports nothing.** Its `tsconfig.json` sets `"types": []`,
   so even Node's own globals are unavailable there. That is what makes the
   headless checks mean something.
2. **One AudioContext, for the life of the app.** See the comment at the top of
   `apps/desktop/src/renderer/audio/context.js` for the three reasons.
3. **No native modules ship inside the app.** `npm run test:no-native` fails the
   build if one appears, because every one of them is a rebuild on every
   Electron version bump and there is nobody to do it.

## Running the checks

```
npm install
npm run test            # the maths, and proof those checks can fail
npm run test:no-native
npm run build:code -w @tva/desktop
xvfb-run -a node scripts/app-harness.mjs                     # the app, driven
xvfb-run -a node scripts/app-harness.mjs --negative-control  # and proof it can fail
```

Every harness here carries a negative control that deliberately breaks something
and expects checks to go red. A harness that cannot fail is not evidence.

`docs/WINDOWS-CHECKLIST.md` covers what only a real Windows machine can prove.

## Where the engine came from

The practice engine is ported from the members site's song player
(`src/pages/members/song-player.astro`), which was itself ported from the chorus
app's Practice Studio. Each port has kept the same property: the maths stays
pure, so it can be checked without a browser. The files that came across say so
at the top, and say what changed.

Speed, key and formants are `signalsmith-stretch`, which is the one runtime
dependency the audio needs. It carries its own WASM and worklet, so the app
fetches nothing from anywhere.
