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

## Recording on the phone

The first time you press **Record new** or **Overdub**, Android asks whether to
let the app use the microphone. Say yes. It asks once and then never again.

Until this build it never worked, and the reason is worth writing down because it
looked like nothing at all: the app asks Android for two permissions when a page
wants a microphone — the obvious one and a second one for changing audio settings
— and Android hands over a microphone only if both come back granted. The second
one was not declared, and a permission that is not declared is refused on the
spot, with no dialog and no message. So the red button lit up, nothing was
recorded, and no check anywhere could see it, because every check ran the page in
a desktop browser where Android's permission system does not exist.

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
the whole case is on screen when the app opens, that everything you press is at
least a fingertip across, that a song
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

Every tab is now opened at three screen sizes and three text sizes — nine
combinations each — and asked one question: can the last thing in it be reached,
without the page running off the side. That check exists because turning
Android's own **Font size** up was what made the app unusable, and nothing here
had ever been measured at anything but the default.

The decisions inside serving a song — which bytes to send, what to say about
their length, what to do when the length is not known — live in a plain Java
class with no Android in it, and fourteen cases go through them on every build.
That is the part that failed the first time.

## And now the app runs on a real Android on every build

The three faults you hit all lived in the same place: the part of an Android app
that a desktop browser has no equivalent of. So every build now installs the
actual APK on an actual Android and drives it:

- **Recording.** The page asks Android for a microphone, gets one, records for
  three seconds through the app's own Record button, and the take is read back
  and measured. Silence fails it.
- **Opening a song.** A real `content://` address goes through the real picker
  code, the real permission, the real name-and-size query and the real byte
  serving. The clock has to read 0:08, and a hundred bytes from the middle of
  the file have to come back exactly right.
- **The layout at larger text.** Android's own Font size is turned up to 1.3 and
  every tab has to be scrollable to its end.

And each of those three has its fault deliberately put back on every build, with
the check required to go red — because a check that cannot fail is not evidence.

**Still not checked, and honestly so.** An emulator is not a Clarett and has one
fake input, so nothing about several microphones at once is proved on a device.
It has no OneDrive app, so Microsoft's own provider — the one that answers slowly,
or will not say how long a file is — is never the thing being talked to. Nobody
taps **Allow**, because the permission is granted before the test starts. Nothing
listens, so no sound is ever proved audible. And an hour of playing with the
screen off, in a pocket, needs a pocket. Those are yours to try, and the Windows
checklist lists them.
