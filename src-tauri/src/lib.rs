mod activity;
mod connections;
mod core;
mod mcp;
mod pool;
mod types;

use std::time::Duration;

use activity::{mcp_emitter, spawn_socket_listener, tauri_emitter};
use core::Core;
use pool::PoolRegistry;
use rmcp::{transport::stdio, ServiceExt};
use tauri::{
    menu::{AboutMetadata, CheckMenuItem, Menu, PredefinedMenuItem, Submenu},
    Emitter, Manager, Runtime, State,
};
use types::*;

// ── Tauri commands (UI side) ──────────────────────────────────────

#[tauri::command]
async fn list_connections(state: State<'_, Core>) -> Result<Vec<Connection>, String> {
    core::list_connections(&state).await.map_err(format_err)
}

#[tauri::command]
async fn add_connection(state: State<'_, Core>, input: NewConnectionInput) -> Result<Connection, String> {
    core::add_connection(&state, input).await.map_err(format_err)
}

#[tauri::command]
async fn delete_connection(state: State<'_, Core>, name: String) -> Result<(), String> {
    core::delete_connection(&state, &name).await.map_err(format_err)
}

#[tauri::command]
async fn connect(
    state: State<'_, Core>,
    name: String,
) -> Result<Option<ClassifyOutcome>, String> {
    core::connect(&state, &name).await.map_err(format_err)
}

#[tauri::command]
async fn disconnect(state: State<'_, Core>, name: String) -> Result<(), String> {
    core::disconnect(&state, &name).await.map_err(format_err)
}

#[tauri::command]
async fn list_schemas(state: State<'_, Core>, connection: String) -> Result<Vec<String>, String> {
    core::list_schemas(&state, &connection).await.map_err(format_err)
}

#[tauri::command]
async fn list_tables(
    state: State<'_, Core>,
    connection: String,
    schema: String,
) -> Result<Vec<TableSummary>, String> {
    core::list_tables(&state, &connection, &schema)
        .await
        .map_err(format_err)
}

#[tauri::command]
async fn search_columns(
    state: State<'_, Core>,
    connection: String,
    query: String,
    limit: Option<i64>,
) -> Result<Vec<ColumnSearchHit>, String> {
    core::search_columns(&state, &connection, &query, limit.unwrap_or(50))
        .await
        .map_err(format_err)
}

#[tauri::command]
async fn describe_table(
    state: State<'_, Core>,
    connection: String,
    schema: String,
    table: String,
) -> Result<Vec<ColumnDescription>, String> {
    core::describe_table(&state, &connection, &schema, &table)
        .await
        .map_err(format_err)
}

#[tauri::command]
async fn run_query(
    state: State<'_, Core>,
    connection: String,
    sql: String,
    reveal: Option<bool>,
) -> Result<QueryResult, String> {
    // `reveal` is UI-only. Default false (mask). The MCP handler hardcodes
    // false at the call site (see mcp.rs).
    core::run_query(&state, &connection, &sql, reveal.unwrap_or(false))
        .await
        .map_err(format_err)
}

#[tauri::command]
async fn apply_mutations(
    state: State<'_, Core>,
    connection: String,
    batch: MutationBatch,
) -> Result<MutationOutcome, String> {
    core::apply_mutations(&state, &connection, batch)
        .await
        .map_err(format_err)
}

#[tauri::command]
async fn export_query(
    state: State<'_, Core>,
    connection: String,
    sql: String,
    path: String,
    format: String,
    reveal: Option<bool>,
) -> Result<ExportResult, String> {
    core::export_query(
        &state,
        &connection,
        &sql,
        &path,
        &format,
        reveal.unwrap_or(false),
    )
    .await
    .map_err(format_err)
}

#[tauri::command]
fn write_file(path: String, content: String) -> Result<u64, String> {
    core::write_file(&path, content.as_bytes()).map_err(format_err)
}

#[tauri::command]
async fn classify_schema(
    state: State<'_, Core>,
    connection: String,
) -> Result<ClassifyOutcome, String> {
    core::classify_schema(&state, &connection)
        .await
        .map_err(format_err)
}

#[tauri::command]
async fn list_classifications(
    state: State<'_, Core>,
    connection: String,
) -> Result<Vec<Classification>, String> {
    core::list_classifications(&state, &connection)
        .await
        .map_err(format_err)
}

#[tauri::command]
async fn update_classification(
    state: State<'_, Core>,
    connection: String,
    schema: String,
    table: String,
    column: String,
    action: ClassificationAction,
) -> Result<(), String> {
    core::update_classification(&state, &connection, &schema, &table, &column, action)
        .await
        .map_err(format_err)
}

/// Debug-only IPC: emit `reveal-sensitive` with the given boolean. Lets the
/// dev test harness drive the toggle without touching the native menu. Also
/// updates the menu item's checkmark so it stays in sync.
#[cfg(debug_assertions)]
#[tauri::command]
fn dev_toggle_reveal<R: Runtime>(app: tauri::AppHandle<R>, on: bool) -> Result<(), String> {
    if let Some(check) = find_check_item(&app, REVEAL_MENU_ID) {
        check.set_checked(on).map_err(|e| e.to_string())?;
    }
    app.emit(REVEAL_EVENT_NAME, on).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
async fn list_snippets(state: State<'_, Core>) -> Result<Vec<Snippet>, String> {
    core::list_snippets(&state).await.map_err(format_err)
}

#[tauri::command]
async fn upsert_snippet(
    state: State<'_, Core>,
    input: SnippetInput,
) -> Result<Snippet, String> {
    core::upsert_snippet(&state, input).await.map_err(format_err)
}

#[tauri::command]
async fn delete_snippet(state: State<'_, Core>, id: String) -> Result<(), String> {
    core::delete_snippet(&state, &id).await.map_err(format_err)
}

#[tauri::command]
fn mcp_snippet() -> Result<McpSnippet, String> {
    let path = std::env::current_exe()
        .map_err(|e| e.to_string())?
        .display()
        .to_string();

    // Same JSON shape works for both Claude Desktop's config file and
    // Claude Code's .mcp.json / ~/.claude.json under `mcpServers`.
    let json = serde_json::json!({
        "mcpServers": {
            "database-app": {
                "command": &path,
                "args": ["--mcp"]
            }
        }
    });
    let json_snippet = serde_json::to_string_pretty(&json).map_err(|e| e.to_string())?;

    // Shell-quote the binary path in case it contains spaces (it does:
    // "/.../Claude/Projects/Database App/...").
    let quoted_path = shell_quote(&path);
    let cli_snippet = format!(
        "claude mcp add database-app -s user -- {quoted_path} --mcp"
    );

    let targets = vec![
        McpTarget {
            key: "claude-code".into(),
            label: "Claude Code".into(),
            language: "shell".into(),
            instructions:
                "Run this in a terminal to register the workbench at the user scope (available across all projects). Then restart any open Claude Code sessions."
                    .into(),
            snippet: cli_snippet,
        },
        McpTarget {
            key: "claude-desktop".into(),
            label: "Claude Desktop".into(),
            language: "json".into(),
            instructions:
                "Paste into ~/Library/Application Support/Claude/claude_desktop_config.json under \"mcpServers\", then restart Claude Desktop."
                    .into(),
            snippet: json_snippet,
        },
    ];

    Ok(McpSnippet { binary_path: path, targets })
}

/// Quote a path for safe use in a POSIX shell command line.
/// Wraps in single quotes and escapes any embedded single quotes.
fn shell_quote(s: &str) -> String {
    if !s.contains(|c: char| c.is_whitespace() || "\"'$`\\!*?[](){}<>|&;#~".contains(c)) {
        return s.to_string();
    }
    let escaped = s.replace('\'', "'\\''");
    format!("'{escaped}'")
}

fn format_err(e: anyhow::Error) -> String {
    format!("{:#}", e)
}

/// Menu item id for the View > Reveal sensitive data toggle. Shared between
/// the builder and the on_menu_event handler.
const REVEAL_MENU_ID: &str = "view.reveal_sensitive";

/// Tauri event name fired when the toggle state changes. Payload is the new
/// `bool` value (true = revealing). The frontend listens to this to update
/// global state and pass `reveal` into subsequent `run_query` calls.
const REVEAL_EVENT_NAME: &str = "reveal-sensitive";

/// Recursively search the app's menu tree for a CheckMenuItem with `id`.
/// `Menu::get` only checks the top level; submenus need a manual walk.
fn find_check_item<R: Runtime>(
    app: &tauri::AppHandle<R>,
    id: &str,
) -> Option<tauri::menu::CheckMenuItem<R>> {
    use tauri::menu::MenuItemKind;
    fn walk<R: Runtime>(
        kinds: Vec<MenuItemKind<R>>,
        id: &str,
    ) -> Option<tauri::menu::CheckMenuItem<R>> {
        for k in kinds {
            if k.id().as_ref() == id {
                if let Some(c) = k.as_check_menuitem() {
                    return Some(c.clone());
                }
            }
            if let MenuItemKind::Submenu(sub) = &k {
                if let Ok(children) = sub.items() {
                    if let Some(found) = walk(children, id) {
                        return Some(found);
                    }
                }
            }
        }
        None
    }
    let menu = app.menu()?;
    let items = menu.items().ok()?;
    walk(items, id)
}

/// Mirrors `tauri::menu::Menu::default()` but omits the Edit menu's
/// Undo/Redo items. Why: CodeMirror's paste handler calls preventDefault,
/// so WebKit's native undo manager has no record of the change. The macOS
/// Edit > Undo item then becomes disabled — and crucially, ⌘Z stops
/// dispatching ANY event to JS (not even a keydown for "z"). Removing the
/// menu binding lets ⌘Z reach the editor as a normal keydown, where
/// CodeMirror's historyKeymap handles it.
fn build_app_menu<R: Runtime>(app: &tauri::AppHandle<R>) -> tauri::Result<Menu<R>> {
    let pkg = app.package_info();
    let config = app.config();
    let about = AboutMetadata {
        name: Some(pkg.name.clone()),
        version: Some(pkg.version.to_string()),
        copyright: config.bundle.copyright.clone(),
        authors: config.bundle.publisher.clone().map(|p| vec![p]),
        ..Default::default()
    };

    let app_menu = Submenu::with_items(
        app,
        pkg.name.clone(),
        true,
        &[
            &PredefinedMenuItem::about(app, None, Some(about))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::services(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::quit(app, None)?,
        ],
    )?;

    let file_menu = Submenu::with_items(
        app,
        "File",
        true,
        &[&PredefinedMenuItem::close_window(app, None)?],
    )?;

    let edit_menu = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;

    // CheckMenuItem for redaction reveal toggle. Default OFF (mask) every
    // launch — see design/redaction.md §"The mask toggle". The accelerator
    // is ⌘⌥R (Cmd+Alt+R) — ⌘⇧R from the spec collides with WebKit's
    // hard-reload binding in dev mode and would reload the page instead of
    // toggling. Frontend listens for the `reveal-sensitive` event the menu
    // handler emits.
    let reveal_item = CheckMenuItem::with_id(
        app,
        REVEAL_MENU_ID,
        "Reveal sensitive data",
        true,
        false,
        Some("CmdOrCtrl+Alt+R"),
    )?;

    let view_menu = Submenu::with_items(
        app,
        "View",
        true,
        &[
            &PredefinedMenuItem::fullscreen(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &reveal_item,
        ],
    )?;

    let window_menu = Submenu::with_items(
        app,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::maximize(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::close_window(app, None)?,
        ],
    )?;

    Menu::with_items(
        app,
        &[&app_menu, &file_menu, &edit_menu, &view_menu, &window_menu],
    )
}

// ── Entry points ──────────────────────────────────────────────────

/// UI mode: launch Tauri with full state + activity socket listener.
pub fn run() {
    init_tracing(false);

    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init());

    #[cfg(debug_assertions)]
    {
        builder = builder.plugin(tauri_plugin_pilot::init());
    }

    builder
        .on_menu_event(|app, event| {
            if event.id().as_ref() == REVEAL_MENU_ID {
                // `Menu::get` only searches the top-level; our item lives
                // under View. Walk submenus to find it. Native menus
                // auto-toggle their visual checkmark BEFORE the event fires,
                // so `is_checked` reports the *new* state we want to emit.
                if let Some(check) = find_check_item(app, REVEAL_MENU_ID) {
                    let new_state = check.is_checked().unwrap_or(false);
                    let _ = app.emit(REVEAL_EVENT_NAME, new_state);
                }
            }
        })
        .setup(|app| {
            let handle = app.handle().clone();
            // Install the custom menu (no Undo/Redo) so ⌘Z is not bound at
            // the OS level — see build_app_menu for the why.
            let menu = build_app_menu(&handle)?;
            app.set_menu(menu)?;
            // Build Core synchronously on the async runtime, then manage it
            // before invoke_handler can run any commands.
            let core = tauri::async_runtime::block_on(async {
                let meta = connections::open_metadata()
                    .await
                    .expect("metadata db open");
                let pools = PoolRegistry::default();
                let emit = tauri_emitter(handle.clone());
                Core {
                    meta,
                    pools,
                    emit,
                    source: "ui".into(),
                    redactor_cache: Default::default(),
                }
            });
            handle.manage(core);
            spawn_socket_listener(handle.clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_connections,
            add_connection,
            delete_connection,
            connect,
            disconnect,
            list_schemas,
            list_tables,
            search_columns,
            describe_table,
            run_query,
            apply_mutations,
            export_query,
            write_file,
            mcp_snippet,
            list_snippets,
            upsert_snippet,
            delete_snippet,
            classify_schema,
            list_classifications,
            update_classification,
            #[cfg(debug_assertions)]
            dev_toggle_reveal,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// MCP mode: run the rmcp stdio server only. No UI window.
/// Logs to stderr because stdout is the MCP transport.
pub fn run_mcp() {
    init_tracing(true);

    let rt = tokio::runtime::Runtime::new().expect("tokio runtime");
    rt.block_on(async move {
        let meta = connections::open_metadata().await.expect("metadata db");
        let core = Core {
            meta,
            pools: PoolRegistry::default(),
            emit: mcp_emitter(),
            source: "mcp".into(),
            redactor_cache: Default::default(),
        };
        let server = mcp::McpServer::new(core);
        let service = match server.serve(stdio()).await {
            Ok(s) => s,
            Err(e) => {
                eprintln!("mcp serve error: {e}");
                std::process::exit(1);
            }
        };
        // Heartbeat: gives the OS a chance to flush stderr logs.
        let _hb = tokio::spawn(async {
            loop {
                tokio::time::sleep(Duration::from_secs(60)).await;
            }
        });
        if let Err(e) = service.waiting().await {
            eprintln!("mcp service ended: {e}");
        }
    });
}

fn init_tracing(to_stderr: bool) {
    let env_filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info"));
    let builder = tracing_subscriber::fmt().with_env_filter(env_filter);
    let _ = if to_stderr {
        builder
            .with_writer(std::io::stderr)
            .with_ansi(false)
            .try_init()
    } else {
        builder.try_init()
    };
}
