use std::fmt;
use std::fs;
use std::io;
use std::path::{Component, Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PathContainmentError {
    pub message: String,
    pub candidate: PathBuf,
    pub workspace_root: PathBuf,
}

impl PathContainmentError {
    fn new(
        message: impl Into<String>,
        candidate: impl Into<PathBuf>,
        workspace_root: impl Into<PathBuf>,
    ) -> Self {
        Self {
            message: message.into(),
            candidate: candidate.into(),
            workspace_root: workspace_root.into(),
        }
    }
}

impl fmt::Display for PathContainmentError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}: {}", self.message, self.candidate.display())
    }
}

impl std::error::Error for PathContainmentError {}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ContainmentOptions {
    pub allow_missing: bool,
}

impl ContainmentOptions {
    pub const EXISTING: Self = Self {
        allow_missing: false,
    };
    pub const ALLOW_MISSING: Self = Self {
        allow_missing: true,
    };
}

pub fn assert_within_workspace(
    workspace_root: impl AsRef<Path>,
    candidate: impl AsRef<Path>,
    options: ContainmentOptions,
) -> Result<PathBuf, PathContainmentError> {
    let workspace_root = workspace_root.as_ref();
    let candidate = candidate.as_ref();
    if candidate.as_os_str().is_empty() {
        return Err(PathContainmentError::new(
            "path is empty",
            candidate,
            workspace_root,
        ));
    }
    if candidate.to_string_lossy().contains('\0') {
        return Err(PathContainmentError::new(
            "path contains NUL byte",
            candidate,
            workspace_root,
        ));
    }
    if candidate.is_absolute() {
        return Err(PathContainmentError::new(
            "absolute path rejected",
            candidate,
            workspace_root,
        ));
    }
    if has_parent_component(candidate) {
        return Err(PathContainmentError::new(
            "path contains traversal segment",
            candidate,
            workspace_root,
        ));
    }

    let root = fs::canonicalize(workspace_root).map_err(|error| {
        PathContainmentError::new(
            format!("workspace root is not accessible: {error}"),
            candidate,
            workspace_root,
        )
    })?;
    let resolved = root.join(candidate);
    let canonical = canonicalize_candidate(&resolved, options.allow_missing).map_err(|error| {
        PathContainmentError::new(
            format!("path is not accessible: {error}"),
            candidate,
            workspace_root,
        )
    })?;

    if !canonical.starts_with(&root) {
        return Err(PathContainmentError::new(
            format!("path escapes workspace via {}", canonical.display()),
            candidate,
            workspace_root,
        ));
    }
    Ok(canonical)
}

pub fn assert_within_workspace_string(
    workspace_root: impl AsRef<Path>,
    candidate: impl AsRef<Path>,
    allow_missing: bool,
) -> Result<String, PathContainmentError> {
    let options = if allow_missing {
        ContainmentOptions::ALLOW_MISSING
    } else {
        ContainmentOptions::EXISTING
    };
    Ok(assert_within_workspace(workspace_root, candidate, options)?
        .to_string_lossy()
        .to_string())
}

fn has_parent_component(path: &Path) -> bool {
    path.components()
        .any(|component| matches!(component, Component::ParentDir))
}

fn canonicalize_candidate(path: &Path, allow_missing: bool) -> io::Result<PathBuf> {
    match fs::canonicalize(path) {
        Ok(path) => Ok(path),
        Err(error) if allow_missing => canonicalize_missing(path).or(Err(error)),
        Err(error) => Err(error),
    }
}

fn canonicalize_missing(path: &Path) -> io::Result<PathBuf> {
    let mut cursor = path;
    let mut tail = Vec::new();
    loop {
        match fs::canonicalize(cursor) {
            Ok(real) => {
                let mut resolved = real;
                for segment in tail.iter().rev() {
                    resolved.push(segment);
                }
                return Ok(resolved);
            }
            Err(error) => {
                let Some(parent) = cursor.parent() else {
                    return Err(error);
                };
                let Some(file_name) = cursor.file_name() else {
                    return Err(error);
                };
                tail.push(file_name.to_os_string());
                cursor = parent;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;
    use std::fs;

    #[test]
    fn rejects_absolute_and_parent_paths() {
        let root = env::current_dir().expect("cwd");

        assert!(assert_within_workspace(&root, "/tmp/file", ContainmentOptions::EXISTING).is_err());
        assert!(assert_within_workspace(&root, "../file", ContainmentOptions::EXISTING).is_err());
        assert!(assert_within_workspace(&root, "bad\0path", ContainmentOptions::EXISTING).is_err());
    }

    #[test]
    fn allows_missing_leaf_under_workspace() {
        let root = env::current_dir().expect("cwd");
        let path = assert_within_workspace(
            &root,
            "target/unclecode-missing-leaf.txt",
            ContainmentOptions::ALLOW_MISSING,
        )
        .expect("missing leaf inside workspace");

        assert!(path.ends_with("target/unclecode-missing-leaf.txt"));
    }

    #[test]
    fn renders_contained_path_as_string() {
        let root = env::current_dir().expect("cwd");
        let path = assert_within_workspace_string(&root, "target/unclecode-missing-leaf.txt", true)
            .expect("path string");

        assert!(path.ends_with("target/unclecode-missing-leaf.txt"));
    }

    #[test]
    fn rejects_symlink_escape() {
        let root = env::temp_dir().join(format!("unclecode-path-test-{}", std::process::id()));
        let outside = env::temp_dir();
        let link = root.join("escape");
        fs::create_dir_all(&root).expect("create root");

        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&outside, &link).expect("symlink");
            assert!(
                assert_within_workspace(&root, "escape", ContainmentOptions::EXISTING).is_err()
            );
        }

        let _ = fs::remove_dir_all(root);
    }
}
