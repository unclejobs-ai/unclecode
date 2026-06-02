use crate::aci::AciError;
use crate::path_guard::{assert_within_workspace, ContainmentOptions};
use crate::runtime::{run_command, RuntimeCommand};
use serde_json::json;
use std::ffi::OsString;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SearchHit {
    pub path: String,
    pub line: Option<usize>,
    pub text: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SearchResult {
    pub truncated: bool,
    pub total_hits: usize,
    pub hits: Vec<SearchHit>,
}

pub fn glob_files(
    workspace_root: impl AsRef<Path>,
    pattern: &str,
    cap: usize,
) -> Result<SearchResult, AciError> {
    let cap = cap.max(1);
    let output = run_command(&RuntimeCommand {
        program: OsString::from("rg"),
        args: vec![
            OsString::from("--files"),
            OsString::from("--hidden"),
            OsString::from("--glob"),
            OsString::from(pattern),
            OsString::from("--glob"),
            OsString::from("!node_modules"),
            OsString::from("--glob"),
            OsString::from("!dist"),
            workspace_root.as_ref().as_os_str().to_os_string(),
        ],
        cwd: workspace_root.as_ref().to_path_buf(),
    })?;
    let lines = output
        .stdout
        .lines()
        .map(ToString::to_string)
        .collect::<Vec<_>>();
    let total_hits = lines.len();
    let truncated = total_hits > cap;
    let hits = lines
        .into_iter()
        .take(cap)
        .map(|path| SearchHit {
            path: display_workspace_path(workspace_root.as_ref(), PathBuf::from(path)),
            line: None,
            text: None,
        })
        .collect();
    Ok(SearchResult {
        truncated,
        total_hits,
        hits,
    })
}

pub fn find_files(
    workspace_root: impl AsRef<Path>,
    pattern: &str,
    cap: usize,
    globs: &[String],
) -> Result<SearchResult, AciError> {
    let cap = cap.max(1);
    let mut args = default_files_args();
    for glob in globs {
        args.push(OsString::from("--glob"));
        args.push(OsString::from(glob));
    }
    args.push(workspace_root.as_ref().as_os_str().to_os_string());
    let output = run_command(&RuntimeCommand {
        program: OsString::from("rg"),
        args,
        cwd: workspace_root.as_ref().to_path_buf(),
    })?;
    let lower_pattern = pattern.to_lowercase();
    let lines = output
        .stdout
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .filter(|line| line.to_lowercase().contains(&lower_pattern))
        .map(ToString::to_string)
        .collect::<Vec<_>>();
    let total_hits = lines.len();
    let truncated = total_hits > cap;
    let hits = lines
        .into_iter()
        .take(cap)
        .map(|path| SearchHit {
            path,
            line: None,
            text: None,
        })
        .collect();
    Ok(SearchResult {
        truncated,
        total_hits,
        hits,
    })
}

pub fn search_text(
    workspace_root: impl AsRef<Path>,
    query: &str,
    path: impl AsRef<Path>,
    cap: usize,
) -> Result<SearchResult, AciError> {
    search_text_with_options(workspace_root, query, path, cap, cap.max(1), &[])
}

pub fn search_text_with_options(
    workspace_root: impl AsRef<Path>,
    query: &str,
    path: impl AsRef<Path>,
    cap: usize,
    max_count_per_file: usize,
    globs: &[String],
) -> Result<SearchResult, AciError> {
    let target = assert_within_workspace(&workspace_root, path, ContainmentOptions::EXISTING)?;
    let cap = cap.max(1);
    let mut args = vec![
        OsString::from("-n"),
        OsString::from("--hidden"),
        OsString::from("--max-count"),
        OsString::from(max_count_per_file.max(1).to_string()),
        OsString::from("--glob"),
        OsString::from("!node_modules"),
        OsString::from("--glob"),
        OsString::from("!dist"),
    ];
    for glob in globs {
        args.push(OsString::from("--glob"));
        args.push(OsString::from(glob));
    }
    args.push(OsString::from("--"));
    args.push(OsString::from(query));
    args.push(target.into_os_string());
    let output = run_command(&RuntimeCommand {
        program: OsString::from("rg"),
        args,
        cwd: workspace_root.as_ref().to_path_buf(),
    })?;
    let lines: Vec<&str> = output.stdout.lines().collect();
    let total_hits = lines.len();
    let truncated = total_hits > cap;
    let hits = lines.into_iter().take(cap).map(parse_rg_line).collect();
    Ok(SearchResult {
        truncated,
        total_hits,
        hits,
    })
}

pub fn find_files_json(
    workspace_root: impl AsRef<Path>,
    pattern: &str,
    cap: usize,
    globs: &[String],
) -> Result<String, AciError> {
    let result = find_files(workspace_root, pattern, cap, globs)?;
    Ok(search_result_json(
        &result,
        result.truncated.then(|| {
            format!(
                "Found {} matches for \"{}\"; only the first {} returned. Refine the pattern (e.g., add a directory prefix or pass globs) and search again.",
                result.total_hits,
                pattern,
                cap.max(1)
            )
        }),
    ))
}

pub fn search_text_json(
    workspace_root: impl AsRef<Path>,
    query: &str,
    path: impl AsRef<Path>,
    cap: usize,
    max_count_per_file: usize,
    globs: &[String],
) -> Result<String, AciError> {
    let result =
        search_text_with_options(workspace_root, query, path, cap, max_count_per_file, globs)?;
    Ok(search_result_json(
        &result,
        result.truncated.then(|| {
            format!(
                "Found {} matches for \"{}\"; only the first {} returned. Refine the query (e.g., add a path filter, pass globs, or use a more specific token) and search again.",
                result.total_hits,
                query,
                cap.max(1)
            )
        }),
    ))
}

fn default_files_args() -> Vec<OsString> {
    vec![
        OsString::from("--files"),
        OsString::from("--hidden"),
        OsString::from("--glob"),
        OsString::from("!node_modules"),
        OsString::from("--glob"),
        OsString::from("!dist"),
    ]
}

fn search_result_json(result: &SearchResult, suggestion: Option<String>) -> String {
    let hits = result
        .hits
        .iter()
        .map(|hit| {
            let mut value = json!({ "path": hit.path });
            if let Some(line) = hit.line {
                value["line"] = json!(line);
            }
            if let Some(text) = &hit.text {
                value["text"] = json!(text);
            }
            value
        })
        .collect::<Vec<_>>();
    match suggestion {
        Some(suggestion) => json!({
            "truncated": result.truncated,
            "totalHits": result.total_hits,
            "hits": hits,
            "suggestion": suggestion,
        })
        .to_string(),
        None => json!({
            "truncated": result.truncated,
            "totalHits": result.total_hits,
            "hits": hits,
        })
        .to_string(),
    }
}

fn display_workspace_path(workspace_root: &Path, path: PathBuf) -> String {
    path.strip_prefix(workspace_root)
        .unwrap_or(&path)
        .to_string_lossy()
        .to_string()
}

fn parse_rg_line(line: &str) -> SearchHit {
    let mut parts = line.splitn(3, ':');
    let path = parts.next().unwrap_or_default().to_string();
    let line_number = parts.next().and_then(|value| value.parse::<usize>().ok());
    let text = parts.next().map(ToString::to_string);
    SearchHit {
        path,
        line: line_number,
        text,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn workspace_root() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .and_then(Path::parent)
            .expect("workspace root")
            .to_path_buf()
    }

    #[test]
    fn globs_workspace_files_with_cap() {
        let root = workspace_root();
        let result = glob_files(&root, "**/*.rs", 2).expect("glob rust files");
        assert!(result.total_hits >= 1);
        assert!(result.hits.len() <= 2);
        assert!(result.hits.iter().all(|hit| hit.path.ends_with(".rs")));
    }

    #[test]
    fn search_uses_literal_query_and_cap() {
        let root = workspace_root();
        let result = search_text(&root, "unclecode-core", "rust", 2).expect("search text");

        assert!(result.total_hits >= 1);
        assert!(result.hits.len() <= 2);
        assert!(result.hits.iter().any(|hit| {
            hit.path.contains("rust")
                && hit
                    .text
                    .as_deref()
                    .unwrap_or_default()
                    .contains("unclecode-core")
        }));
    }

    #[test]
    fn renders_find_and_search_json_contracts() {
        let root = workspace_root();
        let find_json = find_files_json(&root, "Cargo", 5, &[]).expect("find json");
        assert!(find_json.contains("\"totalHits\""));
        assert!(find_json.contains("\"hits\""));

        let search_json =
            search_text_json(&root, "unclecode-core", "rust", 3, 1, &[]).expect("search json");
        assert!(search_json.contains("\"totalHits\""));
        assert!(search_json.contains("\"line\""));
    }
}
