use crate::aci::AciError;
use crate::path_guard::{assert_within_workspace, ContainmentOptions};
use serde_json::json;
use std::fs;
use std::io;
use std::path::Path;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PatchHunk {
    pub old_start: usize,
    pub old_len: usize,
    pub new_start: usize,
    pub new_len: usize,
    pub lines: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FilePatch {
    pub old_path: String,
    pub new_path: String,
    pub hunks: Vec<PatchHunk>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppliedPatch {
    pub path: String,
    pub hunk_count: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RejectedPatch {
    pub path: String,
    pub hunk_index: usize,
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApplyPatchResult {
    pub applied: Vec<AppliedPatch>,
    pub rejected: Vec<RejectedPatch>,
}

pub fn parse_unified_diff(patch: &str) -> Vec<FilePatch> {
    let lines: Vec<&str> = patch.lines().collect();
    let mut files = Vec::new();
    let mut cursor = 0;
    while cursor < lines.len() {
        if !lines[cursor].starts_with("--- ") {
            cursor += 1;
            continue;
        }
        let old_header = lines[cursor][4..].trim();
        let next_line = lines.get(cursor + 1).copied().unwrap_or_default();
        if !next_line.starts_with("+++ ") {
            cursor += 1;
            continue;
        }
        cursor += 2;
        let mut hunks = Vec::new();
        while cursor < lines.len() && lines[cursor].starts_with("@@") {
            let Some((old_start, old_len, new_start, new_len)) = parse_hunk_header(lines[cursor])
            else {
                cursor += 1;
                continue;
            };
            cursor += 1;
            let mut hunk_lines = Vec::new();
            while cursor < lines.len() {
                let candidate = lines[cursor];
                if candidate.starts_with("--- ") || candidate.starts_with("@@") {
                    break;
                }
                hunk_lines.push(candidate.to_string());
                cursor += 1;
            }
            hunks.push(PatchHunk {
                old_start,
                old_len,
                new_start,
                new_len,
                lines: hunk_lines,
            });
        }
        files.push(FilePatch {
            old_path: strip_diff_prefix(old_header),
            new_path: strip_diff_prefix(next_line[4..].trim()),
            hunks,
        });
    }
    files
}

pub fn apply_unified_patch(
    workspace_root: impl AsRef<Path>,
    patch: &str,
) -> Result<ApplyPatchResult, AciError> {
    let mut applied = Vec::new();
    let mut rejected = Vec::new();
    for file in parse_unified_diff(patch) {
        let target = if file.new_path.is_empty() || file.new_path == "/dev/null" {
            file.old_path.as_str()
        } else {
            file.new_path.as_str()
        };
        let target_path = match assert_within_workspace(
            &workspace_root,
            target,
            ContainmentOptions::ALLOW_MISSING,
        ) {
            Ok(path) => path,
            Err(error) => {
                rejected.push(RejectedPatch {
                    path: target.to_string(),
                    hunk_index: 0,
                    reason: error.to_string(),
                });
                continue;
            }
        };
        let original = match fs::read_to_string(&target_path) {
            Ok(content) => content,
            Err(error) if error.kind() == io::ErrorKind::NotFound => String::new(),
            Err(error) => return Err(error.into()),
        };
        let mut working = original
            .split('\n')
            .map(ToString::to_string)
            .collect::<Vec<_>>();
        let mut cursor_offset: isize = 0;
        let mut success = true;
        for (hunk_index, hunk) in file.hunks.iter().enumerate() {
            let start = (hunk.old_start as isize - 1 + cursor_offset).max(0) as usize;
            let (expected_old, replacement) = hunk_replacement(hunk);
            let actual_old = working
                .get(start..start.saturating_add(expected_old.len()))
                .unwrap_or(&[]);
            if actual_old != expected_old.as_slice() {
                rejected.push(RejectedPatch {
                    path: target.to_string(),
                    hunk_index,
                    reason: format!(
                        "hunk {} did not match at line {}",
                        hunk_index + 1,
                        hunk.old_start
                    ),
                });
                success = false;
                break;
            }
            working.splice(start..start + expected_old.len(), replacement.clone());
            cursor_offset += replacement.len() as isize - expected_old.len() as isize;
        }
        if success {
            fs::write(&target_path, working.join("\n"))?;
            applied.push(AppliedPatch {
                path: target.to_string(),
                hunk_count: file.hunks.len(),
            });
        }
    }
    Ok(ApplyPatchResult { applied, rejected })
}

pub fn apply_unified_patch_json(
    workspace_root: impl AsRef<Path>,
    patch: &str,
) -> Result<String, AciError> {
    let result = apply_unified_patch(workspace_root, patch)?;
    let applied = result
        .applied
        .iter()
        .map(|entry| json!({ "path": entry.path, "hunkCount": entry.hunk_count }))
        .collect::<Vec<_>>();
    let rejected = result
        .rejected
        .iter()
        .map(|entry| json!({ "path": entry.path, "hunkIndex": entry.hunk_index, "reason": entry.reason }))
        .collect::<Vec<_>>();
    Ok(json!({ "applied": applied, "rejected": rejected }).to_string())
}

pub fn parse_unified_diff_json(patch: &str) -> String {
    let files = parse_unified_diff(patch)
        .into_iter()
        .map(|file| {
            let hunks = file
                .hunks
                .into_iter()
                .map(|hunk| {
                    json!({
                        "oldStart": hunk.old_start,
                        "oldLen": hunk.old_len,
                        "newStart": hunk.new_start,
                        "newLen": hunk.new_len,
                        "lines": hunk.lines,
                    })
                })
                .collect::<Vec<_>>();
            json!({
                "oldPath": file.old_path,
                "newPath": file.new_path,
                "hunks": hunks,
            })
        })
        .collect::<Vec<_>>();
    json!(files).to_string()
}

fn hunk_replacement(hunk: &PatchHunk) -> (Vec<String>, Vec<String>) {
    let mut expected_old = Vec::new();
    let mut replacement = Vec::new();
    for line in &hunk.lines {
        if let Some(value) = line.strip_prefix(' ') {
            expected_old.push(value.to_string());
            replacement.push(value.to_string());
        } else if let Some(value) = line.strip_prefix('-') {
            expected_old.push(value.to_string());
        } else if let Some(value) = line.strip_prefix('+') {
            replacement.push(value.to_string());
        }
    }
    (expected_old, replacement)
}

fn parse_hunk_header(header: &str) -> Option<(usize, usize, usize, usize)> {
    let rest = header.strip_prefix("@@ -")?;
    let (old_range, rest) = rest.split_once(" +")?;
    let (new_range, _) = rest.split_once(" @@")?;
    let (old_start, old_len) = parse_range(old_range)?;
    let (new_start, new_len) = parse_range(new_range)?;
    Some((old_start, old_len, new_start, new_len))
}

fn parse_range(range: &str) -> Option<(usize, usize)> {
    match range.split_once(',') {
        Some((start, len)) => Some((start.parse().ok()?, len.parse().ok()?)),
        None => Some((range.parse().ok()?, 1)),
    }
}

fn strip_diff_prefix(header: &str) -> String {
    header
        .strip_prefix("a/")
        .or_else(|| header.strip_prefix("b/"))
        .unwrap_or(header)
        .split('\t')
        .next()
        .unwrap_or_default()
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::aci::{read_text_file, write_text_file};
    use std::path::{Path, PathBuf};

    fn workspace_root() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .and_then(Path::parent)
            .expect("workspace root")
            .to_path_buf()
    }

    #[test]
    fn parses_unified_diff_hunk() {
        let files =
            parse_unified_diff("--- a/x.txt\n+++ b/x.txt\n@@ -1,2 +1,2 @@\n alpha\n-beta\n+BETA\n");
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].new_path, "x.txt");
        assert_eq!(files[0].hunks.len(), 1);
        assert_eq!(files[0].hunks[0].old_start, 1);
        assert_eq!(files[0].hunks[0].old_len, 2);
        assert_eq!(files[0].hunks[0].new_start, 1);
        assert_eq!(files[0].hunks[0].new_len, 2);
    }

    #[test]
    fn renders_parse_json_with_typescript_contract_keys() {
        let json = parse_unified_diff_json("--- a/x.txt\n+++ b/x.txt\n@@ -1,2 +3,4 @@\n alpha\n");

        assert!(json.contains("\"oldPath\":\"x.txt\""));
        assert!(json.contains("\"oldStart\":1"));
        assert!(json.contains("\"newStart\":3"));
        assert!(json.contains("\"newLen\":4"));
    }

    #[test]
    fn applies_and_rejects_unified_patch() {
        let root = workspace_root();
        let relative = format!("target/unclecode-patch-test-{}.txt", std::process::id());
        write_text_file(&root, &relative, "alpha\nbeta\ngamma").expect("seed");
        let patch = format!(
            "--- a/{relative}\n+++ b/{relative}\n@@ -1,3 +1,3 @@\n alpha\n-beta\n+BETA\n gamma\n"
        );
        let result = apply_unified_patch(&root, &patch).expect("apply patch");
        assert_eq!(result.applied.len(), 1);
        assert!(result.rejected.is_empty());
        assert_eq!(
            read_text_file(&root, &relative).expect("read patched"),
            "alpha\nBETA\ngamma"
        );
        let rejected = apply_unified_patch(&root, &patch).expect("reject patch");
        assert!(rejected.applied.is_empty());
        assert_eq!(rejected.rejected.len(), 1);
        let _ = std::fs::remove_file(root.join(relative));
    }
}
