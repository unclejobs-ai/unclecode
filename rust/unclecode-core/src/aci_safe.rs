use crate::aci::AciError;
use std::fs::File;
#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
use std::io;
use std::path::Path;

pub struct SafeLockFile {
    file: File,
    #[cfg(windows)]
    _directory_handles: Vec<File>,
}

impl SafeLockFile {
    pub(crate) fn file(&self) -> &File {
        &self.file
    }
}

pub fn read_text_file_no_symlinks(
    workspace_root: impl AsRef<Path>,
    path: impl AsRef<Path>,
) -> Result<String, AciError> {
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    {
        return no_symlink_io::read(workspace_root.as_ref(), path.as_ref()).map_err(AciError::Io);
    }
    #[cfg(windows)]
    {
        return windows_no_reparse_io::read(workspace_root.as_ref(), path.as_ref())
            .map_err(AciError::Io);
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
    {
        let _ = (workspace_root, path);
        Err(AciError::Io(io::Error::new(
            io::ErrorKind::Unsupported,
            "symbolic-link-safe reads are unsupported on this platform",
        )))
    }
}

pub fn write_text_file_atomically_no_symlinks(
    workspace_root: impl AsRef<Path>,
    path: impl AsRef<Path>,
    content: &str,
) -> Result<(), AciError> {
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    {
        return no_symlink_io::write_atomic(workspace_root.as_ref(), path.as_ref(), content)
            .map_err(AciError::Io);
    }
    #[cfg(windows)]
    {
        return windows_no_reparse_io::write_atomic(
            workspace_root.as_ref(),
            path.as_ref(),
            content,
        )
        .map_err(AciError::Io);
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
    {
        let _ = (workspace_root, path, content);
        Err(AciError::Io(io::Error::new(
            io::ErrorKind::Unsupported,
            "symbolic-link-safe atomic writes are unsupported on this platform",
        )))
    }
}

pub fn delete_text_file_no_symlinks(
    workspace_root: impl AsRef<Path>,
    path: impl AsRef<Path>,
) -> Result<(), AciError> {
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    {
        return no_symlink_io::delete(workspace_root.as_ref(), path.as_ref()).map_err(AciError::Io);
    }
    #[cfg(windows)]
    {
        return windows_no_reparse_io::delete(workspace_root.as_ref(), path.as_ref())
            .map_err(AciError::Io);
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
    {
        let _ = (workspace_root, path);
        Err(AciError::Io(io::Error::new(
            io::ErrorKind::Unsupported,
            "symbolic-link-safe deletes are unsupported on this platform",
        )))
    }
}

pub fn open_private_lock_file_no_symlinks(
    workspace_root: impl AsRef<Path>,
    path: impl AsRef<Path>,
) -> Result<SafeLockFile, AciError> {
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    {
        return no_symlink_io::open_private_lock(workspace_root.as_ref(), path.as_ref())
            .map(|file| SafeLockFile { file })
            .map_err(AciError::Io);
    }
    #[cfg(windows)]
    {
        return windows_no_reparse_io::open_private_lock(workspace_root.as_ref(), path.as_ref())
            .map(|(file, directory_handles)| SafeLockFile {
                file,
                _directory_handles: directory_handles,
            })
            .map_err(AciError::Io);
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
    {
        let _ = (workspace_root, path);
        Err(AciError::Io(io::Error::new(
            io::ErrorKind::Unsupported,
            "symbolic-link-safe lock files are unsupported on this platform",
        )))
    }
}

#[cfg(any(windows, test))]
fn validate_windows_handle_attributes(
    attributes: u32,
    expect_directory: bool,
) -> std::io::Result<()> {
    const FILE_ATTRIBUTE_DIRECTORY: u32 = 0x0000_0010;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0000_0400;
    if attributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "refusing Windows reparse-point path",
        ));
    }
    let is_directory = attributes & FILE_ATTRIBUTE_DIRECTORY != 0;
    if is_directory != expect_directory {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            if expect_directory {
                "refusing non-directory path component"
            } else {
                "refusing non-file path target"
            },
        ));
    }
    Ok(())
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
mod no_symlink_io {
    use std::ffi::{CStr, CString};
    use std::fs::{self, File};
    use std::io::{self, Read, Write};
    use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
    use std::os::raw::{c_char, c_int};
    use std::os::unix::ffi::OsStrExt;
    use std::path::{Component, Path};
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    #[cfg(target_os = "linux")]
    const O_CREAT: c_int = 0x40;
    #[cfg(target_os = "macos")]
    const O_CREAT: c_int = 0x200;
    #[cfg(target_os = "linux")]
    const O_EXCL: c_int = 0x80;
    #[cfg(target_os = "macos")]
    const O_EXCL: c_int = 0x800;
    #[cfg(target_os = "linux")]
    const O_DIRECTORY: c_int = 0x10000;
    #[cfg(target_os = "macos")]
    const O_DIRECTORY: c_int = 0x100000;
    #[cfg(target_os = "linux")]
    const O_NOFOLLOW: c_int = 0x20000;
    #[cfg(target_os = "macos")]
    const O_NOFOLLOW: c_int = 0x100;
    #[cfg(target_os = "linux")]
    const O_CLOEXEC: c_int = 0x80000;
    #[cfg(target_os = "macos")]
    const O_CLOEXEC: c_int = 0x1000000;
    #[cfg(target_os = "linux")]
    const ELOOP: i32 = 40;
    #[cfg(target_os = "macos")]
    const ELOOP: i32 = 62;
    const O_RDONLY: c_int = 0;
    const O_WRONLY: c_int = 1;
    const O_RDWR: c_int = 2;
    static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

    unsafe extern "C" {
        #[link_name = "open"]
        fn c_open(path: *const c_char, flags: c_int, ...) -> c_int;
        fn openat(dir_fd: c_int, path: *const c_char, flags: c_int, ...) -> c_int;
        fn mkdirat(dir_fd: c_int, path: *const c_char, mode: u32) -> c_int;
        fn renameat(
            old_dir_fd: c_int,
            old_path: *const c_char,
            new_dir_fd: c_int,
            new_path: *const c_char,
        ) -> c_int;
        fn unlinkat(dir_fd: c_int, path: *const c_char, flags: c_int) -> c_int;
        fn fsync(fd: c_int) -> c_int;
        fn fchmod(fd: c_int, mode: u32) -> c_int;
    }

    pub(super) fn read(workspace_root: &Path, relative_path: &Path) -> io::Result<String> {
        let (directory, file_name) = open_parent(workspace_root, relative_path, false, false)?;
        let file = open_file_at(
            directory.as_raw_fd(),
            &file_name,
            O_RDONLY | O_CLOEXEC | O_NOFOLLOW,
            0,
        )
        .map_err(|error| path_entry_error(error, relative_path))?;
        let mut contents = String::new();
        File::from(file).read_to_string(&mut contents)?;
        Ok(contents)
    }

    pub(super) fn write_atomic(
        workspace_root: &Path,
        relative_path: &Path,
        content: &str,
    ) -> io::Result<()> {
        let (directory, file_name) = open_parent(workspace_root, relative_path, true, false)?;
        refuse_symbolic_link_target(directory.as_raw_fd(), &file_name, relative_path)?;
        let temp_name = CString::new(format!(
            ".bootstrap.{}.{}.{}.tmp",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos(),
            TEMP_COUNTER.fetch_add(1, Ordering::Relaxed)
        ))
        .expect("generated temporary file name has no NUL");
        let temp = open_file_at(
            directory.as_raw_fd(),
            &temp_name,
            O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW,
            0o600,
        )?;
        let write_result = {
            let mut file = File::from(temp);
            file.write_all(content.as_bytes())
                .and_then(|()| file.sync_all())
        };
        if let Err(error) = write_result {
            remove_at(directory.as_raw_fd(), &temp_name);
            return Err(error);
        }
        if unsafe {
            renameat(
                directory.as_raw_fd(),
                temp_name.as_ptr(),
                directory.as_raw_fd(),
                file_name.as_ptr(),
            )
        } != 0
        {
            let error = io::Error::last_os_error();
            remove_at(directory.as_raw_fd(), &temp_name);
            return Err(error);
        }
        if unsafe { fsync(directory.as_raw_fd()) } != 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }

    pub(super) fn delete(workspace_root: &Path, relative_path: &Path) -> io::Result<()> {
        let (directory, file_name) = match open_parent(workspace_root, relative_path, false, false)
        {
            Ok(parent) => parent,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(error),
        };
        refuse_symbolic_link_target(directory.as_raw_fd(), &file_name, relative_path)?;
        if unsafe { unlinkat(directory.as_raw_fd(), file_name.as_ptr(), 0) } != 0 {
            let error = io::Error::last_os_error();
            if error.kind() != io::ErrorKind::NotFound {
                return Err(error);
            }
        }
        if unsafe { fsync(directory.as_raw_fd()) } != 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }

    pub(super) fn open_private_lock(
        workspace_root: &Path,
        relative_path: &Path,
    ) -> io::Result<File> {
        let (directory, file_name) = open_parent(workspace_root, relative_path, true, true)?;
        let file = open_file_at(
            directory.as_raw_fd(),
            &file_name,
            O_RDWR | O_CREAT | O_CLOEXEC | O_NOFOLLOW,
            0o600,
        )
        .map_err(|error| path_entry_error(error, relative_path))?;
        if unsafe { fchmod(file.as_raw_fd(), 0o600) } != 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(File::from(file))
    }

    fn open_parent(
        workspace_root: &Path,
        relative_path: &Path,
        create: bool,
        private: bool,
    ) -> io::Result<(OwnedFd, CString)> {
        let mut segments = relative_segments(relative_path)?;
        let file_name = segments
            .pop()
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "file path is empty"))?;
        let canonical_root = fs::canonicalize(workspace_root)?;
        let root = CString::new(canonical_root.as_os_str().as_bytes()).map_err(|_| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                "workspace path contains a NUL byte",
            )
        })?;
        let root_fd = unsafe {
            c_open(
                root.as_ptr(),
                O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW,
            )
        };
        let mut directory =
            owned_fd(root_fd).map_err(|error| path_entry_error(error, workspace_root))?;
        for segment in segments {
            directory = open_directory_at(directory.as_raw_fd(), &segment, create, private)
                .map_err(|error| path_entry_error(error, relative_path))?;
        }
        Ok((directory, file_name))
    }

    fn relative_segments(path: &Path) -> io::Result<Vec<CString>> {
        let mut segments = Vec::new();
        for component in path.components() {
            let Component::Normal(segment) = component else {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "path must be workspace-relative without parent traversal",
                ));
            };
            segments.push(CString::new(segment.as_bytes()).map_err(|_| {
                io::Error::new(io::ErrorKind::InvalidInput, "path contains a NUL byte")
            })?);
        }
        Ok(segments)
    }

    fn open_directory_at(
        parent_fd: c_int,
        name: &CStr,
        create: bool,
        private: bool,
    ) -> io::Result<OwnedFd> {
        let flags = O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW;
        let directory = match open_file_at(parent_fd, name, flags, 0) {
            Ok(directory) => directory,
            Err(error) if create && error.kind() == io::ErrorKind::NotFound => {
                if unsafe { mkdirat(parent_fd, name.as_ptr(), 0o700) } != 0 {
                    let mkdir_error = io::Error::last_os_error();
                    if mkdir_error.kind() != io::ErrorKind::AlreadyExists {
                        return Err(mkdir_error);
                    }
                }
                open_file_at(parent_fd, name, flags, 0)?
            }
            Err(error) => return Err(error),
        };
        if private && unsafe { fchmod(directory.as_raw_fd(), 0o700) } != 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(directory)
    }

    fn refuse_symbolic_link_target(
        directory_fd: c_int,
        file_name: &CStr,
        relative_path: &Path,
    ) -> io::Result<()> {
        match open_file_at(
            directory_fd,
            file_name,
            O_RDONLY | O_CLOEXEC | O_NOFOLLOW,
            0,
        ) {
            Ok(file) => {
                if File::from(file).metadata()?.is_file() {
                    Ok(())
                } else {
                    Err(io::Error::new(
                        io::ErrorKind::InvalidInput,
                        format!(
                            "refusing non-file bootstrap target {}",
                            relative_path.display()
                        ),
                    ))
                }
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(path_entry_error(error, relative_path)),
        }
    }

    fn open_file_at(
        directory_fd: c_int,
        name: &CStr,
        flags: c_int,
        mode: u32,
    ) -> io::Result<OwnedFd> {
        let raw_fd = unsafe { openat(directory_fd, name.as_ptr(), flags, mode) };
        owned_fd(raw_fd)
    }

    fn owned_fd(raw_fd: c_int) -> io::Result<OwnedFd> {
        if raw_fd < 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(unsafe { OwnedFd::from_raw_fd(raw_fd) })
        }
    }

    fn path_entry_error(error: io::Error, path: &Path) -> io::Error {
        if error.raw_os_error() == Some(ELOOP) || error.kind() == io::ErrorKind::NotADirectory {
            io::Error::new(
                io::ErrorKind::PermissionDenied,
                format!(
                    "refusing symbolic-link or non-directory bootstrap path {}",
                    path.display()
                ),
            )
        } else {
            error
        }
    }

    fn remove_at(directory_fd: c_int, name: &CStr) {
        let _ = unsafe { unlinkat(directory_fd, name.as_ptr(), 0) };
    }
}

#[cfg(windows)]
mod windows_no_reparse_io {
    use super::validate_windows_handle_attributes;
    use std::ffi::{c_void, OsString};
    use std::fs::{self, File};
    use std::io::{self, Read, Write};
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::fs::MetadataExt;
    use std::os::windows::io::{AsRawHandle, FromRawHandle, RawHandle};
    use std::path::{Component, Path, PathBuf};
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    type Handle = *mut c_void;

    const GENERIC_READ: u32 = 0x8000_0000;
    const GENERIC_WRITE: u32 = 0x4000_0000;
    const DELETE_ACCESS: u32 = 0x0001_0000;
    const FILE_SHARE_READ: u32 = 0x0000_0001;
    const FILE_SHARE_WRITE: u32 = 0x0000_0002;
    const CREATE_NEW: u32 = 1;
    const OPEN_EXISTING: u32 = 3;
    const OPEN_ALWAYS: u32 = 4;
    const FILE_ATTRIBUTE_NORMAL: u32 = 0x0000_0080;
    const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;
    const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
    const MOVEFILE_REPLACE_EXISTING: u32 = 0x0000_0001;
    const MOVEFILE_WRITE_THROUGH: u32 = 0x0000_0008;
    const FILE_DISPOSITION_INFO_CLASS: i32 = 4;
    const INVALID_HANDLE_VALUE: Handle = -1isize as Handle;
    static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct FileTime {
        low_date_time: u32,
        high_date_time: u32,
    }

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct ByHandleFileInformation {
        file_attributes: u32,
        creation_time: FileTime,
        last_access_time: FileTime,
        last_write_time: FileTime,
        volume_serial_number: u32,
        file_size_high: u32,
        file_size_low: u32,
        number_of_links: u32,
        file_index_high: u32,
        file_index_low: u32,
    }

    #[repr(C)]
    struct FileDispositionInformation {
        delete_file: u8,
    }

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn CreateFileW(
            file_name: *const u16,
            desired_access: u32,
            share_mode: u32,
            security_attributes: *const c_void,
            creation_disposition: u32,
            flags_and_attributes: u32,
            template_file: Handle,
        ) -> Handle;
        fn CreateDirectoryW(path_name: *const u16, security_attributes: *const c_void) -> i32;
        fn DeleteFileW(file_name: *const u16) -> i32;
        fn GetFileInformationByHandle(
            file: Handle,
            information: *mut ByHandleFileInformation,
        ) -> i32;
        fn MoveFileExW(existing: *const u16, new: *const u16, flags: u32) -> i32;
        fn SetFileInformationByHandle(
            file: Handle,
            information_class: i32,
            information: *const c_void,
            buffer_size: u32,
        ) -> i32;
    }

    struct ParentGuard {
        handles: Vec<File>,
        directory_path: PathBuf,
        file_name: OsString,
    }

    impl ParentGuard {
        fn target_path(&self) -> PathBuf {
            self.directory_path.join(&self.file_name)
        }
    }

    pub(super) fn read(workspace_root: &Path, relative_path: &Path) -> io::Result<String> {
        let parent = open_parent(workspace_root, relative_path, false)?;
        let target = parent.target_path();
        let mut file = open_file(&target, GENERIC_READ, OPEN_EXISTING)?;
        validate_handle(&file, false)?;
        let mut contents = String::new();
        file.read_to_string(&mut contents)?;
        Ok(contents)
    }

    pub(super) fn write_atomic(
        workspace_root: &Path,
        relative_path: &Path,
        content: &str,
    ) -> io::Result<()> {
        let parent = open_parent(workspace_root, relative_path, true)?;
        let target = parent.target_path();
        match open_file(&target, 0, OPEN_EXISTING) {
            Ok(existing) => validate_handle(&existing, false)?,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }

        let (temporary_path, mut temporary) = create_temporary_file(&parent.directory_path)?;
        if let Err(error) = temporary
            .write_all(content.as_bytes())
            .and_then(|()| temporary.sync_all())
        {
            drop(temporary);
            delete_path(&temporary_path);
            return Err(error);
        }
        drop(temporary);

        let existing = wide_path(&temporary_path)?;
        let replacement = wide_path(&target)?;
        if unsafe {
            MoveFileExW(
                existing.as_ptr(),
                replacement.as_ptr(),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
            )
        } == 0
        {
            let error = io::Error::last_os_error();
            delete_path(&temporary_path);
            return Err(error);
        }
        Ok(())
    }

    pub(super) fn delete(workspace_root: &Path, relative_path: &Path) -> io::Result<()> {
        let parent = match open_parent(workspace_root, relative_path, false) {
            Ok(parent) => parent,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(error),
        };
        let target = parent.target_path();
        let file = match open_file(&target, DELETE_ACCESS, OPEN_EXISTING) {
            Ok(file) => file,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(error),
        };
        validate_handle(&file, false)?;
        let disposition = FileDispositionInformation { delete_file: 1 };
        if unsafe {
            SetFileInformationByHandle(
                file.as_raw_handle(),
                FILE_DISPOSITION_INFO_CLASS,
                (&disposition as *const FileDispositionInformation).cast(),
                std::mem::size_of::<FileDispositionInformation>() as u32,
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        drop(file);
        Ok(())
    }

    pub(super) fn open_private_lock(
        workspace_root: &Path,
        relative_path: &Path,
    ) -> io::Result<(File, Vec<File>)> {
        let parent = open_parent(workspace_root, relative_path, true)?;
        let target = parent.target_path();
        let file = open_file(&target, GENERIC_READ | GENERIC_WRITE, OPEN_ALWAYS)?;
        validate_handle(&file, false)?;
        Ok((file, parent.handles))
    }

    fn open_parent(
        workspace_root: &Path,
        relative_path: &Path,
        create: bool,
    ) -> io::Result<ParentGuard> {
        let mut segments = relative_segments(relative_path)?;
        let file_name = segments
            .pop()
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "file path is empty"))?;

        let root_metadata = fs::symlink_metadata(workspace_root)?;
        validate_windows_handle_attributes(root_metadata.file_attributes(), true)?;
        let canonical_root = fs::canonicalize(workspace_root)?;
        let root = open_directory(&canonical_root)?;
        let mut handles = vec![root];
        let mut directory_path = canonical_root;

        for segment in segments {
            directory_path.push(&segment);
            let directory = match open_directory(&directory_path) {
                Ok(directory) => directory,
                Err(error) if create && error.kind() == io::ErrorKind::NotFound => {
                    create_directory(&directory_path)?;
                    open_directory(&directory_path)?
                }
                Err(error) => return Err(error),
            };
            handles.push(directory);
        }

        Ok(ParentGuard {
            handles,
            directory_path,
            file_name,
        })
    }

    fn relative_segments(path: &Path) -> io::Result<Vec<OsString>> {
        path.components()
            .map(|component| match component {
                Component::Normal(segment) => Ok(segment.to_os_string()),
                _ => Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "path must be workspace-relative without parent traversal",
                )),
            })
            .collect()
    }

    fn open_directory(path: &Path) -> io::Result<File> {
        let directory = open_handle(
            path,
            0,
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
        )?;
        validate_handle(&directory, true)?;
        Ok(directory)
    }

    fn open_file(path: &Path, desired_access: u32, creation_disposition: u32) -> io::Result<File> {
        open_handle(
            path,
            desired_access,
            creation_disposition,
            FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT,
        )
    }

    fn open_handle(
        path: &Path,
        desired_access: u32,
        creation_disposition: u32,
        flags_and_attributes: u32,
    ) -> io::Result<File> {
        let path = wide_path(path)?;
        let handle = unsafe {
            CreateFileW(
                path.as_ptr(),
                desired_access,
                FILE_SHARE_READ | FILE_SHARE_WRITE,
                std::ptr::null(),
                creation_disposition,
                flags_and_attributes,
                std::ptr::null_mut(),
            )
        };
        if handle == INVALID_HANDLE_VALUE {
            Err(io::Error::last_os_error())
        } else {
            Ok(unsafe { File::from_raw_handle(handle as RawHandle) })
        }
    }

    fn validate_handle(file: &File, expect_directory: bool) -> io::Result<()> {
        let mut information = std::mem::MaybeUninit::<ByHandleFileInformation>::uninit();
        if unsafe { GetFileInformationByHandle(file.as_raw_handle(), information.as_mut_ptr()) }
            == 0
        {
            return Err(io::Error::last_os_error());
        }
        let information = unsafe { information.assume_init() };
        validate_windows_handle_attributes(information.file_attributes, expect_directory)
    }

    fn create_directory(path: &Path) -> io::Result<()> {
        let path = wide_path(path)?;
        if unsafe { CreateDirectoryW(path.as_ptr(), std::ptr::null()) } != 0 {
            return Ok(());
        }
        let error = io::Error::last_os_error();
        if error.kind() == io::ErrorKind::AlreadyExists {
            Ok(())
        } else {
            Err(error)
        }
    }

    fn create_temporary_file(directory: &Path) -> io::Result<(PathBuf, File)> {
        for _ in 0..16 {
            let name = format!(
                ".unclecode.{}.{}.{}.tmp",
                std::process::id(),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_nanos(),
                TEMP_COUNTER.fetch_add(1, Ordering::Relaxed),
            );
            let path = directory.join(name);
            match open_file(&path, GENERIC_WRITE, CREATE_NEW) {
                Ok(file) => {
                    validate_handle(&file, false)?;
                    return Ok((path, file));
                }
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
                Err(error) => return Err(error),
            }
        }
        Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            "unable to allocate a unique queue temporary file",
        ))
    }

    fn delete_path(path: &Path) {
        if let Ok(path) = wide_path(path) {
            let _ = unsafe { DeleteFileW(path.as_ptr()) };
        }
    }

    fn wide_path(path: &Path) -> io::Result<Vec<u16>> {
        let mut path = path.as_os_str().encode_wide().collect::<Vec<_>>();
        if path.contains(&0) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "Windows path contains a NUL character",
            ));
        }
        path.push(0);
        Ok(path)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn ordinary_atomic_write_does_not_widen_existing_directory_permissions() {
        use std::fs;
        use std::os::unix::fs::PermissionsExt;

        let root = std::env::temp_dir().join(format!(
            "unclecode-aci-safe-read-only-{}",
            std::process::id()
        ));
        let directory = root.join(".unclecode").join("context");
        fs::create_dir_all(&directory).expect("create test directory");
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o555))
            .expect("make directory read-only");

        let _ = write_text_file_atomically_no_symlinks(
            &root,
            Path::new(".unclecode/context/bootstrap.json"),
            "{}\n",
        );

        assert_eq!(
            fs::metadata(&directory)
                .expect("read directory metadata")
                .permissions()
                .mode()
                & 0o777,
            0o555,
        );
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o755))
            .expect("restore directory permissions");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn windows_handle_attributes_reject_reparse_points_before_use() {
        let error = validate_windows_handle_attributes(0x0000_0410, true)
            .expect_err("a directory reparse point must be rejected");
        assert_eq!(error.kind(), std::io::ErrorKind::PermissionDenied);

        let error = validate_windows_handle_attributes(0x0000_0400, false)
            .expect_err("a file reparse point must be rejected");
        assert_eq!(error.kind(), std::io::ErrorKind::PermissionDenied);
    }

    #[test]
    fn windows_handle_attributes_require_the_expected_file_kind() {
        validate_windows_handle_attributes(0x0000_0010, true)
            .expect("ordinary directory is accepted");
        validate_windows_handle_attributes(0x0000_0080, false).expect("ordinary file is accepted");
        assert_eq!(
            validate_windows_handle_attributes(0x0000_0010, false)
                .expect_err("directory is not a queue file")
                .kind(),
            std::io::ErrorKind::InvalidInput,
        );
    }
}
