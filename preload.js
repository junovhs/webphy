// webphy/preload.js

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  exportFrame: (frameDataUrl, suggestedName) => 
    ipcRenderer.invoke('export-frame', frameDataUrl, suggestedName),
  
  // --- API FOR FRAME-BY-FRAME VIDEO EXPORT ---

  exportVideoInitialize: () => 
    ipcRenderer.invoke('export-video-initialize'),
  
  // Note: We send the frame data as a raw ArrayBuffer (Uint8Array)
  exportVideoWriteFrame: (frameData) => 
    ipcRenderer.send('export-video-write-frame', frameData),
  
  exportVideoFinalize: (config) => 
    ipcRenderer.invoke('export-video-finalize', config),
  
  // --- LISTENERS for progress updates from the main process ---
  
  onExportProgress: (callback) => {
    ipcRenderer.on('export-progress', (event, data) => callback(data));
  },
  
  onExportComplete: (callback) => {
    ipcRenderer.on('export-complete', (event, data) => callback(data));
  }
});