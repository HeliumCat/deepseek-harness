// Preload for the transparent pet window: expose only the two window controls
// the page needs. No Node or filesystem access reaches the renderer.
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('petWindow', {
  resize: (width, height) => {
    if (Number.isFinite(width) && Number.isFinite(height)) ipcRenderer.send('pet-window:resize', width, height)
  },
  quit: () => { ipcRenderer.send('pet-window:quit') },
})
