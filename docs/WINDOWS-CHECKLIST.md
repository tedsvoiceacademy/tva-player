# What only a real Windows machine can prove

The automatic checks run on every change and cover the maths, the audio graph
and the app being launched and driven. They cannot cover the registry, a real
microphone, or a real sound card. Work through this list once per release.

## The installer

1. Install on a computer that has never had it. Confirm the SmartScreen warning
   appears and that **More info → Run anyway** gets past it.
2. Confirm there is no administrator prompt — the install is per user.
3. Confirm **TVA Player** is in the Start menu.

## Double-clicking a song

4. With the app closed, double-click an MP3 in File Explorer. It opens and plays.
5. With the app already open, double-click another one. It opens in the same
   window rather than starting a second copy.
6. Select six songs, press Enter. **All six arrive**, not just the last one.
   This is the one that has broken before.

## Being the default

7. Open the default-apps panel in the app, click through to Windows Settings,
   choose TVA Player for MP3, come back. The tick beside MP3 appears.

## Sound

8. Choose a different output device and confirm the sound moves to it.
9. Play a stereo recording and confirm the balance control turns down the side
   it names, not the side it points at.

## Microphone — once recording is built

10. Open a real microphone and confirm `track.getSettings()` really reports
    `autoGainControl: false`. Browsers and interface drivers both quietly ignore
    that request, which is why the Ring Meter carries a warning for it.
11. Record for 45 minutes. Memory stays flat and the file opens afterwards.
12. Kill the app mid-recording. The file left behind still opens — the length is
    recovered from the file's own size.

## Updates

13. Install version N, publish N+1, confirm the notice appears and the new
    version is in place after closing the app.

## Media keys

14. Press play/pause while Chrome has the focus, then while Spotify does. If
    another app has claimed a key, the app says which one rather than doing
    nothing silently.
