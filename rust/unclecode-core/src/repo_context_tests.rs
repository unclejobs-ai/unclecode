use super::*;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

#[test]
fn counts_logical_lines_without_trailing_newline() {
    assert_eq!(count_logical_lines(b""), 0);
    assert_eq!(count_logical_lines(b"hello"), 1);
    assert_eq!(count_logical_lines(b"hello\nworld\n"), 2);
}

#[test]
fn parses_status_rename_destination() {
    assert_eq!(
        parse_status_paths("R  old.txt -> new.txt\n M kept.txt\n"),
        ["new.txt", "kept.txt"]
    );
}

#[test]
fn builds_repo_map_for_staged_file_before_first_commit() {
    let root = temp_dir("unclecode-rust-repo-map");
    run("git", &["init"], &root);
    std::fs::write(root.join("notes.txt"), "hello\nworld\n").expect("write");
    run("git", &["add", "notes.txt"], &root);

    let output = build_repo_map_json(&root).expect("repo map");
    let parsed: Value = serde_json::from_str(&output).expect("json");
    assert_eq!(
        parsed.get("gitHeadSha").and_then(Value::as_str),
        Some(ZERO_SHA)
    );
    assert_eq!(parsed.get("totalFiles").and_then(Value::as_u64), Some(1));
    assert_eq!(
        parsed
            .pointer("/entries/0/path")
            .and_then(Value::as_str)
            .unwrap_or(""),
        "notes.txt"
    );
    assert_eq!(
        parsed
            .pointer("/entries/0/lineCount")
            .and_then(Value::as_u64),
        Some(2)
    );

    let _ = std::fs::remove_dir_all(root);
}

fn temp_dir(prefix: &str) -> PathBuf {
    let path = std::env::temp_dir().join(format!(
        "{}-{}",
        prefix,
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time")
            .as_nanos()
    ));
    std::fs::create_dir_all(&path).expect("mkdir");
    path
}

fn run(program: &str, args: &[&str], cwd: &Path) {
    let status = Command::new(program)
        .args(args)
        .current_dir(cwd)
        .status()
        .expect("command");
    assert!(status.success(), "{program} {args:?}");
}
