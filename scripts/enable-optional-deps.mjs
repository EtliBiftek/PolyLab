#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const manifest = resolve(process.cwd(), "core/Cargo.toml");
let source = readFileSync(manifest, "utf8").replace(/\r\n/g, "\n");

if (source.includes("dep:keyring")) {
  console.log("[enable-optional-deps] already enabled - skipping");
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
default = ["keyring"]
keyring = ["dep:keyring"]
tiktoken = ["dep:tiktoken-rs"]

` +
  source.slice(depsStart);

source = source.replace(
  'async-trait = "=0.1.91"' + String.fromCharCode(10),
  'async-trait = "=0.1.91"' + String.fromCharCode(10) + 'keyring = { version = "3", optional = true, features = ["windows-native"] }' + String.fromCharCode(10) + 'tiktoken-rs = { version = "0.6", optional = true }' + String.fromCharCode(10),
);

if (!source.includes('keyring = { version = "3", optional = true,')) {
  console.error("[enable-optional-deps] FAILED to insert keyring/tiktoken-rs");
  process.exit(1);
}

writeFileSync(manifest, source);
console.log("[enable-optional-deps] keyring + tiktoken-rs restored in core/Cargo.toml");
