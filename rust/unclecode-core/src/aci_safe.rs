use crate::aci::AciError;
#[cfg(not(any(target_os = "linux", target_os = "macos")))]
use std::io;
use std::path::Path;

pub fn read_text_file_no_symlinks(
    workspace_root: impl AsRef<Path>,
    path: impl AsRef<Path>,
) -> Result<String, AciError> {
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    {
        return no_symlink_io::read(workspace_root.as_ref(), path.as_ref()).map_err(AciError::Io);
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
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
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        let _ = (workspace_root, path, content);
        Err(AciError::Io(io::Error::new(
            io::ErrorKind::Unsupported,
            "symbolic-link-safe atomic writes are unsupported on this platform",
        )))
    }
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
    }

    pub(super) fn read(workspace_root: &Path, relative_path: &Path) -> io::Result<String> {
        let (directory, file_name) = open_parent(workspace_root, relative_path, false)?;
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
        let (directory, file_name) = open_parent(workspace_root, relative_path, true)?;
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

    fn open_parent(
        workspace_root: &Path,
        relative_path: &Path,
        create: bool,
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
            directory = open_directory_at(directory.as_raw_fd(), &segment, create)
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

    fn open_directory_at(parent_fd: c_int, name: &CStr, create: bool) -> io::Result<OwnedFd> {
        let flags = O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW;
        match open_file_at(parent_fd, name, flags, 0) {
            Ok(directory) => Ok(directory),
            Err(error) if create && error.kind() == io::ErrorKind::NotFound => {
                if unsafe { mkdirat(parent_fd, name.as_ptr(), 0o700) } != 0 {
                    let mkdir_error = io::Error::last_os_error();
                    if mkdir_error.kind() != io::ErrorKind::AlreadyExists {
                        return Err(mkdir_error);
                    }
                }
                open_file_at(parent_fd, name, flags, 0)
            }
            Err(error) => Err(error),
        }
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
