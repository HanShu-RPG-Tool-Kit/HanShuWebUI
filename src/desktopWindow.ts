export function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

type DesktopWindow = Awaited<
  ReturnType<typeof import('@tauri-apps/api/window').getCurrentWindow>
>

/**
 * Splash OS window = dialog + padding so CSS rounded corners / soft shadow
 * aren't clipped by the transparent window bounds.
 */
const SPLASH_PAD = 32
const SPLASH_WIDTH = 820 + SPLASH_PAD * 2
const SPLASH_HEIGHT = 461 + SPLASH_PAD * 2
const SPLASH_MIN_WIDTH = 640
const SPLASH_MIN_HEIGHT = 360
const MAIN_MIN_WIDTH = 900
const MAIN_MIN_HEIGHT = 600

async function currentWindow(): Promise<DesktopWindow | null> {
  if (!isTauriRuntime()) return null
  const { getCurrentWindow } = await import('@tauri-apps/api/window')
  return getCurrentWindow()
}

/** Chrome polish must never block showing the window. */
async function invokeChrome(splash: boolean): Promise<void> {
  if (!isTauriRuntime()) return
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    await invoke(splash ? 'desktop_set_splash_chrome' : 'desktop_set_main_chrome')
  } catch (err) {
    console.warn('desktop window chrome failed', err)
  }
}

export async function minimizeDesktopWindow(): Promise<void> {
  await (await currentWindow())?.minimize()
}

export async function toggleMaximizeDesktopWindow(): Promise<void> {
  await (await currentWindow())?.toggleMaximize()
}

export async function closeDesktopWindow(): Promise<void> {
  await (await currentWindow())?.close()
}

/**
 * Photoshop-style cold start: show a centered splash-sized window
 * before the main shell exists.
 */
export async function presentDesktopSplashWindow(): Promise<void> {
  const win = await currentWindow()
  if (!win) return
  const { LogicalSize } = await import('@tauri-apps/api/dpi')
  try {
    await win.setMinSize(new LogicalSize(SPLASH_MIN_WIDTH, SPLASH_MIN_HEIGHT))
    await win.setSize(new LogicalSize(SPLASH_WIDTH, SPLASH_HEIGHT))
    await win.center()
  } catch (err) {
    console.warn('desktop splash size/center failed', err)
  }
  await invokeChrome(true)
  await win.show()
  try {
    await win.setFocus()
  } catch {
    /* focus can fail if the OS rejects it; window is still shown */
  }
}

export async function hideDesktopWindow(): Promise<void> {
  await (await currentWindow())?.hide()
}

/**
 * After splash (or when splash is skipped): maximize and reveal the main UI.
 * Caller should swap React tree to the main shell while the window is hidden
 * so the splash never stretches to full-screen.
 */
export async function revealDesktopMainWindow(): Promise<void> {
  const win = await currentWindow()
  if (!win) return
  const { LogicalSize } = await import('@tauri-apps/api/dpi')
  try {
    if (await win.isVisible()) await win.hide()
  } catch {
    /* ignore */
  }
  try {
    await win.setMinSize(new LogicalSize(MAIN_MIN_WIDTH, MAIN_MIN_HEIGHT))
    await win.maximize()
  } catch (err) {
    console.warn('desktop maximize failed', err)
  }
  await invokeChrome(false)
  await win.show()
  try {
    await win.setFocus()
  } catch {
    /* ignore */
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

/**
 * Hide splash completely, swap to main shell off-screen, then show maximized.
 *
 * Uses setTimeout (not rAF): WebView2 often pauses animation frames while the
 * window is hidden, which would leave the app stuck invisible forever.
 */
export async function finishDesktopSplashToMain(
  swapToMain: () => void,
): Promise<void> {
  try {
    await hideDesktopWindow()
  } catch (err) {
    console.warn('hide splash failed', err)
  }
  swapToMain()
  await sleep(80)
  await revealDesktopMainWindow()
}

/** Subscribe to maximize state changes; returns an unsubscribe. */
export async function watchDesktopMaximized(
  onChange: (maximized: boolean) => void,
): Promise<() => void> {
  const win = await currentWindow()
  if (!win) return () => undefined
  onChange(await win.isMaximized())
  const unlisten = await win.onResized(async () => {
    onChange(await win.isMaximized())
  })
  return unlisten
}
