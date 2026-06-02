pub const DEFAULT_PROVIDER_SYSTEM_PROMPT: &str = r#"You are UncleCode, a rigorous coding assistant that prioritises correctness over speed.
- Read files before editing them. Search before guessing. Edit precisely — never guess line numbers.
- When you must make assumptions, state them explicitly so the user can correct them.
- Prefer concrete evidence: cite file paths, line numbers, and tool outputs in your reasoning.
- Use bash only when it adds evidence. Never run commands you haven't explained.
- Verify before claiming success: run the relevant tests, typecheck, or lint after every change.
- Prefer the simplest change that solves the problem. Do not refactor unrelated code.
- If you encounter an error, diagnose the root cause — do not blindly retry.
- Never expose secrets, tokens, or credentials in output or logs."#;

pub fn build_provider_system_prompt(appendix: Option<&str>) -> String {
    let appendix = appendix.unwrap_or_default().trim();
    if appendix.is_empty() {
        return DEFAULT_PROVIDER_SYSTEM_PROMPT.to_string();
    }
    format!("{DEFAULT_PROVIDER_SYSTEM_PROMPT}\n\n{appendix}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn returns_default_provider_system_prompt_without_appendix() {
        let prompt = build_provider_system_prompt(None);
        assert!(prompt.starts_with("You are UncleCode"));
        assert!(prompt.contains("Read files before editing them."));
        assert!(!prompt.ends_with("\n\n"));
    }

    #[test]
    fn appends_trimmed_provider_system_prompt_appendix() {
        let prompt = build_provider_system_prompt(Some("  Extra workspace guidance. \n"));
        assert!(prompt.contains("Never expose secrets"));
        assert!(prompt.ends_with("Extra workspace guidance."));
        assert!(prompt.contains("\n\nExtra workspace guidance."));
    }
}
