//! setu-rs: runs every worktree's app and workers side by side, each at its own URL.
//! Slice 1 plan: docs/slices/01-run-and-route.md

mod activity;
mod autoremove;
mod api;
mod claims;
mod cli;
mod config;
mod daemon;
mod disk;
mod disk_measure;
mod dns;
mod doctor;
mod env;
mod globalcfg;
mod model;
mod mcp;
mod naming;
mod paths;
mod ports;
mod presets;
mod procinfo;
mod proxy;
mod setup;
mod state;
mod supervisor;
mod worktree;

fn main() {
    std::process::exit(cli::main());
}
