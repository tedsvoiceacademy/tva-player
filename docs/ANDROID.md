# TVA Player on an Android phone

## Getting it onto the phone

1. On the **phone**, go to
   https://github.com/tedsvoiceacademy/tva-player/actions and open the top build.
2. At the bottom, under **Artifacts**, tap **TVA-Player-android**. It downloads
   as a zip.
3. Open the zip and tap the `.apk` inside it.
4. Android says **"For your security, your phone can't install unknown apps from
   this source."** Tap **Settings**, turn the switch on, come back, tap install.
   That is the same warning Windows shows about the `.exe`, for the same reason:
   nothing here is signed by a store.
5. It appears as **TVA Player**.

To update later, download a newer one and tap it. Your songs, loops and settings
stay.

## What is the same as Windows

All of it, bar the things a phone does not have. The audio engine, the speed and
key control, the pan, the loops, the saved parts, the notes, the click track, the
tuner, the recorder, saving a take out as an MP3 or a WAV, and all twelve skins
are the **same code** — literally the same files, built into the app rather than
rewritten for it. A fix on one is a fix on both.

## What is different

**The song list is a tab.** On Windows it is a column beside the case; there is
no room for a column on a phone, so **Your songs** is the first tab.

**The three sound switches are a tab too** — **Sound**. They are 200 pixels of a
phone screen and they are settings you make once, so moving them is what lets the
case itself fit on the screen without scrolling.

**Opening a song uses Android's own picker**, which is the point: it lists your
phone's storage, OneDrive, and every Google Drive account you are signed into, in
one place. The app never asks for permission to your storage and never asks for
an account — it is handed the one file you chose.

**Add a folder** works where Android offers it: local storage and some providers
support choosing a whole folder, and Google Drive does not offer one at all. Pick
files there instead.

**Takes are kept in the app's own folder**, under
`Android/data/com.tedsvoiceacademy.player/files/Takes`. You can see them in Files,
and **Save my voice** puts a copy wherever you want it, Drive included.

**Settings are the phone's own.** Loops and notes made on the phone stay on the
phone, and the same for the desktop. Making the two agree is a job of its own and
is not done yet — the app says where its settings are, the same as on Windows.

**No drag and drop, no media keys, no "make this the app that opens my music".**
Those are Windows things and they are not shown at all rather than shown broken.

## Android Auto

**Not in this build, and worth knowing what it can ever be.** Android Auto only
accepts media apps, and it draws its own screen: a list to browse, play, pause,
skip, seek, and up to about four extra buttons. The waveform, the dials, loop
dragging and the recorder cannot appear in the car at any effort — that is
Android's rule, not a limit of this app.

So "TVA Player in the car" means your songs listed on the car screen and played
from there, with perhaps a slower button. That is the next piece of work, and it
needs a second, native player inside the app for the car to drive, because the
one in the page cannot run with the screen off.

## What has been checked, and what has not

Checked, at 390 pixels, on every build: that the phone build answers everything
the Windows app can ask for, that nothing runs off the side at 390 or 360, that
the whole case is on screen without scrolling and there is still room to work
under it, that everything you press is at least a fingertip across, that a song
opens from the picker and plays, that the speed and key engine runs, that a
recorded take holds the pitch that went into it, that a take saves out as an MP3
that still holds the singing, and that all twelve skins repaint.

**Not checked by any of that**: Android's own document picker, and a song
streamed out of Drive. Neither can exist on a build runner. They are the first
two things to try on the phone.
