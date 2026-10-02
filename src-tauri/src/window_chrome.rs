//! Native window chrome for the splash dialog (PS-style) and main shell.
//!
//! Soft antialiased corners come from a transparent window + CSS radius
//! (SetWindowRgn is intentionally avoided — it aliases badly). DWM calls
//! strip the Win11 system border stroke when available.

use tauri::Manager;

#[tauri::command]
pub fn desktop_set_splash_chrome(app: tauri::AppHandle) -> Result<(), String> {
  set_chrome(&app, true)
}

#[tauri::command]
pub fn desktop_set_main_chrome(app: tauri::AppHandle) -> Result<(), String> {
  set_chrome(&app, false)
}

pub fn set_chrome(app: &tauri::AppHandle, splash: bool) -> Result<(), String> {
  #[cfg(windows)]
  {
    let window = app
      .get_webview_window("main")
      .ok_or_else(|| "main window missing".to_string())?;
    apply_chrome(&window, splash).map_err(|e| e.to_string())?;
    // 切到主壳时窗口已经真的显示出来了：确认"接受系统拖进来的文件"是开着的。
    // 初始隐藏的窗口上曾见它没被激活（拖文件进来毫无反应），见 webview_perms。
    if !splash {
      crate::webview_perms::ensure_external_drop(app);
    }
    Ok(())
  }
  #[cfg(not(windows))]
  {
    let _ = (app, splash);
    Ok(())
  }
}

#[cfg(windows)]
fn apply_chrome(window: &tauri::WebviewWindow, splash: bool) -> windows::core::Result<()> {
  let hwnd = window.hwnd().map_err(|err| {
    windows::core::Error::new(windows::core::HRESULT(0x80004005u32 as i32), err.to_string())
  })?;

  // Best-effort DWM polish (Win11). Failures are ignored so Win10 still works.
  let _ = apply_dwm(hwnd, splash);
  Ok(())
}

#[cfg(windows)]
fn apply_dwm(hwnd: windows::Win32::Foundation::HWND, splash: bool) -> windows::core::Result<()> {
  use windows::Win32::Graphics::Dwm::{
    DwmSetWindowAttribute, DWMWA_BORDER_COLOR, DWMWA_COLOR_NONE,
    DWMWA_WINDOW_CORNER_PREFERENCE, DWMWCP_DEFAULT, DWMWCP_DONOTROUND,
    DWM_WINDOW_CORNER_PREFERENCE,
  };

  // Don't ask DWM to round — CSS handles antialiased corners. Forcing both
  // can fight the transparent window and look worse.
  let preference: DWM_WINDOW_CORNER_PREFERENCE = if splash {
    DWMWCP_DONOTROUND
  } else {
    DWMWCP_DEFAULT
  };
  let none = DWMWA_COLOR_NONE;

  unsafe {
    let _ = DwmSetWindowAttribute(
      hwnd,
      DWMWA_WINDOW_CORNER_PREFERENCE,
      &preference as *const _ as *const _,
      std::mem::size_of_val(&preference) as u32,
    );
    DwmSetWindowAttribute(
      hwnd,
      DWMWA_BORDER_COLOR,
      &none as *const _ as *const _,
      std::mem::size_of_val(&none) as u32,
    )?;
  }
  Ok(())
}
