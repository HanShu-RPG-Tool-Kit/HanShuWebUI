//! Desktop「另存为」：原生保存对话框 + 写盘。由 C 侧把已打好的导出字节传过来。

use serde::Deserialize;
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;

#[derive(Clone, Deserialize)]
pub struct ExportSaveFilter {
    pub label: String,
    pub extensions: Vec<String>,
}

#[tauri::command]
pub async fn desktop_save_export_file(
    app: AppHandle,
    default_name: String,
    filters: Vec<ExportSaveFilter>,
    title: String,
    data: Vec<u8>,
) -> Result<Option<String>, String> {
    let chooser = app.clone();
    let name = default_name.clone();
    let title = title.clone();
    let filters = filters.clone();
    let selected = tauri::async_runtime::spawn_blocking(move || {
        let mut dialog = chooser
            .dialog()
            .file()
            .set_title(&title)
            .set_file_name(&name);
        for filter in &filters {
            let exts: Vec<&str> = filter.extensions.iter().map(String::as_str).collect();
            dialog = dialog.add_filter(&filter.label, &exts);
        }
        dialog.blocking_save_file()
    })
    .await
    .map_err(|e| e.to_string())?;

    let Some(file) = selected else {
        return Ok(None);
    };
    let path = file.into_path().map_err(|e| e.to_string())?;
    std::fs::write(&path, &data).map_err(|e| e.to_string())?;
    Ok(Some(path.to_string_lossy().into_owned()))
}
