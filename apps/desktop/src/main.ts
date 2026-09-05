/**
 * Electron main process: window management + sidecar supervision.
 * Security posture (docs/ARCHITECTURE.md §2.2):
 *   contextIsolation: true, nodeIntegration: false, sandbox: true — the renderer only
 *   gets the small `window.polylab` bridge exposed by preload.ts.
 */
import * as path from "node:path";

import { app, BrowserWindow, dialog, ipcMain } from "electron";

import { startSidecar, type SidecarHandle } from "./sidecar";

// Electron Main is CJS after tsc; __dirname works. Guard for ESM-dev experiments.
declare const __dirname: string;

let mainWindow: BrowserWindow | null = null;
let sidecar: SidecarHandle | null = null;

const isDev = !app.isPackaged;
const DEV_RENDERER_URL = process.env.ELECTRON_RENDERER_URL ?? "http://127.0.0.1:5173";

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: "#0f0d13", // --bg-0, prevents white flash before CSS loads
    title: "PolyLab",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  if (isDev) {
    await mainWindow.loadURL(DEV_RENDERER_URL);
    mainWindow.webContents.openDevTools({ mode: "detach" });
  } else {
    // Packaged layout keeps the workspace paths: apps/renderer/dist/index.html
    await mainWindow.loadFile(path.join(__dirname, "..", "..", "renderer", "dist", "index.html"));
  }

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    console.error(`[main] renderer gone: ${details.reason} ${details.exitCode}`);
  });
}

// Synchronous info for the preload bridge (needed before the renderer loads).
ipcMain.on("polylab:get-info", (event) => {
  event.returnValue = {
    sidecar: sidecar
      ? { port: sidecar.port, token: sidecar.token }
      : null,
    versions: {
      app: app.getVersion(),
      electron: process.versions.electron ?? "",
      chrome: process.versions.chrome ?? "",
      node: process.versions.node ?? "",
    },
    platform: process.platform,
  };
});

ipcMain.handle("polylab:select-folder", async () => {
  const result = await dialog.showOpenDialog({
    properties: ["openDirectory", "createDirectory"],
  });
  const first = result.filePaths[0];
  return first ?? null;
});

const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    try {
      sidecar = await startSidecar();
    } catch (error) {
      console.error("[main] sidecar failed to start:", error);
      // Keep going with a degraded UI; the renderer will show the offline state.
      // TODO(phase-7): restart with backoff + user notification.
    }
    await createWindow();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  app.on("will-quit", () => {
    sidecar?.dispose();
    sidecar = null;
  });

  // Belt & braces: never leave the sidecar running if the main loop dies.
  process.on("exit", () => sidecar?.dispose());
}
