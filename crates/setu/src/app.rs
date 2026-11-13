//! `setu app [install|path|uninstall]`: put the Setu.app that ships next to the binary into
//! `~/Applications`. Release archives carry `Setu.app` beside `setu`; Homebrew leaves it in
//! `<prefix>/share/setu/Setu.app`. Setu never opens or quits the app: an install over a running
//! copy is refused, and the user quits it first.

use anyhow::{anyhow, bail, Context, Result};
use std::path::{Path, PathBuf};
use std::process::Command;

const APP: &str = "Setu.app";

/// Everything the commands depend on, so tests can sandbox it.
pub struct Ctx<'a> {
    /// The user's home; `~/Applications` is under it.
    pub home: PathBuf,
    /// The app that came with this build, if there is one.
    pub bundled: Option<PathBuf>,
    /// Is a process running from this app bundle?
    pub running: &'a dyn Fn(&Path) -> bool,
}

impl Ctx<'_> {
    pub fn applications(&self) -> PathBuf {
        self.home.join("Applications")
    }
    pub fn installed(&self) -> PathBuf {
        self.applications().join(APP)
    }
}

/// `<dir of the real binary>/../share/setu/Setu.app`, else `$SETU_APP_SOURCE`.
pub fn find_bundled() -> Option<PathBuf> {
    let beside = std::env::current_exe().ok().and_then(|e| e.canonicalize().ok()).and_then(|e| e.parent().map(|d| d.join("../share/setu").join(APP)));
    beside.filter(|p| p.is_dir()).or_else(|| std::env::var_os("SETU_APP_SOURCE").map(PathBuf::from).filter(|p| p.is_dir()))
}

/// `CFBundleShortVersionString` from the bundle's Info.plist (the XML form `bundle-swift.sh` writes).
pub fn version(app: &Path) -> Option<String> {
    let text = std::fs::read_to_string(app.join("Contents/Info.plist")).ok()?;
    let after = &text[text.find("<key>CFBundleShortVersionString</key>")? + "<key>CFBundleShortVersionString</key>".len()..];
    let start = after.find("<string>")? + "<string>".len();
    let end = after[start..].find("</string>")?;
    Some(after[start..start + end].trim().to_string())
}

/// Is any process running an executable from inside `app`? One `ps` scan, matched by bundle path.
pub fn is_running(app: &Path) -> bool {
    // `ps` shows the path the process was started with, which may or may not go through a symlink
    // (/tmp -> /private/tmp, a linked home): match both spellings.
    let prefixes = [format!("{}/", app.display()), format!("{}/", app.canonicalize().unwrap_or_else(|_| app.to_path_buf()).display())];
    let Ok(out) = Command::new("ps").args(["-axo", "comm="]).output() else { return false };
    String::from_utf8_lossy(&out.stdout).lines().any(|l| prefixes.iter().any(|p| l.trim_start().starts_with(p.as_str())))
}

fn missing_bundle() -> anyhow::Error {
    anyhow!("no Setu.app comes with this build (looked at ../share/setu/Setu.app next to the binary, and $SETU_APP_SOURCE). Install setu from Homebrew or a release archive, or build the app with scripts/bundle-swift.sh")
}

fn quit_first(installed: &Path) -> anyhow::Error {
    anyhow!("{} is running; quit Setu.app, then run this again (setu never closes it for you)", installed.display())
}

pub fn install(ctx: &Ctx) -> Result<String> {
    let src = ctx.bundled.as_ref().ok_or_else(missing_bundle)?;
    let dest = ctx.installed();
    if dest.exists() && (ctx.running)(&dest) {
        return Err(quit_first(&dest));
    }
    let dir = ctx.applications();
    std::fs::create_dir_all(&dir).with_context(|| format!("creating {}", dir.display()))?;
    let pid = std::process::id();
    let tmp = dir.join(format!(".{APP}.new-{pid}"));
    let old = dir.join(format!(".{APP}.old-{pid}"));
    let _ = std::fs::remove_dir_all(&tmp);
    let _ = std::fs::remove_dir_all(&old);
    // ditto keeps symlinks, permissions and the code signature of a bundle intact.
    let st = Command::new("ditto").arg(src).arg(&tmp).status().context("running ditto")?;
    if !st.success() {
        let _ = std::fs::remove_dir_all(&tmp);
        bail!("could not copy {} to {}", src.display(), tmp.display());
    }
    // A quarantine flag makes Gatekeeper refuse the copy; absent is the normal case, so the result is ignored.
    let _ = Command::new("xattr").args(["-dr", "com.apple.quarantine"]).arg(&tmp).output();
    let had_old = dest.exists();
    if had_old {
        std::fs::rename(&dest, &old).with_context(|| format!("moving the old {} aside", dest.display()))?;
    }
    if let Err(e) = std::fs::rename(&tmp, &dest) {
        if had_old {
            let _ = std::fs::rename(&old, &dest);
        }
        let _ = std::fs::remove_dir_all(&tmp);
        return Err(e).with_context(|| format!("putting {} in place", dest.display()));
    }
    let _ = std::fs::remove_dir_all(&old);
    let v = version(&dest).unwrap_or_else(|| "?".into());
    Ok(format!("installed Setu.app {v} to ~/Applications; open it from Spotlight or `open -a Setu`"))
}

pub fn path(ctx: &Ctx) -> String {
    let line = |label: &str, p: Option<&Path>| match p {
        Some(p) => format!("{label} {}  ({})", p.display(), version(p).map(|v| format!("version {v}")).unwrap_or_else(|| "version unknown".into())),
        None => format!("{label} none"),
    };
    let installed = ctx.installed();
    format!("{}\n{}", line("bundled:  ", ctx.bundled.as_deref()), line("installed:", Some(installed.as_path()).filter(|p| p.exists())))
}

pub fn uninstall(ctx: &Ctx) -> Result<String> {
    let dest = ctx.installed();
    if !dest.exists() {
        return Ok(format!("{} is not installed; nothing to do", dest.display()));
    }
    if (ctx.running)(&dest) {
        return Err(quit_first(&dest));
    }
    std::fs::remove_dir_all(&dest).with_context(|| format!("removing {}", dest.display()))?;
    Ok(format!("removed {}", dest.display()))
}

/// What `setu doctor` says about the app: `None` when this build has no bundled app.
pub fn doctor_status(bundled: Option<&Path>, home: &Path, running: &dyn Fn(&Path) -> bool) -> Option<(String, String)> {
    let b = bundled?;
    let bv = version(b).unwrap_or_else(|| "unknown".into());
    let installed = home.join("Applications").join(APP);
    Some(match (installed.exists(), version(&installed)) {
        (false, _) => ("not installed".into(), format!("bundled {bv}; run `setu app` to install it")),
        (true, Some(iv)) if iv == bv => ("up to date".into(), format!("installed {iv}, bundled {bv}")),
        (true, iv) if running(&installed) && is_newer(&bv, iv.as_deref()) => ("update pending".into(), "quit Setu to finish".into()),
        (true, iv) => ("update available".into(), format!("installed {}, bundled {bv}; run `setu app` to update", iv.unwrap_or_else(|| "unknown".into()))),
    })
}

/// Numeric dotted compare of version strings ("0.1.10" > "0.1.9"; a "-beta" tail is ignored).
fn parse_version(v: &str) -> Option<Vec<u64>> {
    let parts: Option<Vec<u64>> = v.trim().split('.').map(|p| p.split(|c: char| !c.is_ascii_digit()).next().and_then(|d| d.parse().ok())).collect();
    parts.filter(|p| !p.is_empty())
}

/// Is `bundled` newer than `installed`? An installed copy with no readable version counts as older;
/// a bundled version that cannot be read is never newer.
pub fn is_newer(bundled: &str, installed: Option<&str>) -> bool {
    let Some(b) = parse_version(bundled) else { return false };
    let Some(i) = installed.and_then(parse_version) else { return true };
    let n = b.len().max(i.len());
    let pad = |v: &Vec<u64>| (0..n).map(|k| v.get(k).copied().unwrap_or(0)).collect::<Vec<_>>();
    pad(&b) > pad(&i)
}

#[derive(Debug, PartialEq)]
pub enum AutoUpdate {
    /// No installed app, no bundled app, or the installed one is current.
    Nothing,
    Updated(String),
    /// The installed app is older but running; try again later.
    Pending,
    Failed(String),
}

/// Daemon-side upgrade of an already installed Setu.app: only when the bundled version is newer, and
/// never while the app runs (setu never quits or opens it).
pub fn auto_update(ctx: &Ctx) -> AutoUpdate {
    let (Some(bundled), dest) = (ctx.bundled.as_ref(), ctx.installed()) else { return AutoUpdate::Nothing };
    if !dest.exists() {
        return AutoUpdate::Nothing;
    }
    let Some(bv) = version(bundled) else { return AutoUpdate::Nothing };
    if !is_newer(&bv, version(&dest).as_deref()) {
        return AutoUpdate::Nothing;
    }
    if (ctx.running)(&dest) {
        return AutoUpdate::Pending;
    }
    match install(ctx) {
        Ok(_) => AutoUpdate::Updated(bv),
        Err(e) => AutoUpdate::Failed(format!("{e:#}")),
    }
}

/// `setu app [install|path|uninstall]`
pub fn main(args: &[String]) -> Result<()> {
    let home = std::env::var_os("HOME").map(PathBuf::from).ok_or_else(|| anyhow!("HOME is not set"))?;
    let ctx = Ctx { home, bundled: find_bundled(), running: &is_running };
    match args.first().map(String::as_str) {
        None | Some("install") => println!("{}", install(&ctx)?),
        Some("path") => println!("{}", path(&ctx)),
        Some("uninstall") => println!("{}", uninstall(&ctx)?),
        Some(other) => bail!("unknown argument {other:?}; usage: setu app [install|path|uninstall]"),
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("setu-app-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn fake_app(dir: &Path, version: &str, marker: &str) -> PathBuf {
        let app = dir.join(APP);
        std::fs::create_dir_all(app.join("Contents/MacOS")).unwrap();
        std::fs::write(app.join("Contents/Info.plist"), format!("<?xml version=\"1.0\"?>\n<plist><dict>\n  <key>CFBundleShortVersionString</key><string>{version}</string>\n</dict></plist>\n")).unwrap();
        std::fs::write(app.join("Contents/MacOS/Setu"), marker).unwrap();
        app
    }

    #[test]
    fn reads_the_version_from_the_plist() {
        let d = tmp("ver");
        let app = fake_app(&d, "1.2.3", "x");
        assert_eq!(version(&app).as_deref(), Some("1.2.3"));
        assert_eq!(version(&d.join("nope.app")), None);
        std::fs::write(app.join("Contents/Info.plist"), "<key>CFBundleShortVersionString</key>\n  <string> 9.9 </string>").unwrap();
        assert_eq!(version(&app).as_deref(), Some("9.9"));
    }

    #[test]
    fn install_copies_the_app_and_updates_over_an_old_one() {
        let d = tmp("install");
        let src = fake_app(&d.join("pkg"), "0.2.0", "new");
        let home = d.join("home");
        let never = |_: &Path| false;
        let ctx = Ctx { home: home.clone(), bundled: Some(src), running: &never };
        let msg = install(&ctx).unwrap();
        assert_eq!(msg, "installed Setu.app 0.2.0 to ~/Applications; open it from Spotlight or `open -a Setu`");
        let dest = home.join("Applications").join(APP);
        assert_eq!(std::fs::read_to_string(dest.join("Contents/MacOS/Setu")).unwrap(), "new");
        // an older install is replaced, and nothing is left beside it
        fake_app(&home.join("Applications"), "0.1.0", "old");
        std::fs::write(dest.join("stale-file"), "x").unwrap();
        assert!(install(&ctx).unwrap().contains("0.2.0"));
        assert_eq!(std::fs::read_to_string(dest.join("Contents/MacOS/Setu")).unwrap(), "new");
        assert!(!dest.join("stale-file").exists());
        let left: Vec<String> = std::fs::read_dir(home.join("Applications")).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
        assert_eq!(left, [APP]);
    }

    #[test]
    fn install_and_uninstall_refuse_while_the_app_runs_and_touch_nothing() {
        let d = tmp("running");
        let src = fake_app(&d.join("pkg"), "0.2.0", "new");
        let home = d.join("home");
        let dest = fake_app(&home.join("Applications"), "0.1.0", "old");
        let asked = Cell::new(None);
        let yes = |p: &Path| {
            asked.set(Some(p.to_path_buf()));
            true
        };
        let ctx = Ctx { home: home.clone(), bundled: Some(src), running: &yes };
        let e = install(&ctx).unwrap_err().to_string();
        assert!(e.contains("is running") && e.contains("quit Setu.app"), "{e}");
        assert_eq!(asked.take().as_deref(), Some(dest.as_path()), "the running check is by the installed bundle's path");
        assert_eq!(std::fs::read_to_string(dest.join("Contents/MacOS/Setu")).unwrap(), "old");
        assert!(uninstall(&ctx).unwrap_err().to_string().contains("is running"));
        assert!(dest.exists());
    }

    #[test]
    fn uninstall_removes_the_installed_app() {
        let d = tmp("uninstall");
        let home = d.join("home");
        let dest = fake_app(&home.join("Applications"), "0.1.0", "old");
        let no = |_: &Path| false;
        let ctx = Ctx { home, bundled: None, running: &no };
        assert!(uninstall(&ctx).unwrap().starts_with("removed "));
        assert!(!dest.exists());
        assert!(uninstall(&ctx).unwrap().contains("not installed"));
    }

    #[test]
    fn a_build_without_the_app_says_how_to_get_one() {
        let d = tmp("missing");
        let no = |_: &Path| false;
        let ctx = Ctx { home: d.join("home"), bundled: None, running: &no };
        let e = install(&ctx).unwrap_err().to_string();
        assert!(e.contains("scripts/bundle-swift.sh") && e.contains("SETU_APP_SOURCE"), "{e}");
        assert!(!d.join("home/Applications").exists(), "nothing is created");
    }

    #[test]
    fn path_and_doctor_report_both_versions() {
        let d = tmp("path");
        let src = fake_app(&d.join("pkg"), "0.2.0", "new");
        let home = d.join("home");
        let no = |_: &Path| false;
        let ctx = Ctx { home: home.clone(), bundled: Some(src.clone()), running: &no };
        let p = path(&ctx);
        assert!(p.contains("version 0.2.0") && p.contains("installed: none"), "{p}");
        assert_eq!(doctor_status(Some(&src), &home, &no).unwrap().0, "not installed");
        assert_eq!(doctor_status(None, &home, &no), None);
        fake_app(&home.join("Applications"), "0.1.0", "old");
        let (state, detail) = doctor_status(Some(&src), &home, &no).unwrap();
        assert_eq!(state, "update available");
        assert!(detail.contains("installed 0.1.0, bundled 0.2.0") && detail.contains("run `setu app`"), "{detail}");
        install(&ctx).unwrap();
        assert_eq!(doctor_status(Some(&src), &home, &no).unwrap().0, "up to date");
        assert!(path(&ctx).contains("installed:") && !path(&ctx).contains("installed: none"));
    }

    #[test]
    fn versions_compare_numerically() {
        assert!(is_newer("0.1.10", Some("0.1.9")));
        assert!(is_newer("1.0", Some("0.9.9")));
        assert!(!is_newer("0.1.3", Some("0.1.3")));
        assert!(!is_newer("0.1.2", Some("0.1.3")));
        assert!(is_newer("0.2.0", None), "an installed app with no readable version is older");
        assert!(!is_newer("junk", Some("0.1.0")), "an unreadable bundled version is never newer");
        assert!(is_newer("0.2.0-beta", Some("0.1.9")));
    }

    #[test]
    fn auto_update_replaces_an_older_install_only_when_the_app_is_not_running() {
        let d = tmp("autoupd");
        let src = fake_app(&d.join("pkg"), "0.2.0", "new");
        let home = d.join("home");
        let dest = fake_app(&home.join("Applications"), "0.1.0", "old");
        let marker = |dest: &Path| std::fs::read_to_string(dest.join("Contents/MacOS/Setu")).unwrap();

        // running: nothing is touched, and it is reported pending (also by doctor)
        let running = Cell::new(true);
        let probe = |_: &Path| running.get();
        let ctx = Ctx { home: home.clone(), bundled: Some(src.clone()), running: &probe };
        assert_eq!(auto_update(&ctx), AutoUpdate::Pending);
        assert_eq!(marker(&dest), "old");
        let (state, detail) = doctor_status(Some(&src), &home, &probe).unwrap();
        assert_eq!((state.as_str(), detail.as_str()), ("update pending", "quit Setu to finish"));

        // the app quit: the next try updates it, and then there is nothing left to do
        running.set(false);
        assert_eq!(auto_update(&ctx), AutoUpdate::Updated("0.2.0".into()));
        assert_eq!(marker(&dest), "new");
        assert_eq!(auto_update(&ctx), AutoUpdate::Nothing);
    }

    #[test]
    fn auto_update_never_installs_a_missing_app_or_downgrades() {
        let d = tmp("autonone");
        let src = fake_app(&d.join("pkg"), "0.2.0", "new");
        let home = d.join("home");
        let no = |_: &Path| false;
        let ctx = Ctx { home: home.clone(), bundled: Some(src), running: &no };
        assert_eq!(auto_update(&ctx), AutoUpdate::Nothing, "not installed: the daemon never installs the app");
        assert!(!home.join("Applications").exists());
        let newer = fake_app(&home.join("Applications"), "0.3.0", "keep");
        assert_eq!(auto_update(&ctx), AutoUpdate::Nothing, "an installed newer app is left alone");
        assert_eq!(std::fs::read_to_string(newer.join("Contents/MacOS/Setu")).unwrap(), "keep");
        let none = Ctx { home, bundled: None, running: &no };
        assert_eq!(auto_update(&none), AutoUpdate::Nothing);
    }
}
