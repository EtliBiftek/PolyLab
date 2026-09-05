import i18n from "i18next";
import { initReactI18next } from "react-i18next";

import en from "./en.json";
import tr from "./tr.json";

export const SUPPORTED_LANGUAGES = ["tr", "en"] as const;
export type AppLanguage = (typeof SUPPORTED_LANGUAGES)[number];

export const DEFAULT_LANGUAGE: AppLanguage = "tr";

/** Default to Turkish (product language); English is one click away in the sidebar. */
const initialLanguage = (): AppLanguage => {
  const stored = window.localStorage.getItem("polylab-language");
  if (stored === "tr" || stored === "en") return stored;
  const nav = window.navigator.language?.toLowerCase() ?? "";
  return nav.startsWith("tr") ? "tr" : "en";
};

void i18n.use(initReactI18next).init({
  resources: {
    tr: { translation: tr },
    en: { translation: en },
  },
  lng: initialLanguage(),
  fallbackLng: "en",
  interpolation: { escapeValue: false }, // React already escapes
});

window.localStorage.setItem("polylab-language", i18n.language);
i18n.on("languageChanged", (lng) => {
  window.localStorage.setItem("polylab-language", lng);
  document.documentElement.lang = lng;
});

export default i18n;
