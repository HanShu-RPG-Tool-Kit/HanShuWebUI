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
