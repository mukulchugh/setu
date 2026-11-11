//! setu-rs: runs every worktree's app and workers side by side, each at its own URL.
//! Slice 1 plan: docs/slices/01-run-and-route.md

mod activity;
mod api;
mod cli;
mod config;
mod daemon;
mod model;
mod naming;
mod paths;
mod ports;
mod procinfo;
mod proxy;
mod state;
mod supervisor;

fn main() {
    std::process::exit(cli::main());
}
