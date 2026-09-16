/* The only way the page can reach the rest of the computer.
 *
 * Everything the renderer is allowed to do is named here, one function at a
 * time. It has no file system, no require, no Node — so a bug in the player, or
 * anything that ever gets loaded into it, cannot read or write a file the app
 * did not already decide to hand over.
 */
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const on = (channel) => (handler) => {
  const wrapped = (_event, payload) => handler(payload);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
};

contextBridge.exposeInMainWorld('tva', {
  // Songs
  openSongs: () => ipcRenderer.invoke('dialog:openSongs'),
  onSongsOpened: on('songs:open'),
  /* DRAGGING A SONG IN. A dropped File carries no path the page can read — that
     was taken away from browsers on purpose. webUtils is the one way to ask for
     it, and it only works from here, so the page hands the File over and gets a
     path back. It still cannot read the file: it has to ask the app to open it,
     the same as every other route in. */
  pathForFile: (file) => webUtils.getPathForFile(file),
  openDropped: (paths) => ipcRenderer.invoke('dialog:openDropped', paths),

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

  // The library of folders he has pointed the app at
  addFolder: () => ipcRenderer.invoke('library:addFolder'),
  removeFolder: (folder) => ipcRenderer.invoke('library:removeFolder', folder),
  scanLibrary: () => ipcRenderer.invoke('library:scan'),
  readTags: (paths) => ipcRenderer.invoke('library:tags', paths),

  // Recording
  startRecording: (opts) => ipcRenderer.invoke('record:start', opts),
  /* Sent rather than invoked, and the buffer is TRANSFERRED: at 48 kHz this
     fires about every 21 milliseconds for the whole length of a lesson, so
     neither side may keep a copy. */
  sendChunk: (buffer) => ipcRenderer.send('record:chunk', buffer),
  stopRecording: () => ipcRenderer.invoke('record:stop'),
  listRecordings: () => ipcRenderer.invoke('record:list'),
  removeRecording: (target) => ipcRenderer.invoke('record:remove', target),
  saveMixed: (opts) => ipcRenderer.invoke('record:saveMixed', opts),
  openRecordingsFolder: () => ipcRenderer.invoke('record:folder'),

  // Startup facts and jump-list tasks
  onReady: on('app:ready'),
  onTask: on('task:run'),
});
