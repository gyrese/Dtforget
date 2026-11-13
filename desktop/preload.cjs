// Pont minimal entre la page d'installation et le processus principal.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('atelier', {
  state: () => ipcRenderer.invoke('state'),
  install: (code) => ipcRenderer.invoke('install', code),
  saveLink: (code) => ipcRenderer.invoke('save-link', code),
  onProgress: (fn) => ipcRenderer.on('progress', (_event, data) => fn(data)),
});
