use std::{
    io::{Read, Write},
    path::PathBuf,
    process::ExitCode,
};

const USAGE: &str = "usage: setu-links --data-dir <dir>   (one JSON request on stdin)\n       setu-links serve --data-dir <dir> [--listen <address>]";

enum Mode {
    Operation(PathBuf),
    Serve(setu_links::daemon::Options),
}

fn parse() -> Option<Mode> {
    let mut args = std::env::args_os().skip(1).peekable();
    let serve = args.peek().is_some_and(|first| first == "serve");
    if serve {
        args.next();
    }
    let (mut dir, mut listen) = (None, None);
    while let Some(flag) = args.next() {
        let value = args.next()?;
        match flag.to_str()? {
            "--data-dir" if dir.is_none() => dir = Some(PathBuf::from(value)),
            "--listen" if serve && listen.is_none() => listen = Some(value.into_string().ok()?),
            _ => return None,
        }
    }
    let dir = dir?;
    Some(if serve { Mode::Serve(setu_links::daemon::Options { dir, listen }) } else { Mode::Operation(dir) })
}

fn main() -> ExitCode {
    let Some(mode) = parse() else {
        eprintln!("{USAGE}");
        return ExitCode::from(2);
    };
    let reply = match mode {
        Mode::Serve(options) => setu_links::protocol::serve_reply(options),
        Mode::Operation(dir) => {
            let mut input = Vec::new();
            let limit = setu_links::protocol::MAX_REQUEST_BYTES as u64 + 1;
            if std::io::stdin().take(limit).read_to_end(&mut input).is_err() {
                return ExitCode::from(2);
            }
            match String::from_utf8(input) {
                Ok(text) => setu_links::protocol::handle(&dir, &text),
                Err(_) => setu_links::protocol::handle(&dir, "\u{0}"),
            }
        }
    };
    if writeln!(std::io::stdout(), "{reply}").is_err() {
        return ExitCode::from(1);
    }
    ExitCode::SUCCESS
}
