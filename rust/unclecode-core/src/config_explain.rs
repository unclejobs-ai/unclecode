use crate::command_router::extension_manifests_json;
use crate::mode::{mode_profile, MODE_PROFILE_IDS};
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};

const DEFAULT_MODEL: &str = "claude-sonnet-4-20250514";

#[derive(Debug, Clone)]
struct SourceLayer {
    label: String,
    detail: Option<String>,
    config: Value,
    issues: Vec<String>,
}

#[derive(Debug, Clone)]
struct Contribution {
    label: String,
    detail: Option<String>,
    value: String,
}

#[derive(Debug, Clone)]
struct PromptSection {
    id: String,
    title: String,
    body: String,
    deleted: bool,
    contributors: Vec<Contribution>,
}

pub fn config_explain_text(
    workspace_root: &Path,
    user_home_dir: Option<&Path>,
    cli_mode: Option<&str>,
    cli_model: Option<&str>,
) -> Result<String, String> {
    let mode_sources = collect_mode_sources(workspace_root, user_home_dir, cli_mode, cli_model)?;
    let mode = setting_value(&mode_sources, value_mode, "default");
    let active_mode = mode_profile(&mode);
    let sources = collect_sources(workspace_root, user_home_dir, &mode, cli_mode, cli_model)?;
    let model = explain_setting(&sources, value_model, DEFAULT_MODEL);
    let mode_explanation = explain_setting(&mode_sources, value_mode, "default");
    let editing = explain_setting(&sources, value_behavior_editing, active_mode.editing);
    let search_depth = explain_setting(
        &sources,
        value_behavior_search_depth,
        active_mode.search_depth,
    );
    let background_tasks = explain_setting(
        &sources,
        value_behavior_background_tasks,
        active_mode.background_tasks,
    );
    let explanation_style = explain_setting(
        &sources,
        value_behavior_explanation_style,
        active_mode.explanation_style,
    );
    let prompt_sections = explain_prompt_sections(&sources);
    let prompt_rendered = render_prompt(&prompt_sections);

    let mut lines = vec![
        "Source order (lowest -> highest):".to_string(),
        "1. built-in defaults".to_string(),
        "2. built-in mode profile".to_string(),
        "3. plugin overlay".to_string(),
        "4. project config".to_string(),
        "5. user config".to_string(),
        "6. environment".to_string(),
        "7. cli flags".to_string(),
        "8. session overrides".to_string(),
        String::new(),
    ];

    let issues = sources
        .iter()
        .flat_map(|source| {
            source
                .issues
                .iter()
                .map(|issue| (source, issue))
                .collect::<Vec<_>>()
        })
        .collect::<Vec<_>>();
    if !issues.is_empty() {
        lines.push("Broken sources:".to_string());
        for (source, issue) in issues {
            lines.push(format!(
                "- {}{}: {}",
                source.label,
                source
                    .detail
                    .as_ref()
                    .map(|detail| format!(" ({detail})"))
                    .unwrap_or_default(),
                issue
            ));
        }
        lines.push(String::new());
    }

    lines.extend([
        format!("Active mode: {}", active_mode.id),
        String::new(),
        "Resolved settings:".to_string(),
    ]);
    push_setting_lines(&mut lines, "mode", &mode_explanation);
    push_setting_lines(&mut lines, "model", &model);
    push_setting_lines(&mut lines, "editing", &editing);
    push_setting_lines(&mut lines, "searchDepth", &search_depth);
    push_setting_lines(&mut lines, "backgroundTasks", &background_tasks);
    push_setting_lines(&mut lines, "explanationStyle", &explanation_style);

    lines.extend([String::new(), "Prompt sections:".to_string()]);
    for section in &prompt_sections {
        lines.push(format!(
            "- {}{}",
            section.id,
            if section.deleted { " (deleted)" } else { "" }
        ));
        lines.push(format!(
            "  winner: {}",
            section
                .contributors
                .last()
                .map(|contribution| contribution.label.as_str())
                .unwrap_or("built-in defaults")
        ));
        lines.push(format!(
            "  sources: {}",
            format_contributors(&section.contributors)
        ));
    }
    lines.extend([
        String::new(),
        "Effective prompt:".to_string(),
        prompt_rendered,
    ]);

    Ok(lines.join("\n"))
}

fn collect_sources(
    workspace_root: &Path,
    user_home_dir: Option<&Path>,
    active_mode: &str,
    cli_mode: Option<&str>,
    cli_model: Option<&str>,
) -> Result<Vec<SourceLayer>, String> {
    let mode_sources = collect_mode_sources(workspace_root, user_home_dir, cli_mode, cli_model)?;
    let mut sources = Vec::new();
    if let Some(defaults) = mode_sources.first() {
        sources.push(defaults.clone());
    }
    sources.push(SourceLayer {
        label: "built-in mode profile".to_string(),
        detail: Some(active_mode.to_string()),
        config: mode_overlay(active_mode),
        issues: Vec::new(),
    });
    sources.extend(mode_sources.into_iter().skip(1));
    Ok(sources)
}

fn collect_mode_sources(
    workspace_root: &Path,
    user_home_dir: Option<&Path>,
    cli_mode: Option<&str>,
    cli_model: Option<&str>,
) -> Result<Vec<SourceLayer>, String> {
    let mut sources = vec![SourceLayer {
        label: "built-in defaults".to_string(),
        detail: None,
        config: json!({
            "mode": "default",
            "model": DEFAULT_MODEL,
            "prompt": {
                "sections": {
                    "identity": {
                        "title": "Role",
                        "body": "You are an autonomous coding agent. Execute tasks to completion. Do not ask for permission on obvious next steps - proceed. If blocked, try an alternative approach. Only ask when truly ambiguous or destructive."
                    },
                    "execution": {
                        "title": "Quality",
                        "body": "Write correct, type-safe code. Never use `as any`, `@ts-ignore`, or placeholder logic. Delete dead code immediately. Run verification after changes - format, lint, typecheck, then tests - and report failures honestly."
                    }
                }
            }
        }),
        issues: Vec::new(),
    }];

    let overlays_raw = extension_manifests_json(
        &workspace_root.to_string_lossy(),
        user_home_dir
            .map(|path| path.to_string_lossy().to_string())
            .as_deref(),
    )?;
    let overlays: Value = serde_json::from_str(&overlays_raw)
        .map_err(|error| format!("Invalid extension manifest summary: {error}"))?;
    if let Some(items) = overlays.get("configOverlays").and_then(Value::as_array) {
        for item in items {
            let name = item
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("extension")
                .to_string();
            sources.push(SourceLayer {
                label: "plugin overlay".to_string(),
                detail: Some(name),
                config: sanitize_config(item.get("config").unwrap_or(&Value::Null)).0,
                issues: Vec::new(),
            });
        }
    }

    sources.push(read_config_source(
        "project config",
        None,
        workspace_root.join(".unclecode/config.json"),
    ));
    sources.push(read_config_source(
        "user config",
        None,
        user_home_dir
            .map(Path::to_path_buf)
            .unwrap_or_else(|| PathBuf::from("."))
            .join(".unclecode/config.json"),
    ));
    sources.push(SourceLayer {
        label: "environment".to_string(),
        detail: None,
        config: sanitize_config(&json!({
            "mode": std::env::var("UNCLECODE_MODE").ok(),
            "model": std::env::var("UNCLECODE_MODEL").ok(),
            "behavior": {
                "editing": std::env::var("UNCLECODE_EDITING_POLICY").ok(),
                "searchDepth": std::env::var("UNCLECODE_SEARCH_DEPTH").ok(),
                "backgroundTasks": std::env::var("UNCLECODE_BACKGROUND_TASKS").ok(),
                "explanationStyle": std::env::var("UNCLECODE_EXPLANATION_STYLE").ok()
            }
        }))
        .0,
        issues: Vec::new(),
    });
    sources.push(SourceLayer {
        label: "cli flags".to_string(),
        detail: None,
        config: sanitize_config(&json!({
            "mode": cli_mode,
            "model": cli_model
        }))
        .0,
        issues: Vec::new(),
    });
    sources.push(SourceLayer {
        label: "session overrides".to_string(),
        detail: None,
        config: json!({}),
        issues: Vec::new(),
    });

    Ok(sources)
}

fn read_config_source(label: &str, detail: Option<String>, path: PathBuf) -> SourceLayer {
    match fs::read_to_string(&path) {
        Ok(raw) => match serde_json::from_str::<Value>(&raw) {
            Ok(value) => {
                let (config, issues) = sanitize_config(&value);
                SourceLayer {
                    label: label.to_string(),
                    detail,
                    config,
                    issues,
                }
            }
            Err(error) => SourceLayer {
                label: label.to_string(),
                detail,
                config: json!({}),
                issues: vec![format!("Invalid JSON: {error}")],
            },
        },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => SourceLayer {
            label: label.to_string(),
            detail,
            config: json!({}),
            issues: Vec::new(),
        },
        Err(error) => SourceLayer {
            label: label.to_string(),
            detail,
            config: json!({}),
            issues: vec![format!("Failed to read {}: {error}", path.display())],
        },
    }
}

fn sanitize_config(value: &Value) -> (Value, Vec<String>) {
    let Some(object) = value.as_object() else {
        return (json!({}), vec!["Config must be a JSON object.".to_string()]);
    };
    let mut issues = Vec::new();
    let mut output = serde_json::Map::new();

    if let Some(mode) = object.get("mode") {
        if let Some(mode) = mode
            .as_str()
            .map(str::trim)
            .filter(|mode| MODE_PROFILE_IDS.contains(mode))
        {
            output.insert("mode".to_string(), Value::String(mode.to_string()));
        } else if !mode.is_null() {
            issues.push("Invalid mode value.".to_string());
        }
    }
    if let Some(model) = object.get("model") {
        if let Some(model) = model
            .as_str()
            .map(str::trim)
            .filter(|model| !model.is_empty())
        {
            output.insert("model".to_string(), Value::String(model.to_string()));
        } else if !model.is_null() {
            issues.push("Invalid model value.".to_string());
        }
    }
    if let Some(behavior) = sanitize_behavior(object.get("behavior"), &mut issues) {
        output.insert("behavior".to_string(), behavior);
    }
    if let Some(prompt) = sanitize_prompt(object.get("prompt"), &mut issues) {
        output.insert("prompt".to_string(), prompt);
    }

    (Value::Object(output), issues)
}

fn sanitize_behavior(value: Option<&Value>, issues: &mut Vec<String>) -> Option<Value> {
    let value = value?;
    if value.is_null() {
        return None;
    }
    let Some(object) = value.as_object() else {
        issues.push("Invalid behavior configuration.".to_string());
        return None;
    };
    let mut behavior = serde_json::Map::new();
    for key in [
        "editing",
        "searchDepth",
        "backgroundTasks",
        "explanationStyle",
    ] {
        if let Some(raw) = object.get(key) {
            if let Some(value) = raw
                .as_str()
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                behavior.insert(key.to_string(), Value::String(value.to_string()));
            }
        }
    }
    (!behavior.is_empty()).then_some(Value::Object(behavior))
}

fn sanitize_prompt(value: Option<&Value>, issues: &mut Vec<String>) -> Option<Value> {
    let value = value?;
    if value.is_null() {
        return None;
    }
    let Some(prompt) = value.as_object() else {
        issues.push("Invalid prompt configuration.".to_string());
        return None;
    };
    let Some(sections) = prompt.get("sections").and_then(Value::as_object) else {
        if prompt.contains_key("sections") {
            issues.push("Invalid prompt.sections configuration.".to_string());
        }
        return None;
    };
    let mut sanitized_sections = serde_json::Map::new();
    for (id, section) in sections {
        if section.is_null() {
            sanitized_sections.insert(id.clone(), Value::Null);
            continue;
        }
        let title = section.get("title").and_then(Value::as_str);
        let body = section.get("body").and_then(Value::as_str);
        if let (Some(title), Some(body)) = (title, body) {
            sanitized_sections.insert(id.clone(), json!({ "title": title, "body": body }));
        } else {
            issues.push(format!("Invalid prompt section: {id}."));
        }
    }
    (!sanitized_sections.is_empty()).then_some(json!({ "sections": sanitized_sections }))
}

fn mode_overlay(mode: &str) -> Value {
    let profile = mode_profile(mode);
    json!({
        "behavior": {
            "editing": profile.editing,
            "searchDepth": profile.search_depth,
            "backgroundTasks": profile.background_tasks,
            "explanationStyle": profile.explanation_style
        },
        "prompt": {
            "sections": {
                "active-mode": active_mode_section(mode)
            }
        }
    })
}

fn active_mode_section(mode: &str) -> Value {
    let profile = mode_profile(mode);
    let shared = format!(
        "Keep replies {} and operator-friendly.",
        profile.explanation_style
    );
    let body = match profile.id {
        "search" => vec![
            "Search mode is active.",
            "Stay read-only and do not edit files.",
            "If the user asks for edits, answer in at most two short lines and suggest `/mode set yolo` or `/mode set default`.",
            &shared,
        ],
        "analyze" => vec![
            "Analyze mode is active.",
            "Prefer diagnosis, evidence, and concrete next steps before edits.",
            "If editing is needed, say so briefly and suggest `/mode set yolo` or `/mode set default`.",
            &shared,
        ],
        "ultrawork" => vec![
            "Ultra Work mode is active.",
            "Edit directly, use deeper search, and prefer background or parallel work when it helps.",
            &shared,
        ],
        "yolo" => vec![
            "YOLO mode is active.",
            "Edit directly on clear requests and avoid needless confirmation on low-risk reversible steps.",
            &shared,
        ],
        _ => vec![
            "Default mode is active.",
            "Edit when needed, but stay inside scope and use balanced search depth.",
            &shared,
        ],
    }
    .join("\n");
    json!({ "title": "Active Mode", "body": body })
}

fn explain_setting(
    sources: &[SourceLayer],
    pick: fn(&Value) -> Option<String>,
    fallback: &str,
) -> Vec<Contribution> {
    let mut contributors = sources
        .iter()
        .filter_map(|source| {
            pick(&source.config).map(|value| Contribution {
                label: source.label.clone(),
                detail: source.detail.clone(),
                value,
            })
        })
        .collect::<Vec<_>>();
    if contributors.is_empty() {
        contributors.push(Contribution {
            label: "built-in defaults".to_string(),
            detail: None,
            value: fallback.to_string(),
        });
    }
    contributors
}

fn setting_value(
    sources: &[SourceLayer],
    pick: fn(&Value) -> Option<String>,
    fallback: &str,
) -> String {
    explain_setting(sources, pick, fallback)
        .last()
        .map(|contribution| contribution.value.clone())
        .unwrap_or_else(|| fallback.to_string())
}

fn value_mode(value: &Value) -> Option<String> {
    value
        .get("mode")
        .and_then(Value::as_str)
        .map(str::to_string)
}

fn value_model(value: &Value) -> Option<String> {
    value
        .get("model")
        .and_then(Value::as_str)
        .map(str::to_string)
}

fn value_behavior_editing(value: &Value) -> Option<String> {
    behavior_value(value, "editing")
}

fn value_behavior_search_depth(value: &Value) -> Option<String> {
    behavior_value(value, "searchDepth")
}

fn value_behavior_background_tasks(value: &Value) -> Option<String> {
    behavior_value(value, "backgroundTasks")
}

fn value_behavior_explanation_style(value: &Value) -> Option<String> {
    behavior_value(value, "explanationStyle")
}

fn behavior_value(value: &Value, key: &str) -> Option<String> {
    value
        .get("behavior")
        .and_then(|behavior| behavior.get(key))
        .and_then(Value::as_str)
        .map(str::to_string)
}

fn explain_prompt_sections(sources: &[SourceLayer]) -> Vec<PromptSection> {
    let mut sections: Vec<PromptSection> = Vec::new();
    for source in sources {
        let Some(section_object) = source
            .config
            .get("prompt")
            .and_then(|prompt| prompt.get("sections"))
            .and_then(Value::as_object)
        else {
            continue;
        };
        for (id, section) in section_object {
            let contribution = Contribution {
                label: source.label.clone(),
                detail: source.detail.clone(),
                value: if section.is_null() {
                    "null".to_string()
                } else {
                    section.to_string()
                },
            };
            let existing = sections.iter_mut().find(|entry| entry.id == *id);
            if section.is_null() {
                if let Some(existing) = existing {
                    existing.deleted = true;
                    existing.contributors.push(contribution);
                } else {
                    sections.push(PromptSection {
                        id: id.clone(),
                        title: id.clone(),
                        body: String::new(),
                        deleted: true,
                        contributors: vec![contribution],
                    });
                }
                continue;
            }
            let title = section.get("title").and_then(Value::as_str).unwrap_or(id);
            let body = section.get("body").and_then(Value::as_str).unwrap_or("");
            if let Some(existing) = existing {
                existing.title = title.to_string();
                existing.body = body.to_string();
                existing.deleted = false;
                existing.contributors.push(contribution);
            } else {
                sections.push(PromptSection {
                    id: id.clone(),
                    title: title.to_string(),
                    body: body.to_string(),
                    deleted: false,
                    contributors: vec![contribution],
                });
            }
        }
    }
    if let Some(index) = sections
        .iter()
        .position(|section| section.id == "active-mode")
    {
        let active_mode = sections.remove(index);
        sections.push(active_mode);
    }
    sections
}

fn render_prompt(sections: &[PromptSection]) -> String {
    sections
        .iter()
        .filter(|section| !section.deleted)
        .map(|section| format!("## {}\n{}", section.title, section.body))
        .collect::<Vec<_>>()
        .join("\n\n")
}

fn push_setting_lines(lines: &mut Vec<String>, name: &str, contributors: &[Contribution]) {
    let winner = contributors.last();
    lines.push(format!(
        "- {name} = {}",
        winner
            .map(|contribution| contribution.value.as_str())
            .unwrap_or("")
    ));
    lines.push(format!(
        "  winner: {}",
        winner
            .map(|contribution| contribution.label.as_str())
            .unwrap_or("built-in defaults")
    ));
    lines.push(format!("  sources: {}", format_contributors(contributors)));
}

fn format_contributors(contributors: &[Contribution]) -> String {
    contributors
        .iter()
        .map(|contribution| {
            let suffix = contribution
                .detail
                .as_ref()
                .map(|detail| format!(" ({detail})"))
                .unwrap_or_default();
            format!("{}{suffix}={}", contribution.label, contribution.value)
        })
        .collect::<Vec<_>>()
        .join(" -> ")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn explains_mode_env_and_plugin_prompt_overlay() {
        let root = temp_root("config-explain");
        let extension_dir = root.join(".unclecode/extensions");
        fs::create_dir_all(&extension_dir).unwrap();
        fs::write(
            extension_dir.join("focus.json"),
            r#"{
              "name":"focus-tools",
              "config":{"prompt":{"sections":{"plugin-note":{"title":"Plugin Note","body":"Plugin overlay note."}}}}
            }"#,
        )
        .unwrap();
        std::env::set_var("UNCLECODE_MODEL", "integration-env-model");
        let output = config_explain_text(&root, None, Some("search"), None).unwrap();
        std::env::remove_var("UNCLECODE_MODEL");
        assert!(output.contains("Source order"));
        assert!(output.contains("Active mode: search"));
        assert!(output.contains("- model = integration-env-model"));
        assert!(output.contains("winner: environment"));
        assert!(output.contains("active-mode"));
        assert!(output.contains("Plugin Note"));
        assert!(output.contains("Plugin overlay note."));
        let _ = fs::remove_dir_all(root);
    }

    fn temp_root(label: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("unclecode-rust-{label}-{nanos}"))
    }
}
