use serde_json::Value;

pub fn build_prompt_command_prompt_json(input_json: &str) -> Result<String, String> {
    let input: Value = serde_json::from_str(input_json.trim())
        .map_err(|error| format!("Invalid prompt command JSON: {error}"))?;
    let kind = input
        .get("kind")
        .and_then(Value::as_str)
        .ok_or("Invalid prompt command JSON: missing string field `kind`")?;
    let focus = input
        .get("focus")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("current changes in this workspace");

    match kind {
        "review" => Ok(build_review_prompt(focus)),
        "commit" => Ok(build_commit_prompt(focus)),
        _ => Err(format!(
            "Invalid prompt command JSON: unsupported kind `{kind}`"
        )),
    }
}

fn build_review_prompt(focus: &str) -> String {
    let focus_line = format!("Focus request: {focus}");
    [
        "Review the current repository changes and implementation.",
        &focus_line,
        "Report concrete issues, risks, missing verification, and the smallest high-value next fixes.",
        "If no major issue is found, say that explicitly and still list remaining risks and verification gaps.",
        "Respond with sections: Findings, Risks, Recommended tests, Verdict.",
    ]
    .join("\n\n")
}

fn build_commit_prompt(focus: &str) -> String {
    let focus_line = format!("Focus request: {focus}");
    [
        "Draft a single git commit message using the Lore protocol.",
        &focus_line,
        "The first line must explain why, not what changed.",
        "Then provide a short body plus git trailers using this vocabulary when applicable:",
        "Constraint:\nRejected:\nConfidence:\nScope-risk:\nDirective:\nTested:\nNot-tested:",
        "If some details are unknown, keep them honest and concise instead of inventing facts.",
        "Output only the commit message.",
    ]
    .join("\n\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_review_prompt_with_default_focus() {
        let prompt = build_prompt_command_prompt_json(r#"{"kind":"review"}"#).unwrap();

        assert!(prompt.contains("Review the current repository changes and implementation."));
        assert!(prompt.contains("Focus request: current changes in this workspace"));
        assert!(
            prompt.contains("Respond with sections: Findings, Risks, Recommended tests, Verdict.")
        );
    }

    #[test]
    fn builds_review_prompt_with_trimmed_focus() {
        let prompt =
            build_prompt_command_prompt_json(r#"{"kind":"review","focus":" auth flow "}"#).unwrap();

        assert!(prompt.contains("Focus request: auth flow"));
    }

    #[test]
    fn builds_commit_prompt_with_lore_contract() {
        let prompt =
            build_prompt_command_prompt_json(r#"{"kind":"commit","focus":" release notes "}"#)
                .unwrap();

        assert!(prompt.contains("Draft a single git commit message using the Lore protocol."));
        assert!(prompt.contains("Focus request: release notes"));
        assert!(prompt.contains(
            "Constraint:\nRejected:\nConfidence:\nScope-risk:\nDirective:\nTested:\nNot-tested:"
        ));
        assert!(prompt.ends_with("Output only the commit message."));
    }

    #[test]
    fn rejects_unknown_kind() {
        let error = build_prompt_command_prompt_json(r#"{"kind":"summarize"}"#).unwrap_err();

        assert!(error.contains("unsupported kind"));
    }
}
