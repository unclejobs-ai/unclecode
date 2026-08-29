use std::collections::VecDeque;
use std::fmt;
use std::io;
#[cfg(unix)]
use std::os::fd::AsRawFd;
#[cfg(unix)]
use std::os::raw::c_int;
use std::path::{Component, Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::aci::AciError;
use crate::aci_safe::{
    open_private_lock_file_no_symlinks, read_text_file_no_symlinks,
    write_text_file_atomically_no_symlinks, SafeLockFile,
};
use serde_json::{json, Value};

pub const STALE_IN_FLIGHT_RECOVERY_REASON: &str =
    "UncleCode restarted before this queued follow-up completed. Retry or discard it explicitly.";
pub const QUEUE_MAX_ITEMS: usize = 256;
pub const QUEUE_MAX_MESSAGE_BYTES: usize = 64 * 1024;
pub const QUEUE_MAX_ATTACHMENTS_PER_ITEM: usize = 32;
pub const QUEUE_MAX_ITEM_BYTES: usize = 1024 * 1024;
pub const QUEUE_MAX_BYTES: usize = 16 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QueueLimitCode {
    ItemCount,
    MessageBytes,
    AttachmentCount,
    ItemBytes,
    QueueBytes,
}

impl QueueLimitCode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::ItemCount => "item_count",
            Self::MessageBytes => "message_bytes",
            Self::AttachmentCount => "attachment_count",
            Self::ItemBytes => "item_bytes",
            Self::QueueBytes => "queue_bytes",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QueueLimitError {
    pub code: QueueLimitCode,
    pub actual: usize,
    pub limit: usize,
}

impl fmt::Display for QueueLimitError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "queue limit exceeded: {} actual={} limit={}",
            self.code.as_str(),
            self.actual,
            self.limit,
        )
    }
}

impl std::error::Error for QueueLimitError {}

#[derive(Debug)]
pub enum QueuePushError {
    Io(io::Error),
    Rejected(QueueLimitError),
}

impl QueuePushError {
    pub fn rejection(&self) -> Option<&QueueLimitError> {
        match self {
            Self::Io(_) => None,
            Self::Rejected(error) => Some(error),
        }
    }

    pub fn kind(&self) -> io::ErrorKind {
        match self {
            Self::Io(error) => error.kind(),
            Self::Rejected(_) => io::ErrorKind::InvalidInput,
        }
    }
}

impl fmt::Display for QueuePushError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(error) => error.fmt(formatter),
            Self::Rejected(error) => error.fmt(formatter),
        }
    }
}

impl std::error::Error for QueuePushError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Io(error) => Some(error),
            Self::Rejected(error) => Some(error),
        }
    }
}

impl From<io::Error> for QueuePushError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QueueAttachmentArtifact {
    pub reference: String,
    pub schema: String,
    pub sha256: String,
    pub size: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QueueItem {
    pub id: u64,
    pub line: String,
    pub created_at: u64,
    pub status: QueueItemStatus,
    pub attachment_refs: Vec<String>,
    pub attachment_count: usize,
    pub attachments: Vec<QueueAttachmentArtifact>,
    pub recovery_reason: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QueueItemStatus {
    Pending,
    InFlight,
    RequiresAction,
}

impl QueueItemStatus {
    fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::InFlight => "in-flight",
            Self::RequiresAction => "requires-action",
        }
    }

    fn parse(value: &str) -> Option<Self> {
        match value {
            "pending" => Some(Self::Pending),
            "in-flight" => Some(Self::InFlight),
            "requires-action" => Some(Self::RequiresAction),
            _ => None,
        }
    }
}

#[derive(Debug, Default)]
pub struct WorkQueue {
    next_id: u64,
    items: VecDeque<QueueItem>,
}

#[derive(Debug, Clone)]
pub struct PersistentWorkQueue {
    path: PathBuf,
    workspace_root: PathBuf,
    relative_path: PathBuf,
}

impl WorkQueue {
    pub fn new() -> Self {
        Self {
            next_id: 1,
            items: VecDeque::new(),
        }
    }

    pub fn push(&mut self, line: impl Into<String>) -> Option<QueueItem> {
        self.push_with_metadata(line, epoch_millis(), Vec::new())
    }

    pub fn push_with_metadata(
        &mut self,
        line: impl Into<String>,
        created_at: u64,
        attachment_refs: Vec<String>,
    ) -> Option<QueueItem> {
        let line = line.into().trim().to_string();
        if line.is_empty() {
            return None;
        }
        let item = QueueItem {
            id: self.next_id,
            line,
            created_at,
            status: QueueItemStatus::Pending,
            attachment_count: attachment_refs.len(),
            attachment_refs,
            attachments: Vec::new(),
            recovery_reason: None,
        };
        self.next_id += 1;
        self.items.push_back(item.clone());
        Some(item)
    }

    pub fn push_with_artifacts(
        &mut self,
        line: impl Into<String>,
        created_at: u64,
        attachments: Vec<QueueAttachmentArtifact>,
    ) -> Option<QueueItem> {
        let line = line.into().trim().to_string();
        if line.is_empty() {
            return None;
        }
        let item = QueueItem {
            id: self.next_id,
            line,
            created_at,
            status: QueueItemStatus::Pending,
            attachment_refs: attachments
                .iter()
                .map(|artifact| artifact.reference.clone())
                .collect(),
            attachment_count: attachments.len(),
            attachments,
            recovery_reason: None,
        };
        self.next_id += 1;
        self.items.push_back(item.clone());
        Some(item)
    }

    pub fn pop(&mut self) -> Option<QueueItem> {
        let index = self
            .items
            .iter()
            .position(|item| item.status == QueueItemStatus::Pending)?;
        self.items.remove(index)
    }

    pub fn claim(&mut self) -> Option<QueueItem> {
        let item = self
            .items
            .iter_mut()
            .find(|item| item.status == QueueItemStatus::Pending)?;
        item.status = QueueItemStatus::InFlight;
        Some(item.clone())
    }

    pub fn ack(&mut self, id: u64) -> Option<QueueItem> {
        let index = self
            .items
            .iter()
            .position(|item| item.id == id && item.status == QueueItemStatus::InFlight)?;
        self.items.remove(index)
    }

    pub fn nack(&mut self, id: u64) -> Option<QueueItem> {
        let item = self
            .items
            .iter_mut()
            .find(|item| item.id == id && item.status == QueueItemStatus::InFlight)?;
        item.status = QueueItemStatus::Pending;
        item.recovery_reason = None;
        Some(item.clone())
    }

    pub fn quarantine(&mut self, id: u64, reason: impl Into<String>) -> Option<QueueItem> {
        let item = self
            .items
            .iter_mut()
            .find(|item| item.id == id && item.status == QueueItemStatus::InFlight)?;
        item.status = QueueItemStatus::RequiresAction;
        let reason = reason.into().trim().to_string();
        item.recovery_reason = Some(if reason.is_empty() {
            "Queue item requires user recovery.".to_string()
        } else {
            reason
        });
        Some(item.clone())
    }

    pub fn recover_stale_in_flight(&mut self) -> Vec<QueueItem> {
        self.items
            .iter_mut()
            .filter(|item| item.status == QueueItemStatus::InFlight)
            .map(|item| {
                item.status = QueueItemStatus::RequiresAction;
                item.recovery_reason = Some(STALE_IN_FLIGHT_RECOVERY_REASON.to_string());
                item.clone()
            })
            .collect()
    }

    pub fn retry(&mut self, id: u64) -> Option<QueueItem> {
        let item = self.items.iter_mut().find(|item| {
            item.id == id
                && matches!(
                    item.status,
                    QueueItemStatus::InFlight | QueueItemStatus::RequiresAction
                )
        })?;
        item.status = QueueItemStatus::Pending;
        item.recovery_reason = None;
        Some(item.clone())
    }

    pub fn discard(&mut self, id: u64) -> Option<QueueItem> {
        let index = self.items.iter().position(|item| {
            item.id == id
                && matches!(
                    item.status,
                    QueueItemStatus::InFlight | QueueItemStatus::RequiresAction
                )
        })?;
        self.items.remove(index)
    }

    pub fn remove(&mut self, id: u64) -> Option<QueueItem> {
        let index = self
            .items
            .iter()
            .position(|item| item.id == id && item.status == QueueItemStatus::Pending)?;
        self.items.remove(index)
    }

    pub fn move_item(&mut self, id: u64, direction: QueueMoveDirection) -> Option<QueueItem> {
        let index = self
            .items
            .iter()
            .position(|item| item.id == id && item.status == QueueItemStatus::Pending)?;
        let target = match direction {
            QueueMoveDirection::Up => self
                .items
                .iter()
                .enumerate()
                .take(index)
                .rev()
                .find(|(_, item)| item.status == QueueItemStatus::Pending)
                .map(|(candidate, _)| candidate)?,
            QueueMoveDirection::Down => self
                .items
                .iter()
                .enumerate()
                .skip(index + 1)
                .find(|(_, item)| item.status == QueueItemStatus::Pending)
                .map(|(candidate, _)| candidate)?,
        };
        self.items.swap(index, target);
        self.items.get(target).cloned()
    }

    pub fn len(&self) -> usize {
        self.items.len()
    }

    pub fn pending_len(&self) -> usize {
        self.items
            .iter()
            .filter(|item| item.status == QueueItemStatus::Pending)
            .count()
    }

    pub fn is_empty(&self) -> bool {
        self.items.is_empty()
    }

    pub fn snapshot(&self) -> Vec<QueueItem> {
        self.items.iter().cloned().collect()
    }

    pub fn clear_pending(&mut self) -> Vec<QueueItem> {
        let mut removed = Vec::new();
        self.items.retain(|item| {
            if item.status == QueueItemStatus::Pending {
                removed.push(item.clone());
                false
            } else {
                true
            }
        });
        removed
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QueueMoveDirection {
    Up,
    Down,
}

impl PersistentWorkQueue {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        let path = path.into();
        let (workspace_root, relative_path) = queue_workspace_parts(&path);
        Self {
            path,
            workspace_root,
            relative_path,
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn push(&self, line: impl Into<String>) -> Result<Option<QueueItem>, QueuePushError> {
        let line = line.into();
        self.mutate_push(move |queue| queue.push(line))
    }

    pub fn push_with_metadata(
        &self,
        line: impl Into<String>,
        created_at: u64,
        attachment_refs: Vec<String>,
    ) -> Result<Option<QueueItem>, QueuePushError> {
        let line = line.into();
        self.mutate_push(move |queue| queue.push_with_metadata(line, created_at, attachment_refs))
    }

    pub fn push_with_artifacts(
        &self,
        line: impl Into<String>,
        created_at: u64,
        attachments: Vec<QueueAttachmentArtifact>,
    ) -> Result<Option<QueueItem>, QueuePushError> {
        let line = line.into();
        self.mutate_push(move |queue| queue.push_with_artifacts(line, created_at, attachments))
    }

    pub fn preflight_push_with_artifacts(
        &self,
        line: impl Into<String>,
        created_at: u64,
        attachments: Vec<QueueAttachmentArtifact>,
    ) -> Result<(), QueuePushError> {
        let _lock =
            QueueFileLock::acquire_in_workspace(&self.workspace_root, &self.lock_relative_path())?;
        let mut queue = self.load()?;
        if queue
            .push_with_artifacts(line, created_at, attachments)
            .is_some()
        {
            validate_queue_limits(&queue).map_err(QueuePushError::Rejected)?;
        }
        Ok(())
    }

    pub fn pop(&self) -> io::Result<Option<QueueItem>> {
        self.mutate(WorkQueue::pop)
    }

    pub fn claim(&self) -> io::Result<Option<QueueItem>> {
        self.mutate(WorkQueue::claim)
    }

    pub fn ack(&self, id: u64) -> io::Result<Option<QueueItem>> {
        self.mutate(|queue| queue.ack(id))
    }

    pub fn nack(&self, id: u64) -> io::Result<Option<QueueItem>> {
        self.mutate(|queue| queue.nack(id))
    }

    pub fn quarantine(&self, id: u64, reason: impl Into<String>) -> io::Result<Option<QueueItem>> {
        let reason = reason.into();
        self.mutate(|queue| queue.quarantine(id, reason))
    }

    pub fn recover_stale_in_flight(&self) -> io::Result<Vec<QueueItem>> {
        self.mutate(WorkQueue::recover_stale_in_flight)
    }

    pub fn retry(&self, id: u64) -> io::Result<Option<QueueItem>> {
        self.mutate(|queue| queue.retry(id))
    }

    pub fn discard(&self, id: u64) -> io::Result<Option<QueueItem>> {
        self.mutate(|queue| queue.discard(id))
    }

    pub fn remove(&self, id: u64) -> io::Result<Option<QueueItem>> {
        self.mutate(|queue| queue.remove(id))
    }

    pub fn move_item(
        &self,
        id: u64,
        direction: QueueMoveDirection,
    ) -> io::Result<Option<QueueItem>> {
        self.mutate(|queue| queue.move_item(id, direction))
    }

    pub fn len(&self) -> io::Result<usize> {
        Ok(self.load()?.pending_len())
    }

    pub fn snapshot(&self) -> io::Result<Vec<QueueItem>> {
        Ok(self.load()?.snapshot())
    }

    pub fn clear(&self) -> io::Result<Vec<QueueItem>> {
        self.mutate(WorkQueue::clear_pending)
    }

    fn mutate<T>(&self, update: impl FnOnce(&mut WorkQueue) -> T) -> io::Result<T> {
        let _lock =
            QueueFileLock::acquire_in_workspace(&self.workspace_root, &self.lock_relative_path())?;
        let mut queue = self.load()?;
        let result = update(&mut queue);
        validate_queue_limits(&queue).map_err(queue_limit_io_error)?;
        self.store(&queue)?;
        Ok(result)
    }

    fn mutate_push(
        &self,
        update: impl FnOnce(&mut WorkQueue) -> Option<QueueItem>,
    ) -> Result<Option<QueueItem>, QueuePushError> {
        let _lock =
            QueueFileLock::acquire_in_workspace(&self.workspace_root, &self.lock_relative_path())?;
        let mut queue = self.load()?;
        let result = update(&mut queue);
        validate_queue_limits(&queue).map_err(QueuePushError::Rejected)?;
        self.store(&queue)?;
        Ok(result)
    }

    #[cfg(test)]
    fn lock_path(&self) -> PathBuf {
        self.path.with_extension("queue.lock")
    }

    fn lock_relative_path(&self) -> PathBuf {
        self.relative_path.with_extension("queue.lock")
    }

    fn load(&self) -> io::Result<WorkQueue> {
        let content = match read_text_file_no_symlinks(&self.workspace_root, &self.relative_path) {
            Ok(content) => content,
            Err(AciError::Io(error)) if error.kind() == io::ErrorKind::NotFound => {
                return Ok(WorkQueue::new());
            }
            Err(error) => return Err(aci_error_to_io(error)),
        };
        if content.len() > QUEUE_MAX_BYTES {
            return Err(queue_limit_io_error(QueueLimitError {
                code: QueueLimitCode::QueueBytes,
                actual: content.len(),
                limit: QUEUE_MAX_BYTES,
            }));
        }
        let mut queue = WorkQueue::new();
        let mut max_id = 0;
        for line in content.lines() {
            if line.trim_start().starts_with('{') {
                if let Some(item) = parse_queue_item_value(line) {
                    max_id = max_id.max(item.id);
                    queue.items.push_back(item);
                }
                continue;
            }
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
            queue.items.push_back(QueueItem {
                id,
                line: decoded,
                created_at: 0,
                status: QueueItemStatus::Pending,
                attachment_refs: Vec::new(),
                attachment_count: 0,
                attachments: Vec::new(),
                recovery_reason: None,
            });
        }
        queue.next_id = max_id.saturating_add(1).max(1);
        validate_queue_limits(&queue).map_err(queue_limit_io_error)?;
        Ok(queue)
    }

    fn store(&self, queue: &WorkQueue) -> io::Result<()> {
        let envelope_bytes = queue_envelope_bytes(queue);
        let mut content = Vec::with_capacity(envelope_bytes);
        for item in &queue.items {
            serde_json::to_writer(&mut content, &queue_item_value(item))
                .expect("queue item serialization should not fail");
            content.push(b'\n');
        }
        let content = String::from_utf8(content).expect("queue JSON must be valid UTF-8");
        write_text_file_atomically_no_symlinks(&self.workspace_root, &self.relative_path, &content)
            .map_err(aci_error_to_io)
    }
}

struct QueueFileLock {
    file: SafeLockFile,
}

impl QueueFileLock {
    #[cfg(test)]
    fn acquire(path: PathBuf) -> io::Result<Self> {
        let (workspace_root, relative_path) = queue_workspace_parts(&path);
        Self::acquire_in_workspace(&workspace_root, &relative_path)
    }

    fn acquire_in_workspace(workspace_root: &Path, relative_path: &Path) -> io::Result<Self> {
        let file = open_private_lock_file_no_symlinks(workspace_root, relative_path)
            .map_err(aci_error_to_io)?;
        lock_exclusive(&file)?;
        Ok(Self { file })
    }
}

impl Drop for QueueFileLock {
    fn drop(&mut self) {
        let _ = unlock(&self.file);
    }
}

#[cfg(unix)]
fn lock_exclusive(file: &SafeLockFile) -> io::Result<()> {
    unsafe extern "C" {
        fn flock(fd: c_int, operation: c_int) -> c_int;
    }
    const LOCK_EX: c_int = 2;
    if unsafe { flock(file.file().as_raw_fd(), LOCK_EX) } == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

#[cfg(windows)]
fn lock_exclusive(file: &SafeLockFile) -> io::Result<()> {
    file.file().lock()
}

#[cfg(not(any(unix, windows)))]
fn lock_exclusive(_file: &SafeLockFile) -> io::Result<()> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "queue advisory locking is unsupported on this platform",
    ))
}

#[cfg(unix)]
fn unlock(file: &SafeLockFile) -> io::Result<()> {
    unsafe extern "C" {
        fn flock(fd: c_int, operation: c_int) -> c_int;
    }
    const LOCK_UN: c_int = 8;
    if unsafe { flock(file.file().as_raw_fd(), LOCK_UN) } == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

#[cfg(windows)]
fn unlock(file: &SafeLockFile) -> io::Result<()> {
    file.file().unlock()
}

#[cfg(not(any(unix, windows)))]
fn unlock(_file: &SafeLockFile) -> io::Result<()> {
    Ok(())
}

fn queue_workspace_parts(path: &Path) -> (PathBuf, PathBuf) {
    let components = path.components().collect::<Vec<_>>();
    if let Some(index) = components.iter().position(
        |component| matches!(component, Component::Normal(segment) if *segment == ".unclecode"),
    ) {
        let workspace_root = components[..index].iter().collect::<PathBuf>();
        let relative_path = components[index..].iter().collect::<PathBuf>();
        return (
            if workspace_root.as_os_str().is_empty() {
                PathBuf::from(".")
            } else {
                workspace_root
            },
            relative_path,
        );
    }

    let workspace_root = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."))
        .to_path_buf();
    let relative_path = path
        .file_name()
        .map(PathBuf::from)
        .unwrap_or_else(|| path.to_path_buf());
    (workspace_root, relative_path)
}

fn aci_error_to_io(error: AciError) -> io::Error {
    match error {
        AciError::Io(error) => error,
        AciError::Path(error) => io::Error::new(io::ErrorKind::PermissionDenied, error),
    }
}

fn queue_limit_io_error(error: QueueLimitError) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, error)
}

fn attachment_payload_bytes(item: &QueueItem) -> usize {
    item.attachments.iter().fold(0usize, |total, attachment| {
        total.saturating_add(usize::try_from(attachment.size).unwrap_or(usize::MAX))
    })
}

fn queue_item_envelope_bytes(item: &QueueItem) -> usize {
    serde_json::to_vec(&queue_item_value(item))
        .expect("queue item serialization should not fail")
        .len()
        .saturating_add(1)
}

fn queue_item_accounted_envelope_bytes(item: &QueueItem) -> usize {
    let actual = queue_item_envelope_bytes(item);
    let mut recovery_projection = item.clone();
    recovery_projection.status = QueueItemStatus::RequiresAction;
    recovery_projection.recovery_reason = Some(STALE_IN_FLIGHT_RECOVERY_REASON.to_string());
    actual.max(queue_item_envelope_bytes(&recovery_projection))
}

fn queue_item_bytes(item: &QueueItem) -> usize {
    queue_item_accounted_envelope_bytes(item).saturating_add(attachment_payload_bytes(item))
}

fn queue_envelope_bytes(queue: &WorkQueue) -> usize {
    queue.items.iter().fold(0usize, |total, item| {
        total.saturating_add(queue_item_envelope_bytes(item))
    })
}

fn queue_bytes(queue: &WorkQueue) -> usize {
    queue.items.iter().fold(0usize, |total, item| {
        total.saturating_add(queue_item_bytes(item))
    })
}

fn validate_queue_limits(queue: &WorkQueue) -> Result<(), QueueLimitError> {
    if queue.items.len() > QUEUE_MAX_ITEMS {
        return Err(QueueLimitError {
            code: QueueLimitCode::ItemCount,
            actual: queue.items.len(),
            limit: QUEUE_MAX_ITEMS,
        });
    }
    for item in &queue.items {
        let message_bytes = item.line.len();
        if message_bytes > QUEUE_MAX_MESSAGE_BYTES {
            return Err(QueueLimitError {
                code: QueueLimitCode::MessageBytes,
                actual: message_bytes,
                limit: QUEUE_MAX_MESSAGE_BYTES,
            });
        }
        let attachment_count = item
            .attachment_count
            .max(item.attachment_refs.len())
            .max(item.attachments.len());
        if attachment_count > QUEUE_MAX_ATTACHMENTS_PER_ITEM {
            return Err(QueueLimitError {
                code: QueueLimitCode::AttachmentCount,
                actual: attachment_count,
                limit: QUEUE_MAX_ATTACHMENTS_PER_ITEM,
            });
        }
        let item_bytes = queue_item_bytes(item);
        if item_bytes > QUEUE_MAX_ITEM_BYTES {
            return Err(QueueLimitError {
                code: QueueLimitCode::ItemBytes,
                actual: item_bytes,
                limit: QUEUE_MAX_ITEM_BYTES,
            });
        }
    }
    let queue_bytes = queue_bytes(queue);
    if queue_bytes > QUEUE_MAX_BYTES {
        return Err(QueueLimitError {
            code: QueueLimitCode::QueueBytes,
            actual: queue_bytes,
            limit: QUEUE_MAX_BYTES,
        });
    }
    Ok(())
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

pub fn queue_limit_acceptance_json() -> String {
    json!({ "accepted": true }).to_string()
}

pub fn queue_limit_rejection_json(error: &QueueLimitError) -> String {
    json!({
        "accepted": false,
        "error": {
            "code": error.code.as_str(),
            "actual": error.actual,
            "limit": error.limit,
        }
    })
    .to_string()
}

fn queue_item_value(item: &QueueItem) -> Value {
    json!({
        "id": item.id,
        "line": item.line,
        "createdAt": item.created_at,
        "status": item.status.as_str(),
        "attachmentRefs": item.attachment_refs,
        "attachmentCount": item.attachment_count,
        "attachments": item.attachments.iter().map(|artifact| json!({
            "ref": artifact.reference,
            "schema": artifact.schema,
            "sha256": artifact.sha256,
            "size": artifact.size,
        })).collect::<Vec<_>>(),
        "recoveryReason": item.recovery_reason,
    })
}

fn parse_queue_item_value(input: &str) -> Option<QueueItem> {
    let value: Value = serde_json::from_str(input).ok()?;
    let id = value.get("id")?.as_u64()?;
    let line = value.get("line")?.as_str()?.to_string();
    if id == 0 || line.trim().is_empty() {
        return None;
    }
    let created_at = value.get("createdAt").and_then(Value::as_u64).unwrap_or(0);
    let status = value
        .get("status")
        .and_then(Value::as_str)
        .and_then(QueueItemStatus::parse)
        .unwrap_or(QueueItemStatus::Pending);
    let attachment_refs = value
        .get("attachmentRefs")
        .and_then(Value::as_array)
        .map(|refs| {
            refs.iter()
                .filter_map(Value::as_str)
                .filter(|reference| !reference.trim().is_empty())
                .map(str::to_string)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let attachments = value
        .get("attachments")
        .and_then(Value::as_array)
        .map(|artifacts| {
            artifacts
                .iter()
                .filter_map(|artifact| {
                    Some(QueueAttachmentArtifact {
                        reference: artifact.get("ref")?.as_str()?.to_string(),
                        schema: artifact.get("schema")?.as_str()?.to_string(),
                        sha256: artifact.get("sha256")?.as_str()?.to_string(),
                        size: artifact.get("size")?.as_u64()?,
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let attachment_refs = if attachment_refs.is_empty() && !attachments.is_empty() {
        attachments
            .iter()
            .map(|artifact| artifact.reference.clone())
            .collect()
    } else {
        attachment_refs
    };
    let attachment_count = value
        .get("attachmentCount")
        .and_then(Value::as_u64)
        .and_then(|count| usize::try_from(count).ok())
        .unwrap_or(attachment_refs.len());
    Some(QueueItem {
        id,
        line,
        created_at,
        status,
        attachment_refs,
        attachment_count,
        attachments,
        recovery_reason: value
            .get("recoveryReason")
            .and_then(Value::as_str)
            .map(str::to_string),
    })
}

fn epoch_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
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
    use std::fs::{self, OpenOptions};

    struct QueueTestRoots {
        workspace: PathBuf,
        outside: PathBuf,
    }

    impl QueueTestRoots {
        fn new(label: &str) -> Self {
            let suffix = format!("{}-{}", std::process::id(), epoch_millis());
            let workspace =
                std::env::temp_dir().join(format!("unclecode-queue-{label}-workspace-{suffix}"));
            fs::create_dir_all(&workspace).expect("queue test workspace");
            Self {
                workspace,
                outside: std::env::temp_dir()
                    .join(format!("unclecode-queue-{label}-outside-{suffix}")),
            }
        }

        fn queue_path(&self) -> PathBuf {
            self.workspace
                .join(".unclecode")
                .join("work-queues")
                .join("session.queue")
        }
    }

    impl Drop for QueueTestRoots {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.workspace);
            let _ = fs::remove_dir_all(&self.outside);
        }
    }

    #[cfg(unix)]
    fn symlink_directory(source: impl AsRef<Path>, target: impl AsRef<Path>) -> io::Result<()> {
        std::os::unix::fs::symlink(source, target)
    }

    #[cfg(windows)]
    fn symlink_directory(source: impl AsRef<Path>, target: impl AsRef<Path>) -> io::Result<()> {
        std::os::windows::fs::symlink_dir(source, target)
    }

    #[cfg(unix)]
    fn symlink_file(source: impl AsRef<Path>, target: impl AsRef<Path>) -> io::Result<()> {
        std::os::unix::fs::symlink(source, target)
    }

    #[cfg(windows)]
    fn symlink_file(source: impl AsRef<Path>, target: impl AsRef<Path>) -> io::Result<()> {
        std::os::windows::fs::symlink_file(source, target)
    }

    #[test]
    fn queue_preserves_order_and_ids() {
        let mut queue = WorkQueue::new();

        let first = queue.push(" first ").expect("first");
        let second = queue.push("second").expect("second");
        assert_eq!(first.id, 1);
        assert_eq!(second.id, 2);
        assert_eq!(queue.push("   "), None);
        assert_eq!(queue.len(), 2);

        assert_eq!(queue.pop(), Some(first));
        assert_eq!(queue.pop(), Some(second));
        assert!(queue.is_empty());
    }

    #[test]
    fn queue_removes_and_moves_stable_ids_without_renumbering() {
        let mut queue = WorkQueue::new();
        queue.push("first");
        queue.push("second");
        queue.push("third");

        assert_eq!(
            queue
                .move_item(3, QueueMoveDirection::Up)
                .map(|item| item.id),
            Some(3)
        );
        assert_eq!(
            queue
                .snapshot()
                .iter()
                .map(|item| item.id)
                .collect::<Vec<_>>(),
            vec![1, 3, 2]
        );
        assert_eq!(
            queue.remove(3).map(|item| item.line),
            Some("third".to_string())
        );
        assert_eq!(
            queue
                .snapshot()
                .iter()
                .map(|item| item.id)
                .collect::<Vec<_>>(),
            vec![1, 2]
        );
        assert_eq!(queue.move_item(1, QueueMoveDirection::Up), None);
    }

    #[test]
    fn queue_claim_is_atomic_and_pending_mutations_cannot_touch_in_flight_work() {
        let mut queue = WorkQueue::new();
        let first = queue
            .push_with_metadata("first", 100, vec!["artifact-a".to_string()])
            .expect("first");
        let second = queue.push("second").expect("second");

        let claimed = queue.claim().expect("claim first");
        assert_eq!(claimed.id, first.id);
        assert_eq!(claimed.status, QueueItemStatus::InFlight);
        assert_eq!(
            queue.remove(first.id),
            None,
            "remove only targets pending work"
        );
        assert_eq!(
            queue.move_item(first.id, QueueMoveDirection::Down),
            None,
            "move only targets pending work"
        );
        queue.clear_pending();
        assert_eq!(queue.snapshot(), vec![claimed.clone()]);
        assert_eq!(queue.ack(first.id), Some(claimed));
        assert!(queue.is_empty());
        assert_eq!(queue.ack(second.id), None);
    }

    #[test]
    fn queue_nack_returns_the_same_envelope_to_pending_without_duplication() {
        let mut queue = WorkQueue::new();
        let item = queue
            .push_with_metadata(
                "한글 follow-up",
                1234,
                vec![".unclecode/artifacts/session/queue/image.json".to_string()],
            )
            .expect("queued item");
        assert_eq!(item.attachment_count, 1);
        assert_eq!(queue.claim().map(|claimed| claimed.id), Some(item.id));
        assert_eq!(queue.claim(), None, "an in-flight item is never reclaimed");

        let pending = queue.nack(item.id).expect("nack in-flight");
        assert_eq!(pending.status, QueueItemStatus::Pending);
        assert_eq!(queue.pending_len(), 1);
        assert_eq!(queue.claim().map(|claimed| claimed.id), Some(item.id));
        assert_eq!(queue.snapshot().len(), 1);
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

        let first = queue.push(" first ").expect("push first").expect("first");
        let second = queue
            .push("second\tline")
            .expect("push second")
            .expect("second");
        assert_eq!(first.id, 1);
        assert_eq!(second.id, 2);
        assert_eq!(queue.len().expect("len"), 2);
        assert_eq!(
            queue.snapshot().expect("snapshot"),
            vec![first.clone(), second.clone()]
        );
        assert_eq!(queue.pop().expect("pop first"), Some(first));
        assert_eq!(queue.pop().expect("pop second"), Some(second));
        assert_eq!(queue.pop().expect("empty pop"), None);

        let _ = fs::remove_file(path);
    }

    #[test]
    fn persistent_queue_serializes_concurrent_mutations_without_lost_ids() {
        let path = std::env::temp_dir().join(format!(
            "unclecode-queue-race-test-{}-{}.queue",
            std::process::id(),
            1
        ));
        let queue = PersistentWorkQueue::new(&path);
        queue.clear().expect("clear queue");
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(17));
        let mut threads = Vec::new();
        for index in 0..16 {
            let queue = queue.clone();
            let barrier = barrier.clone();
            threads.push(std::thread::spawn(move || {
                barrier.wait();
                queue.push(format!("follow-up {index}")).expect("push")
            }));
        }
        barrier.wait();
        for thread in threads {
            thread.join().expect("join");
        }
        let items = queue.snapshot().expect("snapshot");
        assert_eq!(items.len(), 16);
        assert_eq!(
            items
                .iter()
                .map(|item| item.id)
                .collect::<std::collections::BTreeSet<_>>()
                .len(),
            16
        );
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn persistent_queue_restores_envelopes_and_reads_legacy_id_line_rows() {
        let path = std::env::temp_dir().join(format!(
            "unclecode-queue-envelope-test-{}-{}.queue",
            std::process::id(),
            1
        ));
        fs::write(&path, "7\tlegacy%09line\n").expect("write legacy queue");
        let queue = PersistentWorkQueue::new(&path);
        let legacy = queue.snapshot().expect("load legacy");
        assert_eq!(legacy.len(), 1);
        assert_eq!(legacy[0].id, 7);
        assert_eq!(legacy[0].line, "legacy\tline");
        assert_eq!(legacy[0].created_at, 0);
        assert_eq!(legacy[0].status, QueueItemStatus::Pending);

        let modern = queue
            .push_with_metadata("modern", 9876, vec!["artifact-ref".to_string()])
            .expect("push modern")
            .expect("modern item");
        let claimed = queue
            .claim()
            .expect("claim mutation")
            .expect("claim legacy first");
        assert_eq!(claimed.id, 7);
        let restored = PersistentWorkQueue::new(&path)
            .snapshot()
            .expect("restore envelopes");
        assert_eq!(restored[0].status, QueueItemStatus::InFlight);
        assert_eq!(restored[1], modern);
        assert_eq!(restored[1].attachment_refs, vec!["artifact-ref"]);
        assert_eq!(restored[1].attachment_count, 1);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn renders_queue_json_contracts() {
        let item = QueueItem {
            id: 7,
            line: "second\tline".to_string(),
            created_at: 123,
            status: QueueItemStatus::Pending,
            attachment_refs: vec!["artifact-ref".to_string()],
            attachment_count: 1,
            attachments: Vec::new(),
            recovery_reason: None,
        };

        assert_eq!(
            queue_item_json(Some(&item)),
            r#"{"attachmentCount":1,"attachmentRefs":["artifact-ref"],"attachments":[],"createdAt":123,"id":7,"line":"second\tline","recoveryReason":null,"status":"pending"}"#
        );
        assert_eq!(queue_item_json(None), "null");
        assert_eq!(
            queue_items_json(&[item]),
            r#"[{"attachmentCount":1,"attachmentRefs":["artifact-ref"],"attachments":[],"createdAt":123,"id":7,"line":"second\tline","recoveryReason":null,"status":"pending"}]"#
        );
        assert_eq!(queue_length_json(3), r#"{"length":3}"#);
    }

    #[test]
    fn queue_quarantines_failed_claims_until_explicit_retry_or_discard() {
        let mut queue = WorkQueue::new();
        let first = queue.push("first").expect("first");
        let second = queue.push("second").expect("second");
        assert_eq!(queue.claim().map(|item| item.id), Some(first.id));

        let quarantined = queue
            .quarantine(first.id, "attachment hash mismatch")
            .expect("quarantine claimed item");
        assert_eq!(quarantined.status, QueueItemStatus::RequiresAction);
        assert_eq!(
            quarantined.recovery_reason.as_deref(),
            Some("attachment hash mismatch")
        );
        assert_eq!(
            queue.claim().map(|item| item.id),
            Some(second.id),
            "quarantine is never automatically executed"
        );

        let retried = queue.retry(first.id).expect("explicit retry");
        assert_eq!(retried.status, QueueItemStatus::Pending);
        assert_eq!(retried.recovery_reason, None);
        assert_eq!(
            queue.discard(second.id).map(|item| item.id),
            Some(second.id)
        );
    }

    #[test]
    fn queue_startup_recovery_quarantines_only_in_flight_with_stable_envelopes() {
        let mut queue = WorkQueue::new();
        let attachment = QueueAttachmentArtifact {
            reference: ".unclecode/artifacts/session/queue-attachments/a.json".to_string(),
            schema: "unclecode.queue-attachment.v1".to_string(),
            sha256: "a".repeat(64),
            size: 42,
        };
        let first = queue
            .push_with_artifacts("claimed before restart", 123, vec![attachment.clone()])
            .expect("first");
        let second = queue.push("still pending").expect("second");
        assert_eq!(queue.claim().map(|item| item.id), Some(first.id));

        let recovered = queue.recover_stale_in_flight();

        assert_eq!(recovered.len(), 1);
        assert_eq!(recovered[0].id, first.id);
        assert_eq!(recovered[0].line, first.line);
        assert_eq!(recovered[0].created_at, first.created_at);
        assert_eq!(recovered[0].attachments, vec![attachment]);
        assert_eq!(recovered[0].status, QueueItemStatus::RequiresAction);
        assert_eq!(
            recovered[0].recovery_reason.as_deref(),
            Some(STALE_IN_FLIGHT_RECOVERY_REASON)
        );
        assert_eq!(queue.pending_len(), 1);
        assert_eq!(queue.snapshot()[1], second);
        assert!(queue.recover_stale_in_flight().is_empty());
    }

    #[test]
    fn queue_envelope_round_trips_verified_attachment_descriptors() {
        let mut queue = WorkQueue::new();
        let attachment = QueueAttachmentArtifact {
            reference: ".unclecode/artifacts/session/queue-attachments/a.json".to_string(),
            schema: "unclecode.queue-attachment.v1".to_string(),
            sha256: "a".repeat(64),
            size: 42,
        };
        let item = queue
            .push_with_artifacts("with image", 123, vec![attachment.clone()])
            .expect("item");
        assert_eq!(item.attachments, vec![attachment]);
        let serialized = queue_item_json(Some(&item));
        let restored = parse_queue_item_value(&serialized).expect("parse serialized item");
        assert_eq!(restored, item);
    }

    fn attachment_with_size(size: u64) -> QueueAttachmentArtifact {
        QueueAttachmentArtifact {
            reference: ".unclecode/artifacts/session/queue-attachments/a.json".to_string(),
            schema: "unclecode.queue-attachment.v1".to_string(),
            sha256: "a".repeat(64),
            size,
        }
    }

    fn payload_size_for_exact_item_bytes(
        id: u64,
        line: &str,
        created_at: u64,
        target: usize,
    ) -> u64 {
        let mut payload_size = target as u64;
        loop {
            let item = QueueItem {
                id,
                line: line.to_string(),
                created_at,
                status: QueueItemStatus::Pending,
                attachment_refs: vec![attachment_with_size(payload_size).reference],
                attachment_count: 1,
                attachments: vec![attachment_with_size(payload_size)],
                recovery_reason: None,
            };
            let next = target
                .checked_sub(queue_item_accounted_envelope_bytes(&item))
                .expect("target fits queue envelope") as u64;
            if next == payload_size {
                assert_eq!(queue_item_bytes(&item), target);
                return payload_size;
            }
            payload_size = next;
        }
    }

    #[test]
    fn persistent_queue_enforces_utf8_message_bytes_at_the_exact_boundary() {
        let roots = QueueTestRoots::new("message-byte-limit");
        let queue = PersistentWorkQueue::new(roots.queue_path());
        let accepted = format!("{}a", "가".repeat((QUEUE_MAX_MESSAGE_BYTES - 1) / 3));
        assert_eq!(accepted.len(), QUEUE_MAX_MESSAGE_BYTES);
        assert!(queue.push(&accepted).expect("boundary push").is_some());

        let oversized = format!("{accepted}나");
        let error = queue
            .push(oversized)
            .expect_err("UTF-8 bytes above the boundary must be rejected");
        assert_eq!(
            error.rejection(),
            Some(&QueueLimitError {
                code: QueueLimitCode::MessageBytes,
                actual: QUEUE_MAX_MESSAGE_BYTES + 3,
                limit: QUEUE_MAX_MESSAGE_BYTES,
            })
        );
        assert_eq!(queue.snapshot().expect("unchanged snapshot").len(), 1);
    }

    #[test]
    fn persistent_queue_accepts_attachment_count_boundary_and_rejects_one_more() {
        let roots = QueueTestRoots::new("attachment-count-limit");
        let queue = PersistentWorkQueue::new(roots.queue_path());
        let boundary = vec![attachment_with_size(0); QUEUE_MAX_ATTACHMENTS_PER_ITEM];
        assert!(queue
            .push_with_artifacts("boundary", 123, boundary)
            .expect("boundary push")
            .is_some());

        let oversized = vec![attachment_with_size(0); QUEUE_MAX_ATTACHMENTS_PER_ITEM + 1];
        let error = queue
            .push_with_artifacts("oversized", 124, oversized)
            .expect_err("attachment count above the boundary must be rejected");
        assert_eq!(
            error.rejection().map(|error| error.code),
            Some(QueueLimitCode::AttachmentCount)
        );
        assert_eq!(
            error.rejection().map(|error| error.actual),
            Some(QUEUE_MAX_ATTACHMENTS_PER_ITEM + 1)
        );
        assert_eq!(queue.snapshot().expect("unchanged snapshot").len(), 1);
    }

    #[test]
    fn persistent_queue_rejects_item_and_aggregate_serialized_bytes_without_mutation() {
        let roots = QueueTestRoots::new("item-byte-limit");
        let queue = PersistentWorkQueue::new(roots.queue_path());
        let boundary_size =
            payload_size_for_exact_item_bytes(1, "item boundary", 123, QUEUE_MAX_ITEM_BYTES);
        assert!(queue
            .push_with_artifacts(
                "item boundary",
                123,
                vec![attachment_with_size(boundary_size)],
            )
            .expect("exact item boundary")
            .is_some());
        queue
            .claim()
            .expect("boundary claim")
            .expect("claimed item");
        let recovered = queue
            .recover_stale_in_flight()
            .expect("boundary crash recovery");
        assert_eq!(recovered.len(), 1);
        assert_eq!(recovered[0].status, QueueItemStatus::RequiresAction);
        let before_item_rejection = queue.snapshot().expect("boundary snapshot");
        let item_error = queue
            .push_with_artifacts(
                "item boundary",
                124,
                vec![attachment_with_size(boundary_size + 1)],
            )
            .expect_err("envelope plus payload must exceed the item boundary");
        assert_eq!(
            item_error.rejection().map(|error| error.code),
            Some(QueueLimitCode::ItemBytes)
        );
        assert!(item_error.rejection().unwrap().actual > QUEUE_MAX_ITEM_BYTES);
        assert_eq!(
            queue.snapshot().expect("unchanged item snapshot"),
            before_item_rejection
        );

        let aggregate_roots = QueueTestRoots::new("aggregate-byte-limit");
        let aggregate_queue = PersistentWorkQueue::new(aggregate_roots.queue_path());
        for index in 0..16 {
            let line = format!("aggregate {index}");
            let created_at = index as u64;
            let payload_size = payload_size_for_exact_item_bytes(
                created_at + 1,
                &line,
                created_at,
                QUEUE_MAX_ITEM_BYTES,
            );
            aggregate_queue
                .push_with_artifacts(line, created_at, vec![attachment_with_size(payload_size)])
                .expect("within aggregate limit")
                .expect("queued item");
        }
        assert_eq!(
            queue_bytes(&aggregate_queue.load().expect("load exact aggregate")),
            QUEUE_MAX_BYTES,
        );
        let before = aggregate_queue
            .snapshot()
            .expect("snapshot before rejection");
        let aggregate_error = aggregate_queue
            .push("aggregate overflow")
            .expect_err("aggregate durable footprint must be bounded");
        assert_eq!(
            aggregate_error.rejection().map(|error| error.code),
            Some(QueueLimitCode::QueueBytes)
        );
        assert!(aggregate_error.rejection().unwrap().actual > QUEUE_MAX_BYTES);
        assert_eq!(
            aggregate_queue.snapshot().expect("unchanged snapshot"),
            before
        );
    }

    #[test]
    fn persistent_queue_caps_all_retained_states_and_does_not_grow_after_rejection() {
        let roots = QueueTestRoots::new("retained-item-limit");
        let queue = PersistentWorkQueue::new(roots.queue_path());
        for index in 0..QUEUE_MAX_ITEMS - 1 {
            queue
                .push(format!("bounded {index}"))
                .expect("push within item limit")
                .expect("queued item");
        }
        queue
            .preflight_push_with_artifacts("race candidate", 123, Vec::new())
            .expect("preflight with one retained slot");
        queue
            .push("concurrent winner")
            .expect("definitive winner push")
            .expect("queued winner");
        let claimed = queue
            .claim()
            .expect("claim mutation")
            .expect("claimed item");
        assert_eq!(claimed.status, QueueItemStatus::InFlight);
        let recovered = queue.recover_stale_in_flight().expect("crash recovery");
        assert_eq!(recovered.len(), 1);
        assert_eq!(recovered[0].status, QueueItemStatus::RequiresAction);
        assert!(queue
            .recover_stale_in_flight()
            .expect("idempotent crash recovery")
            .is_empty());
        let before = fs::metadata(roots.queue_path())
            .expect("queue metadata")
            .len();
        let error = queue
            .push("one too many")
            .expect_err("the retained item cap must include every durable state");
        assert_eq!(
            error.rejection(),
            Some(&QueueLimitError {
                code: QueueLimitCode::ItemCount,
                actual: QUEUE_MAX_ITEMS + 1,
                limit: QUEUE_MAX_ITEMS,
            })
        );
        assert_eq!(
            queue.snapshot().expect("bounded snapshot").len(),
            QUEUE_MAX_ITEMS
        );
        assert_eq!(
            fs::metadata(roots.queue_path())
                .expect("queue metadata")
                .len(),
            before
        );
    }

    #[test]
    fn persistent_queue_rejects_an_oversized_raw_queue_file_before_rewriting_it() {
        let roots = QueueTestRoots::new("raw-file-limit");
        let path = roots.queue_path();
        fs::create_dir_all(path.parent().expect("queue parent")).expect("queue directory");
        let file = OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .open(&path)
            .expect("oversized queue fixture");
        file.set_len((QUEUE_MAX_BYTES + 1) as u64)
            .expect("oversized queue length");
        let before = fs::metadata(&path).expect("queue metadata").len();

        let error = PersistentWorkQueue::new(&path)
            .clear()
            .expect_err("oversized raw storage must not be parsed and rewritten");
        assert_eq!(error.kind(), io::ErrorKind::InvalidData);
        assert_eq!(fs::metadata(path).expect("queue metadata").len(), before);
    }

    #[test]
    fn queue_limit_rejection_json_is_structured_and_payload_free() {
        let error = QueueLimitError {
            code: QueueLimitCode::QueueBytes,
            actual: QUEUE_MAX_BYTES + 1,
            limit: QUEUE_MAX_BYTES,
        };
        assert_eq!(
            queue_limit_rejection_json(&error),
            format!(
                r#"{{"accepted":false,"error":{{"actual":{},"code":"queue_bytes","limit":{}}}}}"#,
                QUEUE_MAX_BYTES + 1,
                QUEUE_MAX_BYTES,
            )
        );
    }

    #[cfg(any(unix, windows))]
    #[test]
    fn persistent_queue_rejects_symlinked_work_queue_root_without_external_writes() {
        let roots = QueueTestRoots::new("symlink-root");
        fs::create_dir_all(roots.workspace.join(".unclecode")).expect("workspace metadata");
        fs::create_dir_all(&roots.outside).expect("outside root");
        symlink_directory(
            &roots.outside,
            roots.workspace.join(".unclecode").join("work-queues"),
        )
        .expect("symlink queue root");

        let error = PersistentWorkQueue::new(roots.queue_path())
            .push("must stay inside")
            .expect_err("a symlinked work-queues root must be rejected");
        assert!(matches!(
            error.kind(),
            io::ErrorKind::PermissionDenied | io::ErrorKind::InvalidInput
        ));
        assert!(!roots.outside.join("session.queue").exists());
        assert!(!roots.outside.join("session.queue.lock").exists());
    }

    #[cfg(any(unix, windows))]
    #[test]
    fn persistent_queue_rejects_symlinked_metadata_parent_without_external_writes() {
        let roots = QueueTestRoots::new("symlink-parent");
        fs::create_dir_all(&roots.workspace).expect("workspace root");
        fs::create_dir_all(roots.outside.join("work-queues")).expect("outside queue root");
        symlink_directory(&roots.outside, roots.workspace.join(".unclecode"))
            .expect("symlink metadata parent");

        let error = PersistentWorkQueue::new(roots.queue_path())
            .push("must stay inside")
            .expect_err("a symlinked .unclecode parent must be rejected");
        assert!(matches!(
            error.kind(),
            io::ErrorKind::PermissionDenied | io::ErrorKind::InvalidInput
        ));
        assert!(!roots.outside.join("work-queues/session.queue").exists());
        assert!(!roots
            .outside
            .join("work-queues/session.queue.lock")
            .exists());
    }

    #[cfg(any(unix, windows))]
    #[test]
    fn persistent_queue_rejects_symlinked_queue_leaf_without_external_reads() {
        let roots = QueueTestRoots::new("symlink-queue-leaf");
        let queue_directory = roots.workspace.join(".unclecode/work-queues");
        fs::create_dir_all(&queue_directory).expect("queue root");
        fs::create_dir_all(&roots.outside).expect("outside root");
        let outside_queue = roots.outside.join("outside.queue");
        fs::write(&outside_queue, "91\texternal%09secret\n").expect("outside queue");
        symlink_file(&outside_queue, roots.queue_path()).expect("symlink queue leaf");

        let error = PersistentWorkQueue::new(roots.queue_path())
            .snapshot()
            .expect_err("a symlinked queue leaf must be rejected before reading it");
        assert!(matches!(
            error.kind(),
            io::ErrorKind::PermissionDenied | io::ErrorKind::InvalidInput
        ));
        assert_eq!(
            fs::read_to_string(outside_queue).expect("outside sentinel"),
            "91\texternal%09secret\n"
        );
    }

    #[cfg(any(unix, windows))]
    #[test]
    fn persistent_queue_rejects_symlinked_lock_leaf_without_touching_external_target() {
        #[cfg(unix)]
        use std::os::unix::fs::PermissionsExt;

        let roots = QueueTestRoots::new("symlink-lock-leaf");
        let queue_directory = roots.workspace.join(".unclecode/work-queues");
        fs::create_dir_all(&queue_directory).expect("queue root");
        fs::create_dir_all(&roots.outside).expect("outside root");
        let outside_lock = roots.outside.join("outside.lock");
        fs::write(&outside_lock, "outside lock sentinel").expect("outside lock");
        #[cfg(unix)]
        fs::set_permissions(&outside_lock, fs::Permissions::from_mode(0o644))
            .expect("outside mode");
        symlink_file(&outside_lock, queue_directory.join("session.queue.lock"))
            .expect("symlink lock leaf");

        let error = PersistentWorkQueue::new(roots.queue_path())
            .push("must not lock outside")
            .expect_err("a symlinked lock leaf must be rejected");
        assert!(matches!(
            error.kind(),
            io::ErrorKind::PermissionDenied | io::ErrorKind::InvalidInput
        ));
        assert_eq!(
            fs::read_to_string(&outside_lock).expect("outside sentinel"),
            "outside lock sentinel"
        );
        #[cfg(unix)]
        assert_eq!(
            fs::metadata(outside_lock).unwrap().permissions().mode() & 0o777,
            0o644
        );
    }

    #[cfg(unix)]
    #[test]
    fn advisory_queue_lock_recovers_when_owner_process_dies() {
        use std::os::raw::c_int;
        unsafe extern "C" {
            fn fork() -> c_int;
            fn waitpid(pid: c_int, status: *mut c_int, options: c_int) -> c_int;
            fn _exit(status: c_int) -> !;
        }

        let root = std::env::temp_dir().join(format!(
            "unclecode-queue-owner-death-{}",
            std::process::id()
        ));
        let lock_path = root.join("session.queue.lock");
        fs::create_dir_all(&root).expect("root");
        let child = unsafe { fork() };
        assert!(child >= 0, "fork failed");
        if child == 0 {
            let _held = QueueFileLock::acquire(lock_path.clone()).expect("child lock");
            unsafe { _exit(0) };
        }
        let mut status = 0;
        assert_eq!(unsafe { waitpid(child, &mut status, 0) }, child);
        let _recovered =
            QueueFileLock::acquire(lock_path).expect("lock recovers after owner death");
        let _ = fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[test]
    fn persistent_queue_repairs_private_directory_and_file_modes() {
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};

        let root =
            std::env::temp_dir().join(format!("unclecode-queue-modes-{}", std::process::id()));
        let directory = root.join(".unclecode").join("work-queues");
        let path = directory.join("session.queue");
        fs::create_dir_all(&directory).expect("directory");
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o777)).expect("wide dir");
        OpenOptions::new()
            .create(true)
            .write(true)
            .mode(0o666)
            .open(&path)
            .expect("queue file");
        fs::set_permissions(&path, fs::Permissions::from_mode(0o666)).expect("wide queue");

        let queue = PersistentWorkQueue::new(&path);
        queue.push("repair permissions").expect("push");
        let lock_path = queue.lock_path();
        assert_eq!(
            fs::metadata(&directory).unwrap().permissions().mode() & 0o777,
            0o700
        );
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(
            fs::metadata(lock_path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        let _ = fs::remove_dir_all(root);
    }
}
