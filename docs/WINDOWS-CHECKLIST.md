# What only a real Windows machine can prove

The automatic checks run on every change. On a Windows runner they now build
the installer, RUN it, and drive the app as installed: the page served out of
the package, an MP3 named on the command line opening and playing, the library,
the speed and key engine, a recording that comes back at the pitch that went in,
the tuner, all four media keys, and asking Windows for the computer's own sound.

What they still cannot cover is the registry as a person changes it, a real
microphone, a real sound card, and anything that takes longer than a build.
Work through this list once per release.

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

## Microphone

10. Open a real microphone and confirm `track.getSettings()` really reports
    `autoGainControl: false`. Browsers and interface drivers both quietly ignore
    that request, which is why the Ring Meter carries a warning for it.
11. Record for 45 minutes. Memory stays flat and the file opens afterwards.
12. Kill the app mid-recording. The file left behind still opens — the length is
    recovered from the file's own size.

## The interface's own microphone inputs — THE ONE THING CI CANNOT DO

No build runner has an audio interface, and Chromium cannot make a
MediaStream with more than two channels inside a page. So everything DOWNSTREAM
of getUserMedia is checked — four channels are fed straight into the recorder
and come out as four correctly-named files — but what Windows actually hands
over for a real interface can only be found out here.

13. Plug in the Clarett 4Pre. Turn the microphone on and read the line in
    **Set-up**: how many inputs did Windows give? Four is the hoped-for answer;
    two would mean the driver only offers a pair, which is a fact about the
    driver rather than a fault in the app.
14. Record with two microphones plugged into different inputs and confirm each
    file holds the microphone its name says, not the same one twice.
15. Do the same with the Zoom interface, and with the laptop's built-in
    microphone, which should report one input.
16. Untick an input with nothing plugged into it, record, and confirm no file is
    written for it.
17. Turn one microphone up inside the app while singing into it and confirm the
    bar and the live lane both move with it — and that the noise floor comes up
    too, which is the honest cost and is worth hearing once.

## Saving a take out

18. Save a 45-minute take as an MP3. The per-cent on the button climbs from the
    first second, the window keeps painting throughout, and memory stays flat —
    the slice-by-slice path is exactly what CI cannot prove at that length.
19. Save the same take with the song. This is the one that still decodes both
    files whole, so it is where memory would run out if anywhere does.
20. Play a saved MP3 in Windows Media Player and in whatever a student would
    use on a phone. A file only this app can open is no use to anybody.
21. Cancel the Save box, and pull a USB drive out mid-save. Neither leaves a
    part-written file behind.

## On the phone — THE THINGS NO CHECK CAN REACH

No build runner has Android's document picker, a Drive account, or a phone's
audio hardware. Everything above those is checked at 390 pixels on every build;
these are what is left.

22. Open a song from **phone storage**, from **OneDrive**, and from **each Google
   Drive account**. All three should look identical to the app.
23. Play a 45-minute file straight from Drive and seek about in it. This is the
   one that tests range requests over a real connection rather than a local disk.
24. **Add a folder.** Note which providers offer one — local storage should, and
   Google Drive is expected not to offer it at all.
25. Record a take on the phone's own microphone and play it back.
26. Save a take as an MP3 to Drive, and open it on the computer.
27. Turn the screen off while a song plays. A page loses its audio when Android
   sleeps unless something holds it awake, and nothing does yet — so this is
   expected to stop, and the fix belongs with the Android Auto work.
28. Rotate the phone. The case should stay whole.

## Updates

29. Install version N, publish N+1, confirm the notice appears and the new
    version is in place after closing the app.

## Media keys

30. Press play/pause while Chrome has the focus, then while Spotify does. If
    another app has claimed a key, the app says which one rather than doing
    nothing silently.
