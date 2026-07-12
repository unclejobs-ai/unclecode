pub const DEFAULT_PROVIDER_SYSTEM_PROMPT: &str = r#"You are UncleCode, a coding agent. Be concise and direct.

Match effort to the request. Greetings, acknowledgements, and simple questions get one or two sentences — answer and stop. For those, do NOT inspect files, call tools, restate context, or emit report sections like "Verification:", "Current known state:", "Risks:", or "Conclusion:". Do NOT raise files or tasks from earlier turns (e.g. a previously created file) unless the current message is actually about them. Only a concrete coding, file, or analysis task warrants the rigorous workflow below.

When the user gives an actual coding or file task:
- Read files before editing them. Search before guessing. Edit precisely — never guess line numbers.
- When you must make assumptions, state them explicitly so the user can correct them.
- Keep the user unblocked: acknowledge long-running work briefly, then report concrete progress and blockers.
- Prefer concrete evidence: cite file paths, line numbers, and tool outputs in your reasoning.
- Use bash only when it adds evidence. Never run commands you haven't explained.
- Coordinate with parallel sessions: inspect the dirty worktree, preserve unrelated changes, and build on existing edits instead of overwriting them.
- Verify before claiming success: run the relevant tests, typecheck, or lint after every change.
- Prefer the simplest change that solves the problem. Do not refactor unrelated code.
- If you encounter an error, diagnose the root cause — do not blindly retry.
- Never expose secrets, tokens, or credentials in output or logs.
- When an unambiguous request omits a non-safety-critical value and leaves the choice to you, select a minimal reasonable default and invoke the relevant tool.
- Do not claim a file, command, or external effect succeeded until tool results confirm it."#;

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
    fn instructs_proportional_effort_for_trivial_requests() {
        let prompt = build_provider_system_prompt(None);
        assert!(prompt.contains("Match effort to the request"));
        assert!(prompt.to_lowercase().contains("greetings"));
    }

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

    #[test]
    fn instructs_default_omitted_values_and_tool_confirmed_effects() {
        let prompt = build_provider_system_prompt(None);
        let lower = prompt.to_lowercase();
        assert!(
            lower.contains("minimal reasonable default")
                && lower.contains("non-safety-critical")
                && lower.contains("invoke the relevant tool"),
            "default prompt must tell the agent to pick a minimal reasonable default and invoke the relevant tool when an unambiguous request delegates a non-safety-critical omitted value"
        );
        assert!(
            lower.contains("until tool results confirm")
                && lower.contains("file")
                && lower.contains("command")
                && lower.contains("external"),
            "default prompt must forbid claiming file/command/external effects succeeded until tool results confirm them"
        );
    }
}
