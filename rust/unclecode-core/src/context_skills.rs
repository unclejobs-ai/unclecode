use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::fs;
use std::path::{Path, PathBuf};

const SKILL_SEARCH_LIMIT: usize = 64;

#[derive(Debug, Clone, PartialEq, Eq)]
struct SkillMetadata {
    name: String,
    description: String,
    path: PathBuf,
    scope: &'static str,
}

pub fn discover_skill_metadata_json(cwd: &Path, home_dir: &Path) -> Result<String, String> {
    let skills = discover_skill_metadata(cwd, home_dir)?;
    serde_json::to_string(&skills.iter().map(skill_metadata_json).collect::<Vec<_>>())
        .map_err(|error| error.to_string())
}

pub fn list_available_skills_json(cwd: &Path, home_dir: &Path) -> Result<String, String> {
    let skills = discover_skill_metadata(cwd, home_dir)?;
    serde_json::to_string(
        &skills
            .iter()
            .map(|skill| {
                json!({
                    "name": skill.name,
                    "path": skill.path.to_string_lossy(),
                    "scope": skill.scope,
                    "summary": skill.description
                })
            })
            .collect::<Vec<_>>(),
    )
    .map_err(|error| error.to_string())
}

pub fn load_named_skill_json(name: &str, cwd: &Path, home_dir: &Path) -> Result<String, String> {
    let mut attempts = Vec::new();
    for file_path in candidate_skill_paths(name, cwd, home_dir) {
        match fs::read_to_string(&file_path) {
            Ok(content) => {
                attempts.push(load_attempt_json(&file_path, true, None));
                return serde_json::to_string(&json!({
                    "name": name,
                    "path": file_path.to_string_lossy(),
                    "content": content,
                    "attempts": attempts
                }))
                .map_err(|error| error.to_string());
            }
            Err(error) => {
                attempts.push(load_attempt_json(
                    &file_path,
                    false,
                    Some(&error.to_string()),
                ));
            }
        }
    }

    if let Some(skill) = discover_skill_metadata(cwd, home_dir)?
        .into_iter()
        .find(|skill| skill.name == name)
    {
        let content = fs::read_to_string(&skill.path).map_err(|error| {
            format!(
                "Failed to read discovered skill {}: {error}",
                skill.path.display()
            )
        })?;
        attempts.push(load_attempt_json(&skill.path, true, None));
        return serde_json::to_string(&json!({
            "name": name,
            "path": skill.path.to_string_lossy(),
            "content": content,
            "attempts": attempts
        }))
        .map_err(|error| error.to_string());
    }

    Err(format!("Skill not found: {name}"))
}

fn discover_skill_metadata(cwd: &Path, home_dir: &Path) -> Result<Vec<SkillMetadata>, String> {
    let mut files = Vec::new();
    files.extend(collect_skill_files(
        &cwd.join(".codex/skills"),
        SKILL_SEARCH_LIMIT,
    ));
    files.extend(collect_skill_files(
        &cwd.join(".cursor/skills"),
        SKILL_SEARCH_LIMIT,
    ));
    files.extend(collect_skill_files(
        &home_dir.join(".codex/skills"),
        SKILL_SEARCH_LIMIT,
    ));
    files.extend(collect_skill_files(
        &home_dir.join(".cursor/skills"),
        SKILL_SEARCH_LIMIT,
    ));
    files.extend(
        collect_skill_files(&home_dir.join(".agents/skills"), SKILL_SEARCH_LIMIT)
            .into_iter()
            .filter(|path| !is_legacy_superpowers_skill_path(path, home_dir)),
    );

    let mut deduped = HashMap::<String, SkillMetadata>::new();
    for file_path in files {
        let inferred_name = file_path
            .parent()
            .and_then(Path::file_name)
            .and_then(|name| name.to_str())
            .unwrap_or("")
            .to_string();
        if inferred_name.is_empty() || deduped.contains_key(&inferred_name) {
            continue;
        }

        let content = fs::read_to_string(&file_path)
            .map_err(|error| format!("Failed to read skill {}: {error}", file_path.display()))?;
        let frontmatter = parse_skill_frontmatter(&content);
        let name = frontmatter
            .get("name")
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .unwrap_or(inferred_name);
        if deduped.contains_key(&name) {
            continue;
        }
        let description = frontmatter
            .get("description")
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| summarize_skill_content(&content));
        let scope = if file_path.starts_with(cwd) {
            "project"
        } else {
            "user"
        };
        deduped.insert(
            name.clone(),
            SkillMetadata {
                name,
                description,
                path: file_path,
                scope,
            },
        );
    }

    let mut discovered = deduped.into_values().collect::<Vec<_>>();
    discovered.sort_by(|left, right| left.name.cmp(&right.name));
    Ok(discovered)
}

fn collect_skill_files(root: &Path, limit: usize) -> Vec<PathBuf> {
    let mut found = Vec::new();
    let mut queue = VecDeque::from([root.to_path_buf()]);
    while let Some(current) = queue.pop_front() {
        if found.len() >= limit {
            break;
        }
        let Ok(entries) = fs::read_dir(current) else {
            continue;
        };
        for entry in entries.filter_map(Result::ok) {
            let next_path = entry.path();
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if file_type.is_dir() {
                queue.push_back(next_path);
                continue;
            }
            if file_type.is_file() && entry.file_name() == "SKILL.md" {
                found.push(next_path);
                if found.len() >= limit {
                    break;
                }
            }
        }
    }
    found
}

fn parse_skill_frontmatter(content: &str) -> HashMap<String, String> {
    let Some(stripped) = content.strip_prefix("---") else {
        return HashMap::new();
    };
    let stripped = stripped
        .strip_prefix("\r\n")
        .or_else(|| stripped.strip_prefix('\n'));
    let Some(rest) = stripped else {
        return HashMap::new();
    };
    let Some((body, _)) = rest.split_once("\n---") else {
        return HashMap::new();
    };
    let mut fields = HashMap::new();
    for line in body.lines() {
        let Some((key, raw_value)) = line.split_once(':') else {
            continue;
        };
        let key = key.trim();
        if key.is_empty()
            || !key
                .chars()
                .next()
                .map(|ch| ch.is_ascii_alphabetic())
                .unwrap_or(false)
            || !key
                .chars()
                .all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-')
        {
            continue;
        }
        fields.insert(key.to_string(), trim_quotes(raw_value.trim()).to_string());
    }
    fields
}

fn summarize_skill_content(content: &str) -> String {
    let line = content.lines().map(str::trim).find(|entry| {
        !entry.is_empty()
            && !entry.starts_with('#')
            && !entry.starts_with("<!--")
            && !entry.starts_with("-->")
            && *entry != "-"
    });
    match line {
        Some(line) if line.chars().count() > 88 => {
            format!("{}...", line.chars().take(85).collect::<String>())
        }
        Some(line) => line.to_string(),
        None => "skill loaded".to_string(),
    }
}

fn candidate_skill_paths(name: &str, cwd: &Path, home_dir: &Path) -> Vec<PathBuf> {
    vec![
        cwd.join(".codex")
            .join("skills")
            .join(name)
            .join("SKILL.md"),
        cwd.join(".cursor")
            .join("skills")
            .join(name)
            .join("SKILL.md"),
        home_dir
            .join(".codex")
            .join("skills")
            .join(name)
            .join("SKILL.md"),
        home_dir
            .join(".cursor")
            .join("skills")
            .join(name)
            .join("SKILL.md"),
        home_dir
            .join(".agents")
            .join("skills")
            .join(name)
            .join("SKILL.md"),
    ]
}

fn is_legacy_superpowers_skill_path(file_path: &Path, home_dir: &Path) -> bool {
    file_path.starts_with(home_dir.join(".agents/skills/superpowers"))
}

fn trim_quotes(value: &str) -> &str {
    value
        .strip_prefix(['"', '\''])
        .and_then(|stripped| stripped.strip_suffix(['"', '\'']))
        .unwrap_or(value)
}

fn skill_metadata_json(skill: &SkillMetadata) -> Value {
    json!({
        "name": skill.name,
        "description": skill.description,
        "source": "skills",
        "commandType": "prompt",
        "paths": [skill.path.to_string_lossy()],
        "path": skill.path.to_string_lossy(),
        "scope": skill.scope
    })
}

fn load_attempt_json(path: &Path, ok: bool, error: Option<&str>) -> Value {
    let mut value = json!({
        "path": path.to_string_lossy(),
        "ok": ok
    });
    if let Some(error) = error {
        value["error"] = json!(error);
    }
    value
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_frontmatter_and_summary() {
        let fields = parse_skill_frontmatter(
            "---\nname: analyze\ndescription: 'Inspect repo.'\n---\n# Title\nBody\n",
        );
        assert_eq!(fields.get("name").map(String::as_str), Some("analyze"));
        assert_eq!(
            fields.get("description").map(String::as_str),
            Some("Inspect repo.")
        );
        assert_eq!(summarize_skill_content("# Title\nBody\n"), "Body");
    }

    #[test]
    fn discovers_cursor_skill_paths() {
        let root = std::env::temp_dir().join(format!(
            "unclecode-cursor-skills-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("time")
                .as_nanos()
        ));
        let home = root.join("home");
        let cwd = root.join("repo");
        let skill_dir = cwd.join(".cursor/skills/demo");
        std::fs::create_dir_all(&skill_dir).expect("mkdir");
        std::fs::write(
            skill_dir.join("SKILL.md"),
            "---\nname: demo\ndescription: Cursor skill fixture\n---\n# Demo\n",
        )
        .expect("write skill");

        let json = discover_skill_metadata_json(&cwd, &home).expect("discover");
        assert!(json.contains("demo"));
        assert!(json.contains(".cursor/skills/demo/SKILL.md"));

        let _ = std::fs::remove_dir_all(root);
    }
}
