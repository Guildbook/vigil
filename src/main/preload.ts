import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import type { AppState, CompanionBridge } from "../core/protocol";

const bridge: CompanionBridge = {
  getState: () => ipcRenderer.invoke("state:get"),
  onState: (cb) => {
    const listener = (_e: IpcRendererEvent, state: AppState) => cb(state);
    ipcRenderer.on("state", listener);
    return () => ipcRenderer.removeListener("state", listener);
  },
  updateSettings: (partial) => ipcRenderer.invoke("settings:update", partial),
  pair: (input) => ipcRenderer.invoke("pair", input),
  unpair: () => ipcRenderer.invoke("unpair"),
  openExternal: (url) => ipcRenderer.invoke("open-external", url),
  pickFolder: () => ipcRenderer.invoke("pick-folder"),
  installAddon: (clientDir) => ipcRenderer.invoke("addon:install", clientDir),
  retryUpload: (id) => ipcRenderer.invoke("upload:retry", id),
  onPairLink: (cb) => {
    const listener = (_e: IpcRendererEvent, link: { code: string }) => cb(link);
    ipcRenderer.on("pair-link", listener);
    return () => ipcRenderer.removeListener("pair-link", listener);
  },
  installUpdate: () => ipcRenderer.invoke("update:install"),
};

contextBridge.exposeInMainWorld("vigil", bridge);
