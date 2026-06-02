pub fn normalize_json_object_argument(raw: &str) -> &str {
    let trimmed = raw.trim();
    if is_probable_json_object(trimmed) {
        trimmed
    } else {
        "{}"
    }
}

fn is_probable_json_object(value: &str) -> bool {
    if !value.starts_with('{') || !value.ends_with('}') {
        return false;
    }

    let mut escaped = false;
    let mut in_string = false;
    let mut depth = 0usize;
    for ch in value.chars() {
        if escaped {
            escaped = false;
            continue;
        }
        if ch == '\\' && in_string {
            escaped = true;
            continue;
        }
        if ch == '"' {
            in_string = !in_string;
            continue;
        }
        if in_string {
            continue;
        }
        match ch {
            '{' => depth += 1,
            '}' => {
                if depth == 0 {
                    return false;
                }
                depth -= 1;
            }
            _ => {}
        }
    }
    depth == 0 && !in_string && !escaped
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preserves_object_arguments() {
        assert_eq!(
            normalize_json_object_argument(r#" { "path": "src/main.rs" } "#),
            r#"{ "path": "src/main.rs" }"#
        );
    }

    #[test]
    fn rejects_empty_array_and_malformed_arguments() {
        assert_eq!(normalize_json_object_argument(""), "{}");
        assert_eq!(normalize_json_object_argument("[]"), "{}");
        assert_eq!(normalize_json_object_argument("{broken"), "{}");
        assert_eq!(normalize_json_object_argument(r#"{"unterminated":"#), "{}");
    }

    #[test]
    fn tolerates_nested_braces_inside_strings() {
        assert_eq!(
            normalize_json_object_argument(r#"{"query":"{literal}","nested":{"ok":true}}"#),
            r#"{"query":"{literal}","nested":{"ok":true}}"#,
        );
    }
}
