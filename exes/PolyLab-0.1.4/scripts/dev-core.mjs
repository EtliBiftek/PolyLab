#!/usr/bin/env node
// Runs the Rust sidecar for renderer-only development (no Electron).
// Uses a fixed dev token so the browser renderer can authenticate through the Vite proxy.
// The sidecar always binds to 127.0.0.1 — this is for local development only.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = process.env.POLYLAB_PORT || "43110";
const token = process.env.POLYLAB_TOKEN || "dev-token";

const child = spawn("cargo", ["run", "--bin", "polylab-core"], {
  cwd: path.join(root, "core"),
  env: { ...process.env, POLYLAB_PORT: port, POLYLAB_TOKEN: token },
  stdio: "inherit",
});

console.log(`[dev-core] sidecar starting on http://127.0.0.1:${port} (dev token)`);
child.on("exit", (code) => process.exit(code ?? 0));
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => child.kill(sig));
}
