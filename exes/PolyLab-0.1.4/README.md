# PolyLab

Windows için çok modelli yapay zekâ çalışma alanı: tek modelle sohbet, **model gruplarıyla
turlu tartışma** (lider model nihai cevabı sentezler) ve proje klasöründe okuma/yazma
yapan, isteğe bağlı terminal erişimli **kodlama agent'ı**.

> Geliştirme planı fazları hâlinde uygulanır. Faz durumu ve test senaryoları:
> [`docs/PHASES.md`](docs/PHASES.md) · Mimari: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
> · WS olay sözleşmesi: [`docs/EVENTS.md`](docs/EVENTS.md)

## Mimari (kısaca)

```
Electron (TypeScript)  ──IPC──▶  React renderer (Vite + Tailwind + Zustand)
        │                              │  REST /health,/api…   WS /ws (streaming)
        │ spawn (port + token)         ▼
        └───────────────────────▶  Rust sidecar `polylab-core` (axum + tokio)
```

- Sidecar yalnızca `127.0.0.1`'e bağlanır; her istekte Electron'un ürettiği oturum
  token'ı doğrulanır (REST: `Authorization: Bearer`, WS: `?token=`).
- Electron kapanınca sidecar öldürülür.

## Geliştirme

Önkoşullar: Node ≥ 20, pnpm ≥ 9, Rust stable (`cargo`), Git.

```bash
pnpm install          # workspace kurulumu
cargo test            # core testleri (core/ dizininde)
pnpm build            # tüm paketleri derle + tip kontrolü
pnpm dev              # Vite + Electron; Electron sidecar'ı kendisi başlatır
```

Renderer'ı Electron olmadan (tarayıcıda) geliştirmek için:

```bash
pnpm dev:core         # sidecar: 127.0.0.1:43110, dev token "dev-token"
pnpm dev:renderer     # Vite /health, /api ve /ws proxy'lerini sidecar'a yönlendirir
```

> `dev:core` yalnızca yerel geliştirme içindir; üretimde token Electron tarafından
> rastgele üretilir ve preload köprüsü ile renderera aktarılır.

## Paketleme (Windows)

```bash
cd core && cargo build --release   # → core/target/release/polylab-core.exe
cd .. && pnpm package              # electron-builder → release/ altında NSIS kurulumu
```

Rust ikilisi `extraResources/bin/` altına gömülür; Electron main üretimde oradan
çalıştırır (`electron-builder.yml`).

## Depo düzeni

| Dizin | İçerik |
|---|---|
| `apps/desktop` | Electron main + preload + sidecar süpervizörü |
| `apps/renderer` | React arayüz (tema, i18n TR/EN, durum yönetimi) |
| `core` | Rust sidecar: sağlayıcılar, tartışma motoru, agent, depolama |
| `prompts` | Düzenlenebilir sistem promptları (markdown) |
| `docs` | Mimari, olay sözleşmesi, faz günlüğü |
