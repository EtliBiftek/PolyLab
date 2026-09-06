//! Sandboxed filesystem tools for the coding agent (plan §5.3).
//!
//! Every path is resolved against `root` and rejected unless it stays inside it
//! (symlink-safe canonicalization where possible). Sizes are capped so a runaway
//! model cannot OOM the sidecar.

use std::path::{Path, PathBuf};

const MAX_READ_BYTES: u64 = 256 * 1024;
const MAX_WRITE_BYTES: usize = 512 * 1024;
const MAX_LIST_ENTRIES: usize = 500;
const MAX_LIST_DEPTH: u32 = 4;

/// Lexically normalizes `root.join(input)` and rejects anything that resolves
/// outside `root` (including `..` escapes and foreign absolute paths).
fn normalize_in(root: &Path, input: &str) -> anyhow::Result<PathBuf> {
    let rel = input.trim();
    if rel.is_empty() {
        return Ok(root.to_path_buf());
    }
    if Path::new(rel).is_absolute() {
        anyhow::bail!("absolute paths are not allowed: {input}");
    }
    let mut normalized = root.to_path_buf();
    for component in Path::new(rel).components() {
        match component {
            std::path::Component::ParentDir => {
                if !normalized.pop() {
                    anyhow::bail!("path escapes the workspace: {input}");
                }
            }
            std::path::Component::CurDir => {}
            std::path::Component::Normal(part) => normalized.push(part),
            other => anyhow::bail!("unsupported path component {other:?}: {input}"),
        }
    }
    if !normalized.starts_with(root) {
        anyhow::bail!("path escapes the workspace: {input}");
    }
    Ok(normalized)
}

/// Resolves `input` inside `root`; errors on escape attempts (lexical `..` and
/// absolute paths) and on symlink paths that would leave the canonical root.
pub fn resolve_in(root: &Path, input: &str) -> anyhow::Result<PathBuf> {
    let normalized = normalize_in(root, input)?;
    let canonical_root = root
        .canonicalize()
        .map_err(|error| anyhow::anyhow!("cannot resolve workspace root: {error}"))?;

    // Walk from the deepest existing ancestor so a symlink anywhere on the path
    // (including inside `root`) is followed and checked against the canonical
    // workspace root. Missing trailing components (new files) keep the check on
    // their parent.
    let mut existing = normalized.as_path();
    while !existing.exists() {
        let Some(parent) = existing.parent() else { break };
        if parent == existing {
            break;
        }
        existing = parent;
    }
    let canonical_existing = existing
        .canonicalize()
        .map_err(|error| anyhow::anyhow!("cannot resolve path component: {error}"))?;
    if !canonical_existing.starts_with(&canonical_root) {
        anyhow::bail!("path escapes the workspace (symlink detected): {input}");
    }
    Ok(normalized)
}

pub fn list(root: &Path, input: &str) -> anyhow::Result<String> {
    let base = resolve_in(root, input)?;
    anyhow::ensure!(base.exists(), "path does not exist: {}", base.display());
    let mut lines = Vec::new();
    walk(&base, "", 0, &mut lines)?;
    Ok(if lines.is_empty() {
        "(empty)".into()
    } else {
        lines.join("\n")
    })
}

fn walk(dir: &Path, prefix: &str, depth: u32, out: &mut Vec<String>) -> anyhow::Result<()> {
    if depth > MAX_LIST_DEPTH || out.len() >= MAX_LIST_ENTRIES {
        return Ok(());
    }
    let mut entries: Vec<_> = ::std::fs::read_dir(dir)?
        .filter_map(|entry| entry.ok())
        .collect();
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        if out.len() >= MAX_LIST_ENTRIES {
            out.push("… (truncated)".into());
            return Ok(());
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') || name == "node_modules" || name == "target" {
            continue;
        }
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
        let display = if prefix.is_empty() {
            name.clone()
        } else {
            format!("{prefix}/{name}")
        };
        if is_dir {
            out.push(format!("{display}/"));
            walk(&entry.path(), &display, depth + 1, out)?;
        } else {
            out.push(display);
        }
    }
    Ok(())
}

pub fn read(root: &Path, input: &str) -> anyhow::Result<String> {
    let path = resolve_in(root, input)?;
    let meta = ::std::fs::metadata(&path)?;
    anyhow::ensure!(meta.is_file(), "not a file: {}", path.display());
    anyhow::ensure!(meta.len() <= MAX_READ_BYTES, "file too large ({} bytes)", meta.len());
    Ok(::std::fs::read_to_string(&path)?)
}

pub fn write(root: &Path, input: &str, contents: &str) -> anyhow::Result<String> {
    anyhow::ensure!(contents.len() <= MAX_WRITE_BYTES, "write too large");
    let path = resolve_in(root, input)?;
    if let Some(parent) = path.parent() {
        ::std::fs::create_dir_all(parent)?;
    }
    ::std::fs::write(&path, contents)?;
    Ok(format!("wrote {} bytes to {}", contents.len(), input))
}

pub fn delete(root: &Path, input: &str) -> anyhow::Result<String> {
    let path = resolve_in(root, input)?;
    anyhow::ensure!(path != root, "refusing to delete the workspace root");
    let meta = ::std::fs::metadata(&path)?;
    anyhow::ensure!(meta.is_file(), "refusing to delete a directory (files only)");
    ::std::fs::remove_file(&path)?;
    Ok(format!("deleted {input}"))
}

/* --------------------------------------------------- workspace snapshot -- */

const SNAPSHOT_MAX_FILES: usize = 40;
const SNAPSHOT_MAX_BYTES: usize = 64 * 1024;
const SNAPSHOT_MAX_FILE_BYTES: u64 = 16 * 1024;
/// Files larger than this are never inlined (fs::read would reject them too).
const SNAPSHOT_READ_LIMIT: u64 = 256 * 1024;

/// Same exclusions as [`list`]: dotfiles, `node_modules`, `target`.
fn collect_files(dir: &Path, prefix: &str, depth: u32, out: &mut Vec<(String, u64)>) {
    if depth > MAX_LIST_DEPTH || out.len() >= MAX_LIST_ENTRIES {
        return;
    }
    let mut entries: Vec<_> = ::std::fs::read_dir(dir)
        .map(|read| read.filter_map(|entry| entry.ok()).collect())
        .unwrap_or_default();
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        if out.len() >= MAX_LIST_ENTRIES {
            return;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') || name == "node_modules" || name == "target" {
            continue;
        }
        let display = if prefix.is_empty() {
            name.clone()
        } else {
            format!("{prefix}/{name}")
        };
        let Ok(file_type) = entry.file_type() else { continue };
        // Symlinks are never followed — they could point outside the sandbox.
        if file_type.is_symlink() {
            continue;
        }
        if file_type.is_dir() {
            collect_files(&entry.path(), &display, depth + 1, out);
        } else if let Ok(meta) = entry.metadata() {
            out.push((display, meta.len()));
        }
    }
}

/// Cheap binary heuristic: NUL bytes almost never appear in hand-written text.
fn is_binary(bytes: &[u8]) -> bool {
    bytes.iter().take(4096).any(|byte| *byte == 0)
}

/// Bounded, deterministic project snapshot: file tree + inline text contents.
///
/// This is what makes project files visible to coding models without them having
/// to probe every path first. Binary / oversized / over-budget files are skipped
/// and reported so the model knows to `fs_read` them explicitly.
pub fn snapshot(root: &Path) -> anyhow::Result<String> {
    let base = resolve_in(root, "")?;
    anyhow::ensure!(base.exists(), "workspace does not exist: {}", base.display());

    let mut files: Vec<(String, u64)> = Vec::new();
    collect_files(&base, "", 0, &mut files);

    let mut body = String::new();
    let mut included: usize = 0;
    let mut skipped: usize = 0;
    for (rel, size) in files {
        if included >= SNAPSHOT_MAX_FILES || body.len() >= SNAPSHOT_MAX_BYTES {
            skipped += 1;
            continue;
        }
        if size > SNAPSHOT_MAX_FILE_BYTES || size > SNAPSHOT_READ_LIMIT {
            skipped += 1;
            continue;
        }
        let bytes = match ::std::fs::read(base.join(&rel)) {
            Ok(bytes) => bytes,
            Err(_) => {
                skipped += 1;
                continue;
            }
        };
        if is_binary(&bytes) || body.len() + bytes.len() > SNAPSHOT_MAX_BYTES {
            skipped += 1;
            continue;
        }
        body.push_str(&format!("## {rel}\n{}\n", String::from_utf8_lossy(&bytes)));
        included += 1;
    }

    let tree = list(root, "")?;
    let mut out = format!("# Dosya ağacı\n{tree}\n\n# Dosya içerikleri\n");
    if body.is_empty() {
        out.push_str("(içerik yok ya da tüm dosyalar atlandı)\n");
    } else {
        out.push_str(body.trim_end());
        out.push('\n');
    }
    if skipped > 0 {
        out.push_str(&format!(
            "\n(… {skipped} dosya atlandı: ikili, büyük veya bütçe dışı — tam içeriği `fs_read` ile oku)\n"
        ));
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_dir(prefix: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("{prefix}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn setup() -> PathBuf {
        let dir = tmp_dir("polylab-fs");
        std::fs::create_dir_all(dir.join("src/nested")).unwrap();
        std::fs::write(dir.join("src/main.rs"), "fn main() {}").unwrap();
        std::fs::write(dir.join("src/nested/util.rs"), "// util").unwrap();
        dir
    }

    #[test]
    fn resolve_blocks_escape() {
        let root = setup();
        assert!(resolve_in(&root, "../outside.txt").is_err());
        assert!(resolve_in(&root, "src/../../evil.txt").is_err());
        assert!(resolve_in(&root, "src/main.rs").is_ok());
        // Foreign absolute paths must be rejected, never silently remapped.
        assert!(resolve_in(&root, "/etc/passwd").is_err());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(unix)]
    #[test]
    fn resolve_blocks_symlink_escape() {
        let root = setup();
        let outside = root.parent().unwrap().join(format!("polylab-fs-outside-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("secret.txt"), "s3cret").unwrap();
        std::os::unix::fs::symlink(&outside, root.join("link")).unwrap();

        // Reading through the symlink must fail even though the lexical path
        // stays inside `root`.
        assert!(read(&root, "link/secret.txt").is_err());
        assert!(list(&root, "link").is_err());
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&outside);
    }

    #[test]
    fn list_read_write_delete_roundtrip() {
        let root = setup();
        let listing = list(&root, "").unwrap();
        assert!(listing.contains("src/main.rs"), "{listing}");
        assert!(listing.contains("src/nested/"), "{listing}");

        assert_eq!(read(&root, "src/main.rs").unwrap(), "fn main() {}");
        assert!(read(&root, "src/missing.rs").is_err());

        write(&root, "src/new/mod.rs", "pub fn x() -> u8 { 1 }").unwrap();
        assert!(read(&root, "src/new/mod.rs").unwrap().contains("x()"));
        assert!(delete(&root, "src/new/mod.rs").is_ok());
        assert!(read(&root, "src/new/mod.rs").is_err());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(unix)]
    #[test]
    fn snapshot_skips_symlinks_that_escape() {
        let root = setup();
        let outside = root
            .parent()
            .unwrap()
            .join(format!("polylab-fs-snap-outside-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("secret.txt"), "outside secret").unwrap();
        std::os::unix::fs::symlink(&outside, root.join("link")).unwrap();

        let snap = snapshot(&root).unwrap();
        // The symlink may be listed by name, but its target contents must never
        // be inlined into the model context.
        assert!(!snap.contains("outside secret"), "{snap}");
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&outside);
    }

    #[test]
    fn snapshot_inlines_text_files_and_skips_noise() {
        let root = setup();
        // Noise that must never reach the model context.
        std::fs::create_dir_all(root.join("node_modules/pkg")).unwrap();
        std::fs::write(root.join("node_modules/pkg/index.js"), "secret js").unwrap();
        std::fs::create_dir_all(root.join("target/debug")).unwrap();
        std::fs::write(root.join("target/debug/out.bin"), "secret bin").unwrap();
        std::fs::write(root.join(".env"), "SECRET=1").unwrap();
        // Binary + oversized files must be skipped, not inlined.
        std::fs::write(root.join("logo.png"), [0u8, 1, 2, 3, 4]).unwrap();
        std::fs::write(root.join("big.txt"), "x".repeat(SNAPSHOT_MAX_FILE_BYTES as usize + 1)).unwrap();

        let snap = snapshot(&root).unwrap();
        assert!(snap.contains("# Dosya ağacı"), "{snap}");
        assert!(snap.contains("src/main.rs"), "{snap}");
        assert!(snap.contains("## src/main.rs\nfn main() {}"), "{snap}");
        assert!(snap.contains("## src/nested/util.rs\n// util"), "{snap}");
        // Exclusions stay in the tree off-screen and never inline contents.
        assert!(!snap.contains("secret js"), "{snap}");
        assert!(!snap.contains("secret bin"), "{snap}");
        assert!(!snap.contains("SECRET=1"), "{snap}");
        // Binary / oversized are reported so the model can fs_read them.
        assert!(snap.contains("logo.png"), "{snap}");
        assert!(snap.contains("big.txt"), "{snap}");
        assert!(snap.contains("atlandı"), "{snap}");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn snapshot_reports_over_budget_files() {
        let root = tmp_dir("polylab-snap-budget");
        for i in 0..(SNAPSHOT_MAX_FILES + 5) {
            std::fs::write(root.join(format!("f{i:02}.txt")), format!("content {i}")).unwrap();
        }
        let snap = snapshot(&root).unwrap();
        assert!(snap.contains("## f00.txt\ncontent 0"), "{snap}");
        assert!(snap.contains("atlandı"), "{snap}");
        let _ = std::fs::remove_dir_all(&root);
    }
}
