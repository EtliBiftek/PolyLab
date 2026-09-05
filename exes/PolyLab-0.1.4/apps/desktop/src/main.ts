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

  // Phase 7: crash-restart with capped backoff. The renderer reconnects on
  // its own (WS retry + /health polling), so a respawn heals the whole UI.
  let restarting = false;
  const MAX_RESTARTS = 5;
  const restartsInWindow = { count: 0, resetAt: 0 };

  const startSidecarGuarded = async (attempt = 0): Promise<void> => {
    try {
      const previous = sidecar;
      sidecar = null;
      previous?.dispose();
      const handle = await startSidecar();
      sidecar = handle;
      restarting = false;
      console.log("[main] sidecar started");
      handle.onCrash(() => {
        if (sidecar === handle) sidecar = null;
        scheduleRestart(1);
      });
    } catch (error) {
      console.error("[main] sidecar failed to start:", error);
      scheduleRestart(attempt + 1);
    }
  };

  const scheduleRestart = (attempt: number): void => {
    if (restarting) return;
    const now = Date.now();
    if (now > restartsInWindow.resetAt) {
      restartsInWindow.count = 0;
      restartsInWindow.resetAt = now + 60_000;
    }
    if (restartsInWindow.count >= MAX_RESTARTS) {
      console.error("[main] sidecar restart budget exhausted; staying down");
      return;
    }
    restarting = true;
    restartsInWindow.count += 1;
    const backoffMs = Math.min(1000 * 2 ** (attempt - 1), 15_000);
    console.warn(`[main] restarting sidecar in ${backoffMs}ms (attempt ${attempt})`);
    setTimeout(() => {
      restarting = false;
      void startSidecarGuarded(attempt);
    }, backoffMs);
  };

  app.whenReady().then(async () => {
    await startSidecarGuarded();
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
