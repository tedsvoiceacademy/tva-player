/* The only way the page can reach the rest of the computer.
 *
 * Everything the renderer is allowed to do is named here, one function at a
 * time. It has no file system, no require, no Node — so a bug in the player, or
 * anything that ever gets loaded into it, cannot read or write a file the app
 * did not already decide to hand over.
 */
const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (handler) => {
  const wrapped = (_event, payload) => handler(payload);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
};

contextBridge.exposeInMainWorld('tva', {
  // Songs
  openSongs: () => ipcRenderer.invoke('dialog:openSongs'),
  onSongsOpened: on('songs:open'),

  // What the app remembers about a song
  loadSong: (songKey) => ipcRenderer.invoke('song:load', songKey),
  saveSong: (songFile) => ipcRenderer.invoke('song:save', songFile),
  listSongs: () => ipcRenderer.invoke('song:list'),

  // App-wide settings
  loadSettings: () => ipcRenderer.invoke('settings:load'),
  saveSettings: (settings) => ipcRenderer.invoke('settings:save', settings),
  revealFolder: (target) => ipcRenderer.invoke('folder:reveal', target),

  // Opening audio files by double-clicking them
  openDefaultAppsSettings: () => ipcRenderer.invoke('defaults:open'),
  readDefaultAppChoices: () => ipcRenderer.invoke('defaults:read'),

  // Media keys
  listShortcuts: () => ipcRenderer.invoke('shortcuts:list'),
  onShortcut: on('shortcut'),

  // Startup facts and jump-list tasks
  onReady: on('app:ready'),
  onTask: on('task:run'),
});
