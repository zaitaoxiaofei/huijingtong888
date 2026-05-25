const { contextBridge } = require("electron");

contextBridge.exposeInMainWorld("ozonDesktop", {
  platform: process.platform,
  isElectron: true
});
