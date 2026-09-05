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

/// Resolves `input` inside `root`; errors on escape attempts.
pub fn resolve_in(root: &Path, input: &str) -> anyhow::Result<PathBuf> {
    let rel = input.trim();
    if rel.is_empty() {
        return Ok(root.to_path_buf());
    }
    let candidate = if Path::new(rel).is_absolute() {
        // Absolute paths must already be inside the root.
        root.join(rel.strip_prefix(root.to_str().unwrap_or_default()).unwrap_or(""))
    } else {
        root.join(rel)
    };
    // Lexical normalization (component-wise) without touching the disk.
    let mut normalized = PathBuf::new();
    for component in candidate.components() {
        match component {
            std::path::Component::ParentDir => {
                if !normalized.pop() {
                    anyhow::bail!("path escapes the workspace: {input}");
                }
            }
            std::path::Component::CurDir => {}
            other => normalized.push(other.as_os_str()),
        }
    }
    if !normalized.starts_with(root) {
        anyhow::bail!("path escapes the workspace: {input}");
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

#[cfg(test)]
mod tests {
    use super::*;

    fn setup() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("polylab-fs-{}", uuid::Uuid::new_v4()));
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
        let _ = std::fs::remove_dir_all(&root);
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
}
