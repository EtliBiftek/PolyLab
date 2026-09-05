/**
 * Sidecar supervisor — owns the polylab-core child process.
 *
 * Lifecycle (see docs/ARCHITECTURE.md §2.1):
 *  1. pick a free TCP port (bind :0, read back, close)
 *  2. generate a random session token
 *  3. spawn `polylab-core` with POLYLAB_PORT / POLYLAB_TOKEN
 *     - dev:  `cargo run --bin polylab-core` inside core/
 *     - prod: process.resourcesPath/bin/polylab-core(.exe)
 *  4. poll GET /health with the bearer token until it answers (or timeout)
 *  5. `dispose()` on quit kills the child
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as http from "node:http";
import * as net from "node:net";
import * as path from "node:path";

import { app } from "electron";

export interface SidecarInfo {
  port: number;
  token: string;
  baseUrl: string;
  wsUrl: string;
}

export interface SidecarHandle extends SidecarInfo {
  dispose(): void;
}

/** Resolve the repo root (…/polylab) from the compiled file location in dev. */
function repoRoot(): string {
  // dist/main.js or dist/sidecar.js → apps/desktop/dist → repo root is ../../..
  return path.resolve(__dirname, "..", "..", "..");
}

function coreCommand(): { cmd: string; args: string[]; cwd?: string } {
  // Explicit override (CI, weird dev layouts).
  const override = process.env.POLYLAB_CORE_BIN;
  if (override) return { cmd: override, args: [] };

  if (!app.isPackaged) {
    return { cmd: "cargo", args: ["run", "--bin", "polylab-core"], cwd: path.join(repoRoot(), "core") };
  }
  const bin = process.platform === "win32" ? "polylab-core.exe" : "polylab-core";
  return { cmd: path.join(process.resourcesPath, "bin", bin), args: [] };
}

export function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address == null || typeof address === "string") {
        reject(new Error("could not determine a free port"));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

function healthCheck(info: SidecarInfo, timeoutMs: number): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const req = http.get(
        {
          host: "127.0.0.1",
          port: info.port,
          path: "/health",
          headers: { Authorization: `Bearer ${info.token}` },
          timeout: 2000,
        },
        (res) => {
          res.resume();
          if (res.statusCode === 200) {
            resolve();
          } else if (Date.now() - started > timeoutMs) {
            reject(new Error(`sidecar /health answered ${res.statusCode}`));
          } else {
            setTimeout(attempt, 300);
          }
        },
      );
      req.on("timeout", () => req.destroy());
      req.on("error", () => {
        if (Date.now() - started > timeoutMs) {
          reject(new Error("sidecar did not become healthy in time"));
        } else {
          setTimeout(attempt, 300);
        }
      });
    };
    attempt();
  });
}

export async function startSidecar(): Promise<SidecarHandle> {
  const port = await findFreePort();
  const token = randomBytes(24).toString("hex");
  const info: SidecarInfo = {
    port,
    token,
    baseUrl: `http://127.0.0.1:${port}`,
    wsUrl: `ws://127.0.0.1:${port}/ws`,
  };

  const { cmd, args, cwd } = coreCommand();
  const timeoutMs = app.isPackaged ? 15_000 : Number(process.env.POLYLAB_SIDECAR_TIMEOUT_MS ?? 240_000);

  console.log(`[sidecar] spawning: ${cmd} ${args.join(" ")}${cwd ? ` (in ${cwd})` : ""}`);
  const child: ChildProcess = spawn(cmd, args, {
    cwd,
    env: {
      ...process.env,
      POLYLAB_PORT: String(port),
      POLYLAB_TOKEN: token,
      POLYLAB_DATA_DIR: app.getPath("userData"),
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  const forward = (stream: NodeJS.ReadableStream | null, prefix: string) => {
    stream?.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString("utf8").split("\n")) {
        if (line.trim().length > 0) console.log(`${prefix} ${line}`);
      }
    });
  };
  forward(child.stdout, "[sidecar]");
  forward(child.stderr, "[sidecar]");
  child.on("exit", (code, signal) => {
    console.log(`[sidecar] exited code=${code} signal=${signal ?? ""}`);
  });

  const dispose = () => {
    if (child.killed || child.exitCode != null) return;
    // Ask politely first (graceful shutdown), then hard-kill.
    child.kill();
    const killer = setTimeout(() => !child.killed && child.kill("SIGKILL"), 3000);
    child.on("exit", () => clearTimeout(killer));
  };

  try {
    await healthCheck(info, timeoutMs);
  } catch (error) {
    dispose();
    throw error;
  }
  console.log(`[sidecar] healthy on ${info.baseUrl}`);
  return { ...info, dispose };
}
