use crate::aci::AciError;
use crate::path_guard::{assert_within_workspace, ContainmentOptions};
use serde_json::json;
use std::fs;
use std::path::Path;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LineEditResult {
    Applied {
        abs_path: String,
        content_preview: String,
        original_content: String,
        proposed_content: String,
    },
    OutOfRange {
        total_lines: usize,
        error_message: String,
    },
}

pub fn line_edit(
    workspace_root: impl AsRef<Path>,
    path: impl AsRef<Path>,
    start_line: usize,
    end_line: usize,
    replacement: &str,
) -> Result<LineEditResult, AciError> {
    let target = assert_within_workspace(&workspace_root, path, ContainmentOptions::EXISTING)?;
    let original = fs::read_to_string(&target)?;
    let lines = original.split('\n').collect::<Vec<_>>();
    if start_line < 1 || end_line > lines.len() || start_line > end_line.saturating_add(1) {
        return Ok(LineEditResult::OutOfRange {
            total_lines: lines.len(),
            error_message: format!(
                "start={start_line} end={end_line} outside 1..{}",
                lines.len()
            ),
        });
    }

    let replacement_lines = replacement.split('\n').collect::<Vec<_>>();
    let mut next_lines = Vec::new();
    next_lines.extend_from_slice(&lines[..start_line - 1]);
    next_lines.extend(replacement_lines.iter().copied());
    next_lines.extend_from_slice(&lines[end_line..]);
    let proposed = next_lines.join("\n");
    fs::write(&target, &proposed)?;

    let preview_start = start_line.saturating_sub(3);
    let preview_end = next_lines
        .len()
        .min(start_line - 1 + replacement_lines.len() + 2);
    let content_preview = numbered_snippet(&next_lines, preview_start, preview_end);

    Ok(LineEditResult::Applied {
        abs_path: target.to_string_lossy().to_string(),
        content_preview,
        original_content: original,
        proposed_content: proposed,
    })
}

pub fn restore_file(
    workspace_root: impl AsRef<Path>,
    path: impl AsRef<Path>,
    content: &str,
) -> Result<(), AciError> {
    let target = assert_within_workspace(workspace_root, path, ContainmentOptions::EXISTING)?;
    fs::write(target, content)?;
    Ok(())
}

pub fn line_edit_json(
    workspace_root: impl AsRef<Path>,
    path: impl AsRef<Path>,
    start_line: usize,
    end_line: usize,
    replacement: &str,
) -> Result<String, AciError> {
    match line_edit(workspace_root, path, start_line, end_line, replacement)? {
        LineEditResult::Applied {
            abs_path,
            content_preview,
            original_content,
            proposed_content,
        } => Ok(json!({
            "status": "applied",
            "absPath": abs_path,
            "contentPreview": content_preview,
            "originalContent": original_content,
            "proposedContent": proposed_content,
        })
        .to_string()),
        LineEditResult::OutOfRange {
            total_lines,
            error_message,
        } => Ok(json!({
            "status": "out_of_range",
            "totalLines": total_lines,
            "errorMessage": error_message,
        })
        .to_string()),
    }
}

pub fn lint_failure_message(
    original: &str,
    proposed: &str,
    start_line: usize,
    replacement: &str,
    snippet_context: usize,
    findings_text: &str,
) -> String {
    let original_lines = original.split('\n').collect::<Vec<_>>();
    let proposed_lines = proposed.split('\n').collect::<Vec<_>>();
    let replacement_len = replacement.split('\n').count();
    let preview_start = start_line.saturating_sub(1 + snippet_context);
    let preview_end = original_lines
        .len()
        .min(start_line.saturating_sub(1) + replacement_len + snippet_context);
    [
        "[file-editor] lint failed; edit reverted.".to_string(),
        "Errors:".to_string(),
        if findings_text.is_empty() {
            "(linter returned no structured findings)".to_string()
        } else {
            findings_text.to_string()
        },
        String::new(),
        "Proposed (would-have-been):".to_string(),
        numbered_snippet(&proposed_lines, preview_start, preview_end),
        String::new(),
        "Original (current state):".to_string(),
        numbered_snippet(&original_lines, preview_start, preview_end),
    ]
    .join("\n")
}

fn numbered_snippet(lines: &[&str], start: usize, end: usize) -> String {
    lines
        .iter()
        .enumerate()
        .skip(start)
        .take(end.saturating_sub(start))
        .map(|(index, line)| format!("{}: {line}", index + 1))
        .collect::<Vec<_>>()
        .join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::aci::write_text_file;
    use std::path::{Path, PathBuf};

    fn workspace_root() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .and_then(Path::parent)
            .expect("workspace root")
            .to_path_buf()
    }

    #[test]
    fn applies_and_restores_line_edit() {
        let root = workspace_root();
        let relative = format!("target/unclecode-edit-test-{}.txt", std::process::id());
        write_text_file(&root, &relative, "alpha\nbeta\ngamma\n").expect("seed");

        let result = line_edit(&root, &relative, 2, 2, "BETA").expect("edit");
        let LineEditResult::Applied {
            original_content,
            proposed_content,
            content_preview,
            ..
        } = result
        else {
            panic!("expected applied edit");
        };
        assert_eq!(proposed_content, "alpha\nBETA\ngamma\n");
        assert!(content_preview.contains("2: BETA"));

        restore_file(&root, &relative, &original_content).expect("restore");
        assert_eq!(
            fs::read_to_string(root.join(&relative)).expect("read"),
            original_content
        );
        let _ = fs::remove_file(root.join(relative));
    }

    #[test]
    fn rejects_out_of_range_edit() {
        let root = workspace_root();
        let result = line_edit(&root, "Cargo.toml", 5000, 5000, "x").expect("range");

        assert!(matches!(result, LineEditResult::OutOfRange { .. }));
    }

    #[test]
    fn builds_lint_failure_message() {
        let message = lint_failure_message(
            "alpha\nbeta\ngamma\n",
            "alpha\n@@@\ngamma\n",
            2,
            "@@@",
            5,
            "- [E999] line 2: syntax error",
        );

        assert!(message.contains("Errors:"));
        assert!(message.contains("Proposed"));
        assert!(message.contains("Original"));
    }
}
