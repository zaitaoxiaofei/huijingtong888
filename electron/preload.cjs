const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("ozonDesktop", {
  platform: process.platform,
  isElectron: true,
  adjustAdvertisingSetting(payload) {
    return ipcRenderer.invoke("advertising:adjust-setting", payload);
  },
  downloadOfficialBarcodePdf(payload) {
    return ipcRenderer.invoke("barcode:download-official-pdf", payload);
  }
});
