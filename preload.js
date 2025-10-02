const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  openFile: () => ipcRenderer.invoke('open-file'),
  
  exportFrame: (frameDataUrl, suggestedName) => 
    ipcRenderer.invoke('export-frame', frameDataUrl, suggestedName),
  
  exportVideoStart: (config) =>
    ipcRenderer.invoke('export-video-start', config),
  
  // Listen for frame processing requests
  onProcessFrame: (callback) => {
    ipcRenderer.on('process-frame', (event, data) => callback(data));
  },
  
  // Send processed frame back
  sendProcessedFrame: (data) => {
    ipcRenderer.send('processed-frame-reply', data);
  },
  
  // Progress/completion listeners
  onExportProgress: (callback) => {
    ipcRenderer.on('export-progress', (event, data) => callback(data));
  },
  
  onExportComplete: (callback) => {
    ipcRenderer.on('export-complete', (event, data) => callback(data));
  }
});