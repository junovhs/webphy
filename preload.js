const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // File operations
  openFile: () => ipcRenderer.invoke('open-file'),
  
  // Single frame export
  exportFrame: (frameDataUrl, suggestedName) => 
    ipcRenderer.invoke('export-frame', frameDataUrl, suggestedName),
  
  // Video export
  exportVideoStart: (config) => 
    ipcRenderer.invoke('export-video-start', config),
  
  exportVideoFrame: (data) => 
    ipcRenderer.invoke('export-video-frame', data),
  
  exportVideoFinish: (data) => 
    ipcRenderer.invoke('export-video-finish', data),
  
  exportVideoCancel: (data) => 
    ipcRenderer.invoke('export-video-cancel', data),
  
  // Listen to progress updates
  onExportProgress: (callback) => {
    ipcRenderer.on('export-progress', (event, data) => callback(data));
  }
});