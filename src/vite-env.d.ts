/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_DEEPSEEK_API_KEY?: string
  readonly VITE_DEEPSEEK_BASE_URL?: string
  readonly VITE_DEEPSEEK_MODEL?: string
  readonly VITE_DEEPSEEK_TEMPERATURE?: string
  /** Set to "1" to force Tauri skin IPC instead of FSA */
  readonly VITE_SKIN_USE_TAURI?: string
}

declare module '*.md?raw' {
  const content: string
  export default content
}

/** Chromium File System Access — 部分 DOM lib 版本声明不全 */
interface Window {
  showDirectoryPicker?: (options?: {
    id?: string
    mode?: 'read' | 'readwrite'
    startIn?:
      | 'desktop'
      | 'documents'
      | 'downloads'
      | 'music'
      | 'pictures'
      | 'videos'
  }) => Promise<FileSystemDirectoryHandle>
}

interface FileSystemHandlePermissionDescriptor {
  mode?: 'read' | 'readwrite'
}

interface FileSystemDirectoryHandle {
  entries: () => AsyncIterableIterator<
    [string, FileSystemHandle]
  >
  queryPermission: (
    descriptor?: FileSystemHandlePermissionDescriptor,
  ) => Promise<PermissionState>
  requestPermission: (
    descriptor?: FileSystemHandlePermissionDescriptor,
  ) => Promise<PermissionState>
}
