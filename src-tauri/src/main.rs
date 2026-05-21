// Prevents an extra console window on Windows in release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    let mcp_mode = std::env::args().any(|a| a == "--mcp");
    if mcp_mode {
        database_app_lib::run_mcp();
    } else {
        database_app_lib::run();
    }
}
