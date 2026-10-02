//! Auto-allow File System Access API prompts inside the desktop WebView.
//!
//! The script workspace still uses Chromium's `showDirectoryPicker` /
//! `requestPermission` path. On Windows WebView2 that surfaces a native
//! "allow file access" dialog; for a packaged desktop app we grant it so the
//! folder picker alone remains the user-facing step.

#[cfg(windows)]
pub fn install(app: &tauri::AppHandle) -> tauri::Result<()> {
  use tauri::Manager;

  let Some(window) = app.get_webview_window("main") else {
    return Ok(());
  };

  window.with_webview(|webview| {
    #[cfg(windows)]
    unsafe {
      use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2Controller2, ICoreWebView2PermissionRequestedEventArgs3,
        COREWEBVIEW2_COLOR, COREWEBVIEW2_PERMISSION_KIND_FILE_READ_WRITE,
        COREWEBVIEW2_PERMISSION_STATE_ALLOW,
      };
      use webview2_com::PermissionRequestedEventHandler;
      use windows::core::Interface;

      let controller = webview.controller();
      // Transparent splash corners need a clear WebView default background.
      if let Ok(controller2) = controller.cast::<ICoreWebView2Controller2>() {
        let _ = controller2.SetDefaultBackgroundColor(COREWEBVIEW2_COLOR {
          A: 0,
          R: 0,
          G: 0,
          B: 0,
        });
      }

      let Ok(core) = controller.CoreWebView2() else {
        return;
      };

      let mut token = 0i64;
      let _ = core.add_PermissionRequested(
        &PermissionRequestedEventHandler::create(Box::new(move |_, args| {
          let Some(args) = args else {
            return Ok(());
          };

          let mut kind = Default::default();
          args.PermissionKind(&mut kind)?;
          if kind == COREWEBVIEW2_PERMISSION_KIND_FILE_READ_WRITE {
            args.SetState(COREWEBVIEW2_PERMISSION_STATE_ALLOW)?;
            if let Ok(args3) = args.cast::<ICoreWebView2PermissionRequestedEventArgs3>() {
              let _ = args3.SetSavesInProfile(true);
            }
          }
          Ok(())
        })),
        &mut token,
      );
    }

    #[cfg(not(windows))]
    {
      let _ = webview;
    }
  })
}

#[cfg(not(windows))]
pub fn install(_app: &tauri::AppHandle) -> tauri::Result<()> {
  Ok(())
}

/// 确认 WebView2 **接受从系统拖进来的文件** —— 这是 HTML5 文件投放的总开关。
///
/// 本应用走 HTML5 拖放（`tauri.conf.json` 的 `dragDropEnabled: false` 让 Tauri 不装原生
/// 拖放处理器），而这项在 WebView2 里**默认是开的**。但"窗口一开始是隐藏的"那种启动
/// 路径上见过它没被激活 —— 症状正是：从资源管理器拖文件进窗口**一点反应都没有、鼠标是
/// 禁止光标**，而窗口**内部**的拖拽（键名互拖、资产拖进目录）一切照常。
///
/// 所以在窗口真的显示出来之后显式读一次、置真一次，并把读到的值写进日志：
/// 下次再有人报"拖进来没反应"，日志里就有答案，不必再猜。
#[cfg(windows)]
pub fn ensure_external_drop(app: &tauri::AppHandle) {
  use tauri::Manager;

  let Some(window) = app.get_webview_window("main") else {
    return;
  };

  let _ = window.with_webview(|webview| unsafe {
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Controller4;
    use windows::core::{Interface, BOOL};

    let Ok(controller4) = webview.controller().cast::<ICoreWebView2Controller4>() else {
      log::warn!(
        "[hanshu] 这台机器的 WebView2 没有 ICoreWebView2Controller4，无法确认外部拖放开关"
      );
      return;
    };

    let mut current = BOOL::default();
    match controller4.AllowExternalDrop(&mut current) {
      Ok(()) => log::info!("[hanshu] WebView2 AllowExternalDrop = {}", current.as_bool()),
      Err(error) => log::warn!("[hanshu] 读 AllowExternalDrop 失败：{error}"),
    }
    if let Err(error) = controller4.SetAllowExternalDrop(true) {
      log::warn!("[hanshu] 打开 AllowExternalDrop 失败：{error}");
    }
  });
}

#[cfg(not(windows))]
pub fn ensure_external_drop(_app: &tauri::AppHandle) {}
