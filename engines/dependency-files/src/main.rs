#![forbid(unsafe_op_in_unsafe_fn)]

use std::env;
use std::io::{self, BufRead, Read, Write};
use std::process;

fn main() {
    let arguments = match env::args_os()
        .map(|argument| argument.into_string().map_err(|_| ()))
        .collect::<Result<Vec<_>, _>>()
    {
        Ok(arguments) => arguments,
        Err(()) => {
            emit_error("INVALID_ARGUMENT");
            process::exit(2);
        }
    };

    if arguments.get(1).map(String::as_str) == Some("stdio") && arguments.len() == 2 {
        stdio_loop();
        return;
    }
    if matches!(
        arguments.get(1).map(String::as_str),
        Some("lease-acquire" | "lease-release")
    ) {
        emit_error("LEASE_STDIO_REQUIRED");
        process::exit(2);
    }

    #[cfg(target_os = "macos")]
    let result = macos::run(&arguments[1..]);
    #[cfg(not(target_os = "macos"))]
    let result: Result<String, &'static str> = Err("NATIVE_UNSUPPORTED");

    match result {
        Ok(response) => {
            println!("{response}");
        }
        Err(code) => {
            emit_error(code);
            process::exit(1);
        }
    }
}

fn stdio_loop() {
    const MAX_FRAME_BYTES: usize = 64 * 1024;
    let stdin = io::stdin();
    let mut stdout = io::BufWriter::new(io::stdout().lock());
    let mut input = stdin.lock();
    loop {
        let mut bytes = Vec::with_capacity(256);
        let read = input
            .by_ref()
            .take((MAX_FRAME_BYTES + 2) as u64)
            .read_until(b'\n', &mut bytes);
        let response = match read {
            Ok(0) => break,
            Ok(_) if bytes.last() == Some(&b'\n') && bytes.len() - 1 <= MAX_FRAME_BYTES => {
                bytes.pop();
                let frame = match String::from_utf8(bytes) {
                    Ok(frame) => frame,
                    Err(_) => {
                        let _ = writeln!(
                            stdout,
                            "{{\"ok\":false,\"protocol\":1,\"code\":\"FRAME_INVALID\"}}"
                        );
                        let _ = stdout.flush();
                        continue;
                    }
                };
                match decode_frame(&frame) {
                    Ok(arguments) => dispatch(&arguments),
                    Err(code) => Err(code),
                }
            }
            Ok(_) => Err("FRAME_TOO_LARGE"),
            Err(_) => break,
        };
        let oversized = matches!(&response, Err("FRAME_TOO_LARGE"));
        let encoded = match response {
            Ok(value) => value,
            Err(code) => format!("{{\"ok\":false,\"protocol\":1,\"code\":\"{code}\"}}"),
        };
        if writeln!(stdout, "{encoded}")
            .and_then(|_| stdout.flush())
            .is_err()
        {
            break;
        }
        if oversized {
            break;
        }
    }
}

fn decode_frame(frame: &str) -> Result<Vec<String>, &'static str> {
    const MAX_FIELDS: usize = 16;
    const MAX_FIELD_BYTES: usize = 32 * 1024;
    let mut fields = frame.split('\t');
    let count_text = fields.next().ok_or("FRAME_INVALID")?;
    if count_text.is_empty()
        || (count_text.len() > 1 && count_text.starts_with('0'))
        || !count_text.bytes().all(|byte| byte.is_ascii_digit())
    {
        return Err("FRAME_INVALID");
    }
    let count = count_text.parse::<usize>().map_err(|_| "FRAME_INVALID")?;
    if count == 0 || count > MAX_FIELDS || fields.clone().count() != count {
        return Err("FRAME_INVALID");
    }
    fields
        .map(|field| {
            if field.is_empty()
                || field.len() % 2 != 0
                || field.len() / 2 > MAX_FIELD_BYTES
                || !field.bytes().all(|byte| byte.is_ascii_hexdigit())
            {
                return Err("FRAME_INVALID");
            }
            let bytes = (0..field.len())
                .step_by(2)
                .map(|index| {
                    u8::from_str_radix(&field[index..index + 2], 16).map_err(|_| "FRAME_INVALID")
                })
                .collect::<Result<Vec<_>, _>>()?;
            String::from_utf8(bytes).map_err(|_| "FRAME_INVALID")
        })
        .collect()
}

#[cfg(target_os = "macos")]
fn dispatch(arguments: &[String]) -> Result<String, &'static str> {
    macos::run(arguments)
}

#[cfg(not(target_os = "macos"))]
fn dispatch(_arguments: &[String]) -> Result<String, &'static str> {
    Err("NATIVE_UNSUPPORTED")
}

fn emit_error(code: &str) {
    let safe = if code
        .bytes()
        .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_')
    {
        code
    } else {
        "NATIVE_HELPER_FAILED"
    };
    println!("{{\"ok\":false,\"protocol\":1,\"code\":\"{safe}\"}}");
}

#[cfg(target_os = "macos")]
mod macos {
    use std::ffi::{c_char, c_int, c_void, CString, OsStr};
    use std::fs::{self, File, FileTimes};
    use std::os::darwin::fs::MetadataExt;
    use std::os::fd::{AsRawFd, FromRawFd};
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::fs::MetadataExt as _;
    use std::path::{Component, Path};
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

    // Darwin values from Apple's public XNU fcntl.h and stdio.h.
    const O_RDONLY: c_int = 0x0000;
    const O_NONBLOCK: c_int = 0x0004;
    const O_NOFOLLOW: c_int = 0x0100;
    const O_DIRECTORY: c_int = 0x0010_0000;
    const O_CLOEXEC: c_int = 0x0100_0000;
    const RENAME_SWAP: u32 = 0x0000_0002;
    const RENAME_NOFOLLOW_ANY: u32 = 0x0000_0010;
    const LOCK_EX: c_int = 0x02;
    const LOCK_NB: c_int = 0x04;
    const EWOULDBLOCK: c_int = 35;
    const EEXIST: c_int = 17;
    const O_RDWR: c_int = 0x0002;
    const O_CREAT: c_int = 0x0200;
    const O_EXCL: c_int = 0x0800;
    const ACL_TYPE_EXTENDED: c_int = 0x0000_0100;
    const ACL_FIRST_ENTRY: c_int = 0;
    const ENOENT: c_int = 2;
    const ERANGE: c_int = 34;
    const ATTRIBUTE_NAME_LIST_MAX: usize = 16 * 1024;
    const ATTRIBUTE_VALUE_MAX: usize = 64 * 1024;
    const ATTRIBUTE_TOTAL_MAX: usize = 256 * 1024;
    const ATTRIBUTE_COUNT_MAX: usize = 32;
    const S_IFMT: u32 = 0o170000;
    const S_IFREG: u32 = 0o100000;
    const NANOSECONDS_PER_SECOND: i128 = 1_000_000_000;

    unsafe extern "C" {
        fn open(path: *const c_char, flags: c_int, ...) -> c_int;
        fn openat(directory: c_int, path: *const c_char, flags: c_int, ...) -> c_int;
        fn renameatx_np(
            from_directory: c_int,
            from_path: *const c_char,
            to_directory: c_int,
            to_path: *const c_char,
            flags: u32,
        ) -> c_int;
        fn flock(fd: c_int, operation: c_int) -> c_int;
        fn acl_get_fd_np(file: c_int, acl_type: c_int) -> *mut c_void;
        fn acl_get_entry(acl: *mut c_void, entry_id: c_int, entry: *mut *mut c_void) -> c_int;
        fn acl_free(value: *mut c_void) -> c_int;
        fn __error() -> *mut c_int;
        fn getuid() -> u32;
        fn flistxattr(file: c_int, namebuf: *mut c_char, size: usize, options: c_int) -> isize;
        fn fgetxattr(
            file: c_int,
            name: *const c_char,
            value: *mut c_void,
            size: usize,
            position: u32,
            options: c_int,
        ) -> isize;
    }

    struct ParentAndLeaf {
        parent: File,
        leaf: CString,
    }

    struct LeaseHandle {
        root: File,
        root_path: String,
        lock: File,
        name: CString,
    }

    pub fn run(arguments: &[String]) -> Result<String, &'static str> {
        let Some(command) = arguments.first().map(String::as_str) else {
            return Err("USAGE");
        };

        if command != "lease-acquire" {
            validate_leases()?;
        }

        match command {
            "version" if arguments.len() == 1 => Ok("{\"ok\":true,\"protocol\":2,\"capabilities\":[\"stdio\",\"xattrs\",\"swap\",\"forced-clone\",\"lease\"],\"version\":\"2\"}".to_owned()),
            "lease-acquire" if arguments.len() == 3 => lease_acquire(&arguments[1], &arguments[2]),
            "lease-release" if arguments.len() == 2 => lease_release(&arguments[1]),
            "probe" if arguments.len() == 3 => probe(&arguments[1], &arguments[2]),
            "restore-times" if arguments.len() == 9 => restore_times(
                &arguments[1],
                &arguments[2],
                &arguments[3],
                &arguments[4],
                &arguments[5],
                &arguments[6],
                &arguments[7],
                &arguments[8],
            ),
            "swap" if arguments.len() == 6 => swap(
                &arguments[1],
                &arguments[2],
                &arguments[3],
                &arguments[4],
                &arguments[5],
            ),
            _ => Err("USAGE"),
        }
    }

    thread_local! {
        static LEASES: std::cell::RefCell<std::collections::HashMap<String, LeaseHandle>> =
            std::cell::RefCell::new(std::collections::HashMap::new());
    }

    fn lease_acquire(root: &str, key: &str) -> Result<String, &'static str> {
        if key.len() != 64
            || !key
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            return Err("LEASE_KEY_INVALID");
        }
        let root_file = open_root(root)?;
        let root_metadata = root_file.metadata().map_err(|_| "LEASE_ROOT_INVALID")?;
        if root_metadata.uid() != unsafe { getuid() } || root_metadata.st_mode() & 0o077 != 0 {
            return Err("LEASE_ROOT_PRIVATE_REQUIRED");
        }
        let name = c_string(&format!(".setu-dependency-file-lease-{key}.lock"))?;
        let initial = unsafe {
            openat(
                root_file.as_raw_fd(),
                name.as_ptr(),
                O_RDWR | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC,
                0o600,
            )
        };
        let descriptor = if initial >= 0 {
            initial
        } else if errno() == EEXIST {
            unsafe {
                openat(
                    root_file.as_raw_fd(),
                    name.as_ptr(),
                    O_RDWR | O_NOFOLLOW | O_CLOEXEC,
                )
            }
        } else {
            return Err("LEASE_FILE_UNAVAILABLE");
        };
        if descriptor < 0 {
            return Err("LEASE_FILE_UNAVAILABLE");
        }
        let file = unsafe { File::from_raw_fd(descriptor) };
        let metadata = file.metadata().map_err(|_| "LEASE_FILE_INVALID")?;
        if !metadata.is_file()
            || metadata.uid() != unsafe { getuid() }
            || metadata.st_mode() & 0o777 != 0o600
            || metadata.st_nlink() != 1
        {
            return Err("LEASE_FILE_INVALID");
        }
        if unsafe { flock(file.as_raw_fd(), LOCK_EX | LOCK_NB) } != 0 {
            return Err(if errno() == EWOULDBLOCK {
                "LEASE_BUSY"
            } else {
                "LEASE_LOCK_FAILED"
            });
        }
        // Reopen the name after locking and compare identity. The retained descriptor keeps
        // the advisory lock attached to this exact inode for the worker's entire lease.
        let verify_descriptor = unsafe {
            openat(
                root_file.as_raw_fd(),
                name.as_ptr(),
                O_RDWR | O_NOFOLLOW | O_CLOEXEC,
            )
        };
        if verify_descriptor < 0 {
            return Err("LEASE_FILE_REPLACED");
        }
        let verify_file = unsafe { File::from_raw_fd(verify_descriptor) };
        let verify_metadata = verify_file.metadata().map_err(|_| "LEASE_FILE_REPLACED")?;
        if verify_metadata.dev() != metadata.dev() || verify_metadata.ino() != metadata.ino() {
            return Err("LEASE_FILE_REPLACED");
        }
        drop(verify_file);
        LEASES.with(|leases| {
            let mut held = leases.borrow_mut();
            if held.contains_key(key) {
                return Err("LEASE_ALREADY_HELD");
            }
            held.insert(
                key.to_owned(),
                LeaseHandle {
                    root: root_file,
                    root_path: root.to_owned(),
                    lock: file,
                    name,
                },
            );
            Ok(())
        })?;
        Ok(format!(
            "{{\"ok\":true,\"protocol\":2,\"lease\":\"acquired\",\"key\":\"{key}\"}}"
        ))
    }

    fn lease_release(key: &str) -> Result<String, &'static str> {
        let removed = LEASES.with(|leases| leases.borrow_mut().remove(key));
        if removed.is_none() {
            return Err("LEASE_NOT_HELD");
        }
        drop(removed);
        Ok(format!(
            "{{\"ok\":true,\"protocol\":2,\"lease\":\"released\",\"key\":\"{key}\"}}"
        ))
    }

    fn validate_leases() -> Result<(), &'static str> {
        LEASES.with(|leases| {
            for lease in leases.borrow().values() {
                let current_root =
                    open_root(&lease.root_path).map_err(|_| "LEASE_ROOT_REPLACED")?;
                let current_root_metadata =
                    current_root.metadata().map_err(|_| "LEASE_ROOT_REPLACED")?;
                let retained_root_metadata =
                    lease.root.metadata().map_err(|_| "LEASE_ROOT_REPLACED")?;
                if current_root_metadata.dev() != retained_root_metadata.dev()
                    || current_root_metadata.ino() != retained_root_metadata.ino()
                    || current_root_metadata.uid() != unsafe { getuid() }
                    || current_root_metadata.st_mode() & 0o077 != 0
                {
                    return Err("LEASE_ROOT_REPLACED");
                }
                let descriptor = unsafe {
                    openat(
                        lease.root.as_raw_fd(),
                        lease.name.as_ptr(),
                        O_RDWR | O_NOFOLLOW | O_CLOEXEC,
                    )
                };
                if descriptor < 0 {
                    return Err("LEASE_FILE_REPLACED");
                }
                let path_file = unsafe { File::from_raw_fd(descriptor) };
                let path_metadata = path_file.metadata().map_err(|_| "LEASE_FILE_REPLACED")?;
                let lock_metadata = lease.lock.metadata().map_err(|_| "LEASE_FILE_INVALID")?;
                if path_metadata.dev() != lock_metadata.dev()
                    || path_metadata.ino() != lock_metadata.ino()
                    || path_metadata.st_nlink() != 1
                    || path_metadata.uid() != unsafe { getuid() }
                    || path_metadata.st_mode() & 0o777 != 0o600
                    || !path_metadata.is_file()
                {
                    return Err("LEASE_FILE_REPLACED");
                }
            }
            Ok(())
        })
    }

    fn errno() -> c_int {
        // SAFETY: Darwin exposes the calling thread's errno through __error.
        unsafe { *__error() }
    }

    fn c_string(value: &str) -> Result<CString, &'static str> {
        CString::new(value.as_bytes()).map_err(|_| "INVALID_PATH")
    }

    fn open_root(root: &str) -> Result<File, &'static str> {
        let path = Path::new(root);
        if !path.is_absolute() || fs::canonicalize(path).map_err(|_| "ROOT_INVALID")? != path {
            return Err("ROOT_INVALID");
        }

        let slash = c_string("/")?;
        // SAFETY: the NUL-terminated path is valid and open returns a new descriptor.
        let root_fd = unsafe {
            open(
                slash.as_ptr(),
                O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC,
            )
        };
        if root_fd < 0 {
            return Err("ROOT_INVALID");
        }
        // SAFETY: root_fd is newly returned by open and ownership moves to File.
        let mut current = unsafe { File::from_raw_fd(root_fd) };

        for component in path.components() {
            match component {
                Component::RootDir => continue,
                Component::Normal(name) => {
                    let name = os_str_c_string(name)?;
                    let descriptor = open_directory_at(current.as_raw_fd(), &name)?;
                    current = descriptor;
                }
                _ => return Err("ROOT_INVALID"),
            }
        }
        Ok(current)
    }

    fn os_str_c_string(value: &OsStr) -> Result<CString, &'static str> {
        CString::new(value.as_bytes()).map_err(|_| "INVALID_PATH")
    }

    fn open_directory_at(parent: c_int, name: &CString) -> Result<File, &'static str> {
        // SAFETY: parent is a live directory descriptor and name is a single path component.
        let descriptor = unsafe {
            openat(
                parent,
                name.as_ptr(),
                O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC,
            )
        };
        if descriptor < 0 {
            return Err("PATH_UNAVAILABLE");
        }
        // SAFETY: descriptor is newly returned by openat and ownership moves to File.
        Ok(unsafe { File::from_raw_fd(descriptor) })
    }

    fn parse_relative_path(value: &str) -> Result<Vec<&str>, &'static str> {
        if value.is_empty()
            || value.starts_with('/')
            || value.ends_with('/')
            || value.contains('\\')
        {
            return Err("UNSAFE_RELATIVE_PATH");
        }
        let segments = value.split('/').collect::<Vec<_>>();
        if segments.iter().any(|segment| {
            segment.is_empty()
                || *segment == "."
                || *segment == ".."
                || segment.eq_ignore_ascii_case(".git")
        }) {
            return Err("UNSAFE_RELATIVE_PATH");
        }
        Ok(segments)
    }

    fn open_parent(root: &str, relative_path: &str) -> Result<ParentAndLeaf, &'static str> {
        let segments = parse_relative_path(relative_path)?;
        let mut parent = open_root(root)?;
        for segment in &segments[..segments.len() - 1] {
            let name = c_string(segment)?;
            parent = open_directory_at(parent.as_raw_fd(), &name)?;
        }
        Ok(ParentAndLeaf {
            parent,
            leaf: c_string(segments[segments.len() - 1])?,
        })
    }

    fn open_file_at(parent: c_int, name: &CString) -> Result<File, &'static str> {
        // O_NONBLOCK prevents a raced-in FIFO from blocking this metadata-only helper.
        // SAFETY: parent is a live directory descriptor and name is a single path component.
        let descriptor = unsafe {
            openat(
                parent,
                name.as_ptr(),
                O_RDONLY | O_NONBLOCK | O_NOFOLLOW | O_CLOEXEC,
            )
        };
        if descriptor < 0 {
            return Err("PATH_UNAVAILABLE");
        }
        // SAFETY: descriptor is newly returned by openat and ownership moves to File.
        Ok(unsafe { File::from_raw_fd(descriptor) })
    }

    fn path_matches_root(path: &Path) -> bool {
        fs::canonicalize(path)
            .map(|resolved| resolved == path)
            .unwrap_or(false)
    }

    fn stat_ns(seconds: i64, nanoseconds: i64) -> i128 {
        i128::from(seconds) * NANOSECONDS_PER_SECOND + i128::from(nanoseconds)
    }

    fn has_extended_acl(descriptor: c_int) -> Result<bool, &'static str> {
        // SAFETY: descriptor is an open file and ACL_TYPE_EXTENDED is Darwin's ACL type.
        let acl = unsafe { acl_get_fd_np(descriptor, ACL_TYPE_EXTENDED) };
        if acl.is_null() {
            if errno() == ENOENT {
                return Ok(false);
            }
            return Err("ACL_PROBE_UNAVAILABLE");
        }

        let mut entry = std::ptr::null_mut();
        // SAFETY: acl is a valid ACL returned by acl_get_fd_np; entry is writable output.
        let result = unsafe { acl_get_entry(acl, ACL_FIRST_ENTRY, &mut entry) };
        // SAFETY: acl is a releasable ACL returned by acl_get_fd_np.
        let free_result = unsafe { acl_free(acl) };
        if result < 0 || free_result != 0 {
            return Err("ACL_PROBE_UNAVAILABLE");
        }
        Ok(result == 1)
    }

    fn inspect_file(file: &File) -> Result<(fs::Metadata, bool, bool), &'static str> {
        let metadata = file.metadata().map_err(|_| "METADATA_UNAVAILABLE")?;
        let is_regular = metadata.st_mode() & S_IFMT == S_IFREG;
        if !is_regular {
            return Ok((metadata, false, false));
        }
        let acl = has_extended_acl(file.as_raw_fd())?;
        let size = metadata.st_size();
        let allocated = metadata.st_blocks().saturating_mul(512);
        let sparse = size > 0 && allocated < size;
        Ok((metadata, acl, sparse))
    }

    fn probe(root: &str, relative_path: &str) -> Result<String, &'static str> {
        if !path_matches_root(Path::new(root)) {
            return Err("ROOT_INVALID");
        }
        let parent = open_parent(root, relative_path)?;
        let file = open_file_at(parent.parent.as_raw_fd(), &parent.leaf)?;
        let (metadata, acl, sparse) = inspect_file(&file)?;
        let attributes = read_attributes(file.as_raw_fd())?;
        let attribute_json = attributes
            .iter()
            .map(|(name, value)| {
                format!(
                    "{{\"name\":\"{}\",\"valueHex\":\"{}\"}}",
                    json_escape(name),
                    hex(value)
                )
            })
            .collect::<Vec<_>>()
            .join(",");
        let mode = metadata.st_mode();
        let regular = mode & S_IFMT == S_IFREG;
        let response = format!(
            "{{\"ok\":true,\"protocol\":1,\"regular\":{regular},\"device\":\"{}\",\"inode\":\"{}\",\"size\":\"{}\",\"mode\":{},\"uid\":{},\"gid\":{},\"nlink\":{},\"mtimeNs\":\"{}\",\"ctimeNs\":\"{}\",\"atimeNs\":\"{}\",\"flags\":{},\"acl\":{acl},\"sparse\":{sparse},\"attributes\":[{attribute_json}]}}",
            metadata.st_dev(),
            metadata.st_ino(),
            metadata.st_size(),
            mode,
            metadata.st_uid(),
            metadata.st_gid(),
            metadata.st_nlink(),
            stat_ns(metadata.st_mtime(), metadata.st_mtime_nsec()),
            stat_ns(metadata.st_ctime(), metadata.st_ctime_nsec()),
            stat_ns(metadata.st_atime(), metadata.st_atime_nsec()),
            metadata.st_flags(),
        );
        Ok(response)
    }

    fn read_attributes(descriptor: c_int) -> Result<Vec<(String, Vec<u8>)>, &'static str> {
        // Darwin flistxattr/fgetxattr operate on the already validated descriptor.
        // Their size-query then bounded-read pattern is documented by Apple.
        let names_size = unsafe { flistxattr(descriptor, std::ptr::null_mut(), 0, 0) };
        if names_size < 0 || names_size as usize > ATTRIBUTE_NAME_LIST_MAX {
            return Err("ATTRIBUTE_TOO_LARGE");
        }
        if names_size == 0 {
            return Ok(Vec::new());
        }
        let mut names = vec![0u8; names_size as usize];
        let listed = unsafe { flistxattr(descriptor, names.as_mut_ptr().cast(), names.len(), 0) };
        if listed < 0 {
            return Err(if errno() == ERANGE {
                "ATTRIBUTE_TOO_LARGE"
            } else {
                "ATTRIBUTE_UNREADABLE"
            });
        }
        names.truncate(listed as usize);
        if names.last() != Some(&0) {
            return Err("ATTRIBUTE_UNREADABLE");
        }
        let mut names = names
            .split(|byte| *byte == 0)
            .filter(|name| !name.is_empty())
            .map(|name| {
                std::str::from_utf8(name)
                    .map(str::to_owned)
                    .map_err(|_| "UNKNOWN_ATTRIBUTE")
            })
            .collect::<Result<Vec<_>, _>>()?;
        if names.len() > ATTRIBUTE_COUNT_MAX {
            return Err("ATTRIBUTE_TOO_LARGE");
        }
        names.sort();
        if names.windows(2).any(|pair| pair[0] == pair[1]) {
            return Err("ATTRIBUTE_UNREADABLE");
        }
        if names
            .iter()
            .any(|name| name != "com.apple.provenance" && name != "com.apple.quarantine")
        {
            return Err("UNKNOWN_ATTRIBUTE");
        }
        let mut total = 0usize;
        let mut result = Vec::with_capacity(names.len());
        for name in names {
            let c_name = c_string(&name)?;
            let value_size =
                unsafe { fgetxattr(descriptor, c_name.as_ptr(), std::ptr::null_mut(), 0, 0, 0) };
            if value_size < 0 || value_size as usize > ATTRIBUTE_VALUE_MAX {
                return Err("ATTRIBUTE_TOO_LARGE");
            }
            total = total
                .checked_add(value_size as usize)
                .ok_or("ATTRIBUTE_TOO_LARGE")?;
            if total > ATTRIBUTE_TOTAL_MAX {
                return Err("ATTRIBUTE_TOO_LARGE");
            }
            let mut value = vec![0u8; value_size as usize];
            let read = unsafe {
                fgetxattr(
                    descriptor,
                    c_name.as_ptr(),
                    value.as_mut_ptr().cast(),
                    value.len(),
                    0,
                    0,
                )
            };
            if read < 0 || read as usize != value.len() {
                return Err(if errno() == ERANGE {
                    "ATTRIBUTE_TOO_LARGE"
                } else {
                    "ATTRIBUTE_UNREADABLE"
                });
            }
            result.push((name, value));
        }
        Ok(result)
    }

    fn hex(bytes: &[u8]) -> String {
        const DIGITS: &[u8; 16] = b"0123456789abcdef";
        let mut output = String::with_capacity(bytes.len() * 2);
        for byte in bytes {
            output.push(DIGITS[(byte >> 4) as usize] as char);
            output.push(DIGITS[(byte & 15) as usize] as char);
        }
        output
    }

    fn json_escape(value: &str) -> String {
        value
            .chars()
            .flat_map(|character| match character {
                '"' => "\\\"".chars().collect::<Vec<_>>(),
                '\\' => "\\\\".chars().collect(),
                character if character.is_control() => "?".chars().collect(),
                character => vec![character],
            })
            .collect()
    }

    fn parse_decimal(value: &str) -> Result<i128, &'static str> {
        value.parse::<i128>().map_err(|_| "TIMESTAMP_INVALID")
    }

    fn to_system_time(nanoseconds: i128) -> Result<SystemTime, &'static str> {
        let absolute = nanoseconds.unsigned_abs();
        let seconds = u64::try_from(absolute / NANOSECONDS_PER_SECOND as u128)
            .map_err(|_| "TIMESTAMP_INVALID")?;
        let nanos = (absolute % NANOSECONDS_PER_SECOND as u128) as u32;
        let duration = Duration::new(seconds, nanos);
        if nanoseconds < 0 {
            UNIX_EPOCH.checked_sub(duration).ok_or("TIMESTAMP_INVALID")
        } else {
            UNIX_EPOCH.checked_add(duration).ok_or("TIMESTAMP_INVALID")
        }
    }

    fn restore_times(
        root: &str,
        relative_path: &str,
        atime: &str,
        mtime: &str,
        expected_device: &str,
        expected_inode: &str,
        expected_size: &str,
        expected_ctime: &str,
    ) -> Result<String, &'static str> {
        if !path_matches_root(Path::new(root)) {
            return Err("ROOT_INVALID");
        }
        let atime_ns = parse_decimal(atime)?;
        let mtime_ns = parse_decimal(mtime)?;
        let parent = open_parent(root, relative_path)?;
        let file = open_file_at(parent.parent.as_raw_fd(), &parent.leaf)?;
        let (metadata, acl, sparse) = inspect_file(&file)?;
        if !metadata.is_file() {
            return Err("NOT_REGULAR_FILE");
        }
        if metadata.st_nlink() != 1 || acl || sparse || metadata.st_flags() != 0 {
            return Err("FILE_UNSUPPORTED");
        }
        if metadata.st_uid() != unsafe { getuid() } {
            return Err("OWNER_MISMATCH");
        }
        if metadata.st_mode() & 0o6000 != 0 {
            return Err("SET_ID_MODE");
        }
        if metadata.st_dev().to_string() != expected_device
            || metadata.st_ino().to_string() != expected_inode
            || metadata.st_size().to_string() != expected_size
            || stat_ns(metadata.st_ctime(), metadata.st_ctime_nsec()).to_string() != expected_ctime
        {
            return Err("FILE_CHANGED");
        }
        let times = FileTimes::new()
            .set_accessed(to_system_time(atime_ns)?)
            .set_modified(to_system_time(mtime_ns)?);
        file.set_times(times)
            .map_err(|_| "TIMESTAMP_RESTORE_FAILED")?;
        file.sync_all().map_err(|_| "TIMESTAMP_SYNC_UNKNOWN")?;
        let after = file.metadata().map_err(|_| "TIMESTAMP_RESTORE_UNKNOWN")?;
        if stat_ns(after.st_atime(), after.st_atime_nsec()) != atime_ns
            || stat_ns(after.st_mtime(), after.st_mtime_nsec()) != mtime_ns
        {
            return Err("TIMESTAMP_RESTORE_UNKNOWN");
        }
        Ok(format!(
            "{{\"ok\":true,\"protocol\":1,\"restored\":true,\"atimeNs\":\"{}\",\"mtimeNs\":\"{}\",\"device\":\"{}\",\"inode\":\"{}\"}}",
            atime_ns,
            mtime_ns,
            after.st_dev(),
            after.st_ino(),
        ))
    }

    fn parse_unsigned(value: &str) -> Result<u64, &'static str> {
        if value.is_empty() || (value.len() > 1 && value.starts_with('0')) {
            return Err("PARENT_IDENTITY_INVALID");
        }
        value.parse::<u64>().map_err(|_| "PARENT_IDENTITY_INVALID")
    }

    fn swap(
        root: &str,
        target_relative_path: &str,
        temporary_relative_path: &str,
        expected_device: &str,
        expected_inode: &str,
    ) -> Result<String, &'static str> {
        if !path_matches_root(Path::new(root)) {
            return Err("ROOT_INVALID");
        }
        let target_parts = parse_relative_path(target_relative_path)?;
        let temporary_parts = parse_relative_path(temporary_relative_path)?;
        if target_parts.len() != temporary_parts.len()
            || target_parts[..target_parts.len() - 1]
                != temporary_parts[..temporary_parts.len() - 1]
            || target_parts[target_parts.len() - 1] == temporary_parts[temporary_parts.len() - 1]
        {
            return Err("EXCHANGE_PATH_INVALID");
        }
        let expected_device = parse_unsigned(expected_device)?;
        let expected_inode = parse_unsigned(expected_inode)?;
        let target = open_parent(root, target_relative_path)?;
        let temporary = open_parent(root, temporary_relative_path)?;
        let parent_metadata = target.parent.metadata().map_err(|_| "PARENT_UNAVAILABLE")?;
        if parent_metadata.st_dev() != expected_device || parent_metadata.st_ino() != expected_inode
        {
            return Err("PARENT_CHANGED");
        }
        let temporary_parent_metadata = temporary
            .parent
            .metadata()
            .map_err(|_| "PARENT_UNAVAILABLE")?;
        if temporary_parent_metadata.st_dev() != parent_metadata.st_dev()
            || temporary_parent_metadata.st_ino() != parent_metadata.st_ino()
        {
            return Err("PARENT_CHANGED");
        }
        for leaf in [&target.leaf, &temporary.leaf] {
            let file = open_file_at(target.parent.as_raw_fd(), leaf)?;
            let (metadata, acl, sparse) = inspect_file(&file)?;
            if !metadata.is_file() {
                return Err("EXCHANGE_FILE_INVALID");
            }
            if metadata.st_nlink() != 1
                || metadata.st_uid() != unsafe { getuid() }
                || metadata.st_mode() & 0o6000 != 0
                || metadata.st_flags() != 0
                || acl
                || sparse
            {
                return Err("FILE_UNSUPPORTED");
            }
        }

        // Reopen the target parent from root just before exchange to detect a changed path.
        let current_parent = open_parent(root, target_relative_path)?;
        let current_metadata = current_parent
            .parent
            .metadata()
            .map_err(|_| "PARENT_UNAVAILABLE")?;
        if current_metadata.st_dev() != parent_metadata.st_dev()
            || current_metadata.st_ino() != parent_metadata.st_ino()
        {
            return Err("PARENT_CHANGED");
        }

        // RENAME_SWAP is atomic; RENAME_NOFOLLOW_ANY refuses raced symlink paths.
        let result = unsafe {
            renameatx_np(
                target.parent.as_raw_fd(),
                target.leaf.as_ptr(),
                target.parent.as_raw_fd(),
                temporary.leaf.as_ptr(),
                RENAME_SWAP | RENAME_NOFOLLOW_ANY,
            )
        };
        if result != 0 {
            return Err("ATOMIC_EXCHANGE_FAILED");
        }
        target
            .parent
            .sync_all()
            .map_err(|_| "EXCHANGE_SYNC_UNKNOWN")?;

        let post_parent =
            open_parent(root, target_relative_path).map_err(|_| "EXCHANGE_PATH_CHANGED")?;
        let post_metadata = post_parent
            .parent
            .metadata()
            .map_err(|_| "EXCHANGE_PATH_CHANGED")?;
        if post_metadata.st_dev() != parent_metadata.st_dev()
            || post_metadata.st_ino() != parent_metadata.st_ino()
        {
            return Err("EXCHANGE_PATH_CHANGED");
        }
        Ok("{\"ok\":true,\"protocol\":1,\"exchanged\":true}".to_owned())
    }
}
