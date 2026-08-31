use std::env;
use std::ffi::OsString;

use unclecode_core::mode::{
    current_workspace_root, is_mode_profile_id, mode_label_for_locale, mode_profile,
    persist_project_mode, resolve_mode_status, MODE_PROFILE_IDS,
};

const MESSAGE_LOCALE_ENV_KEYS: &[&str] = &["LC_ALL", "LC_MESSAGES", "LANGUAGE", "LANG"];

pub fn top_level_mode_args(args: &[OsString]) -> Option<Vec<OsString>> {
    match args.first().and_then(|arg| arg.to_str()) {
        Some("mode") | Some("/mode") => Some(args[1..].to_vec()),
        Some(command) if command.starts_with("/mode ") => Some(
            command
                .split_whitespace()
                .skip(1)
                .map(OsString::from)
                .chain(args[1..].iter().cloned())
                .collect(),
        ),
        _ => None,
    }
}

pub fn run_top_level_mode_command(args: &[OsString]) -> Result<u8, String> {
    match args.first().and_then(|arg| arg.to_str()) {
        Some("--help") | Some("-h") | Some("help") => {
            print_mode_help();
            Ok(0)
        }
        None | Some("status") => {
            print_mode_status()?;
            Ok(0)
        }
        Some("set") => {
            let mode = args.get(1).and_then(|arg| arg.to_str()).ok_or_else(|| {
                format!("Usage: unclecode mode set <{}>", MODE_PROFILE_IDS.join("|"))
            })?;
            if !is_mode_profile_id(mode) {
                return Err(format!("Unsupported mode: {mode}"));
            }
            let workspace_root = current_workspace_root()?;
            let config_path = persist_project_mode(&workspace_root, mode)?;
            let profile = mode_profile(mode);
            println!("Active mode saved: {}", profile.id);
            println!(
                "Label: {}",
                mode_label_for_locale(profile.id, message_locale())
            );
            println!("Config path: {}", config_path.display());
            Ok(0)
        }
        _ => Err(mode_usage()),
    }
}

fn print_mode_status() -> Result<(), String> {
    let workspace_root = current_workspace_root()?;
    let status = resolve_mode_status(&workspace_root, |key| env::var(key).ok());
    println!("Active mode: {}", status.profile.id);
    println!(
        "Label: {}",
        mode_label_for_locale(status.profile.id, message_locale())
    );
    println!("Source: {}", status.source_label);
    println!("Editing: {}", status.profile.editing);
    println!("Search depth: {}", status.profile.search_depth);
    println!("Background tasks: {}", status.profile.background_tasks);
    println!("Explanation style: {}", status.profile.explanation_style);
    Ok(())
}

fn print_mode_help() {
    println!("{}", mode_usage());
    println!();
    println!("Rust-native mode commands:");
    println!("  unclecode mode status");
    println!("  unclecode mode set <{}>", MODE_PROFILE_IDS.join("|"));
}

fn mode_usage() -> String {
    "Usage: unclecode mode <status|set>".to_string()
}

fn message_locale() -> &'static str {
    resolve_message_locale(|key| env::var(key).ok())
}

fn resolve_message_locale(env_get: impl Fn(&str) -> Option<String>) -> &'static str {
    for key in MESSAGE_LOCALE_ENV_KEYS {
        let Some(raw) = env_get(key) else {
            continue;
        };
        let Some(locale) = raw
            .split(':')
            .next()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        else {
            continue;
        };
        let language = locale
            .split(['.', '@'])
            .next()
            .unwrap_or(locale)
            .split(['_', '-'])
            .next()
            .unwrap_or(locale);
        return if language.eq_ignore_ascii_case("ko") {
            "ko"
        } else {
            "en"
        };
    }
    "en"
}

#[cfg(test)]
mod tests {
    use super::resolve_message_locale;

    #[test]
    fn resolves_message_locale_by_posix_precedence() {
        let locale = resolve_message_locale(|key| match key {
            "LC_ALL" => Some("en_US.UTF-8".to_string()),
            "LC_MESSAGES" => Some("ko_KR.UTF-8".to_string()),
            "LANGUAGE" => Some("ko_KR:en_US".to_string()),
            "LANG" => Some("ko_KR.UTF-8".to_string()),
            _ => None,
        });

        assert_eq!(locale, "en");
    }

    #[test]
    fn resolves_korean_from_each_supported_locale_variable() {
        for selected_key in ["LC_ALL", "LC_MESSAGES", "LANGUAGE", "LANG"] {
            let locale = resolve_message_locale(|key| {
                (key == selected_key).then(|| "ko_KR.UTF-8:en_US".to_string())
            });

            assert_eq!(locale, "ko", "locale variable {selected_key}");
        }
    }

    #[test]
    fn defaults_unknown_and_missing_locales_to_english() {
        assert_eq!(resolve_message_locale(|_| None), "en");
        assert_eq!(
            resolve_message_locale(|key| (key == "LANG").then(|| "C.UTF-8".to_string())),
            "en"
        );
        assert_eq!(
            resolve_message_locale(|key| {
                (key == "LANGUAGE").then(|| "ja_JP:ko_KR".to_string())
            }),
            "en"
        );
    }
}
