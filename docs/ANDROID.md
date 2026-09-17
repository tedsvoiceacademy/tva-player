# TVA Player on an Android phone

## Getting it onto the phone

**On the phone, open this and tap the `.apk`:**

https://github.com/tedsvoiceacademy/tva-player/releases/latest

No sign-in, no zip, nothing to unpack. Android asks once whether to allow
installing apps from this source — say yes, then tap the download again. It
appears as **TVA Player**.

That address always points at the newest build that passed every check, so it is
worth a bookmark on the phone's home screen. The Windows installer is on the same
page, which also saves unpacking a zip on the computer.

To update later, open the same link and tap again. Your songs, loops and settings
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

**The same loops and notes as the computer, if you want them.** Under **Set-up**,
*The same loops and notes as your computer* → **Choose that folder**, and point it
at the folder the Windows app prints under its own Set-up (it is inside OneDrive).
Both machines then read and write the same small file per song, so a part you mark
on either one is on the other.

A copy always stays on the phone as well, so a phone with no signal goes on
working. If the folder you pick turns out to be readable but not writable —
some providers are — the line under the button says so rather than silently
dropping what you mark.

What each machine knows about **itself** stays put: which folders it has been
pointed at, which microphones it has, which skin it wears. A Windows folder list
is of no use to a phone.

**No drag and drop, no media keys, no "make this the app that opens my music".**
Those are Windows things and they are not shown at all rather than shown broken.

## Playing with the screen off

It keeps playing, and the song appears on the lock screen with a play and a pause
you can use from there or from a pair of headphones.

Android is entitled to freeze an app it cannot see, so the app tells the phone
what it is playing — a foreground service, audio focus and a media session, which
is also the first half of what Android Auto needs. **Android 13 and later ask
permission to show a notification the first time you press play.** The
notification is not decoration: it is what makes the phone leave the song alone.
Refuse it and the app says so, and the song will stop when the screen does.

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

## If a song will not open

The app now tells you which step failed rather than only that it took too long.
Three things it may say, and what each means:

- **"the file would not be read"** or **"the app is no longer allowed to read
  that file"** — the permission to that file has lapsed. Open it again through
  **Open a song**.
- **"the phone can read that file but will not say how long it is"** — the file
  is in OneDrive or Drive and has not been downloaded to the phone yet. Open it
  once in the OneDrive or Drive app, then try again.
- **"Still opening that song…"** — it is downloading. The app waits a minute for
  a song from a phone, against fifteen seconds on Windows, because a song in
  OneDrive is not on the phone until something asks for it.

**Keep a lot of music in a folder, not one song at a time.** Android limits how
many individual files an app may hold permission to. A folder costs one
permission however much music is inside it; songs opened one at a time each cost
their own, so the app keeps the last 200 of those.

## What has been checked, and what has not

Checked, at 390 pixels, on every build: that the phone build answers everything
the Windows app can ask for, that nothing runs off the side at 390 or 360, that
the whole case is on screen without scrolling and there is still room to work
under it, that everything you press is at least a fingertip across, that a song
opens from the picker and plays, that the speed and key engine runs, that a
recorded take holds the pitch that went into it, that a take saves out as an MP3
that still holds the singing, and that all twelve skins repaint.

Sharing with the computer is checked end to end: a song file is written into the
shared folder exactly as the Windows app writes it, the phone opens that song and
the marked part is there, then a part marked on the phone is read back out of the
same file. The two machines are proved to agree on the file's name rather than
assumed to.

The song list is checked with forty songs in it, not an empty one — which is
what hid the fault where **Open a song** ended up 2,168 pixels below the list.

The decisions inside serving a song — which bytes to send, what to say about
their length, what to do when the length is not known — now live in a plain Java
class with no Android in it, and fourteen cases go through them on every build.
That is the part that failed the first time and the only part of the Android code
a build runner can run.

**Not checked by any of that**, because none of it can exist on a build runner:
Android's own document picker, a song streamed out of Drive or OneDrive, whether
those providers give a folder that can be written to, and whether the phone
really does leave the song playing when the screen goes off. Those four are the
first things to try, and the Windows checklist lists them.
