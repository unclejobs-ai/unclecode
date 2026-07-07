use std::env;
use std::ffi::OsString;

use unclecode_core::http_transport::{redact_proxy_url_for_display, resolve_proxy_policy};
use unclecode_core::model_pricing::{estimate_cost_usd, model_price};
use unclecode_core::model_registry::{
    detect_provider_for_model, openai_reasoning_support, provider_capability_json, provider_label,
    provider_model_catalog, provider_route_json, resolve_provider_route,
};

pub fn top_level_model_args(args: &[OsString]) -> Option<Vec<OsString>> {
    match args.first().and_then(|arg| arg.to_str()) {
        Some("model") | Some("/model") => Some(args[1..].to_vec()),
        Some(command) if command.starts_with("/model ") => Some(
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

pub fn run_top_level_model_command(args: &[OsString]) -> Result<u8, String> {
    match args.first().and_then(|arg| arg.to_str()) {
        None | Some("list") | Some("catalog") => {
            let provider = args.get(1).and_then(|arg| arg.to_str()).unwrap_or("openai");
            print_model_catalog(provider)?;
            Ok(0)
        }
        Some("route") | Some("provider-route") => {
            let provider = args.get(1).and_then(|arg| arg.to_str()).unwrap_or("auto");
            let model = args.get(2).and_then(|arg| arg.to_str());
            print_provider_route(provider, model)?;
            Ok(0)
        }
        Some("route-json") | Some("provider-route-json") => {
            let provider = args.get(1).and_then(|arg| arg.to_str()).unwrap_or("auto");
            let model = args.get(2).and_then(|arg| arg.to_str());
            let route = resolve_provider_route(provider, model)?;
            let proxy = resolve_proxy_policy(&route.endpoint_url)?;
            println!("{}", provider_route_json(&route, &proxy)?);
            Ok(0)
        }
        Some("reasoning") => {
            let model = args
                .get(1)
                .and_then(|arg| arg.to_str())
                .ok_or_else(model_usage)?;
            print_reasoning(model);
            Ok(0)
        }
        Some("price") => {
            let model = args
                .get(1)
                .and_then(|arg| arg.to_str())
                .ok_or_else(model_usage)?;
            print_model_price(model);
            Ok(0)
        }
        Some("estimate-cost") => {
            let model = args
                .get(1)
                .and_then(|arg| arg.to_str())
                .ok_or_else(model_usage)?;
            let prompt_tokens = parse_token_count(args.get(2), "prompt-tokens")?;
            let completion_tokens = parse_token_count(args.get(3), "completion-tokens")?;
            println!(
                "Estimated cost: ${:.6}",
                estimate_cost_usd(model, prompt_tokens, completion_tokens)
            );
            Ok(0)
        }
        Some("detect-provider") => {
            let model = args
                .get(1)
                .and_then(|arg| arg.to_str())
                .ok_or_else(model_usage)?;
            println!("Provider: {}", detect_provider_for_model(model));
            Ok(0)
        }
        Some("capability") => {
            let provider = args
                .get(1)
                .and_then(|arg| arg.to_str())
                .ok_or_else(model_usage)?;
            let capability = args
                .get(2)
                .and_then(|arg| arg.to_str())
                .ok_or_else(model_usage)?;
            let model = args.get(3).and_then(|arg| arg.to_str()).unwrap_or_default();
            println!("{}", provider_capability_json(provider, capability, model)?);
            Ok(0)
        }
        Some("label") => {
            let provider = args
                .get(1)
                .and_then(|arg| arg.to_str())
                .ok_or_else(model_usage)?;
            println!("Label: {}", provider_label(provider));
            Ok(0)
        }
        Some("--help") | Some("-h") | Some("help") => {
            print_model_help();
            Ok(0)
        }
        Some(model_id) if !model_id.starts_with('-') => {
            print_model_summary(model_id)?;
            Ok(0)
        }
        _ => Err(model_usage()),
    }
}

fn print_model_catalog(provider: &str) -> Result<(), String> {
    let active_key = format!("{}_MODEL", provider.to_ascii_uppercase());
    let custom_key = format!("{}_MODELS", provider.to_ascii_uppercase());
    let active_model = env::var(&active_key).ok();
    let catalog = provider_model_catalog(
        provider,
        active_model.as_deref(),
        env::var(&custom_key).ok().as_deref(),
    );
    if catalog.models.is_empty() {
        return Err(format!("Unsupported runtime provider: {provider}"));
    }
    let default_model = resolve_provider_route(provider, None)
        .map(|route| route.default_model)
        .unwrap_or_else(|_| catalog.models[0].clone());

    println!("Provider: {}", catalog.label);
    println!("Default model: {default_model}");
    if let Some(active_model) = active_model
        .as_deref()
        .map(str::trim)
        .filter(|model| !model.is_empty() && *model != default_model.as_str())
    {
        println!("Active model: {active_model}");
    }
    println!("Models:");
    for model in catalog.models {
        let support = if provider == "openai" {
            let support = openai_reasoning_support(&model);
            if support.status == "supported" {
                format!(
                    "reasoning {}",
                    support
                        .default_effort
                        .unwrap_or_else(|| "medium".to_string())
                )
            } else {
                "reasoning unavailable".to_string()
            }
        } else {
            "reasoning unavailable".to_string()
        };
        println!("  {model} · {support}");
    }
    Ok(())
}

fn print_provider_route(provider: &str, model: Option<&str>) -> Result<(), String> {
    let route = resolve_provider_route(provider, model)?;
    let proxy = resolve_proxy_policy(&route.endpoint_url)?;
    println!("Provider: {} ({})", route.label, route.provider_id);
    println!("Transport: {}", route.transport);
    println!(
        "Runtime: {}",
        if route.runtime_supported {
            "supported"
        } else {
            "unsupported"
        }
    );
    println!("Default model: {}", route.default_model);
    println!("Endpoint: {}", route.endpoint_url);
    println!(
        "Proxy: {}",
        proxy
            .proxy_url
            .as_deref()
            .map(redact_proxy_url_for_display)
            .unwrap_or_else(|| format!("direct to {}", proxy.target_host))
    );
    println!("Proxy source: {}", proxy.source);
    if proxy.bypassed {
        println!("Proxy bypass: yes");
    }
    println!("Env: {}", route.env_keys.join(", "));
    Ok(())
}

fn print_reasoning(model: &str) {
    let support = openai_reasoning_support(model);
    println!("Model: {model}");
    println!("Reasoning: {}", support.status);
    println!(
        "Default effort: {}",
        support.default_effort.unwrap_or_else(|| "none".to_string())
    );
    println!(
        "Supported efforts: {}",
        if support.supported_efforts.is_empty() {
            "none".to_string()
        } else {
            support.supported_efforts.join(", ")
        }
    );
}

fn print_model_price(model: &str) {
    println!("Model: {model}");
    match model_price(model) {
        Some(price) => {
            println!("Input: ${}/1M tokens", price.input_usd_per_1m);
            println!("Output: ${}/1M tokens", price.output_usd_per_1m);
        }
        None => {
            println!("Pricing: unknown");
        }
    }
}

fn print_model_summary(model: &str) -> Result<(), String> {
    let provider = detect_provider_for_model(model);
    println!("Model: {model}");
    println!("Provider: {provider}");
    print_provider_route("auto", Some(model))?;
    if provider == "openai" {
        print_reasoning(model);
        print_model_price(model);
    }
    Ok(())
}

fn parse_token_count(arg: Option<&OsString>, name: &str) -> Result<f64, String> {
    arg.and_then(|arg| arg.to_str())
        .ok_or_else(model_usage)?
        .parse::<f64>()
        .map_err(|error| format!("Invalid {name}: {error}"))
}

fn print_model_help() {
    println!("{}", model_usage());
    println!();
    println!("Examples:");
    println!("  unclecode model list openai");
    println!("  unclecode model route auto gpt-5.5");
    println!("  unclecode model reasoning gpt-5.5");
    println!("  unclecode model estimate-cost gpt-5.5 1000000 250000");
}

fn model_usage() -> String {
    "Usage: unclecode model <list [provider]|route [provider|auto] [model]|route-json [provider|auto] [model]|reasoning <model>|price <model>|estimate-cost <model> <prompt-tokens> <completion-tokens>|detect-provider <model>|capability <provider> <capability> [model]|label <provider>|<model-id>>".to_string()
}
