/* The media keys, working while another window has the focus.
 *
 * This is what makes the app usable while Ted is turned toward the piano or
 * looking at a student on a video call. Two things it has to get right:
 *
 * - REGISTRATION CAN FAIL SILENTLY. Whichever media app claimed a key first
 *   keeps it, and register() just returns false. Saying nothing would leave him
 *   pressing a key that does nothing and blaming the app, so the failures are
 *   collected and named.
 * - EACH KEY IS SEPARATELY SWITCHABLE. A shortcut that hijacks his Spotify is
 *   worse than no shortcut, so he can turn any one of them off.
 */
const { globalShortcut } = require('electron');

const KEYS = [
  { id: 'playPause', accelerator: 'MediaPlayPause',     label: 'Play or pause' },
  { id: 'next',      accelerator: 'MediaNextTrack',     label: 'Next track' },
  { id: 'previous',  accelerator: 'MediaPreviousTrack', label: 'Previous track' },
  { id: 'stop',      accelerator: 'MediaStop',          label: 'Stop' },
];

function registerShortcuts(enabled, send) {
  globalShortcut.unregisterAll();
  const taken = [];
  for (const key of KEYS) {
    if (enabled[key.id] === false) continue;
    const ok = globalShortcut.register(key.accelerator, () => send(key.id));
    if (!ok) taken.push(key.label);
  }
  // The caller tells him which keys another app is already holding.
  return { taken };
}

module.exports = { registerShortcuts, KEYS };
