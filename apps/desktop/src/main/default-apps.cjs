/* Becoming the app that opens audio files when they are double-clicked.
 *
 * WINDOWS WILL NOT LET AN APP MAKE ITSELF THE DEFAULT. Microsoft took that away
 * from third-party apps in Windows 8 and tightened it again in 10 and 11, and
 * Windows 11 made the choice per file type rather than per app, so "make this my
 * music player" is up to eleven separate confirmations. Anything claiming to do
 * it in one step is forging a UserChoice hash, which Windows reverts and
 * antivirus flags.
 *
 * So the app does the two halves it honestly can: the installer registers it as
 * a capable handler, and this file opens the exact Settings page and then reads
 * back which file types actually took, so the person can see it worked.
 */
const { shell } = require('electron');
const { execFile } = require('node:child_process');
const { AUDIO_EXTENSIONS } = require('../../dist/main/practice-core.cjs');

const PROG_ID_PREFIX = 'com.tedsvoiceacademy.player';

/** Open Windows Settings on this app's own Default apps page. */
async function openDefaultAppsSettings(appName = 'TVA Player') {
  // Windows 11 lands on the app's own page; Windows 10 ignores the parameter
  // and lands on the list, which is still the right place.
  const url = `ms-settings:defaultapps?registeredAppUser=${encodeURIComponent(appName)}`;
  try {
    await shell.openExternal(url);
    return true;
  } catch {
    try { await shell.openExternal('ms-settings:defaultapps'); return true; } catch { return false; }
  }
}

/* Which file types currently open with this app. Read from the registry key
   Windows writes when a person confirms a choice, so it reports what is really
   true rather than what the installer asked for. */
function readUserChoices() {
  if (process.platform !== 'win32') return Promise.resolve(null);

  const base = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts';
  const reads = AUDIO_EXTENSIONS.map((ext) => new Promise((resolve) => {
    execFile('reg', ['query', `${base}\\.${ext}\\UserChoice`, '/v', 'ProgId'],
      { windowsHide: true }, (err, stdout) => {
        if (err) return resolve({ ext, isOurs: false, progId: null });
        const match = /ProgId\s+REG_SZ\s+(\S+)/.exec(stdout || '');
        const progId = match ? match[1] : null;
        resolve({ ext, isOurs: Boolean(progId && progId.startsWith(PROG_ID_PREFIX)), progId });
      });
  }));
  return Promise.all(reads);
}

module.exports = { openDefaultAppsSettings, readUserChoices, PROG_ID_PREFIX };
