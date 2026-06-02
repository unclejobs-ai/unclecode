use serde_json::{json, Value};
use std::collections::HashSet;
use std::path::{Component, Path, PathBuf};

pub fn parse_work_runtime_args_json(input_json: &str) -> Result<String, String> {
    let input: Value = serde_json::from_str(input_json)
        .map_err(|error| format!("Invalid work runtime args JSON: {error}"))?;
    let cwd = input
        .get("cwd")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .unwrap_or(".");
    let argv = input
        .get("argv")
        .and_then(Value::as_array)
        .map(|values| {
            values
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    serde_json::to_string(&parse_work_runtime_args(&argv, cwd)).map_err(|error| error.to_string())
}

pub fn parse_work_runtime_args_value(argv: &[String], cwd: &str) -> Value {
    parse_work_runtime_args(argv, cwd)
}

pub fn build_work_command_args_json(input_json: &str) -> Result<String, String> {
    let input: Value = serde_json::from_str(input_json)
        .map_err(|error| format!("Invalid work command args JSON: {error}"))?;
    let prompt_parts = input
        .get("promptParts")
        .and_then(Value::as_array)
        .map(|values| {
            values
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let options = input.get("options").unwrap_or(&Value::Null);
    serde_json::to_string(&json!({
        "args": build_work_command_args(&prompt_parts, options),
    }))
    .map_err(|error| error.to_string())
}

pub fn with_work_cwd_json(input_json: &str) -> Result<String, String> {
    let input: Value = serde_json::from_str(input_json)
        .map_err(|error| format!("Invalid work cwd args JSON: {error}"))?;
    let forwarded_args = input
        .get("forwardedArgs")
        .and_then(Value::as_array)
        .map(|values| {
            values
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let caller_cwd = input
        .get("callerCwd")
        .and_then(Value::as_str)
        .unwrap_or(".");
    serde_json::to_string(&json!({
        "args": with_work_cwd(&forwarded_args, caller_cwd),
    }))
    .map_err(|error| error.to_string())
}

pub fn resolve_work_entrypoint_paths_json(input_json: &str) -> Result<String, String> {
    let input: Value = serde_json::from_str(input_json)
        .map_err(|error| format!("Invalid work entrypoint paths JSON: {error}"))?;
    let cli_source_dir = input
        .get("cliSourceDir")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .unwrap_or(".");
    serde_json::to_string(&json!({
        "paths": resolve_work_entrypoint_paths(cli_source_dir),
    }))
    .map_err(|error| error.to_string())
}

fn parse_work_runtime_args(argv: &[String], cwd: &str) -> Value {
    let mut parsed_cwd = lexical_resolve(cwd, cwd);
    let mut provider: Option<&str> = None;
    let mut model: Option<String> = None;
    let mut reasoning: Option<&str> = None;
    let mut session_id: Option<String> = None;
    let mut prompt_parts = Vec::new();
    let mut show_help = false;
    let mut show_tools = false;

    let mut index = 0;
    while index < argv.len() {
        let arg = argv[index].as_str();
        match arg {
            "--help" => {
                show_help = true;
            }
            "--tools" => {
                show_tools = true;
            }
            "--cwd" => {
                let next = argv
                    .get(index + 1)
                    .map(String::as_str)
                    .unwrap_or(&parsed_cwd);
                parsed_cwd = lexical_resolve(&parsed_cwd, next);
                index += 1;
            }
            "--provider" => {
                match argv.get(index + 1).map(String::as_str) {
                    Some("anthropic") => provider = Some("anthropic"),
                    Some("gemini") => provider = Some("gemini"),
                    Some("openai") => provider = Some("openai"),
                    _ => {}
                }
                index += 1;
            }
            "--model" => {
                model = argv.get(index + 1).cloned();
                index += 1;
            }
            "--reasoning" => {
                match argv.get(index + 1).map(String::as_str) {
                    Some("low") => reasoning = Some("low"),
                    Some("medium") => reasoning = Some("medium"),
                    Some("high") => reasoning = Some("high"),
                    _ => {}
                }
                index += 1;
            }
            "--session-id" => {
                session_id = argv.get(index + 1).cloned();
                index += 1;
            }
            _ => {
                prompt_parts.push(arg.to_string());
            }
        }
        index += 1;
    }

    let mut result = json!({
        "cwd": parsed_cwd,
        "showHelp": show_help,
        "showTools": show_tools,
    });
    if let Some(provider) = provider {
        result["provider"] = json!(provider);
    }
    if let Some(model) = model {
        result["model"] = json!(model);
    }
    if let Some(reasoning) = reasoning {
        result["reasoning"] = json!(reasoning);
    }
    if let Some(session_id) = session_id {
        result["sessionId"] = json!(session_id);
    }
    if !prompt_parts.is_empty() {
        result["prompt"] = json!(prompt_parts.join(" "));
    }
    result
}

fn build_work_command_args(prompt_parts: &[String], options: &Value) -> Vec<String> {
    let mut forwarded_args = Vec::new();
    if bool_field(options, "help") {
        forwarded_args.push("--help".to_string());
    }
    if bool_field(options, "tools") {
        forwarded_args.push("--tools".to_string());
    }
    push_option_arg(&mut forwarded_args, options, "cwd", "--cwd");
    push_option_arg(&mut forwarded_args, options, "provider", "--provider");
    push_option_arg(&mut forwarded_args, options, "model", "--model");
    push_option_arg(&mut forwarded_args, options, "reasoning", "--reasoning");
    push_option_arg(&mut forwarded_args, options, "sessionId", "--session-id");
    forwarded_args.extend(prompt_parts.iter().cloned());
    forwarded_args
}

fn with_work_cwd(forwarded_args: &[String], caller_cwd: &str) -> Vec<String> {
    if forwarded_args.iter().any(|arg| arg == "--cwd") {
        return forwarded_args.to_vec();
    }
    let mut out = vec!["--cwd".to_string(), caller_cwd.to_string()];
    out.extend(forwarded_args.iter().cloned());
    out
}

fn resolve_work_entrypoint_paths(cli_source_dir: &str) -> Vec<String> {
    let cli_source_dir = normalize_path(Path::new(cli_source_dir));
    let repo_root = normalize_path(&cli_source_dir.join("../../.."));
    let local_dist_dir =
        if cli_source_dir.file_name().and_then(|name| name.to_str()) == Some("dist") {
            cli_source_dir.clone()
        } else {
            normalize_path(&cli_source_dir.join("../dist"))
        };
    let candidates = [
        repo_root.join("dist-work/apps/unclecode-cli/src/work-entry.js"),
        local_dist_dir.join("work-entry.js"),
    ];
    let mut seen = HashSet::new();
    candidates
        .into_iter()
        .filter(|path| path.exists())
        .filter_map(|path| {
            let path = normalize_path(&path).to_string_lossy().into_owned();
            if seen.insert(path.clone()) {
                Some(path)
            } else {
                None
            }
        })
        .collect()
}

fn push_option_arg(out: &mut Vec<String>, options: &Value, key: &str, flag: &str) {
    if let Some(value) = options.get(key).and_then(Value::as_str) {
        out.push(flag.to_string());
        out.push(value.to_string());
    }
}

fn bool_field(value: &Value, key: &str) -> bool {
    value.get(key).and_then(Value::as_bool).unwrap_or(false)
}

fn lexical_resolve(base: &str, input: &str) -> String {
    let input_path = Path::new(input);
    let combined = if input_path.is_absolute() {
        input_path.to_path_buf()
    } else {
        Path::new(base).join(input_path)
    };
    normalize_path(&combined).to_string_lossy().into_owned()
}

fn normalize_path(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            Component::Normal(part) => out.push(part),
            Component::RootDir | Component::Prefix(_) => out.push(component.as_os_str()),
        }
    }
    if out.as_os_str().is_empty() {
        PathBuf::from(".")
    } else {
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_work_runtime_args_contract() {
        let parsed = serde_json::from_str::<Value>(
            &parse_work_runtime_args_json(
                r#"{"cwd":"/repo","argv":["--cwd","/tmp/project-a","--provider","openai","--model","gpt-5.4","--reasoning","high","--session-id","work-123","--tools","fix","auth"]}"#,
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(parsed["cwd"], "/tmp/project-a");
        assert_eq!(parsed["provider"], "openai");
        assert_eq!(parsed["model"], "gpt-5.4");
        assert_eq!(parsed["reasoning"], "high");
        assert_eq!(parsed["sessionId"], "work-123");
        assert_eq!(parsed["prompt"], "fix auth");
        assert_eq!(parsed["showHelp"], false);
        assert_eq!(parsed["showTools"], true);
    }

    #[test]
    fn ignores_invalid_provider_and_reasoning_like_typescript() {
        let parsed = serde_json::from_str::<Value>(
            &parse_work_runtime_args_json(
                r#"{"cwd":"/repo","argv":["--provider","bogus","--reasoning","huge","prompt"]}"#,
            )
            .unwrap(),
        )
        .unwrap();
        assert!(parsed.get("provider").is_none());
        assert!(parsed.get("reasoning").is_none());
        assert_eq!(parsed["prompt"], "prompt");
    }

    #[test]
    fn resolves_relative_cwd_lexically() {
        let parsed = serde_json::from_str::<Value>(
            &parse_work_runtime_args_json(r#"{"cwd":"/repo/app","argv":["--cwd","../other"]}"#)
                .unwrap(),
        )
        .unwrap();
        assert_eq!(parsed["cwd"], "/repo/other");
    }

    #[test]
    fn builds_work_command_args_contract() {
        let parsed = serde_json::from_str::<Value>(
            &build_work_command_args_json(
                r#"{"promptParts":["review","auth.ts"],"options":{"tools":true,"cwd":"/tmp/project-a","provider":"openai","model":"gpt-5.4","reasoning":"high","sessionId":"work-123"}}"#,
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(
            parsed["args"],
            json!([
                "--tools",
                "--cwd",
                "/tmp/project-a",
                "--provider",
                "openai",
                "--model",
                "gpt-5.4",
                "--reasoning",
                "high",
                "--session-id",
                "work-123",
                "review",
                "auth.ts"
            ])
        );
    }

    #[test]
    fn injects_work_cwd_when_missing() {
        let injected = serde_json::from_str::<Value>(
            &with_work_cwd_json(r#"{"forwardedArgs":["--tools"],"callerCwd":"/tmp/project-a"}"#)
                .unwrap(),
        )
        .unwrap();
        assert_eq!(
            injected["args"],
            json!(["--cwd", "/tmp/project-a", "--tools"])
        );

        let preserved = serde_json::from_str::<Value>(
            &with_work_cwd_json(
                r#"{"forwardedArgs":["--cwd","/tmp/other","--tools"],"callerCwd":"/tmp/project-a"}"#,
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(preserved["args"], json!(["--cwd", "/tmp/other", "--tools"]));
    }

    #[test]
    fn resolves_work_entrypoint_paths_from_cli_source_dir() {
        let root = std::env::temp_dir().join(format!(
            "unclecode-work-entrypoint-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let source_dir = root.join("apps/unclecode-cli/src");
        let dist_work = root.join("dist-work/apps/unclecode-cli/src");
        let local_dist = root.join("apps/unclecode-cli/dist");
        std::fs::create_dir_all(&source_dir).unwrap();
        std::fs::create_dir_all(&dist_work).unwrap();
        std::fs::create_dir_all(&local_dist).unwrap();
        std::fs::write(dist_work.join("work-entry.js"), "").unwrap();
        std::fs::write(local_dist.join("work-entry.js"), "").unwrap();

        let parsed = serde_json::from_str::<Value>(
            &resolve_work_entrypoint_paths_json(&format!(
                r#"{{"cliSourceDir":"{}"}}"#,
                source_dir.to_string_lossy()
            ))
            .unwrap(),
        )
        .unwrap();
        let paths = parsed["paths"].as_array().unwrap();
        assert_eq!(paths.len(), 2);
        assert!(paths[0]
            .as_str()
            .unwrap()
            .ends_with("dist-work/apps/unclecode-cli/src/work-entry.js"));
        assert!(paths[1]
            .as_str()
            .unwrap()
            .ends_with("apps/unclecode-cli/dist/work-entry.js"));

        std::fs::remove_dir_all(root).unwrap();
    }
}
