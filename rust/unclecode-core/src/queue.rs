use std::collections::VecDeque;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QueueItem {
    pub id: u64,
    pub line: String,
}

#[derive(Debug, Default)]
pub struct WorkQueue {
    next_id: u64,
    items: VecDeque<QueueItem>,
}

#[derive(Debug, Clone)]
pub struct PersistentWorkQueue {
    path: PathBuf,
}

impl WorkQueue {
    pub fn new() -> Self {
        Self {
            next_id: 1,
            items: VecDeque::new(),
        }
    }

    pub fn push(&mut self, line: impl Into<String>) -> Option<QueueItem> {
        let line = line.into().trim().to_string();
        if line.is_empty() {
            return None;
        }
        let item = QueueItem {
            id: self.next_id,
            line,
        };
        self.next_id += 1;
        self.items.push_back(item.clone());
        Some(item)
    }

    pub fn pop(&mut self) -> Option<QueueItem> {
        self.items.pop_front()
    }

    pub fn len(&self) -> usize {
        self.items.len()
    }

    pub fn is_empty(&self) -> bool {
        self.items.is_empty()
    }

    pub fn snapshot(&self) -> Vec<QueueItem> {
        self.items.iter().cloned().collect()
    }
}

impl PersistentWorkQueue {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self { path: path.into() }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn push(&self, line: impl Into<String>) -> io::Result<Option<QueueItem>> {
        let mut queue = self.load()?;
        let item = queue.push(line);
        self.store(&queue)?;
        Ok(item)
    }

    pub fn pop(&self) -> io::Result<Option<QueueItem>> {
        let mut queue = self.load()?;
        let item = queue.pop();
        self.store(&queue)?;
        Ok(item)
    }

    pub fn len(&self) -> io::Result<usize> {
        Ok(self.load()?.len())
    }

    pub fn snapshot(&self) -> io::Result<Vec<QueueItem>> {
        Ok(self.load()?.snapshot())
    }

    pub fn clear(&self) -> io::Result<()> {
        self.store(&WorkQueue::new())
    }

    fn load(&self) -> io::Result<WorkQueue> {
        let content = match fs::read_to_string(&self.path) {
            Ok(content) => content,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(WorkQueue::new()),
            Err(error) => return Err(error),
        };
        let mut queue = WorkQueue::new();
        let mut max_id = 0;
        for line in content.lines() {
            let Some((id_text, encoded_line)) = line.split_once('\t') else {
                continue;
            };
            let Ok(id) = id_text.parse::<u64>() else {
                continue;
            };
            let decoded = decode_line(encoded_line);
            if decoded.trim().is_empty() {
                continue;
            }
            max_id = max_id.max(id);
            queue.items.push_back(QueueItem { id, line: decoded });
        }
        queue.next_id = max_id.saturating_add(1).max(1);
        Ok(queue)
    }

    fn store(&self, queue: &WorkQueue) -> io::Result<()> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut content = String::new();
        for item in queue.snapshot() {
            content.push_str(&item.id.to_string());
            content.push('\t');
            content.push_str(&encode_line(&item.line));
            content.push('\n');
        }
        fs::write(&self.path, content)
    }
}

pub fn queue_item_json(item: Option<&QueueItem>) -> String {
    match item {
        Some(item) => serde_json::to_string(&queue_item_value(item))
            .expect("queue item json serialization should not fail"),
        None => "null".to_string(),
    }
}

pub fn queue_items_json(items: &[QueueItem]) -> String {
    serde_json::to_string(&items.iter().map(queue_item_value).collect::<Vec<_>>())
        .expect("queue items json serialization should not fail")
}

pub fn queue_length_json(length: usize) -> String {
    json!({ "length": length }).to_string()
}

fn queue_item_value(item: &QueueItem) -> Value {
    json!({
        "id": item.id,
        "line": item.line,
    })
}

fn encode_line(input: &str) -> String {
    let mut encoded = String::with_capacity(input.len());
    for ch in input.chars() {
        match ch {
            '%' => encoded.push_str("%25"),
            '\n' => encoded.push_str("%0A"),
            '\r' => encoded.push_str("%0D"),
            '\t' => encoded.push_str("%09"),
            ch => encoded.push(ch),
        }
    }
    encoded
}

fn decode_line(input: &str) -> String {
    let mut decoded = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch != '%' {
            decoded.push(ch);
            continue;
        }
        let first = chars.next();
        let second = chars.next();
        match (first, second) {
            (Some('2'), Some('5')) => decoded.push('%'),
            (Some('0'), Some('A')) => decoded.push('\n'),
            (Some('0'), Some('D')) => decoded.push('\r'),
            (Some('0'), Some('9')) => decoded.push('\t'),
            (Some(left), Some(right)) => {
                decoded.push('%');
                decoded.push(left);
                decoded.push(right);
            }
            (Some(left), None) => {
                decoded.push('%');
                decoded.push(left);
            }
            (None, _) => decoded.push('%'),
        }
    }
    decoded
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn queue_preserves_order_and_ids() {
        let mut queue = WorkQueue::new();

        assert_eq!(queue.push(" first ").map(|item| item.id), Some(1));
        assert_eq!(queue.push("second").map(|item| item.id), Some(2));
        assert_eq!(queue.push("   "), None);
        assert_eq!(queue.len(), 2);

        assert_eq!(
            queue.pop(),
            Some(QueueItem {
                id: 1,
                line: "first".to_string()
            })
        );
        assert_eq!(
            queue.pop(),
            Some(QueueItem {
                id: 2,
                line: "second".to_string()
            })
        );
        assert!(queue.is_empty());
    }

    #[test]
    fn persistent_queue_round_trips_order() {
        let path = std::env::temp_dir().join(format!(
            "unclecode-queue-test-{}-{}.queue",
            std::process::id(),
            1
        ));
        let queue = PersistentWorkQueue::new(&path);
        queue.clear().expect("clear queue");

        assert_eq!(
            queue
                .push(" first ")
                .expect("push first")
                .map(|item| item.id),
            Some(1)
        );
        assert_eq!(
            queue
                .push("second\tline")
                .expect("push second")
                .map(|item| item.id),
            Some(2)
        );
        assert_eq!(queue.len().expect("len"), 2);
        assert_eq!(
            queue.snapshot().expect("snapshot"),
            vec![
                QueueItem {
                    id: 1,
                    line: "first".to_string()
                },
                QueueItem {
                    id: 2,
                    line: "second\tline".to_string()
                }
            ]
        );
        assert_eq!(
            queue.pop().expect("pop first"),
            Some(QueueItem {
                id: 1,
                line: "first".to_string()
            })
        );
        assert_eq!(
            queue.pop().expect("pop second"),
            Some(QueueItem {
                id: 2,
                line: "second\tline".to_string()
            })
        );
        assert_eq!(queue.pop().expect("empty pop"), None);

        let _ = fs::remove_file(path);
    }

    #[test]
    fn renders_queue_json_contracts() {
        let item = QueueItem {
            id: 7,
            line: "second\tline".to_string(),
        };

        assert_eq!(
            queue_item_json(Some(&item)),
            r#"{"id":7,"line":"second\tline"}"#
        );
        assert_eq!(queue_item_json(None), "null");
        assert_eq!(
            queue_items_json(&[item]),
            r#"[{"id":7,"line":"second\tline"}]"#
        );
        assert_eq!(queue_length_json(3), r#"{"length":3}"#);
    }
}
