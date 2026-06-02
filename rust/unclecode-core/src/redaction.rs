const REDACTED: &str = "[REDACTED]";

pub fn redact_secrets(content: &str) -> String {
    let mut redacted = content.to_string();
    redacted = redact_prefixed_token(&redacted, "ghp_", 36, is_ascii_alphanumeric);
    redacted = redact_prefixed_token(&redacted, "gho_", 36, is_ascii_alphanumeric);
    redacted = redact_prefixed_token(&redacted, "ghu_", 36, is_ascii_alphanumeric);
    redacted = redact_prefixed_token(&redacted, "ghs_", 36, is_ascii_alphanumeric);
    redacted = redact_prefixed_token(&redacted, "ghr_", 36, is_ascii_alphanumeric);
    redacted = redact_prefixed_token(&redacted, "github_pat_", 82, is_github_pat_char);
    redacted = redact_prefixed_token(&redacted, "glpat-", 20, is_word_or_dash);
    redacted = redact_prefixed_token(&redacted, "AIza", 35, is_word_or_dash);
    redacted = redact_prefixed_token(&redacted, "npm_", 36, is_ascii_alphanumeric);
    redacted = redact_prefixed_token(&redacted, "hf_", 34, is_ascii_alphanumeric);
    redacted = redact_openai_project_key(&redacted);
    redacted = redact_dapi_token(&redacted);
    redacted = redact_anthropic_api_key(&redacted);
    redacted = redact_legacy_openai_key(&redacted);
    redact_private_keys(&redacted)
}

fn redact_prefixed_token(
    content: &str,
    prefix: &str,
    tail_len: usize,
    valid_tail: fn(char) -> bool,
) -> String {
    redact_matching(content, |rest| {
        let tail = rest.strip_prefix(prefix)?;
        let mut count = 0;
        let mut end = prefix.len();
        for ch in tail.chars() {
            if count >= tail_len || !valid_tail(ch) {
                break;
            }
            count += 1;
            end += ch.len_utf8();
        }
        (count == tail_len).then_some(end)
    })
}

fn redact_openai_project_key(content: &str) -> String {
    redact_matching(content, |rest| {
        for prefix in ["sk-proj-", "sk-svcacct-", "sk-admin-"] {
            if let Some(tail) = rest.strip_prefix(prefix) {
                let tail_len = token_tail_len(tail, is_openai_key_char);
                if tail_len >= 20 {
                    return Some(prefix.len() + tail_len);
                }
            }
        }
        None
    })
}

fn redact_dapi_token(content: &str) -> String {
    redact_matching(content, |rest| {
        let tail = rest.strip_prefix("dapi")?;
        let hex_len = tail.chars().take_while(|ch| ch.is_ascii_hexdigit()).count();
        if hex_len != 32 {
            return None;
        }
        let mut end = "dapi".len() + hex_len;
        let suffix = &rest[end..];
        if suffix.starts_with('-') {
            let digit_len = suffix[1..]
                .chars()
                .take_while(|ch| ch.is_ascii_digit())
                .count();
            if digit_len == 1 {
                end += 2;
            }
        }
        Some(end)
    })
}

fn redact_anthropic_api_key(content: &str) -> String {
    redact_matching(content, |rest| {
        let prefix = "sk-ant-api03-";
        let tail = rest.strip_prefix(prefix)?;
        let tail_len = token_tail_len(tail, is_openai_key_char);
        (tail_len >= 95 && tail[..tail_len].ends_with("AA")).then_some(prefix.len() + tail_len)
    })
}

fn redact_legacy_openai_key(content: &str) -> String {
    redact_matching(content, |rest| {
        let prefix = "sk-";
        let tail = rest.strip_prefix(prefix)?;
        let tail_len = token_tail_len(tail, |ch| ch.is_ascii_alphanumeric());
        let token = &tail[..tail_len];
        (tail_len >= 44 && token.contains("T3BlbkFJ")).then_some(prefix.len() + tail_len)
    })
}

fn redact_private_keys(content: &str) -> String {
    let mut out = String::with_capacity(content.len());
    let mut remaining = content;
    while let Some(start) = remaining.to_ascii_uppercase().find("-----BEGIN") {
        let (before, after_start) = remaining.split_at(start);
        out.push_str(before);
        let upper_after = after_start.to_ascii_uppercase();
        let begin_marker_len = "-----BEGIN".len();
        let Some(header_close_rel) = upper_after[begin_marker_len..].find("-----") else {
            out.push_str(after_start);
            return out;
        };
        let header_end = begin_marker_len + header_close_rel + 5;
        let header = &upper_after[..header_end];
        if !header.contains("PRIVATE KEY") {
            out.push_str(&after_start[..header_end]);
            remaining = &after_start[header_end..];
            continue;
        }
        let Some(end_start) = upper_after[header_end..].find("-----END") else {
            out.push_str(after_start);
            return out;
        };
        let end_start = header_end + end_start;
        let end_marker_len = "-----END".len();
        let Some(end_close_rel) = upper_after[end_start + end_marker_len..].find("-----") else {
            out.push_str(after_start);
            return out;
        };
        let end_close = end_start + end_marker_len + end_close_rel + 5;
        out.push_str(REDACTED);
        remaining = &after_start[end_close..];
    }
    out.push_str(remaining);
    out
}

fn redact_matching(content: &str, matcher: impl Fn(&str) -> Option<usize>) -> String {
    let mut out = String::with_capacity(content.len());
    let mut index = 0;
    while index < content.len() {
        let rest = &content[index..];
        if let Some(len) = matcher(rest) {
            out.push_str(REDACTED);
            index += len;
            continue;
        }
        let ch = rest.chars().next().expect("non-empty rest");
        out.push(ch);
        index += ch.len_utf8();
    }
    out
}

fn token_tail_len(tail: &str, valid_tail: fn(char) -> bool) -> usize {
    tail.chars()
        .take_while(|ch| valid_tail(*ch))
        .map(char::len_utf8)
        .sum()
}

fn is_ascii_alphanumeric(ch: char) -> bool {
    ch.is_ascii_alphanumeric()
}

fn is_word_or_dash(ch: char) -> bool {
    ch.is_ascii_alphanumeric() || ch == '_' || ch == '-'
}

fn is_github_pat_char(ch: char) -> bool {
    ch.is_ascii_alphanumeric() || ch == '_'
}

fn is_openai_key_char(ch: char) -> bool {
    ch.is_ascii_alphanumeric() || ch == '_' || ch == '-'
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacts_common_provider_tokens() {
        let github_token = format!("{}{}", "ghp_", "1".repeat(36));
        let github_pat = format!("{}{}", "github_pat_", "a".repeat(82));
        let openai_key = format!("{}{}", "sk-proj-", "a".repeat(30));
        let input = format!("{github_token} {github_pat} {openai_key}");
        assert_eq!(redact_secrets(&input), "[REDACTED] [REDACTED] [REDACTED]");
    }

    #[test]
    fn redacts_google_and_huggingface_tokens() {
        let google_key = format!("{}{}", "AIza", "1".repeat(35));
        let huggingface_token = format!("{}{}", "hf_", "A".repeat(34));
        let input = format!("{google_key} {huggingface_token}");
        assert_eq!(redact_secrets(&input), "[REDACTED] [REDACTED]");
    }

    #[test]
    fn redacts_private_key_blocks() {
        let input = "before -----BEGIN PRIVATE KEY-----\nabcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyz\n-----END PRIVATE KEY----- after";
        assert_eq!(redact_secrets(input), "before [REDACTED] after");
    }
}
