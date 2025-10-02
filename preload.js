// webphy/preload.js

const { contextBridge, ipcRenderer } = require('electron');

// --- API for the MAIN UI window (index.html) ---
if (!window.location.href.endsWith('export.html')) {
    contextBridge.exposeInMainWorld('electronAPI', {
        exportVideoStart: (config) =>
            ipcRenderer.invoke('export-video-start', config),

        exportFrame: (frameDataUrl, suggestedName) => 
            ipcRenderer.invoke('export-frame', frameDataUrl, suggestedName),
        
        onExportProgress: (callback) => {
            ipcRenderer.on('export-progress', (event, data) => callback(data));
        },
        onExportComplete: (callback) => {
            ipcRenderer.on('export-complete', (event, data) => callback(data));
        }
    });
}


// --- API for the HEADLESS RENDERER window (export.html) ---
if (window.location.href.endsWith('export.html')) {
  contextBridge.exposeInMainWorld('electronAPI', {
    onInitExport: (callback) => ipcRenderer.on('init-export', (event, data) => callback(data)),
    onExportFrame: (callback) => ipcRenderer.on('export-frame-data', (event, data) => callback(data)),
    sendExportReady: () => ipcRenderer.send('export-renderer-ready'),
    // CRITICAL FIX: The second argument is for transferable objects (pixels buffer)
    sendExportResult: (data) => ipcRenderer.send('export-frame-result', data, [data.pixels]), 
    sendExportError: (error) => ipcRenderer.send('export-error', error)
  });
}