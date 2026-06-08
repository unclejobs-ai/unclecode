use crate::context_packet::build_context_selection_json;
use crate::mcp_host::load_mcp_host_registry;
use crate::repo_context::build_repo_map_json;
use crate::session::{session_paths, WorkShellSessionSnapshot, WorkShellSessionStore};
use crate::setup_report::session_store_root_from_env;
use crate::sha256::sha256_hex;
use crate::time_iso::utc_now_iso;
use serde_json::{json, Value};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::Path;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

const RESEARCH_LATENCY_THRESHOLDS: ResearchLatencyThresholds = ResearchLatencyThresholds {
    first_event_ms_budget: 1_500,
    total_ms_budget: 3_000,
    bundle_ms_budget: 1_500,
    mcp_start_ms_budget: 500,
    executor_ms_budget: 1_500,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResearchRunReport {
    pub lines: Vec<String>,
    pub json: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct ResearchLatencyThresholds {
    first_event_ms_budget: u128,
    total_ms_budget: u128,
    bundle_ms_budget: u128,
    mcp_start_ms_budget: u128,
    executor_ms_budget: u128,
}

pub fn research_run_report(
    workspace_root: &Path,
    home_dir: Option<&Path>,
    env_get: impl Fn(&str) -> Option<String> + Copy,
    prompt: &str,
) -> Result<ResearchRunReport, String> {
    let prompt = prompt.trim();
    if prompt.is_empty() {
        return Err("Usage: unclecode research run <prompt...> [--json]".to_string());
    }

    let total_started_at = Instant::now();
    let first_event_ms = elapsed_ms(total_started_at);
    let session_id = new_research_session_id(workspace_root, prompt);
    let session_root = session_store_root_from_env(env_get, home_dir.map(Path::to_path_buf));
    let session_store = WorkShellSessionStore::new(&session_root);

    let mcp_started_at = Instant::now();
    let registry = load_mcp_host_registry(workspace_root, home_dir)?;
    let mcp_start_ms = elapsed_ms(mcp_started_at);
    let connected_server_names = registry
        .iter()
        .map(|entry| entry.name.clone())
        .collect::<Vec<_>>();

    let bundle_started_at = Instant::now();
    let bundle = prepare_local_research_bundle(workspace_root, &session_id, prompt)?;
    let bundle_ms = elapsed_ms(bundle_started_at);

    let executor_started_at = Instant::now();
    let summary = format!(
        "Refreshed Work context for \"{}\" with {} changed files and {} MCP servers.",
        prompt,
        bundle.changed_files.len(),
        connected_server_names.len()
    );
    let paths = session_paths(&session_root, workspace_root, &session_id);
    fs::create_dir_all(&paths.research_artifacts_dir).map_err(|error| {
        format!(
            "Failed to create research artifacts directory {}: {error}",
            paths.research_artifacts_dir.display()
        )
    })?;
    let artifact_path = paths.research_artifacts_dir.join("research.md");
    fs::write(
        &artifact_path,
        research_markdown(
            prompt,
            &bundle,
            &connected_server_names,
            &summary,
        ),
    )
    .map_err(|error| {
        format!(
            "Failed to write research artifact {}: {error}",
            artifact_path.display()
        )
    })?;
    let executor_ms = elapsed_ms(executor_started_at);

    session_store
        .persist_work_shell_snapshot(&WorkShellSessionSnapshot {
            session_id: session_id.clone(),
            project_path: workspace_root.to_string_lossy().to_string(),
            model: "research-local".to_string(),
            mode: "normal".to_string(),
            state: "idle".to_string(),
            summary: summary.clone(),
            trace_mode: None,
            reasoning_effort: None,
            entries: vec![],
        })
        .map_err(|error| format!("Failed to persist research session: {error}"))?;

    append_research_ledger(
        workspace_root,
        &session_id,
        prompt,
        &summary,
        &artifact_path,
    )?;

    let total_ms = elapsed_ms(total_started_at);
    let artifact_path_text = artifact_path.to_string_lossy().to_string();
    let lines = vec![
        "Work context refreshed".to_string(),
        format!("Focus: {prompt}"),
        format!("Summary: {summary}"),
    ];
    let report = json!({
        "command": "research.run",
        "sessionId": session_id,
        "prompt": prompt,
        "status": "completed",
        "summary": summary,
        "artifactPaths": [artifact_path_text],
        "metrics": {
            "firstEventMs": first_event_ms,
            "totalMs": total_ms,
            "bundleMs": bundle_ms,
            "mcpStartMs": mcp_start_ms,
            "executorMs": executor_ms,
        },
        "thresholds": {
            "firstEventMsBudget": RESEARCH_LATENCY_THRESHOLDS.first_event_ms_budget,
            "totalMsBudget": RESEARCH_LATENCY_THRESHOLDS.total_ms_budget,
            "bundleMsBudget": RESEARCH_LATENCY_THRESHOLDS.bundle_ms_budget,
            "mcpStartMsBudget": RESEARCH_LATENCY_THRESHOLDS.mcp_start_ms_budget,
            "executorMsBudget": RESEARCH_LATENCY_THRESHOLDS.executor_ms_budget,
        },
    });
    let json = serde_json::to_string(&report).map_err(|error| error.to_string())?;

    Ok(ResearchRunReport { lines, json })
}

#[derive(Debug, Clone, PartialEq)]
struct LocalResearchBundle {
    packet_id: String,
    changed_files: Vec<String>,
    hotspots: Vec<Value>,
    policy_signals: Vec<String>,
}

fn prepare_local_research_bundle(
    workspace_root: &Path,
    session_id: &str,
    prompt: &str,
) -> Result<LocalResearchBundle, String> {
    let repo_map = build_repo_map_json(workspace_root).unwrap_or_else(|_| {
        json!({
            "rootDir": workspace_root.to_string_lossy(),
            "generatedAt": utc_now_iso(),
            "gitHeadSha": "0000000000000000000000000000000000000000",
            "entries": [],
            "totalFiles": 0,
            "totalLines": 0
        })
        .to_string()
    });
    let selection_json = build_context_selection_json(workspace_root, "search", None, &repo_map)
        .unwrap_or_else(|_| {
            json!({
                "hotspots": [],
                "changedFiles": [],
                "candidatePaths": [],
                "policySignals": [],
                "includedContents": [],
                "tokenEstimate": 0,
                "tokenBudget": {
                    "maxTokens": 100000,
                    "reservedForTools": 5000,
                    "reservedForSystem": 5000
                }
            })
            .to_string()
        });
    let selection: Value = serde_json::from_str(&selection_json)
        .map_err(|error| format!("Invalid local research context selection: {error}"))?;
    let changed_files = string_array(&selection, "changedFiles");
    let hotspots = selection
        .get("hotspots")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let policy_signals = string_array(&selection, "policySignals");
    let packet_id = format!(
        "packet-{}",
        &sha256_hex(&format!(
            "{session_id}\n{prompt}\n{repo_map}\n{selection_json}"
        ))[..20]
    );

    Ok(LocalResearchBundle {
        packet_id,
        changed_files,
        hotspots,
        policy_signals,
    })
}

fn research_markdown(
    prompt: &str,
    bundle: &LocalResearchBundle,
    connected_server_names: &[String],
    summary: &str,
) -> String {
    let policy = if bundle.policy_signals.is_empty() {
        "none".to_string()
    } else {
        bundle.policy_signals.join(", ")
    };
    let mcp_servers = if connected_server_names.is_empty() {
        "none".to_string()
    } else {
        connected_server_names.join(", ")
    };
    let changed_files_line = if bundle.changed_files.is_empty() {
        "- No changed files observed in the current packet.".to_string()
    } else {
        format!(
            "- Changed files observed: {}",
            bundle.changed_files.join(", ")
        )
    };
    let hotspots_line = if bundle.hotspots.is_empty() {
        "- No hotspots detected in the current packet.".to_string()
    } else {
        format!("- Hotspots detected: {}", bundle.hotspots.len())
    };
    let policy_line = if bundle.policy_signals.is_empty() {
        "- No policy signals were emitted.".to_string()
    } else {
        format!("- Policy signals: {}", bundle.policy_signals.join(", "))
    };
    let mcp_line = if connected_server_names.is_empty() {
        "- No MCP servers were connected for this run.".to_string()
    } else {
        format!(
            "- Connected MCP servers: {}",
            connected_server_names.join(", ")
        )
    };
    let next_changed = if bundle.changed_files.is_empty() {
        "1. Give Work a narrower target when the workspace has no changed files."
    } else {
        "1. Start Work from the changed files above before widening scope."
    };
    let next_hotspots = if bundle.hotspots.is_empty() {
        "2. Refresh context again after a meaningful code change."
    } else {
        "2. Prioritize the hotspot count when choosing the next file."
    };
    let next_mcp = if connected_server_names.is_empty() {
        "3. Configure MCP servers if you need external tools or richer context for the next run."
    } else {
        "3. Use the connected MCP servers as the next source of truth for deeper investigation."
    };

    [
        "# UncleCode Work Context".to_string(),
        String::new(),
        format!("Focus: {prompt}"),
        format!("Context id: {}", bundle.packet_id),
        format!("Changed files: {}", bundle.changed_files.len()),
        format!("Hotspots: {}", bundle.hotspots.len()),
        format!("Policy signals: {policy}"),
        format!("MCP servers: {mcp_servers}"),
        String::new(),
        "## Findings".to_string(),
        changed_files_line,
        hotspots_line,
        policy_line,
        mcp_line,
        String::new(),
        "## Next Work Handoff".to_string(),
        next_changed.to_string(),
        next_hotspots.to_string(),
        next_mcp.to_string(),
        String::new(),
        format!("Summary: {summary}"),
        String::new(),
    ]
    .join("\n")
}

fn append_research_ledger(
    workspace_root: &Path,
    session_id: &str,
    prompt: &str,
    summary: &str,
    artifact_path: &Path,
) -> Result<(), String> {
    let ledger_dir = workspace_root.join(".unclecode");
    fs::create_dir_all(&ledger_dir).map_err(|error| {
        format!(
            "Failed to create research ledger directory {}: {error}",
            ledger_dir.display()
        )
    })?;
    let ledger_path = ledger_dir.join("research-runs.jsonl");
    let record = json!({
        "sessionId": session_id,
        "prompt": prompt,
        "status": "completed",
        "summary": summary,
        "artifactPaths": [artifact_path.to_string_lossy().to_string()],
        "timestamp": utc_now_iso(),
    });
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&ledger_path)
        .map_err(|error| format!("Failed to open {}: {error}", ledger_path.display()))?;
    writeln!(file, "{record}")
        .map_err(|error| format!("Failed to write {}: {error}", ledger_path.display()))
}

fn new_research_session_id(workspace_root: &Path, prompt: &str) -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    let seed = format!(
        "{}\n{}\n{}\n{}",
        workspace_root.to_string_lossy(),
        prompt,
        std::process::id(),
        nanos
    );
    format!("research-{}", &sha256_hex(&seed)[..32])
}

fn string_array(input: &Value, key: &str) -> Vec<String> {
    input
        .get(key)
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(ToString::to_string)
                .collect()
        })
        .unwrap_or_default()
}

fn elapsed_ms(started_at: Instant) -> u128 {
    started_at.elapsed().as_millis()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::research_status::research_status_report;
    use std::path::PathBuf;
    use std::process::Command;

    #[test]
    fn runs_local_research_and_updates_status() {
        let root = temp_root("research-run");
        let session_root = root.join(".state");
        init_git_repo(&root);

        let report = research_run_report(
            &root,
            None,
            |key| {
                (key == "UNCLECODE_SESSION_STORE_ROOT")
                    .then(|| session_root.to_string_lossy().to_string())
            },
            "summarize current workspace",
        )
        .unwrap();
        let text = report.lines.join("\n");
        assert!(text.contains("Work context refreshed"));
        assert!(text.contains("Focus: summarize current workspace"));
        let parsed: Value = serde_json::from_str(&report.json).unwrap();
        assert_eq!(parsed["command"], "research.run");
        assert_eq!(parsed["status"], "completed");
        let artifact_path = parsed["artifactPaths"][0].as_str().unwrap();
        let artifact = fs::read_to_string(artifact_path).unwrap();
        assert!(artifact.contains("# UncleCode Work Context"));
        assert!(artifact.contains("Focus: summarize current workspace"));
        assert!(root.join(".unclecode/research-runs.jsonl").exists());

        let status = research_status_report(&root, None, |key| {
            (key == "UNCLECODE_SESSION_STORE_ROOT")
                .then(|| session_root.to_string_lossy().to_string())
        })
        .unwrap();
        let status_text = status.lines.join("\n");
        assert!(status_text.contains("Last refresh: research-"));
        assert!(status_text.contains("State: idle"));
        let _ = fs::remove_dir_all(root);
    }

    fn init_git_repo(root: &Path) {
        run(root, &["init"]);
        run(root, &["config", "user.email", "test@example.com"]);
        run(root, &["config", "user.name", "Test User"]);
        fs::write(root.join("README.md"), "# temp research workspace\n").unwrap();
        run(root, &["add", "README.md"]);
        run(root, &["commit", "-m", "init"]);
    }

    fn run(root: &Path, args: &[&str]) {
        let output = Command::new("git")
            .args(args)
            .current_dir(root)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "git {} failed: {}",
            args.join(" "),
            String::from_utf8_lossy(&output.stderr)
        );
    }

    fn temp_root(label: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("unclecode-rust-{label}-{nanos}"));
        fs::create_dir_all(&root).unwrap();
        root
    }
}
