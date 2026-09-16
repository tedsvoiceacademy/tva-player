# TVA Player

A Windows audio player with the practice controls built in, and a recorder.

## Getting the installer

**One page, both files, no zip:**

https://github.com/tedsvoiceacademy/tva-player/releases/latest

- **TVA-Player-Setup.exe** — Windows
- **TVA-Player.apk** — your Android phone

That address always points at the newest build that passed every check, so it is
worth a bookmark. Nothing to sign into and nothing to unpack.

## Installing

1. Double-click the `.exe`.
2. **Windows shows a blue box saying "Windows protected your PC".** That is what
   Windows says about any program without a paid certificate. Click
   **More info**, then **Run anyway**.
3. It installs and appears in your Start menu as **TVA Player**. No
   administrator prompt.

To update later, download a new installer the same way and run it over the top.
It keeps all your settings.

## On your Android phone

There is an Android build of the same app now — the same engine, the same
controls, the same twelve skins, laid out for a phone. It installs from a file
rather than from the Play Store. **See `docs/ANDROID.md`** for how to get it on
and what differs (the song list and the sound switches become tabs, and songs
come from Android's own picker, which reaches your phone, OneDrive and every
Google Drive account at once).

Android Auto is not in it yet, and is worth knowing about before it is: Auto
draws its own screen for media apps — a list, play, pause, skip — so the dials,
the waveform and the recorder can never appear in the car.

## What it does

**Your songs.** Click **Add a folder** and point it at where you keep your
music. Everything playable inside is listed, including anything you add later.
Nothing is copied or moved. Search the list, click a song to play it, and the
rest of the list plays after it. **Play them all** starts at the top. **Save
this list** keeps what is lined up under a name.

**Opening a file directly.** Double-click any MP3, M4A, WAV, FLAC, AAC or OGG in
File Explorer. Select several and they all play in turn. You can also **drag a
song straight into the window**.

**The practice controls.**

| Control | What it does |
|---|---|
| Speed | Slower or faster without changing the pitch. Straight up is normal; the ends are quarter speed and double |
| Pitch | Up or down in half steps without changing the speed |
| Pan | Turns one side of the recording down |
| Volume | How loud it plays |
| Keep voices natural when you move Pitch | Stops voices going chipmunky |
| Turn the lead singer down | Removes what sits dead centre; bass and drums fade too |
| Play the same sound from both speakers | For a car stereo that only carries one side |

**Double-click any dial to put it back to normal.**

**Loop a part.** Drag across the waveform, or type the times to the tenth of a
second and nudge them. Save a loop by name and it is there next time you open
that song.

**The waveform.** On a stereo song the left channel is drawn on top and the
right underneath, so you can see which side a part sits on.

**Record.** Two buttons sit in the transport, beside play. The **red** one,
**Record new**, records just your voice. The **orange** one, **Overdub**, starts
the song and records you singing over it. Press the same button again to stop and
keep the take. Nothing has to be set up first — the first press asks Windows for
the microphone.

**Mic** turns the microphone on early so you can check your level before you
start, and **Keep last** saves the last two minutes the microphone already heard,
so a good run is never lost for want of pressing record. While the microphone is
on, **Your voice** appears in the display with a bar showing how loud you are.

**Turning a microphone up.** Under the bar, **−** and **+** move the app's own
gain a decibel at a time; double-click the number to put it back to nothing. It
sits on top of whatever the interface is set to, so it is there when the
interface has run out. It turns the room up along with the voice, so use the
least that gets you off the bottom of the bar. Each microphone keeps its own
setting, remembered against that interface.

**More than one microphone.** An interface with several inputs hands all of them
over at once and the app takes up to eight. **Set-up** says how many Windows
gave and lets you untick any input with nothing plugged in. One take then writes
**a file for every microphone, plus one more with them all mixed** — so you can
send one singer their own track, or listen back to the room. With several on,
**◀** and **▶** beside the gain switch choose which one it acts on, and the
panel names it. The tuner follows the first microphone, and **Keep last** saves
the mix.

**Seeing what is being recorded.** While the microphone is on, the bottom of the
waveform becomes a live picture of what is coming in — one lane per microphone,
named, scrolling from the right, and red while a take is running.

Takes are listed under **Takes**, kept as WAV files. You can also record what the
computer itself is playing, from that same tab.

**Getting a take out.** Every take carries two save buttons. **Save my voice**
saves that take on its own; **Save with the song** makes one file of your take
and the song together, which is the one to send to somebody who was not there.
Either opens the usual Windows Save box, and you pick the format from the
**Save as type** list at the bottom:

| | |
|---|---|
| **MP3** | Small enough to email or put on a phone — a 45-minute lesson comes out around 40 MB |
| **WAV** | Full quality, about six times the size. A take saved as a WAV on its own is an exact copy, so it happens instantly |

A long lesson takes a little while to save as an MP3. The button counts up while
it works and the app stays usable throughout.

**Notes.** Pin a note to a moment in a song and click it later to jump there.

**Click track.** A metronome over the song, with a count-in.

**The tuner** appears while the microphone is on and names the note being sung.

**Help.** There is a **Help** tab inside the app with all of this in it, so you
never have to come back to this file.

## How it looks

Twelve skins, under **Set-up**. Each changes the colours and the finish together
— some are lit like hardware, some are flat like modern recording software. The
chosen one's description is printed under the row:

| | |
|---|---|
| **Studio navy** | The default — TVA navy and gold |
| **AVF** | Your book's teal and amber |
| **PASS** | The profile platform's deep teal and green |
| **Vocal Fit** | Dark green with the bright green accent |
| **Daylight** | Cream case, dark text — for a sunlit room |
| **Bright colours** | White, with the strongest colours in the set: pink names things, teal is the song, orange is recording |
| **Paper grey** | The quietest light one — paper grey and a single blue |
| **Studio grey** | Neutral grey; nothing competes with the song |
| **High contrast** | Black and white, for reading it across the room |
| **Vintage** | Warm brown and cream, matte, like the hardware player |
| **Night** | Near-black with dim amber, for a dark room late on |
| **Stage** | Deep violet and magenta |

Your choice follows you to your other computer.

## Where things are kept

Your marked parts, named parts, notes and lists live in a folder inside your
OneDrive, so they are the same on your laptop and your desktop. The app prints
the exact path under **Set-up**.

Takes are kept on the computer that made them, in your Music folder, because a
45-minute lesson is a big file and whether it syncs should be your choice.

## What never leaves your computer

The songs you open. They are played from where they already are and never
uploaded anywhere.
