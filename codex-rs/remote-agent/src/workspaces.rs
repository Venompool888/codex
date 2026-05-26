use std::path::Path;
use std::path::PathBuf;
use std::time::UNIX_EPOCH;

use anyhow::Context;
use std::io::Read;
use tokio::process::Command;

use crate::models::DiffFile;
use crate::models::DiffSummary;
use crate::models::FileEntry;
use crate::models::FileEntryKind;
use crate::models::Workspace;

const MAX_FILE_ENTRIES: usize = 1_000;
const MAX_FILE_READ_BYTES: u64 = 1_000_000;
const WORKSPACE_ID_HASH_BYTES: usize = 8;

#[derive(Clone, Debug)]
pub(crate) struct WorkspaceRoot {
    id: String,
    legacy_id: String,
    root: PathBuf,
}

impl WorkspaceRoot {
    #[cfg(test)]
    pub(crate) fn new(id: String, root: PathBuf) -> anyhow::Result<Self> {
        let root = root
            .canonicalize()
            .with_context(|| format!("failed to canonicalize workspace root {}", root.display()))?;
        Ok(Self {
            id,
            legacy_id: "workspace-1".to_string(),
            root,
        })
    }

    pub(crate) fn from_config_entry(index: usize, root: PathBuf) -> anyhow::Result<Self> {
        let root = root
            .canonicalize()
            .with_context(|| format!("failed to canonicalize workspace root {}", root.display()))?;
        Ok(Self {
            id: stable_workspace_id(&root),
            legacy_id: legacy_workspace_id(index),
            root,
        })
    }

    pub(crate) fn id(&self) -> &str {
        &self.id
    }

    pub(crate) fn matches_workspace_id(&self, workspace_id: &str) -> bool {
        workspace_id == self.id || workspace_id == self.legacy_id
    }

    pub(crate) fn root(&self) -> &Path {
        &self.root
    }

    pub(crate) async fn to_workspace(&self, last_session_id: Option<String>) -> Workspace {
        Workspace {
            id: self.id.clone(),
            display_name: self
                .root()
                .file_name()
                .map(|file_name| file_name.to_string_lossy().into_owned())
                .unwrap_or_else(|| self.root().display().to_string()),
            path: self.root().display().to_string(),
            branch: current_branch(&self.root).await.ok(),
            dirty: is_dirty(&self.root).await.unwrap_or(false),
            last_session_id,
            error: None,
        }
    }

    pub(crate) fn resolve_relative(&self, relative: &str) -> anyhow::Result<PathBuf> {
        let candidate = self.root.join(relative);
        let canonical = if candidate.exists() {
            candidate
                .canonicalize()
                .with_context(|| format!("failed to canonicalize {}", candidate.display()))?
        } else {
            let parent = candidate
                .parent()
                .unwrap_or(self.root.as_path())
                .canonicalize()?;
            let Some(file_name) = candidate.file_name() else {
                return ensure_workspace_path(&self.root, parent);
            };
            parent.join(file_name)
        };
        ensure_workspace_path(&self.root, canonical)
    }

    pub(crate) fn list_files(&self, relative: &str) -> anyhow::Result<Vec<FileEntry>> {
        let path = self.resolve_relative(relative)?;
        let mut entries = Vec::new();
        list_files_inner(&self.root, &path, &mut entries)?;
        entries.sort_by(|left, right| left.path.cmp(&right.path));
        Ok(entries)
    }

    pub(crate) fn read_file(&self, relative: &str) -> anyhow::Result<String> {
        let path = self.root.join(relative);
        let canonical = path
            .canonicalize()
            .with_context(|| format!("failed to canonicalize {}", path.display()))?;
        ensure_workspace_path(&self.root, canonical)?;
        let mut file = open_file_no_follow(&path)?;
        let metadata = file
            .metadata()
            .with_context(|| format!("failed to read metadata for {}", path.display()))?;
        if metadata.is_dir() {
            anyhow::bail!("path is a directory");
        }
        if metadata.len() > MAX_FILE_READ_BYTES {
            anyhow::bail!("file is too large");
        }
        let mut contents = String::new();
        file.read_to_string(&mut contents)
            .with_context(|| format!("failed to read file {}", path.display()))?;
        Ok(contents)
    }

    pub(crate) async fn diff_summary(&self) -> anyhow::Result<DiffSummary> {
        let output = Command::new("git")
            .arg("-C")
            .arg(&self.root)
            .arg("diff")
            .arg("--numstat")
            .arg("HEAD")
            .output()
            .await
            .with_context(|| format!("failed to run git diff in {}", self.root.display()))?;
        if !output.status.success() {
            anyhow::bail!(
                "git diff failed: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            );
        }

        let stdout = String::from_utf8(output.stdout).context("git diff output was not UTF-8")?;
        let mut files = Vec::new();
        let mut additions = 0;
        let mut deletions = 0;
        for line in stdout.lines() {
            let mut parts = line.split('\t');
            let file_additions = parts.next().unwrap_or_default().parse().unwrap_or(0);
            let file_deletions = parts.next().unwrap_or_default().parse().unwrap_or(0);
            let Some(path) = parts.next() else {
                continue;
            };
            additions += file_additions;
            deletions += file_deletions;
            files.push(DiffFile {
                path: path.to_string(),
                status: "modified".to_string(),
                additions: file_additions,
                deletions: file_deletions,
            });
        }
        for path in untracked_files(&self.root).await? {
            let file_additions = untracked_file_additions(&self.root, &path).unwrap_or(0);
            additions += file_additions;
            files.push(DiffFile {
                path,
                status: "untracked".to_string(),
                additions: file_additions,
                deletions: 0,
            });
        }
        files.sort_by(|left, right| left.path.cmp(&right.path));

        Ok(DiffSummary {
            files,
            additions,
            deletions,
        })
    }
}

#[cfg(unix)]
fn open_file_no_follow(path: &Path) -> anyhow::Result<std::fs::File> {
    use std::os::unix::fs::OpenOptionsExt;

    std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)
        .with_context(|| format!("failed to open file {}", path.display()))
}

#[cfg(not(unix))]
fn open_file_no_follow(path: &Path) -> anyhow::Result<std::fs::File> {
    std::fs::OpenOptions::new()
        .read(true)
        .open(path)
        .with_context(|| format!("failed to open file {}", path.display()))
}

pub(crate) struct UnavailableWorkspace {
    id: String,
    path: PathBuf,
    error: String,
}

impl UnavailableWorkspace {
    fn new(index: usize, path: PathBuf, error: anyhow::Error) -> Self {
        Self {
            id: legacy_workspace_id(index),
            path,
            error: error.to_string(),
        }
    }

    pub(crate) fn to_workspace(&self) -> Workspace {
        Workspace {
            id: self.id.clone(),
            display_name: self
                .path
                .file_name()
                .map(|file_name| file_name.to_string_lossy().into_owned())
                .unwrap_or_else(|| self.path.display().to_string()),
            path: self.path.display().to_string(),
            branch: None,
            dirty: false,
            last_session_id: None,
            error: Some(self.error.clone()),
        }
    }
}

pub(crate) enum WorkspaceConfigEntry {
    Available(WorkspaceRoot),
    Unavailable(UnavailableWorkspace),
}

#[cfg(test)]
pub(crate) fn workspace_roots(paths: &[PathBuf]) -> Vec<WorkspaceRoot> {
    paths
        .iter()
        .enumerate()
        .filter_map(|(index, path)| WorkspaceRoot::from_config_entry(index, path.clone()).ok())
        .collect()
}

pub(crate) fn workspace_config_entries(paths: &[PathBuf]) -> Vec<WorkspaceConfigEntry> {
    paths
        .iter()
        .enumerate()
        .map(
            |(index, path)| match WorkspaceRoot::from_config_entry(index, path.clone()) {
                Ok(root) => WorkspaceConfigEntry::Available(root),
                Err(error) => WorkspaceConfigEntry::Unavailable(UnavailableWorkspace::new(
                    index,
                    path.clone(),
                    error,
                )),
            },
        )
        .collect()
}

pub(crate) fn workspace_root_by_id(
    paths: &[PathBuf],
    workspace_id: &str,
) -> anyhow::Result<Option<WorkspaceRoot>> {
    for (index, path) in paths.iter().enumerate() {
        if !workspace_id_matches_entry(index, path, workspace_id) {
            continue;
        }
        return WorkspaceRoot::from_config_entry(index, path.clone()).map(Some);
    }
    Ok(None)
}

fn workspace_id_matches_entry(index: usize, path: &Path, workspace_id: &str) -> bool {
    if workspace_id == legacy_workspace_id(index) {
        return true;
    }

    let Ok(canonical) = path.canonicalize() else {
        return false;
    };
    workspace_id == stable_workspace_id(&canonical)
}

fn legacy_workspace_id(index: usize) -> String {
    let legacy_index = index + 1;
    format!("workspace-{legacy_index}")
}

fn stable_workspace_id(path: &Path) -> String {
    use base64::Engine;
    use sha2::Digest;

    let digest = sha2::Sha256::digest(path.to_string_lossy().as_bytes());
    let suffix =
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(&digest[..WORKSPACE_ID_HASH_BYTES]);
    format!("workspace-{suffix}")
}

fn ensure_workspace_path(root: &Path, path: PathBuf) -> anyhow::Result<PathBuf> {
    if !path.starts_with(root) {
        anyhow::bail!("path escapes workspace");
    }
    Ok(path)
}

fn list_files_inner(root: &Path, path: &Path, entries: &mut Vec<FileEntry>) -> anyhow::Result<()> {
    let metadata = std::fs::symlink_metadata(path)
        .with_context(|| format!("failed to read metadata for {}", path.display()))?;
    if metadata.is_file() || metadata.file_type().is_symlink() {
        entries.push(file_entry(root, path, &metadata)?);
        return Ok(());
    }

    for entry in std::fs::read_dir(path)
        .with_context(|| format!("failed to read directory {}", path.display()))?
    {
        let entry = entry.with_context(|| format!("failed to read entry in {}", path.display()))?;
        let entry_path = entry.path();
        let metadata = std::fs::symlink_metadata(&entry_path)
            .with_context(|| format!("failed to read metadata for {}", entry_path.display()))?;
        entries.push(file_entry(root, &entry_path, &metadata)?);
        if entries.len() > MAX_FILE_ENTRIES {
            anyhow::bail!("too many file entries");
        }
    }

    Ok(())
}

fn file_entry(root: &Path, path: &Path, metadata: &std::fs::Metadata) -> anyhow::Result<FileEntry> {
    let entry_metadata = if metadata.file_type().is_symlink() {
        let canonical = path
            .canonicalize()
            .with_context(|| format!("failed to canonicalize {}", path.display()))?;
        ensure_workspace_path(root, canonical)?;
        std::fs::metadata(path)
            .with_context(|| format!("failed to read metadata for {}", path.display()))?
    } else {
        metadata.clone()
    };
    let path = path
        .strip_prefix(root)
        .with_context(|| format!("failed to make {} relative to workspace", path.display()))?
        .to_string_lossy()
        .replace('\\', "/");
    let modified_at = entry_metadata
        .modified()
        .ok()
        .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
        .and_then(|duration| i64::try_from(duration.as_secs()).ok());
    let kind = if entry_metadata.is_dir() {
        FileEntryKind::Directory
    } else {
        FileEntryKind::File
    };
    let size = if entry_metadata.is_file() {
        entry_metadata.len()
    } else {
        0
    };

    Ok(FileEntry {
        path,
        kind,
        size,
        modified_at,
    })
}

async fn untracked_files(root: &Path) -> anyhow::Result<Vec<String>> {
    let output = Command::new("git")
        .arg("-C")
        .arg(root)
        .arg("ls-files")
        .arg("--others")
        .arg("--exclude-standard")
        .output()
        .await
        .with_context(|| format!("failed to run git ls-files in {}", root.display()))?;
    if !output.status.success() {
        anyhow::bail!(
            "git ls-files failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }
    let stdout = String::from_utf8(output.stdout).context("git ls-files output was not UTF-8")?;
    Ok(stdout.lines().map(str::to_string).collect())
}

fn untracked_file_additions(root: &Path, relative: &str) -> anyhow::Result<u64> {
    let path = root.join(relative);
    let canonical = path
        .canonicalize()
        .with_context(|| format!("failed to canonicalize {}", path.display()))?;
    ensure_workspace_path(root, canonical)?;
    let mut file = open_file_no_follow(&path)?;
    let metadata = file
        .metadata()
        .with_context(|| format!("failed to read metadata for {}", path.display()))?;
    if !metadata.is_file() || metadata.len() > MAX_FILE_READ_BYTES {
        return Ok(0);
    }
    let mut contents = String::new();
    file.read_to_string(&mut contents)
        .with_context(|| format!("failed to read file {}", path.display()))?;
    Ok(contents.lines().count() as u64)
}

async fn current_branch(root: &Path) -> anyhow::Result<String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(root)
        .arg("branch")
        .arg("--show-current")
        .output()
        .await
        .with_context(|| format!("failed to run git branch in {}", root.display()))?;
    if !output.status.success() {
        anyhow::bail!("git branch failed");
    }
    let branch = String::from_utf8(output.stdout)
        .context("git branch output was not UTF-8")?
        .trim()
        .to_string();
    if branch.is_empty() {
        anyhow::bail!("git branch returned no branch");
    }
    Ok(branch)
}

async fn is_dirty(root: &Path) -> anyhow::Result<bool> {
    let output = Command::new("git")
        .arg("-C")
        .arg(root)
        .arg("status")
        .arg("--porcelain")
        .output()
        .await
        .with_context(|| format!("failed to run git status in {}", root.display()))?;
    if !output.status.success() {
        anyhow::bail!("git status failed");
    }
    Ok(!output.stdout.is_empty())
}

#[cfg(test)]
mod tests {
    use std::fs;

    use pretty_assertions::assert_eq;
    use tempfile::TempDir;

    use super::*;

    #[tokio::test]
    async fn workspace_roots_use_stable_ids_when_cli_order_changes() {
        let temp_dir = TempDir::new().unwrap();
        let first_workspace = temp_dir.path().join("first");
        let second_workspace = temp_dir.path().join("second");
        fs::create_dir_all(&first_workspace).unwrap();
        fs::create_dir_all(&second_workspace).unwrap();

        let original = workspace_roots(&[first_workspace.clone(), second_workspace.clone()])
            .into_iter()
            .map(|root| (root.root().to_path_buf(), root.id().to_string()))
            .collect::<Vec<_>>();
        let reordered = workspace_roots(&[second_workspace, first_workspace])
            .into_iter()
            .map(|root| (root.root().to_path_buf(), root.id().to_string()))
            .collect::<Vec<_>>();

        assert_eq!(original[0], reordered[1]);
        assert_eq!(original[1], reordered[0]);
        assert_ne!(original[0].1, "workspace-1");
        assert_ne!(original[1].1, "workspace-2");
    }

    #[tokio::test]
    async fn workspace_roots_skip_bad_entries() {
        let temp_dir = TempDir::new().unwrap();
        let workspace_dir = temp_dir.path().join("workspace");
        let missing_dir = temp_dir.path().join("missing");
        fs::create_dir_all(&workspace_dir).unwrap();

        let roots = workspace_roots(&[missing_dir, workspace_dir.clone()]);

        assert_eq!(roots.len(), 1);
        assert_eq!(roots[0].root(), workspace_dir.canonicalize().unwrap());
    }

    #[tokio::test]
    async fn rejects_path_traversal_outside_workspace() {
        let temp_dir = TempDir::new().unwrap();
        let workspace_dir = temp_dir.path().join("workspace");
        let outside_dir = temp_dir.path().join("outside");
        fs::create_dir_all(&workspace_dir).unwrap();
        fs::create_dir_all(&outside_dir).unwrap();
        fs::write(outside_dir.join("secret.txt"), "secret").unwrap();
        let root = WorkspaceRoot::new("workspace-1".to_string(), workspace_dir).unwrap();

        let error = root.resolve_relative("../outside/secret.txt").unwrap_err();

        assert!(error.to_string().contains("path escapes workspace"));
    }

    #[tokio::test]
    async fn lists_files_relative_to_workspace() {
        let temp_dir = TempDir::new().unwrap();
        let workspace_dir = temp_dir.path().join("workspace");
        fs::create_dir_all(workspace_dir.join("src")).unwrap();
        fs::write(workspace_dir.join("README.md"), "hello").unwrap();
        fs::write(workspace_dir.join("src/main.rs"), "fn main() {}\n").unwrap();
        let root = WorkspaceRoot::new("workspace-1".to_string(), workspace_dir).unwrap();

        let entries = root.list_files("").unwrap();

        assert_eq!(
            entries,
            vec![
                crate::models::FileEntry {
                    path: "README.md".to_string(),
                    kind: crate::models::FileEntryKind::File,
                    size: 5,
                    modified_at: entries[0].modified_at,
                },
                crate::models::FileEntry {
                    path: "src".to_string(),
                    kind: crate::models::FileEntryKind::Directory,
                    size: 0,
                    modified_at: entries[1].modified_at,
                },
            ]
        );
    }

    #[tokio::test]
    async fn rejects_file_reads_over_size_limit() {
        let temp_dir = TempDir::new().unwrap();
        let workspace_dir = temp_dir.path().join("workspace");
        fs::create_dir_all(&workspace_dir).unwrap();
        fs::write(
            workspace_dir.join("large.txt"),
            vec![b'x'; MAX_FILE_READ_BYTES as usize + 1],
        )
        .unwrap();
        let root = WorkspaceRoot::new("workspace-1".to_string(), workspace_dir).unwrap();

        let error = root.read_file("large.txt").unwrap_err();

        assert!(error.to_string().contains("file is too large"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn rejects_symlink_file_read_even_when_target_stays_in_workspace() {
        use std::os::unix::fs::symlink;

        let temp_dir = TempDir::new().unwrap();
        let workspace_dir = temp_dir.path().join("workspace");
        fs::create_dir_all(&workspace_dir).unwrap();
        fs::write(workspace_dir.join("target.txt"), "hello").unwrap();
        symlink(
            workspace_dir.join("target.txt"),
            workspace_dir.join("link.txt"),
        )
        .unwrap();
        let root = WorkspaceRoot::new("workspace-1".to_string(), workspace_dir).unwrap();

        let error = root.read_file("link.txt").unwrap_err();

        assert!(error.to_string().contains("failed to open file"));
    }

    #[tokio::test]
    async fn diff_summary_includes_staged_tracked_changes() {
        let temp_dir = TempDir::new().unwrap();
        let workspace_dir = temp_dir.path().join("workspace");
        fs::create_dir_all(&workspace_dir).unwrap();
        run_git(&workspace_dir, &["init"]).await;
        run_git(
            &workspace_dir,
            &["config", "user.email", "test@example.com"],
        )
        .await;
        run_git(&workspace_dir, &["config", "user.name", "Test User"]).await;
        fs::write(workspace_dir.join("README.md"), "hello\n").unwrap();
        run_git(&workspace_dir, &["add", "README.md"]).await;
        run_git(&workspace_dir, &["commit", "-m", "baseline"]).await;
        fs::write(workspace_dir.join("README.md"), "hello\nworld\n").unwrap();
        run_git(&workspace_dir, &["add", "README.md"]).await;
        let root = WorkspaceRoot::new("workspace-1".to_string(), workspace_dir).unwrap();

        let summary = root.diff_summary().await.unwrap();

        assert_eq!(
            summary,
            crate::models::DiffSummary {
                files: vec![crate::models::DiffFile {
                    path: "README.md".to_string(),
                    status: "modified".to_string(),
                    additions: 1,
                    deletions: 0,
                }],
                additions: 1,
                deletions: 0,
            }
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn rejects_symlink_escape_outside_workspace() {
        use std::os::unix::fs::symlink;

        let temp_dir = TempDir::new().unwrap();
        let workspace_dir = temp_dir.path().join("workspace");
        let outside_dir = temp_dir.path().join("outside");
        fs::create_dir_all(&workspace_dir).unwrap();
        fs::create_dir_all(&outside_dir).unwrap();
        fs::write(outside_dir.join("secret.txt"), "secret").unwrap();
        symlink(
            outside_dir.join("secret.txt"),
            workspace_dir.join("secret-link"),
        )
        .unwrap();
        let root = WorkspaceRoot::new("workspace-1".to_string(), workspace_dir).unwrap();

        let error = root.resolve_relative("secret-link").unwrap_err();

        assert!(error.to_string().contains("path escapes workspace"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn rejects_symlink_directory_escape_while_listing() {
        use std::os::unix::fs::symlink;

        let temp_dir = TempDir::new().unwrap();
        let workspace_dir = temp_dir.path().join("workspace");
        let outside_dir = temp_dir.path().join("outside");
        fs::create_dir_all(&workspace_dir).unwrap();
        fs::create_dir_all(&outside_dir).unwrap();
        fs::write(outside_dir.join("secret.txt"), "secret").unwrap();
        symlink(&outside_dir, workspace_dir.join("outside-link")).unwrap();
        let root = WorkspaceRoot::new("workspace-1".to_string(), workspace_dir).unwrap();

        let error = root.list_files("").unwrap_err();

        assert!(error.to_string().contains("path escapes workspace"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn symlink_cycle_lists_one_level_without_recursing() {
        use std::os::unix::fs::symlink;

        let temp_dir = TempDir::new().unwrap();
        let workspace_dir = temp_dir.path().join("workspace");
        fs::create_dir_all(&workspace_dir).unwrap();
        fs::write(workspace_dir.join("README.md"), "hello").unwrap();
        symlink(&workspace_dir, workspace_dir.join("root-link")).unwrap();
        let root = WorkspaceRoot::new("workspace-1".to_string(), workspace_dir).unwrap();

        let entries = root.list_files("").unwrap();

        assert_eq!(
            entries,
            vec![
                crate::models::FileEntry {
                    path: "README.md".to_string(),
                    kind: crate::models::FileEntryKind::File,
                    size: 5,
                    modified_at: entries[0].modified_at,
                },
                crate::models::FileEntry {
                    path: "root-link".to_string(),
                    kind: crate::models::FileEntryKind::Directory,
                    size: 0,
                    modified_at: entries[1].modified_at,
                },
            ]
        );
    }

    async fn run_git(repo: &Path, args: &[&str]) {
        let output = Command::new("git")
            .arg("-C")
            .arg(repo)
            .args(args)
            .output()
            .await
            .unwrap_or_else(|error| panic!("failed to run git {args:?}: {error}"));
        assert!(
            output.status.success(),
            "git {args:?} failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
}
