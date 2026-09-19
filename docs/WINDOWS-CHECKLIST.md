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

## Speed and key, on a song of a real length

These go at the top of a release now, because all three of the faults they cover
shipped with every check green. They need a **real song, three minutes or more** —
the one that mattered most does not reproduce on a short file at all.

8. Open a three-minute song, press play, then turn the Speed dial to about 90%.
   The sound carries on without a gap and is audibly slower.
9. Close the app. Open it again. Open that same song — it comes back with 90% on
   it — and **press play immediately**, without waiting for the dial to settle.
   It plays. This is the one that gave no sound and no message at all.
10. While a song is opening with a speed saved on it, open a different song
    before the first has finished. The second one plays, and the clock shows the
    second one's length rather than the first one's.

## Sound

11. Choose a different output device and confirm the sound moves to it. Close the
    app, open it again, and confirm it is still using that device — it used to
    go quietly back to whatever Windows is set to.
12. Play a stereo recording and confirm the balance control turns down the side
   it names, not the side it points at.

## Microphone

13. Open a real microphone and confirm `track.getSettings()` really reports
    `autoGainControl: false`. Browsers and interface drivers both quietly ignore
    that request, which is why the Ring Meter carries a warning for it.
14. Record for 45 minutes. Memory stays flat and the file opens afterwards.
15. Kill the app mid-recording. The file left behind still opens — the length is
    recovered from the file's own size.

## The interface's own microphone inputs — THE ONE THING CI CANNOT DO

No build runner has an audio interface, and Chromium cannot make a
MediaStream with more than two channels inside a page. So everything DOWNSTREAM
of getUserMedia is checked — four channels are fed straight into the recorder
and come out as four correctly-named files — but what Windows actually hands
over for a real interface can only be found out here.

16. Plug in the Clarett 4Pre. Turn the microphone on and read the line in
    **Set-up**: how many inputs did Windows give? Four is the hoped-for answer;
    two would mean the driver only offers a pair, which is a fact about the
    driver rather than a fault in the app.
17. Record with two microphones plugged into different inputs and confirm each
    file holds the microphone its name says, not the same one twice.
18. Do the same with the Zoom interface, and with the laptop's built-in
    microphone, which should report one input.
19. Untick an input with nothing plugged into it, record, and confirm no file is
    written for it.
20. Turn one microphone up inside the app while singing into it and confirm the
    bar and the live lane both move with it — and that the noise floor comes up
    too, which is the honest cost and is worth hearing once.

## Saving a take out

21. Save a 45-minute take as an MP3. The per-cent on the button climbs from the
    first second, the window keeps painting throughout, and memory stays flat —
    the slice-by-slice path is exactly what CI cannot prove at that length.
22. Save the same take with the song. This is the one that still decodes both
    files whole, so it is where memory would run out if anywhere does.
23. Play a saved MP3 in Windows Media Player and in whatever a student would
    use on a phone. A file only this app can open is no use to anybody.
24. Cancel the Save box, and pull a USB drive out mid-save. Neither leaves a
    part-written file behind.

## On the phone — THE THINGS NO CHECK CAN REACH

No build runner has Android's document picker, a Drive account, or a phone's
audio hardware. Everything above those is checked at 390 pixels on every build;
these are what is left.

25. Open a song from **phone storage**, from **OneDrive**, and from **each Google
   Drive account**. All three should look identical to the app.
26. Play a 45-minute file straight from Drive and seek about in it. This is the
   one that tests range requests over a real connection rather than a local disk.
27. **Add a folder.** Note which providers offer one — local storage should, and
   Google Drive is expected not to offer it at all.
28. Record a take on the phone's own microphone and play it back.
29. Save a take as an MP3 to Drive, and open it on the computer.
30. Open a song and press play. The phone asks about notifications when the app
   opens rather than over the song — say yes — and then **the song keeps playing
   for a good minute**. It used to play a split second and stop, on every song
   from then on, and there was nothing on screen to say why.
31. Turn the screen off while a song plays. It keeps playing, and the song is on
   the lock screen with a play and a pause that work from there and from a pair
   of headphones.
32. Rotate the phone. The case should stay whole.

## Updates

33. Install version N, publish N+1, confirm the notice appears and the new
    version is in place after closing the app.

## Media keys

34. Press play/pause while Chrome has the focus, then while Spotify does. If
    another app has claimed a key, the app says which one rather than doing
    nothing silently.
