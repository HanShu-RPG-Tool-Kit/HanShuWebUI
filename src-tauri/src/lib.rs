mod skin;
mod project_service;
mod window_chrome;
mod webview_perms;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            app.manage(project_service::ProjectService::init(app.handle())?);
            webview_perms::configure_visuals(app.handle())?;
            // Splash starts hidden; apply rounded / borderless chrome before first show.
            let _ = window_chrome::set_chrome(app.handle(), true);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            project_service::project_local_connection,
            project_service::project_open_local,
            window_chrome::desktop_set_splash_chrome,
            window_chrome::desktop_set_main_chrome,
            skin::commands::skin_net_fetch_png,
            skin::commands::skin_net_resolve_player,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
