/// <reference types="vitest" />
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

// The sidecar port used by the dev proxy (renderer-only development, no Electron).
const sidecarPort = process.env.POLYLAB_PORT || "43110";

/**
 * index.html ships a strict CSP for production (file:// inside Electron). Vite dev
 * needs inline scripts (React refresh preamble), so the meta tag is stripped in dev —
 * dev servers run on localhost only.
 */
const stripCspInDev: Plugin = {
  name: "strip-csp-in-dev",
  apply: "serve",
  transformIndexHtml(html) {
    return html.replace(/<meta[^>]+http-equiv=["']Content-Security-Policy["'][^>]*>/i, "");
  },
};

export default defineConfig({
  plugins: [react(), stripCspInDev],
  base: "./", // packaged renderer is loaded via file:// from Electron
  server: {
    host: true, // 0.0.0.0 — required for the sandbox/preview environment
    port: 5173,
    strictPort: true,
    proxy: {
      "/health": { target: `http://127.0.0.1:${sidecarPort}` },
      "/api": { target: `http://127.0.0.1:${sidecarPort}` },
      "/ws": { target: `ws://127.0.0.1:${sidecarPort}`, ws: true },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
  },
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
    setupFiles: ["src/test/setup.ts"],
  },
});
