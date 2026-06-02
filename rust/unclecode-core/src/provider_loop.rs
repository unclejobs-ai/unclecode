use serde_json::json;

const DEFAULT_LIMIT_TEXT: &str = "Stopped after reaching the tool iteration limit.";
pub const DEFAULT_PROVIDER_TOOL_LOOP_MAX: usize = 8;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderLoopDecision {
    pub decision: String,
    pub text: String,
}

pub fn provider_loop_decision(
    iteration: usize,
    max_iterations: usize,
    action_count: usize,
    assistant_text: &str,
) -> ProviderLoopDecision {
    if action_count == 0 {
        return ProviderLoopDecision {
            decision: "final".to_string(),
            text: assistant_text.to_string(),
        };
    }

    if iteration.saturating_add(1) >= max_iterations {
        return ProviderLoopDecision {
            decision: "limit".to_string(),
            text: if assistant_text.is_empty() {
                DEFAULT_LIMIT_TEXT.to_string()
            } else {
                assistant_text.to_string()
            },
        };
    }

    ProviderLoopDecision {
        decision: "continue".to_string(),
        text: assistant_text.to_string(),
    }
}

pub fn provider_loop_decision_json(
    iteration: usize,
    max_iterations: usize,
    action_count: usize,
    assistant_text: &str,
) -> String {
    let decision = provider_loop_decision(iteration, max_iterations, action_count, assistant_text);
    json!({
        "decision": decision.decision,
        "text": decision.text
    })
    .to_string()
}

pub fn provider_iteration_action_plan_json(
    iteration: usize,
    max_iterations: usize,
    action_count: usize,
    assistant_text: &str,
) -> String {
    let decision = provider_loop_decision(iteration, max_iterations, action_count, assistant_text);
    json!({
        "decision": decision.decision,
        "text": decision.text,
        "shouldDispatchTools": decision.decision == "continue",
    })
    .to_string()
}

pub fn provider_loop_limit_json() -> String {
    json!({
        "maxIterations": DEFAULT_PROVIDER_TOOL_LOOP_MAX,
        "limitText": DEFAULT_LIMIT_TEXT
    })
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finalizes_when_no_tool_actions_remain() {
        assert_eq!(
            provider_loop_decision(0, DEFAULT_PROVIDER_TOOL_LOOP_MAX, 0, "done"),
            ProviderLoopDecision {
                decision: "final".to_string(),
                text: "done".to_string()
            }
        );
    }

    #[test]
    fn continues_until_iteration_limit() {
        assert_eq!(
            provider_loop_decision(
                DEFAULT_PROVIDER_TOOL_LOOP_MAX - 2,
                DEFAULT_PROVIDER_TOOL_LOOP_MAX,
                1,
                "thinking"
            )
            .decision,
            "continue"
        );
        assert_eq!(
            provider_loop_decision(
                DEFAULT_PROVIDER_TOOL_LOOP_MAX - 1,
                DEFAULT_PROVIDER_TOOL_LOOP_MAX,
                1,
                ""
            )
            .text,
            DEFAULT_LIMIT_TEXT.to_string()
        );
    }

    #[test]
    fn renders_loop_limit_contract() {
        let parsed: serde_json::Value =
            serde_json::from_str(&provider_loop_limit_json()).expect("json");
        assert_eq!(parsed["maxIterations"], DEFAULT_PROVIDER_TOOL_LOOP_MAX);
        assert_eq!(parsed["limitText"], DEFAULT_LIMIT_TEXT);
    }

    #[test]
    fn renders_iteration_action_plan_for_dispatch_boundary() {
        let parsed: serde_json::Value =
            serde_json::from_str(&provider_iteration_action_plan_json(0, 8, 1, "working"))
                .expect("json");
        assert_eq!(parsed["decision"], "continue");
        assert_eq!(parsed["shouldDispatchTools"], true);

        let parsed: serde_json::Value =
            serde_json::from_str(&provider_iteration_action_plan_json(7, 8, 1, "done"))
                .expect("json");
        assert_eq!(parsed["decision"], "limit");
        assert_eq!(parsed["shouldDispatchTools"], false);
    }
}
