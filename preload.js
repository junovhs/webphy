const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Invokes a request to the main process
  exportFrame: (frameDataUrl, suggestedName) => 
    ipcRenderer.invoke('export-frame', frameDataUrl, suggestedName),
  
  exportVideoStart: (config) =>
    ipcRenderer.invoke('export-video-start', config),
  
  // Listens for events from the main process
  onExportProgress: (callback) => {
    ipcRenderer.on('export-progress', (event, data) => callback(data));
  },
  
  onExportComplete: (callback) => {
    ipcRenderer.on('export-complete', (event, data) => callback(data));
  }
});