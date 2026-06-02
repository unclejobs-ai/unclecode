use serde_json::{json, Value};
use std::collections::{BTreeSet, HashSet};
use std::fs;
use std::path::Path;
use std::process::Command;

pub fn estimate_context_tokens(text: &str) -> usize {
    text.chars().count().div_ceil(4)
}

pub fn token_budget_json(mode: &str) -> Result<String, String> {
    serde_json::to_string(&token_budget_value(mode)).map_err(|error| error.to_string())
}

pub fn summarize_diff_json(root_dir: &Path, since_sha: &str) -> Result<String, String> {
    let output = run_git(root_dir, &["diff", "--name-only", since_sha, "HEAD"])?;
    serde_json::to_string(&split_lines(&output)).map_err(|error| error.to_string())
}

pub fn detect_hotspots_json(repo_map_json: &str, top_n: usize) -> Result<String, String> {
    let repo_map: Value = serde_json::from_str(repo_map_json)
        .map_err(|error| format!("Invalid repo map JSON: {error}"))?;
    let entries = sorted_repo_entries(&repo_map, top_n);
    serde_json::to_string(&entries).map_err(|error| error.to_string())
}

pub fn build_context_selection_json(
    root_dir: &Path,
    mode: &str,
    since_sha: Option<&str>,
    repo_map_json: &str,
) -> Result<String, String> {
    let repo_map: Value = serde_json::from_str(repo_map_json)
        .map_err(|error| format!("Invalid repo map JSON: {error}"))?;
    let entries = repo_entries(&repo_map);
    let repo_paths = entries
        .iter()
        .filter_map(|entry| entry.get("path").and_then(Value::as_str))
        .map(ToString::to_string)
        .collect::<HashSet<_>>();
    let hotspots = sorted_repo_entries(&repo_map, 10);
    let changed_files = match since_sha {
        Some(since_sha) => split_lines(&run_git(
            root_dir,
            &["diff", "--name-only", since_sha, "HEAD"],
        )?),
        None => entries
            .iter()
            .filter_map(|entry| entry.get("path").and_then(Value::as_str))
            .map(ToString::to_string)
            .collect(),
    };
    let candidate_paths = collect_candidate_paths(&repo_paths, &changed_files, &hotspots);
    let token_budget = token_budget_value(mode);
    let token_limit = readable_content_token_limit(&token_budget);
    let included = read_included_contents(root_dir, &candidate_paths, token_limit)?;
    let signal_paths = changed_files
        .iter()
        .chain(candidate_paths.iter())
        .map(String::as_str)
        .collect::<Vec<_>>();

    serde_json::to_string(&json!({
        "hotspots": hotspots,
        "changedFiles": changed_files,
        "candidatePaths": candidate_paths,
        "policySignals": derive_policy_signals(&signal_paths),
        "includedContents": included.contents,
        "tokenEstimate": included.token_estimate,
        "tokenBudget": token_budget
    }))
    .map_err(|error| error.to_string())
}

struct IncludedContents {
    contents: Vec<Value>,
    token_estimate: usize,
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

fn token_budget_value(mode: &str) -> Value {
    match mode {
        "ultrawork" => {
            json!({"maxTokens": 80_000, "reservedForTools": 8_000, "reservedForSystem": 4_000})
        }
        "search" => {
            json!({"maxTokens": 100_000, "reservedForTools": 5_000, "reservedForSystem": 5_000})
        }
        "analyze" => {
            json!({"maxTokens": 80_000, "reservedForTools": 8_000, "reservedForSystem": 5_000})
        }
        _ => json!({"maxTokens": 60_000, "reservedForTools": 10_000, "reservedForSystem": 5_000}),
    }
}

fn readable_content_token_limit(token_budget: &Value) -> usize {
    let max_tokens = token_budget
        .get("maxTokens")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let tools = token_budget
        .get("reservedForTools")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let system = token_budget
        .get("reservedForSystem")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    max_tokens.saturating_sub(tools).saturating_sub(system) as usize
}

fn repo_entries(repo_map: &Value) -> Vec<Value> {
    repo_map
        .get("entries")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

fn sorted_repo_entries(repo_map: &Value, top_n: usize) -> Vec<Value> {
    if top_n == 0 {
        return Vec::new();
    }
    let mut entries = repo_entries(repo_map);
    entries.sort_by(|left, right| {
        score(right)
            .partial_cmp(&score(left))
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| frequency(right).cmp(&frequency(left)))
            .then_with(|| path(left).cmp(path(right)))
    });
    entries.into_iter().take(top_n).collect()
}

fn collect_candidate_paths(
    repo_paths: &HashSet<String>,
    changed_files: &[String],
    hotspots: &[Value],
) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut candidates = Vec::new();
    let hotspot_paths = hotspots
        .iter()
        .filter_map(|entry| entry.get("path").and_then(Value::as_str));

    for file_path in changed_files
        .iter()
        .map(String::as_str)
        .chain(hotspot_paths)
    {
        if repo_paths.contains(file_path) && seen.insert(file_path.to_string()) {
            candidates.push(file_path.to_string());
        }
    }
    candidates
}

fn read_included_contents(
    root_dir: &Path,
    candidate_paths: &[String],
    token_limit: usize,
) -> Result<IncludedContents, String> {
    let mut contents = Vec::new();
    let mut token_estimate = 0;

    for file_path in candidate_paths {
        let content = match fs::read_to_string(root_dir.join(file_path)) {
            Ok(content) => content,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => {
                return Err(format!(
                    "Failed to read context candidate {}: {error}",
                    file_path
                ));
            }
        };
        let next_estimate = token_estimate + estimate_context_tokens(&content);
        if next_estimate > token_limit {
            continue;
        }
        contents.push(json!({"path": file_path, "content": content}));
        token_estimate = next_estimate;
    }

    Ok(IncludedContents {
        contents,
        token_estimate,
    })
}

fn derive_policy_signals(file_paths: &[&str]) -> Vec<String> {
    let mut signals = BTreeSet::new();
    for file_path in file_paths {
        let normalized = file_path.to_lowercase();
        if normalized.ends_with("package.json") || normalized.ends_with("package-lock.json") {
            signals.insert("dependency-manifest-change");
        }
        if normalized.contains("auth")
            || normalized.contains("provider")
            || normalized.contains("oauth")
        {
            signals.insert("provider-auth-surface");
        }
        if normalized.contains("runtime")
            || normalized.contains("sandbox")
            || normalized.contains("docker")
        {
            signals.insert("runtime-surface");
        }
        if normalized.contains("mcp") {
            signals.insert("mcp-surface");
        }
        if normalized.contains("policy") || normalized.contains("approval") {
            signals.insert("policy-surface");
        }
        if normalized.contains("secret")
            || normalized.contains("credential")
            || normalized.contains("token")
            || normalized.contains("key")
            || normalized.contains(".env")
        {
            signals.insert("secret-surface");
        }
    }
    signals.into_iter().map(ToString::to_string).collect()
}

fn score(entry: &Value) -> f64 {
    entry
        .get("hotspotScore")
        .and_then(Value::as_f64)
        .unwrap_or(0.0)
}

fn frequency(entry: &Value) -> u64 {
    entry
        .get("changeFrequency")
        .and_then(Value::as_u64)
        .unwrap_or(0)
}

fn path(entry: &Value) -> &str {
    entry.get("path").and_then(Value::as_str).unwrap_or("")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn estimates_tokens_with_four_character_heuristic() {
        assert_eq!(estimate_context_tokens("hello"), 2);
        assert_eq!(estimate_context_tokens(""), 0);
    }

    #[test]
    fn selects_hotspots_by_score_frequency_and_path() {
        let repo_map = json!({
            "entries": [
                {"path": "b.ts", "hotspotScore": 1.0, "changeFrequency": 2},
                {"path": "a.ts", "hotspotScore": 1.0, "changeFrequency": 2},
                {"path": "c.ts", "hotspotScore": 0.5, "changeFrequency": 9}
            ]
        });
        let hotspots = sorted_repo_entries(&repo_map, 2);
        assert_eq!(path(&hotspots[0]), "a.ts");
        assert_eq!(path(&hotspots[1]), "b.ts");
    }
}
