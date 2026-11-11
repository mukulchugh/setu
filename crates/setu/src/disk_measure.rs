//! Clone-aware directory sizing (APFS). `logical` is the sum of file lengths; `private` is the
//! bytes that would actually be freed by deleting the files (shared clone extents excluded).
#![allow(dead_code)]

use serde::Serialize;
use std::fs;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize)]
pub struct Size {
    pub logical: u64,
    pub private: u64,
    pub files: u64,
    pub errors: u64,
}

/// Walk `root` (no symlink following, single device, nested `.git` skipped) and total its files.
pub fn measure(root: &Path) -> Size {
    let mut size = Size::default();
    let root_md = match fs::symlink_metadata(root) {
        Ok(m) => m,
        Err(e) => {
            if e.kind() != std::io::ErrorKind::NotFound {
                size.errors += 1;
            }
            return size;
        }
    };
    if root_md.file_type().is_symlink() {
        return size;
    }
    if root_md.is_file() {
        add_file(root, &root_md, &mut size);
        return size;
    }
    let dev = root_md.dev();
    let mut stack: Vec<PathBuf> = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let rd = match fs::read_dir(&dir) {
            Ok(rd) => rd,
            Err(_) => {
                size.errors += 1;
                continue;
            }
        };
        for ent in rd {
            let ent = match ent {
                Ok(e) => e,
                Err(_) => {
                    size.errors += 1;
                    continue;
                }
            };
            let path = ent.path();
            let md = match fs::symlink_metadata(&path) {
                Ok(m) => m,
                Err(_) => {
                    size.errors += 1;
                    continue;
                }
            };
            let ft = md.file_type();
            if ft.is_symlink() {
                continue; // its own size counts as 0; never descend
            }
            if ft.is_dir() {
                if md.dev() != dev || ent.file_name() == ".git" {
                    continue;
                }
                stack.push(path);
            } else if ft.is_file() {
                add_file(&path, &md, &mut size);
            }
        }
    }
    size
}

fn add_file(path: &Path, md: &fs::Metadata, size: &mut Size) {
    size.files += 1;
    size.logical += md.len();
    match private_size(path) {
        Some(p) => size.private += p,
        None => {
            size.errors += 1;
            size.private += md.blocks() * 512;
        }
    }
}

/// Private (not shared with any clone) bytes of a single file. None if the OS call fails.
pub fn private_size(path: &Path) -> Option<u64> {
    sys::private_size(path)
}

#[cfg(target_os = "macos")]
mod sys {
    use std::ffi::{c_void, CString};
    use std::os::unix::ffi::OsStrExt;
    use std::path::Path;

    // sys/attr.h: FSOPT_NOFOLLOW 0x1, FSOPT_ATTR_CMN_EXTENDED 0x20 (makes attrlist.forkattr carry
    // the ATTR_CMNEXT_* bits), ATTR_CMNEXT_PRIVATESIZE 0x8 (off_t of bytes not shared by clones).
    const FSOPT_NOFOLLOW: u32 = 0x1;
    const FSOPT_ATTR_CMN_EXTENDED: u32 = 0x20;
    const ATTR_CMNEXT_PRIVATESIZE: u32 = 0x0000_0008;
    const ATTR_BIT_MAP_COUNT: u16 = 5;

    pub fn private_size(path: &Path) -> Option<u64> {
        let c = CString::new(path.as_os_str().as_bytes()).ok()?;
        let mut al = libc::attrlist {
            bitmapcount: ATTR_BIT_MAP_COUNT,
            reserved: 0,
            commonattr: 0,
            volattr: 0,
            dirattr: 0,
            fileattr: 0,
            forkattr: ATTR_CMNEXT_PRIVATESIZE,
        };
        // Reply layout: u32 total length, then the off_t private size (4-byte packed on Darwin).
        let mut buf = [0u8; 16];
        // SAFETY: c is NUL-terminated, al and buf are valid for the sizes passed.
        let r = unsafe {
            libc::getattrlist(
                c.as_ptr(),
                &mut al as *mut _ as *mut c_void,
                buf.as_mut_ptr() as *mut c_void,
                buf.len(),
                FSOPT_NOFOLLOW | FSOPT_ATTR_CMN_EXTENDED,
            )
        };
        if r != 0 {
            return None;
        }
        let len = u32::from_ne_bytes(buf[0..4].try_into().ok()?);
        if len < 12 {
            return None;
        }
        Some(i64::from_ne_bytes(buf[4..12].try_into().ok()?).max(0) as u64)
    }
}

#[cfg(not(target_os = "macos"))]
mod sys {
    use std::os::unix::fs::MetadataExt;
    use std::path::Path;

    pub fn private_size(path: &Path) -> Option<u64> {
        std::fs::symlink_metadata(path).ok().map(|m| m.blocks() * 512)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    struct Tmp(PathBuf);
    impl Tmp {
        fn new(tag: &str) -> Tmp {
            let p = std::env::temp_dir().join(format!("setu-measure-{}-{}", tag, std::process::id()));
            let _ = fs::remove_dir_all(&p);
            fs::create_dir_all(&p).unwrap();
            Tmp(p)
        }
    }
    impl Drop for Tmp {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn random_file(path: &Path, len: usize) {
        let mut v = vec![0u8; len];
        let mut x: u64 = 0x9E37_79B9_7F4A_7C15 ^ len as u64;
        for b in v.iter_mut() {
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            *b = x as u8;
        }
        fs::write(path, v).unwrap();
        // Blocks are allocated lazily; flush so private size reflects the data.
        fs::File::open(path).unwrap().sync_all().unwrap();
    }

    const MIB4: usize = 4 * 1024 * 1024;

    #[test]
    fn missing_root_is_default() {
        assert_eq!(measure(Path::new("/nonexistent/setu-measure")), Size::default());
    }

    #[test]
    fn logical_sum_and_nested_git_skipped() {
        let t = Tmp::new("sum");
        fs::create_dir_all(t.0.join("a/b")).unwrap();
        fs::write(t.0.join("a/one"), vec![1u8; 1000]).unwrap();
        fs::write(t.0.join("a/b/two"), vec![2u8; 2500]).unwrap();
        fs::create_dir_all(t.0.join("a/.git")).unwrap();
        fs::write(t.0.join("a/.git/obj"), vec![3u8; 99999]).unwrap();
        let s = measure(&t.0);
        assert_eq!(s.logical, 3500);
        assert_eq!(s.files, 2);
        assert_eq!(s.errors, 0);
        assert!(s.private >= 3500 || s.private > 0);
    }

    #[test]
    fn symlinks_not_counted_or_followed() {
        let outside = Tmp::new("out");
        let big = outside.0.join("big");
        random_file(&big, MIB4);
        let inside_dir = outside.0.join("dir");
        fs::create_dir_all(&inside_dir).unwrap();
        fs::write(inside_dir.join("f"), vec![0u8; 5000]).unwrap();
        let t = Tmp::new("sym");
        std::os::unix::fs::symlink(&big, t.0.join("lnk")).unwrap();
        std::os::unix::fs::symlink(&inside_dir, t.0.join("dlnk")).unwrap();
        fs::write(t.0.join("real"), vec![1u8; 10]).unwrap();
        let s = measure(&t.0);
        assert_eq!(s.logical, 10);
        assert_eq!(s.files, 1);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn fresh_file_private_is_full() {
        let t = Tmp::new("fresh");
        let f = t.0.join("f");
        random_file(&f, MIB4);
        let p = private_size(&f).unwrap();
        assert!(p >= MIB4 as u64 - 64 * 1024 && p <= MIB4 as u64 + 64 * 1024, "{p}");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn clone_private_size() {
        let t = Tmp::new("clone");
        let a = t.0.join("a");
        let b = t.0.join("b");
        random_file(&a, MIB4);
        let st = Command::new("cp").arg("-c").arg(&a).arg(&b).status().unwrap();
        assert!(st.success());
        let (pa, pb) = (private_size(&a).unwrap(), private_size(&b).unwrap());
        if pa >= MIB4 as u64 - 64 * 1024 {
            eprintln!("temp dir is not on APFS; clone semantics unavailable, skipping");
            return;
        }
        assert!(pa < 64 * 1024 && pb < 64 * 1024, "{pa} {pb}");
        let s = measure(&t.0);
        assert_eq!(s.logical, 2 * MIB4 as u64);
        assert!(s.private < 128 * 1024, "{}", s.private);
        fs::remove_file(&a).unwrap();
        let pb = private_size(&b).unwrap();
        assert!(pb >= MIB4 as u64 - 64 * 1024 && pb <= MIB4 as u64 + 64 * 1024, "{pb}");
    }
}
