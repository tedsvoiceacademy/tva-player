# TVA Player — installing it and keeping it up to date

## Getting the installer

Every time I change the app, a fresh Windows installer is built automatically
and left on that build's own page. To fetch the current one:

1. Go to
   https://github.com/tedsvoiceacademy/tva-player/actions/workflows/ci.yml
2. Click the entry at the top of the list — that is the most recent build. A
   green tick beside it means everything passed.
3. Scroll to the bottom of that page to a box headed **Artifacts**, and click
   **TVA-Player-installer**. It downloads as a zip.
4. Open the zip and pull the `.exe` out of it.

## Installing it, the first time on each computer

1. Double-click the `.exe` you just pulled out of the zip.
2. **Windows will show a blue box saying "Windows protected your PC".**
   That is expected and it is not a warning about this app specifically — it is
   what Windows says about any program that has not paid for a certificate.
   Click **More info**, then **Run anyway**.
3. It installs itself and appears in your Start menu as **TVA Player**. There is
   no Yes/No administrator prompt, because it installs only for you.

You do this once per computer.

**Updating itself is not switched on yet.** That needs a published release, and
while the app is still being built there is not one. For now, fetch a new
installer the same way and run it over the top — it replaces what is there and
keeps your settings. I will say so when the app starts updating itself.

## Making it the app that opens your music

Windows does not let a program make itself the default — you confirm it by hand,
once. The app has a button that opens the right page in Windows Settings, and
then shows you a tick beside each kind of file that took.

## When there is a new version, later on

Once the app is finished enough to publish properly, it will check for new
versions itself, download them quietly in the background, tell you when one is
ready, and put it in place the next time you close the app. It will never
restart itself in the middle of a lesson.

## Where your loops and settings are kept

In a folder inside your OneDrive, so the loops you mark on the laptop are there
on the desktop. The app prints the exact path along the bottom of its window.

Your recordings are kept separately, on the computer that made them, because a
45-minute lesson is a large file and it should be your choice whether it goes
into OneDrive.

## What never leaves your computer

The songs you open. The app plays them from where they already sit and never
uploads them anywhere.
