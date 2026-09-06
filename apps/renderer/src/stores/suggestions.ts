import { create } from "zustand";

import type { Mode } from "./settings";

/**
 * Composer suggestions for the empty state (3 chips). Varies by chat/coding mode,
 * rotates on every new chat (never the same set twice in a row), and is seeded by
 * the user's history so different users see different picks.
 */

const POOLS: Record<"tr" | "en", Record<Mode, string[]>> = {
  tr: {
    chat: [
      "Bu hafta öğrenebileceğim yeni bir hobi önerir misin?",
      "Bana ilginç bir bilim kurgu hikâyesi anlat.",
      "Haftalık yemek planı hazırla, akşam yemekleri için.",
      "Öğrenmekte zorlandığım konuları sınavda nasıl hatırlarım?",
      "Bir e-posta ya da Slack mesajını kibarca nasıl reddederim? Örnek yaz.",
      "İstanbul'da yağmurlu bir gün için 3 saatlik bir plan yap.",
      "Uyku düzenimi düzeltmek için pratik adımlar sırala.",
      "Bana kolay bir akşam yemeği tarifi ver, eldekilerle olur.",
      "Yeni başlayanlar için bütçe dostu egzersiz planı yaz.",
      "Bir kitap öner ve neden sevdiğim tahmin et.",
    ],
    coding: [
      "Bu çalışma alanında küçük bir TypeScript CLI aracı oluştur.",
      "Mevcut dosyaları incele ve kısa bir mimari özeti yaz.",
      "Birim testleri çalıştır ve başarısızları düzelt.",
      "README.md oluştur: kurulum, kullanım ve örnek komutlar.",
      "Kod tekrarlarını bul ve refactor et.",
      "Basit bir HTTP sunucusu yaz ve curl ile test et.",
      "Tüm TODO'ları bul, listele ve en kolayı çöz.",
      "Bir fonksiyonun karmaşıklığını azalt, davranışı koru.",
      "Git durumunu özetle ve değişiklikleri commit et.",
      "Küçük bir hesap makinesi kütüphanesi yaz + testleri.",
    ],
  },
  en: {
    chat: [
      "Suggest a new hobby I could pick up this month.",
      "Tell me a short science-fiction story.",
      "Plan my weekly dinners, easy recipes only.",
      "How do I remember hard topics for an exam?",
      "Draft a polite decline for a meeting invite.",
      "Plan a 3-hour rainy afternoon in my city.",
      "Give me practical steps to fix my sleep schedule.",
      "A simple dinner recipe from pantry staples.",
      "Write a beginner-friendly, budget exercise plan.",
      "Recommend a book and guess why I'd like it.",
    ],
    coding: [
      "Create a small TypeScript CLI tool in this workspace.",
      "Inspect the files and write a short architecture summary.",
      "Run the unit tests and fix the failures.",
      "Create a README.md with setup, usage, and examples.",
      "Find duplicated code and refactor it.",
      "Write a tiny HTTP server and test it with curl.",
      "List all TODOs and resolve the easiest one.",
      "Reduce a function's complexity without changing behavior.",
      "Summarize git status and commit the changes.",
      "Write a small calculator library plus tests.",
    ],
  },
};

interface SuggestionsState {
  current: string[];
  /** Last shown set (per mode) so consecutive picks never repeat. */
  lastByMode: Partial<Record<Mode, string[]>>;
  refresh: (mode: Mode, language: string, seed: string) => void;
}

function pick3(pool: string[], avoid: string[], seed: string): string[] {
  // Deterministic-per-seed rotation + rejection of the previous set.
  let hash = 0;
  for (const char of seed) hash = (hash * 31 + char.charCodeAt(0)) % 1_000_003;
  const offset = hash % pool.length;
  const rotated = [...pool.slice(offset), ...pool.slice(0, offset)];
  const unique = rotated.filter((item) => !avoid.includes(item));
  const source = unique.length >= 3 ? unique : rotated;
  return source.slice(0, 3);
}

export const useSuggestions = create<SuggestionsState>((set, get) => ({
  current: [],
  lastByMode: {},

  refresh: (mode, language, seed) => {
    const lang = language.startsWith("tr") ? "tr" : "en";
    const pool = POOLS[lang][mode];
    const avoid = get().lastByMode[mode] ?? [];
    const jitter = String(Date.now() % 9973);
    const next = pick3(pool, avoid, `${seed}|${jitter}`);
    set({
      current: next,
      lastByMode: { ...get().lastByMode, [mode]: next },
    });
  },
}));

/** Test hook: fixed pools for assertions. */
export const SUGGESTION_POOLS = POOLS;
