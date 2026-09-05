//! Git integration (plan §5.5) — shells out to the `git` CLI from the
//! conversation's workspace. Output is plain text the agent/renderer consumes.

use std::path::Path;

async fn run(root: &Path, args: &[&str]) -> anyhow::Result<String> {
    let output = tokio::process::Command::new("git")
        .arg("-C")
        .arg(root)
        .args(args)
        .output()
        .await?;
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    if !output.status.success() {
        anyhow::bail!("git {} failed: {}", args.join(" "), stderr.trim());
    }
    Ok(stdout)
}

pub fn is_repo(root: &Path) -> bool {
    root.join(".git").exists()
}

/// `status --porcelain=v1 --branch`; a clean tree reports "(clean)" after the
/// branch line (the branch header alone is not a change).
pub async fn status(root: &Path) -> anyhow::Result<String> {
    let out = run(root, &["status", "--porcelain=v1", "--branch"]).await?;
    let dirty = out.lines().any(|line| !line.starts_with("##") && !line.trim().is_empty());
    if dirty {
        Ok(out)
    } else {
        let branch = out.lines().next().unwrap_or("").to_string();
        Ok(format!("{branch}\n(clean)"))
    }
}

/// Unified diff of staged + unstaged changes (capped); untracked files are
/// appended by name since `git diff` never lists them.
pub async fn diff(root: &Path) -> anyhow::Result<String> {
    let mut out = run(root, &["diff", "HEAD"]).await?;
    if out.trim().is_empty() {
        out = run(root, &["diff"]).await?;
    }
    let untracked = run(root, &["ls-files", "--others", "--exclude-standard"]).await?;
    if !untracked.trim().is_empty() {
        out.push_str("\nİzlenmeyen dosyalar:\n");
        out.push_str(&untracked);
    }
    Ok(truncate(&out))
}

pub async fn log(root: &Path, limit: u32) -> anyhow::Result<String> {
    run(root, &["log", "--oneline", "-n", &limit.max(1).to_string()]).await
}

pub async fn commit(root: &Path, message: &str) -> anyhow::Result<String> {
    let staged = run(root, &["diff", "--cached", "--name-only"]).await?;
    if staged.trim().is_empty() {
        run(root, &["add", "-A"]).await?;
    }
    run(root, &["commit", "-m", message]).await?;
    run(root, &["log", "--oneline", "-n", "1"]).await
}

fn truncate(text: &str) -> String {
    const MAX: usize = 20_000;
    if text.len() <= MAX {
        return text.to_string();
    }
    format!("{}\n… (truncated)", &text[..MAX])
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn repo() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("polylab-git-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let git = |args: &[&str]| {
            let out = std::process::Command::new("git").arg("-C").arg(&dir).args(args).output().unwrap();
            assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        };
        git(&["init", "-q"]);
        git(&["config", "user.email", "test@polylab.local"]);
        git(&["config", "user.name", "PolyLab Test"]);
        std::fs::write(dir.join("a.txt"), "hello\n").unwrap();
        git(&["add", "-A"]);
        git(&["commit", "-q", "-m", "init"]);
        dir
    }

    #[tokio::test]
    async fn status_and_diff_and_commit() {
        let dir = repo();
        assert!(is_repo(&dir));
        let s0 = status(&dir).await.unwrap();
        assert!(s0.contains("clean"), "initial: {s0}");

        std::fs::write(dir.join("b.txt"), "change\n").unwrap();
        let status_out = status(&dir).await.unwrap();
        assert!(status_out.contains("b.txt"), "{status_out}");
        assert!(diff(&dir).await.unwrap().contains("b.txt"));
        assert!(log(&dir, 5).await.unwrap().contains("init"));
        assert!(commit(&dir, "add b").await.unwrap().contains("add b"));
        let s1 = status(&dir).await.unwrap();
        assert!(s1.contains("clean"), "final: {s1}");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
