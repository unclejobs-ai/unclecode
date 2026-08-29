use super::*;
use std::collections::BTreeMap;
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
        parse_status_paths(b"R  new.txt\0old.txt\0 M kept.txt\0").expect("status paths"),
        [b"new.txt".to_vec(), b"kept.txt".to_vec()]
    );
}

#[test]
fn builds_repo_map_with_literal_git_paths() {
    let root = temp_dir("unclecode-rust-repo-map-literal-paths");
    run("git", &["init"], &root);
    for file_path in [
        "한글.txt",
        "quote\".txt",
        "back\\slash.txt",
        "line\nbreak.txt",
    ] {
        std::fs::write(root.join(file_path), "content\n").expect("write");
    }
    run("git", &["add", "-A"], &root);

    let output = build_repo_map_json(&root).expect("repo map");
    let parsed: Value = serde_json::from_str(&output).expect("json");
    let entries = parsed
        .get("entries")
        .and_then(Value::as_array)
        .expect("entries")
        .iter()
        .map(|entry| {
            (
                entry
                    .get("path")
                    .and_then(Value::as_str)
                    .expect("path")
                    .to_string(),
                entry
                    .get("lineCount")
                    .and_then(Value::as_u64)
                    .expect("line count"),
            )
        })
        .collect::<BTreeMap<_, _>>();

    assert_eq!(
        entries,
        BTreeMap::from([
            ("back\\slash.txt".to_string(), 1),
            ("line\nbreak.txt".to_string(), 1),
            ("quote\".txt".to_string(), 1),
            ("한글.txt".to_string(), 1),
        ])
    );

    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn worktree_fingerprint_tracks_literal_paths_and_rename_destination() {
    let root = temp_dir("unclecode-rust-worktree-literal-paths");
    init_repo(&root);
    for file_path in [
        "한글.txt",
        "old\"name.txt",
        "back\\slash.txt",
        "line\nbreak.txt",
    ] {
        std::fs::write(root.join(file_path), "original\n").expect("write");
    }
    run("git", &["add", "-A"], &root);
    run("git", &["commit", "-m", "init"], &root);

    std::fs::write(root.join("한글.txt"), "changed\n").expect("Korean edit");
    std::fs::write(root.join("back\\slash.txt"), "changed\n").expect("backslash edit");
    std::fs::write(root.join("line\nbreak.txt"), "changed once\n").expect("newline edit");
    run("git", &["mv", "old\"name.txt", "renamed\"name.txt"], &root);

    let first = get_worktree_fingerprint(&root).expect("first fingerprint");
    let actual_paths = first.modified_paths.into_iter().collect::<BTreeSet<_>>();
    assert_eq!(
        actual_paths,
        BTreeSet::from([
            "back\\slash.txt".to_string(),
            "line\nbreak.txt".to_string(),
            "renamed\"name.txt".to_string(),
            "한글.txt".to_string(),
        ])
    );

    std::fs::write(root.join("line\nbreak.txt"), "changed twice\n").expect("second newline edit");
    let second = get_worktree_fingerprint(&root).expect("second fingerprint");
    assert_ne!(first.fingerprint, second.fingerprint);

    let _ = std::fs::remove_dir_all(root);
}

#[cfg(target_os = "linux")]
#[test]
fn repo_map_and_fingerprint_accept_non_utf8_git_paths() {
    use std::ffi::OsString;
    use std::os::unix::ffi::OsStringExt;

    let root = temp_dir("unclecode-rust-repo-map-non-utf8");
    init_repo(&root);
    let file_name = OsString::from_vec(b"invalid-\xff.txt".to_vec());
    let file_path = root.join(&file_name);
    std::fs::write(&file_path, "original\n").expect("write");
    run("git", &["add", "-A"], &root);
    run("git", &["commit", "-m", "init"], &root);

    let map = build_repo_map_json(&root).expect("repo map");
    let parsed: Value = serde_json::from_str(&map).expect("json");
    assert_eq!(parsed.get("totalFiles").and_then(Value::as_u64), Some(1));

    let clean_token = get_repo_map_cache_token(&root);
    std::fs::write(&file_path, "changed once\n").expect("first edit");
    let first_dirty_token = get_repo_map_cache_token(&root);
    std::fs::write(&file_path, "changed twice\n").expect("second edit");
    let second_dirty_token = get_repo_map_cache_token(&root);

    assert_ne!(clean_token, first_dirty_token);
    assert_ne!(first_dirty_token, second_dirty_token);
    assert!(!second_dirty_token.ends_with(":unavailable"));

    let _ = std::fs::remove_dir_all(root);
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

#[test]
fn repo_map_cache_token_tracks_same_head_content_without_changing_map_head_sha() {
    let root = temp_dir("unclecode-rust-repo-map-cache-token");
    init_repo(&root);
    std::fs::write(root.join("notes.txt"), "line one\n").expect("write");
    run("git", &["add", "notes.txt"], &root);
    run("git", &["commit", "-m", "init"], &root);

    let git_head_sha = output("git", &["rev-parse", "HEAD"], &root);
    let clean_token = get_repo_map_cache_token(&root);

    std::fs::write(root.join("notes.txt"), "line one\nline two\n").expect("first edit");
    let first_dirty_token = get_repo_map_cache_token(&root);

    std::fs::write(root.join("notes.txt"), "line one\nline six\n").expect("second edit");
    let second_dirty_token = get_repo_map_cache_token(&root);
    let output = build_repo_map_json(&root).expect("repo map");
    let parsed: Value = serde_json::from_str(&output).expect("json");

    assert_ne!(clean_token, first_dirty_token);
    assert_ne!(first_dirty_token, second_dirty_token);
    assert!(
        second_dirty_token.len() <= 128,
        "cache token must stay bounded"
    );
    assert_eq!(
        parsed.get("gitHeadSha").and_then(Value::as_str),
        Some(git_head_sha.as_str())
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

fn init_repo(root: &Path) {
    run("git", &["init"], root);
    run("git", &["config", "user.email", "test@example.com"], root);
    run("git", &["config", "user.name", "Test User"], root);
}

fn run(program: &str, args: &[&str], cwd: &Path) {
    let status = Command::new(program)
        .args(args)
        .current_dir(cwd)
        .status()
        .expect("command");
    assert!(status.success(), "{program} {args:?}");
}

fn output(program: &str, args: &[&str], cwd: &Path) -> String {
    let result = Command::new(program)
        .args(args)
        .current_dir(cwd)
        .output()
        .expect("command");
    assert!(result.status.success(), "{program} {args:?}");
    String::from_utf8(result.stdout)
        .expect("utf8 stdout")
        .trim()
        .to_string()
}
