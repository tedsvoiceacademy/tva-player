# TVA Player

A Windows audio player with the practice controls built in, and a recorder.

## Getting the installer

Every change builds a fresh installer automatically and leaves it on that
build's own page.

1. Go to https://github.com/tedsvoiceacademy/tva-player/actions
   You get a **list** of builds. The installer is not on this list page — it is
   inside one of them.
2. **Click the blue title of the top entry** to open that build. A green tick
   means everything passed. (A yellow dot means it is still running — wait about
   three minutes and reload.)
3. Scroll to the bottom of that page. Under **Artifacts** there is one row,
   **TVA-Player-installer**. Click it and it downloads as a zip.
4. Open the zip and pull the `.exe` out of it.

## Installing

1. Double-click the `.exe`.
2. **Windows shows a blue box saying "Windows protected your PC".** That is what
   Windows says about any program without a paid certificate. Click
   **More info**, then **Run anyway**.
3. It installs and appears in your Start menu as **TVA Player**. No
   administrator prompt.

To update later, download a new installer the same way and run it over the top.
It keeps all your settings.

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

Takes are listed under **Takes**, kept as WAV files. You can also record what the
computer itself is playing, from that same tab.

**Notes.** Pin a note to a moment in a song and click it later to jump there.

**Click track.** A metronome over the song, with a count-in.

**The tuner** appears while the microphone is on and names the note being sung.

**Help.** There is a **Help** tab inside the app with all of this in it, so you
never have to come back to this file.

## How it looks

Ten skins, under **Set-up**. Each changes the colours and the finish together —
some are lit like hardware, some are flat like modern recording software:

| | |
|---|---|
| **Studio navy** | The default — TVA navy and gold |
| **AVF** | Your book's teal and amber |
| **PASS** | The profile platform's deep teal and green |
| **Vocal Fit** | Dark green with the bright green accent |
| **Daylight** | Cream case, dark text — for a sunlit room |
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
