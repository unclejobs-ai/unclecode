use std::env;
use std::fs;
use std::path::{Path, PathBuf};

use serde_json::{Map, Value};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModeProfile {
    pub id: &'static str,
    pub label: &'static str,
    pub editing: &'static str,
    pub search_depth: &'static str,
    pub background_tasks: &'static str,
    pub explanation_style: &'static str,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModeStatus {
    pub profile: ModeProfile,
    pub source_label: &'static str,
}

pub const MODE_PROFILE_IDS: &[&str] = &[
    "default",
    "ultrawork",
    "search",
    "analyze",
    "yolo",
    "plan",
    "build",
];

pub fn is_mode_profile_id(value: &str) -> bool {
    MODE_PROFILE_IDS.contains(&value)
}

pub fn project_config_path(workspace_root: &Path) -> PathBuf {
    workspace_root.join(".unclecode").join("config.json")
}

pub fn user_config_path(home: Option<String>) -> PathBuf {
    PathBuf::from(home.unwrap_or_else(|| ".".to_string()))
        .join(".unclecode")
        .join("config.json")
}

pub fn resolve_mode_status(
    workspace_root: &Path,
    env_get: impl Fn(&str) -> Option<String>,
) -> ModeStatus {
    let project_mode = read_mode_from_config(&project_config_path(workspace_root));
    let user_mode = read_mode_from_config(&user_config_path(env_get("HOME")));
    let env_mode = env_get("UNCLECODE_MODE")
        .as_deref()
        .map(str::trim)
        .filter(|value| is_mode_profile_id(value))
        .map(ToOwned::to_owned);

    if let Some(mode) = env_mode {
        return ModeStatus {
            profile: mode_profile(&mode),
            source_label: "environment",
        };
    }

    if let Some(mode) = user_mode {
        return ModeStatus {
            profile: mode_profile(&mode),
            source_label: "user config",
        };
    }

    if let Some(mode) = project_mode {
        return ModeStatus {
            profile: mode_profile(&mode),
            source_label: "project config",
        };
    }

    ModeStatus {
        profile: mode_profile("default"),
        source_label: "built-in defaults",
    }
}

pub fn persist_project_mode(workspace_root: &Path, mode: &str) -> Result<PathBuf, String> {
    if !is_mode_profile_id(mode) {
        return Err(format!("Unsupported mode: {mode}"));
    }

    let config_path = project_config_path(workspace_root);
    let mut config = read_project_config_object(&config_path)?;
    config.insert("mode".to_string(), Value::String(mode.to_string()));

    if let Some(parent) = config_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Failed to create {}: {error}", parent.display()))?;
    }

    let raw = serde_json::to_string_pretty(&Value::Object(config))
        .map_err(|error| format!("Failed to encode project config: {error}"))?;
    fs::write(&config_path, format!("{raw}\n"))
        .map_err(|error| format!("Failed to write {}: {error}", config_path.display()))?;
    Ok(config_path)
}

pub fn mode_label(mode: &str) -> String {
    let normalized = mode.trim().to_ascii_lowercase();
    if is_mode_profile_id(&normalized) {
        return mode_profile(&normalized).label.to_string();
    }
    format!("{normalized} mode")
}

pub fn mode_profile(mode: &str) -> ModeProfile {
    match mode {
        "ultrawork" => ModeProfile {
            id: "ultrawork",
            label: "집중 작업 모드",
            editing: "allowed",
            search_depth: "deep",
            background_tasks: "preferred",
            explanation_style: "concise",
        },
        "search" => ModeProfile {
            id: "search",
            label: "탐색 모드",
            editing: "forbidden",
            search_depth: "deep",
            background_tasks: "preferred",
            explanation_style: "concise",
        },
        "analyze" => ModeProfile {
            id: "analyze",
            label: "분석 모드",
            editing: "reviewed",
            search_depth: "balanced",
            background_tasks: "allowed",
            explanation_style: "detailed",
        },
        "yolo" => ModeProfile {
            id: "yolo",
            label: "YOLO 모드",
            editing: "allowed",
            search_depth: "balanced",
            background_tasks: "preferred",
            explanation_style: "concise",
        },
        "plan" => ModeProfile {
            id: "plan",
            label: "계획 모드",
            editing: "forbidden",
            search_depth: "deep",
            background_tasks: "forbidden",
            explanation_style: "detailed",
        },
        "build" => ModeProfile {
            id: "build",
            label: "구현 모드",
            editing: "allowed",
            search_depth: "balanced",
            background_tasks: "allowed",
            explanation_style: "balanced",
        },
        _ => ModeProfile {
            id: "default",
            label: "작업 모드",
            editing: "allowed",
            search_depth: "balanced",
            background_tasks: "allowed",
            explanation_style: "balanced",
        },
    }
}

fn read_mode_from_config(path: &Path) -> Option<String> {
    let raw = fs::read_to_string(path).ok()?;
    let parsed: Value = serde_json::from_str(&raw).ok()?;
    let mode = parsed.get("mode")?.as_str()?.trim();
    is_mode_profile_id(mode).then(|| mode.to_string())
}

fn read_project_config_object(path: &Path) -> Result<Map<String, Value>, String> {
    match fs::read_to_string(path) {
        Ok(raw) => match serde_json::from_str::<Value>(&raw) {
            Ok(Value::Object(object)) => Ok(object),
            Ok(_) => Err("Project config must be a JSON object.".to_string()),
            Err(error) => Err(format!("Invalid project config JSON: {error}")),
        },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Map::new()),
        Err(error) => Err(format!("Failed to read {}: {error}", path.display())),
    }
}

pub fn current_workspace_root() -> Result<PathBuf, String> {
    env::current_dir().map_err(|error| format!("Failed to resolve current directory: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn persists_and_reports_project_mode() {
        let root = temp_root("mode-project");
        let config_path = persist_project_mode(&root, "yolo").expect("persist mode");

        let status = resolve_mode_status(&root, |_| None);

        assert_eq!(config_path, root.join(".unclecode/config.json"));
        assert_eq!(status.profile.id, "yolo");
        assert_eq!(status.profile.label, "YOLO 모드");
        assert_eq!(status.source_label, "project config");
        let raw = fs::read_to_string(config_path).expect("config raw");
        assert!(raw.contains("\"mode\": \"yolo\""));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn mode_profiles_use_korean_operator_labels() {
        assert_eq!(mode_label("default"), "작업 모드");
        assert_eq!(mode_label("yolo"), "YOLO 모드");
        assert_eq!(mode_label("ultrawork"), "집중 작업 모드");
        assert_eq!(mode_label("search"), "탐색 모드");
        assert_eq!(mode_label("analyze"), "분석 모드");
        assert_eq!(mode_label("plan"), "계획 모드");
        assert_eq!(mode_label("build"), "구현 모드");
    }

    #[test]
    fn environment_mode_is_used_when_config_missing() {
        let root = temp_root("mode-env");
        let status = resolve_mode_status(&root, |key| {
            (key == "UNCLECODE_MODE").then(|| "plan".to_string())
        });

        assert_eq!(status.profile.id, "plan");
        assert_eq!(status.source_label, "environment");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn environment_mode_overrides_project_mode() {
        let root = temp_root("mode-env-over-project");
        persist_project_mode(&root, "yolo").expect("persist mode");

        let status = resolve_mode_status(&root, |key| {
            (key == "UNCLECODE_MODE").then(|| "plan".to_string())
        });

        assert_eq!(status.profile.id, "plan");
        assert_eq!(status.source_label, "environment");
        let _ = fs::remove_dir_all(root);
    }

    fn temp_root(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "unclecode-{name}-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }
}
