import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        "bg-0": "var(--bg-0)",
        "bg-1": "var(--bg-1)",
        "bg-2": "var(--bg-2)",
        "bg-3": "var(--bg-3)",
        "bg-invert": "var(--bg-invert)",
        "txt-0": "var(--text-0)",
        "txt-1": "var(--text-1)",
        "txt-2": "var(--text-2)",
        "txt-invert": "var(--text-invert)",
        accent: "var(--accent)",
        "accent-2": "var(--accent-2)",
        border: "var(--border)",
        success: "var(--success)",
        warn: "var(--warn)",
        danger: "var(--danger)",
      },
      fontFamily: {
        sans: [
          "Inter",
          "Segoe UI",
          "system-ui",
          "-apple-system",
          "Roboto",
          "Helvetica Neue",
          "Arial",
          "sans-serif",
        ],
        serif: ["ui-serif", "Georgia", "Cambria", "Times New Roman", "serif"],
        mono: ["JetBrains Mono", "Cascadia Code", "Consolas", "ui-monospace", "monospace"],
      },
    },
  },
  plugins: [],
} satisfies Config;
