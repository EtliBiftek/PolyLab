/**
 * i18n guardrails:
 *  1. Every literal `t("...")` key used anywhere in the renderer must exist in
 *     BOTH locale files — a missing string silently shows the raw key to users.
 *  2. en.json and tr.json must contain exactly the same key tree (TR/EN parity).
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import en from "./en.json";
import tr from "./tr.json";

const SRC_ROOT = join(process.cwd(), "src");

function collectKeys(node: Record<string, unknown>, prefix = ""): string[] {
  const keys: string[] = [];
  for (const [key, value] of Object.entries(node)) {
    const path = prefix ? `${prefix}.${key}` : key;
    keys.push(path);
    if (typeof value === "object" && value != null) {
      keys.push(...collectKeys(value as Record<string, unknown>, path));
    }
  }
  return keys;
}

function walk(dir: string, files: string[]): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      walk(path, files);
    } else if (/\.(ts|tsx)$/.test(entry) && !entry.endsWith(".test.ts") && !entry.endsWith(".test.tsx")) {
      files.push(path);
    }
  }
  return files;
}

describe("i18n parity", () => {
  it("en and tr expose the same key tree", () => {
    const enKeys = collectKeys(en as unknown as Record<string, unknown>).sort();
    const trKeys = collectKeys(tr as unknown as Record<string, unknown>).sort();
    expect(trKeys).toEqual(enKeys);
  });

  it("every literal t() key used in source exists in both locales", () => {
    const enKeys = new Set(collectKeys(en as unknown as Record<string, unknown>));
    const trKeys = new Set(collectKeys(tr as unknown as Record<string, unknown>));
    const used = new Set<string>();
    for (const file of walk(SRC_ROOT, [])) {
      const source = readFileSync(file, "utf8");
      // Literal keys only: `t("a.b")`, `t('a.b')`, `t(\`a.b\`)`.
      for (const match of source.matchAll(/\bt\(\s*(["'`])([^"'`$]+)\1\s*[,)]/g)) {
        const key = match[2] as string;
        if (key.includes("/") || key.length < 2) continue; // not a translation key
        used.add(key);
      }
    }
    const missing = [...used].filter((key) => !enKeys.has(key) || !trKeys.has(key)).sort();
    expect(missing, `missing in en/tr: ${missing.join(", ")}`).toEqual([]);
  });
});
