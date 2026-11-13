//! setu: runs every worktree's app and workers side by side, each at its own URL.
//! Slice 1 plan: docs/slices/01-run-and-route.md

mod activity;
mod app;
mod autoremove;
mod api;
mod claims;
mod cli;
mod config;
mod cutover;
mod daemon;
mod deps;
mod db;
mod dbimport;
mod disk;
mod disk_measure;
mod dns;
mod doctor;
mod env;
mod globalcfg;
mod model;
mod mcp;
mod mcpcfg;
mod migrate;
mod naming;
mod paths;
mod ports;
mod presets;
mod procinfo;
mod proxy;
mod recipes;
mod setup;
mod state;
mod supervisor;
mod upstream;
mod worktree;

fn main() {
    // CLI output piped into `head` or `grep -q` should end quietly, like any Unix tool, not panic
    // on a broken pipe. The daemon keeps Rust's default (SIGPIPE ignored, EPIPE as an error), so
    // a client that hangs up never kills it.
    if std::env::args().nth(1).as_deref() != Some("daemon") {
        unsafe {
            libc::signal(libc::SIGPIPE, libc::SIG_DFL);
        }
    }
    std::process::exit(cli::main());
}
