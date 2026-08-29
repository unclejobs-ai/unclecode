use crate::sha256::sha256_hex_bytes;
use crate::time_iso::{epoch_iso, utc_now_iso};
use serde_json::{json, Value};
use std::collections::{BTreeSet, HashMap};
use std::fs;
use std::path::Path;
use std::process::Command;

const EXCLUDED_SEGMENTS: &[&str] = &[".git", "node_modules", "dist", "build"];
const ZERO_SHA: &str = "0000000000000000000000000000000000000000";
const REPO_MAP_HISTORY_SCAN_LIMIT: &str = "200";

#[derive(Debug, Clone, PartialEq)]
struct RepoMapEntry {
    path: String,
    last_modified: String,
    line_count: usize,
    change_frequency: usize,
    hotspot_score: f64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct WorktreeFingerprint {
    fingerprint: String,
    modified_paths: Vec<String>,
}

pub fn get_repo_map_cache_token(root_dir: &Path) -> String {
    let git_head_sha = get_git_head_sha(root_dir);
    match get_worktree_fingerprint(root_dir) {
        Ok(worktree) => format!("{git_head_sha}:{}", worktree.fingerprint),
        Err(_) => format!("{git_head_sha}:unavailable"),
    }
}

pub fn build_repo_map_json(root_dir: &Path) -> Result<String, String> {
    let generated_at = utc_now_iso();
    let git_head_sha = get_git_head_sha(root_dir);
    let tracked_files_output = run_git(root_dir, &["ls-files"])?;
    let (last_modified_output, change_frequency_output) = if git_head_sha == ZERO_SHA {
        (String::new(), String::new())
    } else {
        (
            run_git(
                root_dir,
                &[
                    "log",
                    "--max-count",
                    REPO_MAP_HISTORY_SCAN_LIMIT,
                    "--format=%cI",
                    "--name-only",
                    "--no-renames",
                    "--",
                ],
            )?,
            run_git(
                root_dir,
                &[
                    "log",
                    "--max-count",
                    REPO_MAP_HISTORY_SCAN_LIMIT,
                    "--oneline",
                    "--name-only",
                    "--no-renames",
                    "--",
                ],
            )?,
        )
    };
    let last_modified = parse_last_modified(&last_modified_output);
    let change_frequency = parse_change_frequency(&change_frequency_output);
    let mut raw_entries = Vec::new();

    for file_path in split_lines(&tracked_files_output) {
        if is_excluded_path(&file_path) {
            continue;
        }
        if let Some(entry) = read_repo_map_entry(
            root_dir,
            &file_path,
            &git_head_sha,
            &last_modified,
            &change_frequency,
        )? {
            raw_entries.push(entry);
        }
    }

    let max_change_frequency = raw_entries
        .iter()
        .map(|entry| entry.change_frequency)
        .max()
        .unwrap_or(0);
    let mut entries = raw_entries
        .into_iter()
        .map(|mut entry| {
            entry.hotspot_score = if max_change_frequency == 0 {
                0.0
            } else {
                entry.change_frequency as f64 / max_change_frequency as f64
            };
            entry
        })
        .collect::<Vec<_>>();
    entries.sort_by(|left, right| {
        right
            .hotspot_score
            .partial_cmp(&left.hotspot_score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| right.change_frequency.cmp(&left.change_frequency))
            .then_with(|| left.path.cmp(&right.path))
    });
    let total_lines = entries.iter().map(|entry| entry.line_count).sum::<usize>();

    serde_json::to_string(&json!({
        "rootDir": root_dir.to_string_lossy(),
        "generatedAt": generated_at,
        "gitHeadSha": git_head_sha,
        "entries": entries.iter().map(repo_map_entry_json).collect::<Vec<_>>(),
        "totalFiles": entries.len(),
        "totalLines": total_lines
    }))
    .map_err(|error| error.to_string())
}

fn get_git_head_sha(root_dir: &Path) -> String {
    match run_git(root_dir, &["rev-parse", "HEAD"]) {
        Ok(output) => output.trim().to_string(),
        Err(_) => ZERO_SHA.to_string(),
    }
}

pub fn build_worktree_fingerprint_json(root_dir: &Path) -> Result<String, String> {
    serde_json::to_string(&worktree_fingerprint_json(&get_worktree_fingerprint(
        root_dir,
    )?))
    .map_err(|error| error.to_string())
}

pub fn check_freshness_json(root_dir: &Path, packet_json: &str) -> Result<String, String> {
    let packet: Value = serde_json::from_str(packet_json)
        .map_err(|error| format!("Invalid packet JSON: {error}"))?;
    let packet_git_head_sha = packet
        .get("gitHeadSha")
        .and_then(Value::as_str)
        .ok_or("packet.gitHeadSha must be a string")?;
    let packet_fingerprint = packet
        .get("worktreeFingerprint")
        .and_then(Value::as_str)
        .ok_or("packet.worktreeFingerprint must be a string")?;
    let checked_at = utc_now_iso();

    match run_git(root_dir, &["rev-parse", "HEAD"]) {
        Ok(output) => {
            let git_head_sha = output.trim().to_string();
            let worktree = get_worktree_fingerprint(root_dir)?;
            if git_head_sha == packet_git_head_sha && worktree.fingerprint == packet_fingerprint {
                return freshness_json(
                    "fresh",
                    &checked_at,
                    &git_head_sha,
                    packet_git_head_sha,
                    &[],
                );
            }

            let modified_paths = match run_git(
                root_dir,
                &["diff", "--name-only", packet_git_head_sha, "HEAD"],
            ) {
                Ok(diff_output) => merge_paths(split_lines(&diff_output), worktree.modified_paths),
                Err(_) => Vec::new(),
            };
            freshness_json(
                "stale",
                &checked_at,
                &git_head_sha,
                packet_git_head_sha,
                &modified_paths,
            )
        }
        Err(_) if packet_git_head_sha == ZERO_SHA && is_inside_git_worktree(root_dir)? => {
            let worktree = get_worktree_fingerprint(root_dir)?;
            let status = if worktree.fingerprint == packet_fingerprint {
                "fresh"
            } else {
                "stale"
            };
            freshness_json(
                status,
                &checked_at,
                ZERO_SHA,
                packet_git_head_sha,
                &worktree.modified_paths,
            )
        }
        Err(_) => freshness_json(
            "unknown",
            &checked_at,
            packet_git_head_sha,
            packet_git_head_sha,
            &[],
        ),
    }
}

fn run_git(root_dir: &Path, args: &[&str]) -> Result<String, String> {
    let output = Command::new("git")
        .args(args)
        .current_dir(root_dir)
        .output()
        .map_err(|error| format!("Failed to run git {}: {error}", args.join(" ")))?;
    if output.status.success() {
        return String::from_utf8(output.stdout)
            .map_err(|error| format!("git {} returned non-utf8 stdout: {error}", args.join(" ")));
    }

    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    Err(if stderr.is_empty() {
        format!("Git command failed: git {}", args.join(" "))
    } else {
        format!("Git command failed: git {}: {stderr}", args.join(" "))
    })
}

fn split_lines(output: &str) -> Vec<String> {
    output
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(ToString::to_string)
        .collect()
}

fn parse_status_paths(output: &str) -> Vec<String> {
    output
        .lines()
        .map(str::trim_end)
        .filter(|line| line.len() >= 4)
        .map(|line| line[3..].to_string())
        .map(|path| {
            path.split(" -> ")
                .last()
                .map(ToString::to_string)
                .unwrap_or(path)
        })
        .collect()
}

fn is_excluded_path(file_path: &str) -> bool {
    file_path
        .split('/')
        .any(|segment| EXCLUDED_SEGMENTS.contains(&segment))
}

fn parse_last_modified(output: &str) -> HashMap<String, String> {
    let mut last_modified = HashMap::new();
    let mut current_timestamp: Option<&str> = None;
    for line in output.lines() {
        if line.is_empty() {
            continue;
        }
        if is_iso_git_timestamp(line) {
            current_timestamp = Some(line);
            continue;
        }
        if let Some(timestamp) = current_timestamp {
            last_modified
                .entry(line.to_string())
                .or_insert_with(|| timestamp.to_string());
        }
    }
    last_modified
}

fn parse_change_frequency(output: &str) -> HashMap<String, usize> {
    let mut frequencies = HashMap::new();
    for line in output.lines() {
        if line.is_empty() || is_commit_line(line) {
            continue;
        }
        *frequencies.entry(line.to_string()).or_insert(0) += 1;
    }
    frequencies
}

fn read_repo_map_entry(
    root_dir: &Path,
    file_path: &str,
    git_head_sha: &str,
    last_modified: &HashMap<String, String>,
    change_frequency: &HashMap<String, usize>,
) -> Result<Option<RepoMapEntry>, String> {
    let path = root_dir.join(file_path);
    let buffer = match fs::read(&path) {
        Ok(buffer) => buffer,
        Err(error)
            if error.kind() == std::io::ErrorKind::NotFound
                || error.kind() == std::io::ErrorKind::IsADirectory =>
        {
            return Ok(None);
        }
        Err(error) => {
            return Err(format!(
                "Failed to read tracked file {}: {error}",
                path.display()
            ));
        }
    };
    if is_binary_buffer(&buffer) {
        return Ok(None);
    }

    Ok(Some(RepoMapEntry {
        path: file_path.to_string(),
        last_modified: last_modified.get(file_path).cloned().unwrap_or_else(|| {
            get_last_modified_fallback(root_dir, file_path, git_head_sha)
                .unwrap_or_else(|_| epoch_iso())
        }),
        line_count: count_logical_lines(&buffer),
        change_frequency: *change_frequency.get(file_path).unwrap_or(&0),
        hotspot_score: 0.0,
    }))
}

fn get_last_modified_fallback(
    root_dir: &Path,
    file_path: &str,
    git_head_sha: &str,
) -> Result<String, String> {
    if git_head_sha == ZERO_SHA {
        return Ok(epoch_iso());
    }
    let timestamp = run_git(root_dir, &["log", "-1", "--format=%cI", "--", file_path])?
        .trim()
        .to_string();
    Ok(if timestamp.is_empty() {
        epoch_iso()
    } else {
        timestamp
    })
}

fn get_worktree_fingerprint(root_dir: &Path) -> Result<WorktreeFingerprint, String> {
    let output = run_git(
        root_dir,
        &["status", "--porcelain=v1", "--untracked-files=no"],
    )?;
    let modified_paths = parse_status_paths(&output);
    if modified_paths.is_empty() {
        return Ok(WorktreeFingerprint {
            fingerprint: "clean".to_string(),
            modified_paths,
        });
    }

    let mut chunks = Vec::new();
    for file_path in sorted_paths(&modified_paths) {
        chunks.extend_from_slice(file_path.as_bytes());
        match fs::read(root_dir.join(file_path)) {
            Ok(bytes) => chunks.extend(bytes),
            Err(error) => {
                chunks.extend_from_slice(b"[missing]");
                chunks.extend_from_slice(error.kind().to_string().as_bytes());
            }
        }
    }

    Ok(WorktreeFingerprint {
        fingerprint: sha256_hex_bytes(&chunks),
        modified_paths,
    })
}

fn is_inside_git_worktree(root_dir: &Path) -> Result<bool, String> {
    match run_git(root_dir, &["rev-parse", "--is-inside-work-tree"]) {
        Ok(output) => Ok(output.trim() == "true"),
        Err(_) => Ok(false),
    }
}

fn merge_paths(left: Vec<String>, right: Vec<String>) -> Vec<String> {
    let mut seen = BTreeSet::new();
    let mut merged = Vec::new();
    for path in left.into_iter().chain(right) {
        if seen.insert(path.clone()) {
            merged.push(path);
        }
    }
    merged
}

fn sorted_paths(paths: &[String]) -> Vec<&str> {
    let mut sorted = paths.iter().map(String::as_str).collect::<Vec<_>>();
    sorted.sort_unstable();
    sorted
}

fn is_binary_buffer(buffer: &[u8]) -> bool {
    buffer.iter().take(8_000).any(|byte| *byte == 0)
}

fn count_logical_lines(buffer: &[u8]) -> usize {
    if buffer.is_empty() {
        return 0;
    }
    let newlines = buffer.iter().filter(|byte| **byte == b'\n').count();
    if buffer.last() == Some(&b'\n') {
        newlines
    } else {
        newlines + 1
    }
}

fn is_iso_git_timestamp(line: &str) -> bool {
    let bytes = line.as_bytes();
    bytes.len() == 25
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes[10] == b'T'
        && bytes[13] == b':'
        && bytes[16] == b':'
        && (bytes[19] == b'+' || bytes[19] == b'-')
        && bytes[22] == b':'
        && bytes.iter().enumerate().all(|(index, byte)| {
            matches!(index, 4 | 7 | 10 | 13 | 16 | 19 | 22) || byte.is_ascii_digit()
        })
}

fn is_commit_line(line: &str) -> bool {
    let Some((sha, _)) = line.split_once(' ') else {
        return false;
    };
    (7..=40).contains(&sha.len()) && sha.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn repo_map_entry_json(entry: &RepoMapEntry) -> Value {
    json!({
        "path": entry.path,
        "lastModified": entry.last_modified,
        "lineCount": entry.line_count,
        "changeFrequency": entry.change_frequency,
        "hotspotScore": entry.hotspot_score
    })
}

fn worktree_fingerprint_json(fingerprint: &WorktreeFingerprint) -> Value {
    json!({
        "fingerprint": fingerprint.fingerprint,
        "modifiedPaths": fingerprint.modified_paths
    })
}

fn freshness_json(
    status: &str,
    checked_at: &str,
    git_head_sha: &str,
    packet_sha: &str,
    modified_paths: &[String],
) -> Result<String, String> {
    serde_json::to_string(&json!({
        "status": status,
        "checkedAt": checked_at,
        "gitHeadSha": git_head_sha,
        "packetSha": packet_sha,
        "modifiedPaths": modified_paths
    }))
    .map_err(|error| error.to_string())
}

#[cfg(test)]
#[path = "repo_context_tests.rs"]
mod repo_context_tests;
