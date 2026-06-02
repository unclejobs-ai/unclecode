use crate::sha256::sha256_hex;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

const GUIDANCE_FILE_NAMES: &[&str] = &["AGENTS.md", "CLAUDE.md", "GEMINI.md", "UNCLECODE.md"];

#[derive(Debug, Clone, PartialEq, Eq)]
struct GuidanceSource {
    path: PathBuf,
    name: String,
    content: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct GuidanceConflict {
    kind: String,
    winner: String,
    loser: String,
}

pub fn build_workspace_guidance_json(
    cwd: &Path,
    user_home_dir: Option<&Path>,
    workspace_skills_json: &str,
) -> Result<String, String> {
    let skills = parse_project_skills(workspace_skills_json)?;
    let discovered = discover_guidance_sources(cwd, user_home_dir)?;
    let (sources, dedup_notes) = dedupe_guidance_sources(&discovered);
    let conflicts = detect_guidance_conflicts(&sources);

    if sources.is_empty() && skills.is_empty() {
        return serde_json::to_string(&json!({
            "systemPromptAppendix": "",
            "contextSummaryLines": [
                "No AGENTS.md, CLAUDE.md, GEMINI.md, UNCLECODE.md, or project skills found.",
                "Use /context after adding one to reload context."
            ],
            "sources": []
        }))
        .map_err(|error| error.to_string());
    }

    let mut appendix_blocks = sources
        .iter()
        .map(|source| {
            format!(
                "## {} ({})\n{}",
                source.name,
                source.path.to_string_lossy(),
                source.content.trim()
            )
        })
        .collect::<Vec<_>>();
    appendix_blocks.extend(skills.iter().map(|skill| {
        format!(
            "## SKILL {} ({})\n{}",
            skill_name(skill),
            skill_path(skill),
            skill_content(skill).trim()
        )
    }));

    let mut context_summary_lines = Vec::new();
    if !sources.is_empty() {
        context_summary_lines.push(format!(
            "Loaded guidance: {}",
            sources
                .iter()
                .map(|source| source.name.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        ));
    }
    context_summary_lines.extend(
        sources
            .iter()
            .take(4)
            .map(|source| format!("{}: {}", source.name, summarize_content(&source.content))),
    );
    context_summary_lines.extend(dedup_notes.into_iter().take(2));
    context_summary_lines.extend(conflicts.into_iter().map(|conflict| {
        format!(
            "Conflict: {} guidance differs -> {} wins over {}",
            conflict.kind, conflict.winner, conflict.loser
        )
    }));
    if !skills.is_empty() {
        context_summary_lines.push(format!(
            "Loaded skills: {}",
            skills
                .iter()
                .take(6)
                .map(skill_name)
                .collect::<Vec<_>>()
                .join(", ")
        ));
        context_summary_lines.extend(
            skills
                .iter()
                .take(2)
                .map(|skill| format!("Skill {}: {}", skill_name(skill), skill_summary(skill))),
        );
    }
    context_summary_lines.push("/context · /help · /sessions · /reasoning · /skills".to_string());

    let mut source_paths = sources
        .iter()
        .map(|source| source.path.to_string_lossy().to_string())
        .collect::<Vec<_>>();
    source_paths.extend(skills.iter().map(skill_path));

    serde_json::to_string(&json!({
        "systemPromptAppendix": format!("Workspace guidance:\n\n{}", appendix_blocks.join("\n\n")),
        "contextSummaryLines": context_summary_lines,
        "sources": source_paths
    }))
    .map_err(|error| error.to_string())
}

fn parse_project_skills(raw: &str) -> Result<Vec<Value>, String> {
    let parsed: Value = serde_json::from_str(raw.trim().if_empty("[]"))
        .map_err(|error| format!("Invalid workspace skills JSON: {error}"))?;
    let skills = parsed
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter(|item| item.get("scope").and_then(Value::as_str) == Some("project"))
                .cloned()
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    Ok(skills)
}

fn discover_guidance_sources(
    cwd: &Path,
    user_home_dir: Option<&Path>,
) -> Result<Vec<GuidanceSource>, String> {
    let mut candidates = Vec::new();

    if let Some(user_home_dir) = user_home_dir {
        push_guidance_file(
            &mut candidates,
            user_home_dir.join(".unclecode/UNCLECODE.md"),
            "UNCLECODE.md",
        )?;
    }

    for directory in list_guidance_directories(cwd) {
        for name in GUIDANCE_FILE_NAMES {
            push_guidance_file(&mut candidates, directory.join(name), name)?;
        }
        for name in GUIDANCE_FILE_NAMES {
            let local_name = name.replace(".md", ".local.md");
            push_guidance_file(&mut candidates, directory.join(&local_name), &local_name)?;
        }
    }

    let rules_dir = cwd.join(".sisyphus/rules");
    if let Ok(entries) = fs::read_dir(rules_dir) {
        let mut files = entries
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .filter(|path| path.extension().and_then(|ext| ext.to_str()) == Some("md"))
            .collect::<Vec<_>>();
        files.sort();
        for file in files {
            let Some(file_name) = file.file_name().and_then(|name| name.to_str()) else {
                continue;
            };
            push_guidance_file(&mut candidates, file.clone(), &format!("rules/{file_name}"))?;
        }
    }

    Ok(candidates)
}

fn push_guidance_file(
    candidates: &mut Vec<GuidanceSource>,
    path: PathBuf,
    name: &str,
) -> Result<(), String> {
    match fs::read_to_string(&path) {
        Ok(content) => {
            candidates.push(GuidanceSource {
                path,
                name: name.to_string(),
                content,
            });
            Ok(())
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!(
            "Failed to read guidance file {}: {error}",
            path.display()
        )),
    }
}

fn list_guidance_directories(cwd: &Path) -> Vec<PathBuf> {
    let mut directories = cwd.ancestors().map(Path::to_path_buf).collect::<Vec<_>>();
    directories.reverse();
    directories
}

fn dedupe_guidance_sources(sources: &[GuidanceSource]) -> (Vec<GuidanceSource>, Vec<String>) {
    let hashes = sources
        .iter()
        .map(|source| sha256_hex(&source.content))
        .collect::<Vec<_>>();
    let mut latest_index_by_hash = HashMap::new();
    for (index, hash) in hashes.iter().enumerate() {
        latest_index_by_hash.insert(hash.as_str(), index);
    }

    let mut notes = Vec::new();
    let deduped = sources
        .iter()
        .enumerate()
        .filter_map(|(index, source)| {
            let latest_index = latest_index_by_hash.get(hashes[index].as_str()).copied();
            if latest_index == Some(index) {
                return Some(source.clone());
            }
            if let Some(latest_index) = latest_index {
                notes.push(format!(
                    "Deduped duplicate guidance: {} -> {}",
                    source.name,
                    sources
                        .get(latest_index)
                        .map(|latest| latest.name.as_str())
                        .unwrap_or("higher priority source")
                ));
            }
            None
        })
        .collect::<Vec<_>>();

    (deduped, notes)
}

fn detect_guidance_conflicts(sources: &[GuidanceSource]) -> Vec<GuidanceConflict> {
    #[derive(Clone)]
    struct Directive {
        kind: &'static str,
        stance: &'static str,
        source: String,
    }

    let mut directives = Vec::new();
    for source in sources {
        let content = source.content.to_lowercase();
        if content.contains("tests optional") || content.contains("optional tests") {
            directives.push(Directive {
                kind: "tests",
                stance: "optional",
                source: source.name.clone(),
            });
        }
        if content.contains("tdd required")
            || content.contains("tests required")
            || content.contains("test required")
            || content.contains("must run tests")
            || content.contains("test first")
        {
            directives.push(Directive {
                kind: "tests",
                stance: "required",
                source: source.name.clone(),
            });
        }
        if content.contains("without waiting for approval")
            || content.contains("don't wait for approval")
            || content.contains("keep moving without waiting")
        {
            directives.push(Directive {
                kind: "approval",
                stance: "auto",
                source: source.name.clone(),
            });
        }
        if content.contains("ask for approval")
            || content.contains("wait for approval")
            || content.contains("ask permission")
            || content.contains("confirm before")
        {
            directives.push(Directive {
                kind: "approval",
                stance: "ask",
                source: source.name.clone(),
            });
        }
    }

    ["tests", "approval"]
        .iter()
        .filter_map(|kind| {
            let matching = directives
                .iter()
                .filter(|directive| directive.kind == *kind)
                .collect::<Vec<_>>();
            let mut stances = matching
                .iter()
                .map(|directive| directive.stance)
                .collect::<Vec<_>>();
            stances.sort_unstable();
            stances.dedup();
            if stances.len() < 2 || matching.len() < 2 {
                return None;
            }
            let winner = matching.last()?;
            let loser = matching
                .iter()
                .find(|directive| directive.stance != winner.stance)?;
            Some(GuidanceConflict {
                kind: (*kind).to_string(),
                winner: winner.source.clone(),
                loser: loser.source.clone(),
            })
        })
        .collect()
}

fn summarize_content(content: &str) -> String {
    let line = content.lines().map(str::trim).find(|entry| {
        !entry.is_empty()
            && !entry.starts_with('#')
            && !entry.starts_with("<!--")
            && !entry.starts_with("-->")
            && *entry != "-"
    });

    match line {
        Some(line) if line.chars().count() > 88 => {
            let summary = line.chars().take(85).collect::<String>();
            format!("{summary}...")
        }
        Some(line) => line.to_string(),
        None => "guidance loaded".to_string(),
    }
}

fn skill_name(skill: &Value) -> String {
    skill
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("skill")
        .to_string()
}

fn skill_path(skill: &Value) -> String {
    skill
        .get("path")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string()
}

fn skill_summary(skill: &Value) -> String {
    skill
        .get("summary")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string()
}

fn skill_content(skill: &Value) -> String {
    skill
        .get("content")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string()
}

trait EmptyDefault {
    fn if_empty<'a>(&'a self, default: &'a str) -> &'a str;
}

impl EmptyDefault for str {
    fn if_empty<'a>(&'a self, default: &'a str) -> &'a str {
        if self.is_empty() {
            default
        } else {
            self
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn builds_workspace_guidance_summary_with_dedupe_conflict_and_skills() {
        let root = std::env::temp_dir().join(format!(
            "unclecode-context-guidance-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("time")
                .as_nanos()
        ));
        let nested = root.join("apps/demo");
        fs::create_dir_all(&nested).expect("mkdir");
        fs::write(
            root.join("AGENTS.md"),
            "# Agents\nTests optional for quick edits.\n",
        )
        .expect("agents");
        fs::write(
            nested.join("CLAUDE.md"),
            "# Claude\nTDD required for all changes.\n",
        )
        .expect("claude");
        fs::write(
            nested.join("GEMINI.local.md"),
            "# Claude\nTDD required for all changes.\n",
        )
        .expect("duplicate");

        let output = build_workspace_guidance_json(
            &nested,
            None,
            r##"[{"name":"autopilot","path":"/tmp/SKILL.md","scope":"project","summary":"Keep moving.","content":"# Autopilot\nKeep moving."}]"##,
        )
        .expect("guidance");
        let parsed: Value = serde_json::from_str(&output).expect("json");
        let summary = parsed
            .get("contextSummaryLines")
            .and_then(Value::as_array)
            .expect("summary");
        assert!(summary
            .iter()
            .any(|line| line.as_str().unwrap_or("").contains("Loaded guidance")));
        assert!(summary.iter().any(|line| line
            .as_str()
            .unwrap_or("")
            .contains("Deduped duplicate guidance")));
        assert!(summary
            .iter()
            .any(|line| line.as_str().unwrap_or("").contains("Conflict: tests")));
        assert!(summary.iter().any(|line| line
            .as_str()
            .unwrap_or("")
            .contains("Loaded skills: autopilot")));
        assert!(parsed
            .get("systemPromptAppendix")
            .and_then(Value::as_str)
            .unwrap_or("")
            .contains("Workspace guidance:"));

        let _ = fs::remove_dir_all(root);
    }
}
