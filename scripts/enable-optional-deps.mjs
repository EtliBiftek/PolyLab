#!/usr/bin/env node
/**
 * CI-only helper: re-enables the optional `keyring` (Windows Credential
 * Manager) and `tiktoken-rs` (exact token counts) dependencies before the
 * release build.
 *
 * The committed core/Cargo.toml intentionally leaves them out so offline
 * builds against the vendored registry keep working (those crates are not in
 * the vendor set). On a networked machine (e.g. GitHub Actions) this script
 * restores the feature wiring, and the subsequent `cargo build` resolves and
 * locks the new dependencies automatically.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const manifest = resolve(process.cwd(), "core/Cargo.toml");
let source = readFileSync(manifest, "utf8");

if (source.includes("dep:keyring")) {
  console.log("[enable-optional-deps] already enabled — skipping");
  process.exit(0);
}

const featuresStart = source.indexOf("[features]");
const depsStart = source.indexOf("[dependencies]");
if (featuresStart === -1 || depsStart === -1 || depsStart < featuresStart) {
  console.error("[enable-optional-deps] unexpected Cargo.toml layout");
  process.exit(1);
}

source =
  source.slice(0, featuresStart) +
  `[features]
# Full-registry builds (CI/release) enable the Windows Credential Manager store
# by default and exact token counting via tiktoken when requested. Offline
# vendor builds use --no-default-features and keep both off.
default = ["keyring"]
keyring = ["dep:keyring"]
tiktoken = ["dep:tiktoken-rs"]

` +
  source.slice(depsStart);

source = source.replace(
  "async-trait = \"=0.1.91\"\n",
  'async-trait = "=0.1.91"\nkeyring = { version = "3", optional = true, features = ["windows-native"] }\ntiktoken-rs = { version = "0.6", optional = true }\n',
);

writeFileSync(manifest, source);
console.log("[enable-optional-deps] keyring + tiktoken-rs restored in core/Cargo.toml");
