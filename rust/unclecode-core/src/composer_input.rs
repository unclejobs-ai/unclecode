use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};

const MAX_TEXT_ATTACHMENT_BYTES: u64 = 5 * 1024 * 1024;
const MAX_TEXT_ATTACHMENT_COUNT: usize = 5;
const MAX_TEXT_REFERENCE_CHARS: usize = 2_000;
const MAX_DIRECTORY_ENTRIES: usize = 12;

#[derive(Clone, Debug, PartialEq, Eq)]
struct TextMatch {
    raw_match: String,
    candidate: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct ImageAttachment {
    mime_type: String,
    data_url: String,
    path: String,
    display_name: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum PathReference {
    Image(ImageAttachment),
    File {
        prompt_block: String,
        transcript_line: String,
    },
    Directory {
        prompt_block: String,
        transcript_line: String,
    },
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct ResolvedReference {
    raw_match: String,
    reference: PathReference,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct ResolvedImage {
    raw_match: String,
    attachment: ImageAttachment,
}

pub fn resolve_composer_input_json(value: &str, cwd: &str) -> Result<String, String> {
    let resolution = resolve_composer_input_value(value, cwd)?;
    serde_json::to_string(&resolution)
        .map_err(|error| format!("Failed to serialize composer input: {error}"))
}

fn resolve_composer_input_value(value: &str, cwd: &str) -> Result<Value, String> {
    let raw = value.trim();
    let cwd_path = Path::new(cwd);

    let valid_references: Vec<ResolvedReference> = reference_matches(raw)
        .into_iter()
        .filter_map(|entry| {
            to_path_reference(&entry.candidate, cwd_path).map(|reference| ResolvedReference {
                raw_match: entry.raw_match,
                reference,
            })
        })
        .collect();

    let valid_images: Vec<ResolvedImage> = image_matches(raw)
        .into_iter()
        .filter_map(|entry| {
            let candidate = entry.candidate.replace("\\ ", " ");
            to_image_attachment(&candidate, cwd_path).map(|attachment| ResolvedImage {
                raw_match: entry.raw_match,
                attachment,
            })
        })
        .collect();

    let mut image_references = Vec::new();
    let mut text_references = Vec::new();
    for entry in &valid_references {
        match &entry.reference {
            PathReference::Image(attachment) => image_references.push((entry, attachment)),
            PathReference::File { .. } | PathReference::Directory { .. } => {
                text_references.push(entry)
            }
        }
    }

    let mut referenced_image_paths: Vec<String> = image_references
        .iter()
        .map(|(_, attachment)| attachment.path.clone())
        .collect();
    referenced_image_paths.sort();
    referenced_image_paths.dedup();

    let mut attachments: Vec<ImageAttachment> = image_references
        .iter()
        .map(|(_, attachment)| (*attachment).clone())
        .collect();
    for image in &valid_images {
        if !referenced_image_paths
            .iter()
            .any(|path| path == &image.attachment.path)
        {
            attachments.push(image.attachment.clone());
        }
    }
    attachments.truncate(MAX_TEXT_ATTACHMENT_COUNT);

    let mut prompt = raw.to_string();
    for entry in &valid_references {
        prompt = prompt.replacen(&entry.raw_match, " ", 1);
    }
    for entry in &valid_images {
        prompt = prompt.replacen(&entry.raw_match, " ", 1);
    }
    prompt = collapse_whitespace(&prompt);

    let prompt_blocks: Vec<String> = text_references
        .iter()
        .map(|entry| match &entry.reference {
            PathReference::File { prompt_block, .. }
            | PathReference::Directory { prompt_block, .. } => prompt_block.clone(),
            PathReference::Image(_) => String::new(),
        })
        .filter(|block| !block.is_empty())
        .collect();

    if prompt.is_empty() && !attachments.is_empty() && prompt_blocks.is_empty() {
        prompt = if attachments.len() == 1 {
            "Please inspect the attached image.".to_string()
        } else {
            "Please inspect the attached images.".to_string()
        };
    }
    if !prompt_blocks.is_empty() {
        let mut blocks = Vec::new();
        if !prompt.is_empty() {
            blocks.push(prompt);
        }
        blocks.extend(prompt_blocks);
        prompt = blocks.join("\n\n");
    }

    let mut transcript_lines = Vec::new();
    if !prompt.is_empty() {
        transcript_lines.push(prompt.clone());
    }
    if !attachments.is_empty() {
        if attachments.len() == 1 {
            transcript_lines.push(format!("Attached image: {}", attachments[0].display_name));
        } else {
            let names = attachments
                .iter()
                .map(|attachment| attachment.display_name.as_str())
                .collect::<Vec<_>>()
                .join(", ");
            transcript_lines.push(format!("Attached images: {names}"));
        }
    }
    for entry in text_references {
        match &entry.reference {
            PathReference::File {
                transcript_line, ..
            }
            | PathReference::Directory {
                transcript_line, ..
            } => transcript_lines.push(transcript_line.clone()),
            PathReference::Image(_) => {}
        }
    }

    Ok(json!({
        "prompt": prompt,
        "attachments": attachments
            .into_iter()
            .map(image_attachment_value)
            .collect::<Vec<_>>(),
        "transcriptText": transcript_lines.join("\n"),
    }))
}

fn reference_matches(raw: &str) -> Vec<TextMatch> {
    let chars: Vec<(usize, char)> = raw.char_indices().collect();
    let mut result = Vec::new();
    let mut index = 0;

    while index < chars.len() {
        let (byte_index, ch) = chars[index];
        if ch != '@' {
            index += 1;
            continue;
        }
        if byte_index > 0 {
            let previous = raw[..byte_index].chars().next_back();
            if !previous.is_some_and(char::is_whitespace) {
                index += 1;
                continue;
            }
        }

        let start = byte_index;
        let mut next = index + 1;
        if next >= chars.len() {
            break;
        }

        let candidate;
        let end;
        if chars[next].1 == '"' {
            next += 1;
            let candidate_start = chars
                .get(next)
                .map(|(offset, _)| *offset)
                .unwrap_or(raw.len());
            while next < chars.len() && chars[next].1 != '"' && chars[next].1 != '\n' {
                next += 1;
            }
            if next >= chars.len() || chars[next].1 != '"' {
                index += 1;
                continue;
            }
            candidate = raw[candidate_start..chars[next].0].to_string();
            end = chars[next].0 + chars[next].1.len_utf8();
            next += 1;
        } else {
            let candidate_start = chars[next].0;
            while next < chars.len() && !chars[next].1.is_whitespace() {
                next += 1;
            }
            end = chars
                .get(next)
                .map(|(offset, _)| *offset)
                .unwrap_or(raw.len());
            candidate = raw[candidate_start..end].to_string();
        }

        if !candidate.is_empty() {
            result.push(TextMatch {
                raw_match: raw[start..end].to_string(),
                candidate,
            });
        }
        index = next;
    }

    result
}

fn image_matches(raw: &str) -> Vec<TextMatch> {
    let chars: Vec<(usize, char)> = raw.char_indices().collect();
    let mut result = Vec::new();
    let mut index = 0;

    while index < chars.len() {
        let (start, ch) = chars[index];
        if ch == '"' {
            let candidate_start = start + ch.len_utf8();
            let mut next = index + 1;
            while next < chars.len() && chars[next].1 != '"' && chars[next].1 != '\n' {
                next += 1;
            }
            if next < chars.len() && chars[next].1 == '"' {
                let end = chars[next].0 + chars[next].1.len_utf8();
                let candidate = raw[candidate_start..chars[next].0].to_string();
                if has_image_extension(&candidate) {
                    result.push(TextMatch {
                        raw_match: raw[start..end].to_string(),
                        candidate,
                    });
                }
                index = next + 1;
                continue;
            }
        }

        if ch.is_whitespace() {
            index += 1;
            continue;
        }

        let mut next = index;
        while next < chars.len() {
            let current = chars[next].1;
            if current.is_whitespace() {
                let escaped_space = next > index && chars[next - 1].1 == '\\';
                if !escaped_space {
                    break;
                }
            }
            next += 1;
        }
        let end = chars
            .get(next)
            .map(|(offset, _)| *offset)
            .unwrap_or(raw.len());
        let raw_match = raw[start..end].to_string();
        let candidate = raw_match
            .strip_prefix("file://")
            .unwrap_or(&raw_match)
            .to_string();
        if has_image_extension(&candidate) {
            result.push(TextMatch {
                raw_match,
                candidate,
            });
        }
        index = next;
    }

    result
}

fn to_path_reference(candidate_path: &str, cwd: &Path) -> Option<PathReference> {
    let resolved_path = resolve_path(candidate_path, cwd);
    let metadata = fs::metadata(&resolved_path).ok()?;
    let display_name = file_display_name(&resolved_path);

    if metadata.is_dir() {
        let mut entries = fs::read_dir(&resolved_path)
            .ok()?
            .filter_map(|entry| entry.ok())
            .filter_map(|entry| entry.file_name().into_string().ok())
            .collect::<Vec<_>>();
        entries.sort();
        entries.truncate(MAX_DIRECTORY_ENTRIES);

        let mut lines = vec![format!("Referenced directory: {display_name}")];
        if entries.is_empty() {
            lines.push("(empty directory)".to_string());
        } else {
            lines.extend(entries.into_iter().map(|entry| format!("- {entry}")));
        }
        return Some(PathReference::Directory {
            prompt_block: lines.join("\n"),
            transcript_line: format!("Referenced directory: {display_name}"),
        });
    }

    if let Some(attachment) = to_image_attachment_path(&resolved_path, cwd) {
        return Some(PathReference::Image(attachment));
    }

    let bytes = fs::read(&resolved_path).ok()?;
    let text = String::from_utf8_lossy(&bytes);
    let visible_text = if text.contains('\0') {
        "(binary file omitted)".to_string()
    } else {
        let trimmed = text.trim();
        if trimmed.is_empty() {
            "(empty file)".to_string()
        } else {
            take_chars(trimmed, MAX_TEXT_REFERENCE_CHARS)
        }
    };

    Some(PathReference::File {
        prompt_block: format!("Referenced file: {display_name}\n{visible_text}"),
        transcript_line: format!("Referenced file: {display_name}"),
    })
}

fn to_image_attachment(candidate_path: &str, cwd: &Path) -> Option<ImageAttachment> {
    let resolved_path = resolve_path(candidate_path, cwd);
    to_image_attachment_path(&resolved_path, cwd)
}

fn to_image_attachment_path(resolved_path: &Path, _cwd: &Path) -> Option<ImageAttachment> {
    let mime_type = image_mime_type(resolved_path)?;
    let metadata = fs::metadata(resolved_path).ok()?;
    if metadata.len() > MAX_TEXT_ATTACHMENT_BYTES {
        return None;
    }
    let bytes = fs::read(resolved_path).ok()?;
    Some(ImageAttachment {
        mime_type: mime_type.to_string(),
        data_url: format!("data:{mime_type};base64,{}", base64_encode(&bytes)),
        path: resolved_path.to_string_lossy().to_string(),
        display_name: file_display_name(resolved_path),
    })
}

fn resolve_path(candidate_path: &str, cwd: &Path) -> PathBuf {
    let path = Path::new(candidate_path);
    if path.is_absolute() {
        path.to_path_buf()
    } else {
        cwd.join(path)
    }
}

fn file_display_name(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| path.to_string_lossy().to_string())
}

fn has_image_extension(candidate: &str) -> bool {
    image_mime_type(Path::new(candidate)).is_some()
}

fn image_mime_type(path: &Path) -> Option<&'static str> {
    match path
        .extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| extension.to_ascii_lowercase())
        .as_deref()
    {
        Some("png") => Some("image/png"),
        Some("jpg") | Some("jpeg") => Some("image/jpeg"),
        Some("gif") => Some("image/gif"),
        Some("webp") => Some("image/webp"),
        Some("bmp") => Some("image/bmp"),
        _ => None,
    }
}

fn collapse_whitespace(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn take_chars(value: &str, max_chars: usize) -> String {
    value.chars().take(max_chars).collect()
}

fn image_attachment_value(attachment: ImageAttachment) -> Value {
    json!({
        "type": "image",
        "mimeType": attachment.mime_type,
        "dataUrl": attachment.data_url,
        "path": attachment.path,
        "displayName": attachment.display_name,
    })
}

fn base64_encode(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut output = String::with_capacity(bytes.len().div_ceil(3) * 4);

    for chunk in bytes.chunks(3) {
        let first = chunk[0];
        let second = *chunk.get(1).unwrap_or(&0);
        let third = *chunk.get(2).unwrap_or(&0);

        output.push(TABLE[(first >> 2) as usize] as char);
        output.push(TABLE[(((first & 0b0000_0011) << 4) | (second >> 4)) as usize] as char);
        if chunk.len() > 1 {
            output.push(TABLE[(((second & 0b0000_1111) << 2) | (third >> 6)) as usize] as char);
        } else {
            output.push('=');
        }
        if chunk.len() > 2 {
            output.push(TABLE[(third & 0b0011_1111) as usize] as char);
        } else {
            output.push('=');
        }
    }

    output
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::{self, File};
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_dir() -> PathBuf {
        let millis = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time should be valid")
            .as_millis();
        let path = std::env::temp_dir().join(format!(
            "unclecode-composer-input-{}-{millis}",
            std::process::id()
        ));
        fs::create_dir_all(&path).expect("temp dir should be created");
        path
    }

    #[test]
    fn resolves_pasted_image_path() {
        let cwd = temp_dir();
        let image = cwd.join("clipboard.png");
        fs::write(&image, [0x89, 0x50, 0x4e, 0x47]).expect("image should be written");

        let value = resolve_composer_input_value(&image.to_string_lossy(), &cwd.to_string_lossy())
            .expect("composer input should resolve");

        assert_eq!(value["prompt"], "Please inspect the attached image.");
        assert_eq!(value["attachments"][0]["mimeType"], "image/png");
        assert!(value["attachments"][0]["dataUrl"]
            .as_str()
            .unwrap()
            .starts_with("data:image/png;base64,"));
        assert!(value["transcriptText"]
            .as_str()
            .unwrap()
            .contains("Attached image: clipboard.png"));
    }

    #[test]
    fn resolves_file_and_directory_references() {
        let cwd = temp_dir();
        let file = cwd.join("notes.txt");
        fs::write(&file, "hello from file\n").expect("file should be written");
        let dir = cwd.join("docs");
        fs::create_dir_all(&dir).expect("dir should be created");
        fs::write(dir.join("a.md"), "A").expect("dir entry should be written");

        let file_value = resolve_composer_input_value(
            &format!("summarize @{}", file.display()),
            &cwd.to_string_lossy(),
        )
        .expect("file reference should resolve");
        assert!(file_value["prompt"]
            .as_str()
            .unwrap()
            .contains("Referenced file: notes.txt\nhello from file"));

        let dir_value = resolve_composer_input_value(
            &format!("check @{}", dir.display()),
            &cwd.to_string_lossy(),
        )
        .expect("directory reference should resolve");
        assert!(dir_value["prompt"]
            .as_str()
            .unwrap()
            .contains("Referenced directory: docs\n- a.md"));
    }

    #[test]
    fn drops_oversized_images_without_removing_prompt_text() {
        let cwd = temp_dir();
        let image = cwd.join("big.jpg");
        let file = File::create(&image).expect("file should be created");
        file.set_len(MAX_TEXT_ATTACHMENT_BYTES + 1)
            .expect("file should be resized");

        let value = resolve_composer_input_value(
            &format!("look at {}", image.display()),
            &cwd.to_string_lossy(),
        )
        .expect("composer input should resolve");

        assert_eq!(value["attachments"].as_array().unwrap().len(), 0);
        assert!(value["prompt"].as_str().unwrap().contains("look at"));
        assert!(value["prompt"]
            .as_str()
            .unwrap()
            .contains(image.to_string_lossy().as_ref()));
    }

    #[test]
    fn supports_escaped_and_quoted_image_paths() {
        let cwd = temp_dir();
        let image = cwd.join("two words.png");
        fs::write(&image, [1, 2, 3]).expect("image should be written");

        let escaped = image.to_string_lossy().replace(' ', "\\ ");
        let value = resolve_composer_input_value(&escaped, &cwd.to_string_lossy())
            .expect("escaped image path should resolve");
        assert_eq!(value["attachments"].as_array().unwrap().len(), 1);

        let quoted = format!("\"{}\"", image.display());
        let quoted_value = resolve_composer_input_value(&quoted, &cwd.to_string_lossy())
            .expect("quoted image path should resolve");
        assert_eq!(quoted_value["attachments"].as_array().unwrap().len(), 1);
    }
}
