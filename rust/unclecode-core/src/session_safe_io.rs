use std::io;
use std::path::Path;

pub(crate) struct BoundedRegularFiles {
    pub(crate) files: Vec<(String, Vec<u8>)>,
    pub(crate) truncated_count: usize,
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
mod platform {
    use super::*;
    use std::ffi::{CStr, CString};
    use std::fs::{self, File};
    use std::io::{Read, Write};
    use std::os::fd::{AsRawFd, FromRawFd, IntoRawFd, OwnedFd};
    use std::os::raw::{c_char, c_int};
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::fs::MetadataExt;
    use std::path::Component;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    #[cfg(target_os = "linux")]
    const O_APPEND: c_int = 0x400;
    #[cfg(target_os = "macos")]
    const O_APPEND: c_int = 0x8;
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
        fn fdopendir(fd: c_int) -> *mut DirectoryStream;
        fn readdir(directory: *mut DirectoryStream) -> *mut DirectoryEntry;
        fn closedir(directory: *mut DirectoryStream) -> c_int;
        #[cfg(target_os = "linux")]
        fn __errno_location() -> *mut c_int;
        #[cfg(target_os = "macos")]
        fn __error() -> *mut c_int;
    }

    #[repr(C)]
    struct DirectoryStream {
        _private: [u8; 0],
    }

    #[cfg(target_os = "linux")]
    #[repr(C)]
    struct DirectoryEntry {
        d_ino: u64,
        d_off: i64,
        d_reclen: u16,
        d_type: u8,
        d_name: [c_char; 256],
    }

    #[cfg(target_os = "macos")]
    #[repr(C)]
    struct DirectoryEntry {
        d_ino: u64,
        d_seekoff: u64,
        d_reclen: u16,
        d_namlen: u16,
        d_type: u8,
        d_name: [c_char; 1024],
    }

    struct OwnedDirectoryStream(*mut DirectoryStream);

    impl Drop for OwnedDirectoryStream {
        fn drop(&mut self) {
            let _ = unsafe { closedir(self.0) };
        }
    }

    pub(crate) struct AnchoredSessionRoot {
        root: OwnedFd,
    }

    impl AnchoredSessionRoot {
        pub(crate) fn open(path: &Path) -> io::Result<Self> {
            Self::open_inner(path, true)
        }

        pub(crate) fn open_existing(path: &Path) -> io::Result<Self> {
            Self::open_inner(path, false)
        }

        fn open_inner(path: &Path, create: bool) -> io::Result<Self> {
            if create {
                fs::create_dir_all(path)?;
            }
            let metadata = fs::symlink_metadata(path)?;
            if metadata.file_type().is_symlink() || !metadata.is_dir() {
                return Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "refusing symbolic-link or non-directory session root",
                ));
            }
            let path = CString::new(path.as_os_str().as_bytes()).map_err(|_| {
                io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "session root contains a NUL byte",
                )
            })?;
            let root = owned_fd(unsafe {
                c_open(
                    path.as_ptr(),
                    O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW,
                )
            })
            .map_err(|error| path_entry_error(error, Path::new("session root")))?;
            let opened_root = File::from(root);
            let opened_metadata = opened_root.metadata()?;
            if opened_metadata.dev() != metadata.dev() || opened_metadata.ino() != metadata.ino() {
                return Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "session root changed while its anchored handle was opened",
                ));
            }
            let root = OwnedFd::from(opened_root);
            Ok(Self { root })
        }

        pub(crate) fn create_dir_all(&self, relative_path: &Path) -> io::Result<()> {
            let mut directory = duplicate_directory(&self.root)?;
            for segment in relative_segments(relative_path)? {
                directory = open_directory_at(directory.as_raw_fd(), &segment, true)
                    .map_err(|error| path_entry_error(error, relative_path))?;
            }
            Ok(())
        }

        pub(crate) fn read_to_string_bounded(
            &self,
            relative_path: &Path,
            max_bytes: usize,
        ) -> io::Result<String> {
            let (directory, file_name) = self.open_parent(relative_path, false)?;
            let file = open_file_at(
                directory.as_raw_fd(),
                &file_name,
                O_RDONLY | O_CLOEXEC | O_NOFOLLOW,
                0,
            )
            .map_err(|error| path_entry_error(error, relative_path))?;
            let mut file = File::from(file);
            let metadata = file.metadata()?;
            if !metadata.is_file() || metadata.len() > max_bytes as u64 {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!("session file exceeds the {max_bytes}-byte read bound"),
                ));
            }
            let mut contents = String::with_capacity(metadata.len() as usize);
            Read::by_ref(&mut file)
                .take(max_bytes.saturating_add(1) as u64)
                .read_to_string(&mut contents)?;
            if contents.len() > max_bytes {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!("session file exceeds the {max_bytes}-byte read bound"),
                ));
            }
            Ok(contents)
        }

        pub(crate) fn regular_file_len(&self, relative_path: &Path) -> io::Result<Option<u64>> {
            let (directory, file_name) = self.open_parent(relative_path, false)?;
            let file = match open_file_at(
                directory.as_raw_fd(),
                &file_name,
                O_RDONLY | O_CLOEXEC | O_NOFOLLOW,
                0,
            ) {
                Ok(file) => file,
                Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
                Err(error) => return Err(path_entry_error(error, relative_path)),
            };
            let metadata = File::from(file).metadata()?;
            if !metadata.is_file() {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    format!(
                        "refusing non-file session target {}",
                        relative_path.display()
                    ),
                ));
            }
            Ok(Some(metadata.len()))
        }

        pub(crate) fn append_all(&self, relative_path: &Path, bytes: &[u8]) -> io::Result<()> {
            let (directory, file_name) = self.open_parent(relative_path, true)?;
            let file = open_file_at(
                directory.as_raw_fd(),
                &file_name,
                O_WRONLY | O_APPEND | O_CREAT | O_CLOEXEC | O_NOFOLLOW,
                0o600,
            )
            .map_err(|error| path_entry_error(error, relative_path))?;
            let mut file = File::from(file);
            file.write_all(bytes)?;
            file.sync_all()
        }

        pub(crate) fn write_atomic_durable(
            &self,
            relative_path: &Path,
            bytes: &[u8],
        ) -> io::Result<()> {
            let (directory, file_name) = self.open_parent(relative_path, true)?;
            refuse_symbolic_link_target(directory.as_raw_fd(), &file_name, relative_path)?;
            let temporary = CString::new(format!(
                ".session.{}.{}.{}.tmp",
                std::process::id(),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_nanos(),
                TEMP_COUNTER.fetch_add(1, Ordering::Relaxed),
            ))
            .expect("generated session temporary file has no NUL");
            let temp = open_file_at(
                directory.as_raw_fd(),
                &temporary,
                O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW,
                0o600,
            )?;
            let write_result = {
                let mut file = File::from(temp);
                file.write_all(bytes).and_then(|()| file.sync_all())
            };
            if let Err(error) = write_result {
                remove_at(directory.as_raw_fd(), &temporary);
                return Err(error);
            }
            if unsafe {
                renameat(
                    directory.as_raw_fd(),
                    temporary.as_ptr(),
                    directory.as_raw_fd(),
                    file_name.as_ptr(),
                )
            } != 0
            {
                let error = io::Error::last_os_error();
                remove_at(directory.as_raw_fd(), &temporary);
                return Err(error);
            }
            sync_fd(directory.as_raw_fd())
        }

        pub(crate) fn read_bounded_regular_files_matching<Matches>(
            &self,
            relative_directory: &Path,
            max_entries: usize,
            max_bytes: usize,
            matches: Matches,
        ) -> io::Result<BoundedRegularFiles>
        where
            Matches: Fn(&[u8]) -> bool,
        {
            let directory = self.open_directory(relative_directory, false)?;
            read_bounded_regular_files_at(&directory, max_entries, max_bytes, matches)
        }

        pub(crate) fn prune_regular_files_matching<Matches>(
            &self,
            relative_directory: &Path,
            max_entries: usize,
            protected_name: &str,
            matches: Matches,
        ) -> io::Result<usize>
        where
            Matches: Fn(&[u8]) -> bool,
        {
            let directory = self.open_directory(relative_directory, false)?;
            prune_regular_files_at(&directory, max_entries, protected_name.as_bytes(), matches)
        }

        #[cfg(test)]
        fn read_bounded_regular_files_with_hooks<Before, After>(
            &self,
            relative_directory: &Path,
            max_entries: usize,
            max_bytes: usize,
            before_enumeration: Before,
            after_enumeration: After,
        ) -> io::Result<Vec<(String, Vec<u8>)>>
        where
            Before: FnOnce(),
            After: FnOnce(),
        {
            let directory = self.open_directory(relative_directory, false)?;
            before_enumeration();
            let result =
                read_bounded_regular_files_at(&directory, max_entries, max_bytes, |_| true)
                    .map(|scan| scan.files);
            after_enumeration();
            result
        }

        fn open_directory(&self, relative_path: &Path, create: bool) -> io::Result<OwnedFd> {
            let mut directory = duplicate_directory(&self.root)?;
            for segment in relative_segments(relative_path)? {
                directory = open_directory_at(directory.as_raw_fd(), &segment, create)
                    .map_err(|error| path_entry_error(error, relative_path))?;
            }
            Ok(directory)
        }

        fn open_parent(
            &self,
            relative_path: &Path,
            create: bool,
        ) -> io::Result<(OwnedFd, CString)> {
            let mut segments = relative_segments(relative_path)?;
            let file_name = segments.pop().ok_or_else(|| {
                io::Error::new(io::ErrorKind::InvalidInput, "session file path is empty")
            })?;
            let mut directory = duplicate_directory(&self.root)?;
            for segment in segments {
                directory = open_directory_at(directory.as_raw_fd(), &segment, create)
                    .map_err(|error| path_entry_error(error, relative_path))?;
            }
            Ok((directory, file_name))
        }
    }

    fn read_bounded_regular_files_at<Matches>(
        directory: &OwnedFd,
        max_entries: usize,
        max_bytes: usize,
        matches: Matches,
    ) -> io::Result<BoundedRegularFiles>
    where
        Matches: Fn(&[u8]) -> bool,
    {
        let duplicate = duplicate_directory(directory)?;
        let raw_fd = duplicate.into_raw_fd();
        let raw_stream = unsafe { fdopendir(raw_fd) };
        if raw_stream.is_null() {
            let error = io::Error::last_os_error();
            drop(unsafe { OwnedFd::from_raw_fd(raw_fd) });
            return Err(error);
        }
        let stream = OwnedDirectoryStream(raw_stream);
        let mut files = Vec::new();
        let mut truncated_count = 0_usize;
        loop {
            unsafe { *errno_location() = 0 };
            let entry = unsafe { readdir(stream.0) };
            if entry.is_null() {
                let errno = unsafe { *errno_location() };
                if errno != 0 {
                    return Err(io::Error::from_raw_os_error(errno));
                }
                break;
            }
            let name = unsafe { CStr::from_ptr((*entry).d_name.as_ptr()) };
            if name.to_bytes() == b"." || name.to_bytes() == b".." {
                continue;
            }
            if !matches(name.to_bytes()) {
                continue;
            }
            let Ok(file) = open_file_at(
                directory.as_raw_fd(),
                name,
                O_RDONLY | O_CLOEXEC | O_NOFOLLOW,
                0,
            ) else {
                continue;
            };
            let mut file = File::from(file);
            let metadata = file.metadata()?;
            if !metadata.is_file() || metadata.len() > max_bytes as u64 {
                continue;
            }
            if files.len() >= max_entries {
                truncated_count = truncated_count.saturating_add(1);
                continue;
            }
            let mut bytes = Vec::with_capacity(metadata.len() as usize);
            Read::by_ref(&mut file)
                .take(max_bytes.saturating_add(1) as u64)
                .read_to_end(&mut bytes)?;
            if bytes.len() > max_bytes {
                continue;
            }
            let Ok(name) = name.to_owned().into_string() else {
                continue;
            };
            files.push((name, bytes));
        }
        files.sort_by(|left, right| left.0.cmp(&right.0));
        Ok(BoundedRegularFiles {
            files,
            truncated_count,
        })
    }

    fn prune_regular_files_at<Matches>(
        directory: &OwnedFd,
        max_entries: usize,
        protected_name: &[u8],
        matches: Matches,
    ) -> io::Result<usize>
    where
        Matches: Fn(&[u8]) -> bool,
    {
        let duplicate = duplicate_directory(directory)?;
        let raw_fd = duplicate.into_raw_fd();
        let raw_stream = unsafe { fdopendir(raw_fd) };
        if raw_stream.is_null() {
            let error = io::Error::last_os_error();
            drop(unsafe { OwnedFd::from_raw_fd(raw_fd) });
            return Err(error);
        }
        let stream = OwnedDirectoryStream(raw_stream);
        let mut retained_others = 0_usize;
        let max_others = max_entries.saturating_sub(1);
        let mut removed = 0_usize;
        loop {
            unsafe { *errno_location() = 0 };
            let entry = unsafe { readdir(stream.0) };
            if entry.is_null() {
                let errno = unsafe { *errno_location() };
                if errno != 0 {
                    return Err(io::Error::from_raw_os_error(errno));
                }
                break;
            }
            let name = unsafe { CStr::from_ptr((*entry).d_name.as_ptr()) };
            let bytes = name.to_bytes();
            if bytes == b"." || bytes == b".." || !matches(bytes) || bytes == protected_name {
                continue;
            }
            let Ok(file) = open_file_at(
                directory.as_raw_fd(),
                name,
                O_RDONLY | O_CLOEXEC | O_NOFOLLOW,
                0,
            ) else {
                continue;
            };
            if !File::from(file).metadata()?.is_file() {
                continue;
            }
            if retained_others < max_others {
                retained_others += 1;
                continue;
            }
            if unsafe { unlinkat(directory.as_raw_fd(), name.as_ptr(), 0) } != 0 {
                return Err(io::Error::last_os_error());
            }
            removed += 1;
        }
        if removed > 0 {
            sync_fd(directory.as_raw_fd())?;
        }
        Ok(removed)
    }

    unsafe fn errno_location() -> *mut c_int {
        #[cfg(target_os = "linux")]
        {
            unsafe { __errno_location() }
        }
        #[cfg(target_os = "macos")]
        {
            unsafe { __error() }
        }
    }

    fn duplicate_directory(directory: &OwnedFd) -> io::Result<OwnedFd> {
        let current = CString::new(".").expect("literal has no NUL");
        open_file_at(
            directory.as_raw_fd(),
            &current,
            O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW,
            0,
        )
    }

    fn relative_segments(path: &Path) -> io::Result<Vec<CString>> {
        path.components()
            .map(|component| match component {
                Component::Normal(segment) => CString::new(segment.as_bytes()).map_err(|_| {
                    io::Error::new(
                        io::ErrorKind::InvalidInput,
                        "session path contains a NUL byte",
                    )
                }),
                _ => Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "session path must be relative without parent traversal",
                )),
            })
            .collect()
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
                } else {
                    sync_fd(parent_fd)?;
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
                            "refusing non-file session target {}",
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
        owned_fd(unsafe { openat(directory_fd, name.as_ptr(), flags, mode) })
    }

    fn owned_fd(raw_fd: c_int) -> io::Result<OwnedFd> {
        if raw_fd < 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(unsafe { OwnedFd::from_raw_fd(raw_fd) })
        }
    }

    fn sync_fd(fd: c_int) -> io::Result<()> {
        if unsafe { fsync(fd) } == 0 {
            Ok(())
        } else {
            Err(io::Error::last_os_error())
        }
    }

    fn remove_at(directory_fd: c_int, name: &CStr) {
        let _ = unsafe { unlinkat(directory_fd, name.as_ptr(), 0) };
    }

    fn path_entry_error(error: io::Error, path: &Path) -> io::Error {
        if error.raw_os_error() == Some(ELOOP) || error.kind() == io::ErrorKind::NotADirectory {
            io::Error::new(
                io::ErrorKind::PermissionDenied,
                format!(
                    "refusing symbolic-link or non-directory session path {}",
                    path.display()
                ),
            )
        } else {
            error
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use std::os::unix::fs::symlink;

        struct TestDirectory(std::path::PathBuf);

        impl TestDirectory {
            fn new(label: &str) -> Self {
                let path = std::env::temp_dir().join(format!(
                    "unclecode-session-safe-io-{label}-{}-{}",
                    std::process::id(),
                    SystemTime::now()
                        .duration_since(UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_nanos(),
                ));
                fs::create_dir_all(&path).expect("create test directory");
                Self(path)
            }
        }

        impl Drop for TestDirectory {
            fn drop(&mut self) {
                let _ = fs::remove_dir_all(&self.0);
            }
        }

        #[test]
        fn anchored_notice_scan_never_emits_outside_revision_after_swap_out_and_back() {
            let temp = TestDirectory::new("notice-aba");
            let root = temp.0.join("root");
            let notices = root.join("notifications");
            let parked = root.join("notifications.parked");
            let outside = temp.0.join("outside");
            fs::create_dir_all(&notices).expect("create notices");
            fs::create_dir_all(&outside).expect("create outside");
            let notice_name = "session-00000000000000000000.notice.json";
            fs::write(notices.join(notice_name), b"{\"revision\":1}").expect("write inside notice");
            fs::write(outside.join(notice_name), b"{\"revision\":99}")
                .expect("write outside notice");

            let anchored = AnchoredSessionRoot::open_existing(&root).expect("anchor root");
            let files = anchored
                .read_bounded_regular_files_with_hooks(
                    Path::new("notifications"),
                    128,
                    4 * 1024,
                    || {
                        fs::rename(&notices, &parked).expect("park notices");
                        symlink(&outside, &notices).expect("swap outside link into path");
                    },
                    || {
                        fs::remove_file(&notices).expect("remove outside link");
                        fs::rename(&parked, &notices).expect("restore notices");
                    },
                )
                .expect("scan anchored notices");

            assert_eq!(files.len(), 1);
            assert_eq!(files[0].0, notice_name);
            assert_eq!(files[0].1, b"{\"revision\":1}");
            assert_eq!(
                fs::read(outside.join(notice_name)).expect("read outside sentinel"),
                b"{\"revision\":99}"
            );
        }

        #[test]
        fn bounded_scan_applies_the_name_filter_before_the_entry_limit() {
            let temp = TestDirectory::new("notice-name-filter");
            let root = temp.0.join("root");
            let notices = root.join("notifications");
            fs::create_dir_all(&notices).expect("create notices");
            for index in 0..256 {
                fs::write(notices.join(format!("{index:03}-malformed")), b"ignored")
                    .expect("write malformed entry");
            }
            let notice_name = "session-00000000000000000000.notice.json";
            fs::write(notices.join(notice_name), b"{\"revision\":1}").expect("write valid notice");

            let anchored = AnchoredSessionRoot::open_existing(&root).expect("anchor root");
            let scan = anchored
                .read_bounded_regular_files_matching(
                    Path::new("notifications"),
                    128,
                    4 * 1024,
                    |name| name == notice_name.as_bytes(),
                )
                .expect("scan matching notices");

            assert_eq!(scan.files.len(), 1);
            assert_eq!(scan.files[0].0, notice_name);
            assert_eq!(scan.truncated_count, 0);
        }
    }
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
mod platform {
    use super::*;

    pub(crate) struct AnchoredSessionRoot;

    impl AnchoredSessionRoot {
        pub(crate) fn open(_path: &Path) -> io::Result<Self> {
            Err(io::Error::new(
                io::ErrorKind::Unsupported,
                "symlink-safe session persistence is unsupported on this platform",
            ))
        }

        pub(crate) fn open_existing(_path: &Path) -> io::Result<Self> {
            Err(io::Error::new(
                io::ErrorKind::Unsupported,
                "symlink-safe session notification scanning is unsupported on this platform",
            ))
        }

        pub(crate) fn create_dir_all(&self, _path: &Path) -> io::Result<()> {
            unreachable!("unsupported session root cannot be constructed")
        }

        pub(crate) fn read_to_string_bounded(
            &self,
            _path: &Path,
            _max_bytes: usize,
        ) -> io::Result<String> {
            unreachable!("unsupported session root cannot be constructed")
        }

        pub(crate) fn regular_file_len(&self, _path: &Path) -> io::Result<Option<u64>> {
            unreachable!("unsupported session root cannot be constructed")
        }

        pub(crate) fn append_all(&self, _path: &Path, _bytes: &[u8]) -> io::Result<()> {
            unreachable!("unsupported session root cannot be constructed")
        }

        pub(crate) fn write_atomic_durable(&self, _path: &Path, _bytes: &[u8]) -> io::Result<()> {
            unreachable!("unsupported session root cannot be constructed")
        }

        pub(crate) fn read_bounded_regular_files_matching<Matches>(
            &self,
            _relative_directory: &Path,
            _max_entries: usize,
            _max_bytes: usize,
            _matches: Matches,
        ) -> io::Result<BoundedRegularFiles>
        where
            Matches: Fn(&[u8]) -> bool,
        {
            unreachable!("unsupported session root cannot be constructed")
        }

        pub(crate) fn prune_regular_files_matching<Matches>(
            &self,
            _relative_directory: &Path,
            _max_entries: usize,
            _protected_name: &str,
            _matches: Matches,
        ) -> io::Result<usize>
        where
            Matches: Fn(&[u8]) -> bool,
        {
            unreachable!("unsupported session root cannot be constructed")
        }
    }
}

pub(crate) use platform::AnchoredSessionRoot;
