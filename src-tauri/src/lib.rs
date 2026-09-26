mod skin;

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
            // MC 皮肤管理器：独立 Rust core + 薄 IPC 适配层。
            let skin_state = skin::state::SkinState::init(app.handle())?;
            app.manage(skin_state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            skin::commands::skin_get_capabilities,
            skin::commands::skin_list_entries,
            skin::commands::skin_get_entry,
            skin::commands::skin_list_tags,
            skin::commands::skin_create_tag,
            skin::commands::skin_patch_tag,
            skin::commands::skin_delete_tag,
            skin::commands::skin_list_folders,
            skin::commands::skin_create_folder,
            skin::commands::skin_patch_folder,
            skin::commands::skin_delete_folder,
            skin::commands::skin_save_entry,
            skin::commands::skin_patch_entry,
            skin::commands::skin_batch_patch_entries,
            skin::commands::skin_delete_entry,
            skin::commands::skin_start_import,
            skin::commands::skin_import_file,
            skin::commands::skin_get_import,
            skin::commands::skin_list_imports,
            skin::commands::skin_cancel_import,
            skin::commands::skin_get_preview_png,
            skin::commands::skin_export_skin,
            skin::commands::skin_export_entry,
            skin::commands::skin_export_usable_manifest,
            skin::commands::skin_get_skin_code,
            skin::commands::skin_write_export_file,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
