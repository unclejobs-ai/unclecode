use crate::path_guard::{assert_within_workspace, ContainmentOptions, PathContainmentError};
use serde_json::json;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DirEntryLine {
    pub kind: &'static str,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileView {
    pub content: String,
    pub abs_path: PathBuf,
    pub total_lines: usize,
    pub window_start: usize,
    pub window_end: usize,
    pub window: usize,
}

#[derive(Debug)]
pub enum AciError {
    Path(PathContainmentError),
    Io(io::Error),
}

impl From<PathContainmentError> for AciError {
    fn from(error: PathContainmentError) -> Self {
        Self::Path(error)
    }
}

impl From<io::Error> for AciError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}

impl std::fmt::Display for AciError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Path(error) => write!(formatter, "{error}"),
            Self::Io(error) => write!(formatter, "{error}"),
        }
    }
}

impl std::error::Error for AciError {}

pub fn list_files(
    workspace_root: impl AsRef<Path>,
    path: impl AsRef<Path>,
) -> Result<Vec<DirEntryLine>, AciError> {
    let target = assert_within_workspace(workspace_root, path, ContainmentOptions::EXISTING)?;
    let mut entries = Vec::new();
    for entry in fs::read_dir(target)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        entries.push(DirEntryLine {
            kind: if file_type.is_dir() { "dir" } else { "file" },
            name: entry.file_name().to_string_lossy().to_string(),
        });
    }
    entries.sort_by(|left, right| left.name.cmp(&right.name));
    Ok(entries)
}

pub fn read_text_file(
    workspace_root: impl AsRef<Path>,
    path: impl AsRef<Path>,
) -> Result<String, AciError> {
    let target = assert_within_workspace(workspace_root, path, ContainmentOptions::EXISTING)?;
    Ok(fs::read_to_string(target)?)
}

pub fn view_text_file(
    workspace_root: impl AsRef<Path>,
    path: impl AsRef<Path>,
    window: usize,
) -> Result<FileView, AciError> {
    view_text_file_window(workspace_root, path, window, 1)
}

pub fn view_text_file_window(
    workspace_root: impl AsRef<Path>,
    path: impl AsRef<Path>,
    window: usize,
    window_start: usize,
) -> Result<FileView, AciError> {
    let relative_path = path.as_ref().to_string_lossy().to_string();
    let target = assert_within_workspace(&workspace_root, path, ContainmentOptions::EXISTING)?;
    let content = fs::read_to_string(&target)?;
    let lines: Vec<&str> = content.split('\n').collect();
    let total_lines = lines.len();
    let window = window.max(1);
    let max_start = total_lines.saturating_sub(window).saturating_add(1).max(1);
    let window_start = window_start.clamp(1, max_start);
    let window_end = total_lines.min(window_start + window - 1);
    let above = window_start - 1;
    let below = total_lines.saturating_sub(window_end);
    let mut rendered = vec![
        format!("[File] {relative_path}"),
        format!("[Total] {total_lines} lines"),
        format!("[Window] lines {window_start}-{window_end} ({above} above, {below} below)"),
    ];
    rendered.extend(
        lines
            .iter()
            .skip(window_start - 1)
            .take(window_end.saturating_sub(window_start).saturating_add(1))
            .enumerate()
            .map(|(index, line)| format!("{}: {line}", window_start + index)),
    );
    Ok(FileView {
        content: rendered.join("\n"),
        abs_path: target,
        total_lines,
        window_start,
        window_end,
        window,
    })
}

pub fn view_text_file_json(
    workspace_root: impl AsRef<Path>,
    path: impl AsRef<Path>,
    window: usize,
    window_start: usize,
) -> Result<String, AciError> {
    let relative_path = path.as_ref().to_string_lossy().to_string();
    let view = view_text_file_window(workspace_root, path, window, window_start)?;
    Ok(json!({
        "state": {
            "path": relative_path,
            "absPath": view.abs_path.to_string_lossy(),
            "totalLines": view.total_lines,
            "windowStart": view.window_start,
            "windowEnd": view.window_end,
            "window": view.window,
        },
        "content": view.content,
    })
    .to_string())
}

pub fn write_text_file(
    workspace_root: impl AsRef<Path>,
    path: impl AsRef<Path>,
    content: &str,
) -> Result<(), AciError> {
    let target = assert_within_workspace(workspace_root, path, ContainmentOptions::ALLOW_MISSING)?;
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(target, content)?;
    Ok(())
}

pub fn delete_text_file(
    workspace_root: impl AsRef<Path>,
    path: impl AsRef<Path>,
) -> Result<(), AciError> {
    let target = assert_within_workspace(workspace_root, path, ContainmentOptions::EXISTING)?;
    fs::remove_file(target)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::{Path, PathBuf};

    fn workspace_root() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .and_then(Path::parent)
            .expect("workspace root")
            .to_path_buf()
    }

    #[test]
    fn reads_and_lists_workspace_files() {
        let root = workspace_root();
        let entries = list_files(&root, "rust").expect("list rust dir");
        assert!(entries.iter().any(|entry| entry.name == "unclecode-core"));

        let content = read_text_file(&root, "Cargo.toml").expect("read cargo toml");
        assert!(content.contains("[workspace]"));
    }

    #[test]
    fn views_text_file_with_viewer_header() {
        let root = workspace_root();
        let view = view_text_file(&root, "Cargo.toml", 3).expect("view cargo toml");
        assert!(view.content.contains("[File] Cargo.toml"));
        assert!(view.content.contains("[Window] lines 1-3"));
        assert_eq!(view.window_start, 1);
        assert_eq!(view.window_end, 3);
    }

    #[test]
    fn views_text_file_with_shifted_window_json() {
        let root = workspace_root();
        let view = view_text_file_window(&root, "Cargo.toml", 2, 2).expect("view cargo toml");

        assert!(view.content.contains("[Window] lines 2-3"));
        assert!(view.content.contains("2: "));
        assert_eq!(view.window_start, 2);
        assert_eq!(view.window_end, 3);

        let json = view_text_file_json(&root, "Cargo.toml", 2, 2).expect("json view");
        assert!(json.contains("\"windowStart\":2"));
        assert!(json.contains("\"content\""));
    }

    #[test]
    fn writes_missing_leaf_inside_workspace() {
        let root = workspace_root();
        let relative = format!("target/unclecode-write-test-{}.txt", std::process::id());

        write_text_file(&root, &relative, "hello from rust").expect("write text");
        let content = read_text_file(&root, &relative).expect("read written file");

        assert_eq!(content, "hello from rust");
        let _ = std::fs::remove_file(root.join(relative));
    }

    #[test]
    fn deletes_existing_file_inside_workspace() {
        let root = workspace_root();
        let relative = format!("target/unclecode-delete-test-{}.txt", std::process::id());

        write_text_file(&root, &relative, "to be removed").expect("seed file");
        delete_text_file(&root, &relative).expect("delete file");

        assert!(!root.join(&relative).exists());
        assert!(read_text_file(&root, &relative).is_err());
    }

    #[test]
    fn delete_rejects_paths_outside_workspace() {
        let root = workspace_root();
        assert!(delete_text_file(&root, "../../../etc/hosts").is_err());
    }
}
