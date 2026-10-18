use std::{
    io::{Read, Write},
    path::PathBuf,
    process::ExitCode,
};

fn data_dir() -> Option<PathBuf> {
    let mut args = std::env::args_os().skip(1);
    match (args.next(), args.next(), args.next()) {
        (Some(flag), Some(dir), None) if flag == "--data-dir" => Some(PathBuf::from(dir)),
        _ => None,
    }
}

fn main() -> ExitCode {
    let Some(dir) = data_dir() else {
        eprintln!("usage: setu-links --data-dir <dir>   (one JSON request on stdin)");
        return ExitCode::from(2);
    };
    let mut input = Vec::new();
    let limit = setu_links::protocol::MAX_REQUEST_BYTES as u64 + 1;
    if std::io::stdin().take(limit).read_to_end(&mut input).is_err() {
        return ExitCode::from(2);
    }
    let reply = match String::from_utf8(input) {
        Ok(text) => setu_links::protocol::handle(&dir, &text),
        Err(_) => setu_links::protocol::handle(&dir, "\u{0}"),
    };
    if writeln!(std::io::stdout(), "{reply}").is_err() {
        return ExitCode::from(1);
    }
    ExitCode::SUCCESS
}
