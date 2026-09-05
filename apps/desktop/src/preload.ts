/**
 * Preload bridge — the only surface between the renderer and Node/Electron.
 * Nothing else is exposed; renderer code stays sandboxed.
 */
import { contextBridge, ipcRenderer } from "electron";

interface SidecarInfoBridge {
  port: number;
  token: string;
}

const info = ipcRenderer.sendSync("polylab:get-info") as {
  sidecar: SidecarInfoBridge | null;
  versions: Record<string, string>;
  platform: string;
};

contextBridge.exposeInMainWorld("polylab", {
  sidecar: info.sidecar,
  versions: info.versions,
  platform: info.platform,
  /** Native folder picker (used by Coding mode from Phase 4 on). */
  selectFolder: (): Promise<string | null> => ipcRenderer.invoke("polylab:select-folder"),
});
