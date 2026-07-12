#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ModelPrice {
    pub input_usd_per_1m: f64,
    pub output_usd_per_1m: f64,
}

const OPENAI_PRICES: &[(&str, ModelPrice)] = &[
    (
        "gpt-5.6-sol",
        ModelPrice {
            input_usd_per_1m: 5.0,
            output_usd_per_1m: 30.0,
        },
    ),
    (
        "gpt-5.6-terra",
        ModelPrice {
            input_usd_per_1m: 2.5,
            output_usd_per_1m: 15.0,
        },
    ),
    (
        "gpt-5.6-luna",
        ModelPrice {
            input_usd_per_1m: 1.0,
            output_usd_per_1m: 6.0,
        },
    ),
    (
        "gpt-5.6",
        ModelPrice {
            input_usd_per_1m: 5.0,
            output_usd_per_1m: 30.0,
        },
    ),
];

const ANTHROPIC_PRICES: &[(&str, ModelPrice)] = &[
    (
        "claude-haiku-4-5",
        ModelPrice {
            input_usd_per_1m: 0.8,
            output_usd_per_1m: 4.0,
        },
    ),
    (
        "claude-sonnet-4-6",
        ModelPrice {
            input_usd_per_1m: 3.0,
            output_usd_per_1m: 15.0,
        },
    ),
    (
        "claude-opus-4-7",
        ModelPrice {
            input_usd_per_1m: 15.0,
            output_usd_per_1m: 75.0,
        },
    ),
];

const GEMINI_PRICES: &[(&str, ModelPrice)] = &[
    (
        "gemini-2.5-flash",
        ModelPrice {
            input_usd_per_1m: 0.3,
            output_usd_per_1m: 2.5,
        },
    ),
    (
        "gemini-2.5-pro",
        ModelPrice {
            input_usd_per_1m: 1.25,
            output_usd_per_1m: 10.0,
        },
    ),
    (
        "gemini-3.1-flash",
        ModelPrice {
            input_usd_per_1m: 0.5,
            output_usd_per_1m: 3.0,
        },
    ),
    (
        "gemini-3.1-pro",
        ModelPrice {
            input_usd_per_1m: 2.0,
            output_usd_per_1m: 12.0,
        },
    ),
];

pub fn model_price(model_id: &str) -> Option<ModelPrice> {
    let normalized = model_id.trim();
    if normalized.is_empty() {
        return None;
    }
    let lower = normalized.to_ascii_lowercase();
    if lower.starts_with("claude") {
        return match_price(ANTHROPIC_PRICES, normalized);
    }
    if lower.starts_with("gemini") {
        return match_price(GEMINI_PRICES, normalized);
    }
    match_price(OPENAI_PRICES, normalized)
}

pub fn estimate_cost_usd(model_id: &str, prompt_tokens: f64, completion_tokens: f64) -> f64 {
    let Some(price) = model_price(model_id) else {
        return 0.0;
    };
    let prompt_cost = (prompt_tokens / 1_000_000.0) * price.input_usd_per_1m;
    let completion_cost = (completion_tokens / 1_000_000.0) * price.output_usd_per_1m;
    prompt_cost + completion_cost
}

fn match_price(table: &[(&str, ModelPrice)], model_id: &str) -> Option<ModelPrice> {
    table
        .iter()
        .find_map(|(key, price)| (*key == model_id).then_some(*price))
        .or_else(|| {
            table
                .iter()
                .find_map(|(key, price)| model_id.starts_with(&format!("{key}-")).then_some(*price))
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn returns_known_provider_prices() {
        assert_eq!(model_price("gpt-5.6-sol").unwrap().input_usd_per_1m, 5.0);
        assert_eq!(
            model_price("gpt-5.6-terra").unwrap().output_usd_per_1m,
            15.0
        );
        assert_eq!(model_price("gpt-5.6-luna").unwrap().output_usd_per_1m, 6.0);
        assert_eq!(
            model_price("claude-sonnet-4-6").unwrap().output_usd_per_1m,
            15.0
        );
        assert_eq!(model_price("gemini-3.1-pro").unwrap().input_usd_per_1m, 2.0);
    }

    #[test]
    fn falls_back_to_family_for_suffixed_models() {
        assert_eq!(
            model_price("claude-sonnet-4-6-20260301")
                .unwrap()
                .input_usd_per_1m,
            3.0
        );
    }

    #[test]
    fn estimates_cost_and_unknowns_as_zero() {
        assert_eq!(
            estimate_cost_usd("gpt-5.6-sol", 1_000_000.0, 1_000_000.0),
            35.0
        );
        assert_eq!(
            estimate_cost_usd("no-such-model", 1_000_000.0, 1_000_000.0),
            0.0
        );
        assert!((estimate_cost_usd("claude-haiku-4-5", 500.0, 1000.0) - 0.0044).abs() < 1e-9);
    }
}
