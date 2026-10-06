import { getExtension } from './workspace'

export type ExplorerIconKind =
  | 'package'
  | 'folder'
  | 'group'
  | 'hanshu'
  | 'character'
  | 'python'
  | 'markdown'
  | 'lang'
  | 'voice'
  | 'tts'
  | 'service'
  | 'image'
  | 'audio'
  | 'json'
  | 'file'

const PATHS: Record<ExplorerIconKind, string> = {
  package: 'M12 2l9 5v10l-9 5-9-5V7z M3 7l9 5 9-5 M12 12v10',
  folder: 'M2 5h6l2 2h12v12H2z',
  group: 'M2 5h6l2 2h12v12H2z M6 13h12',
  hanshu: 'M4 5h7a3 3 0 013 3v12a3 3 0 00-3-3H4z M20 5h-7a3 3 0 00-3 3v12a3 3 0 013-3h7z',
  character: 'M12 12a4 4 0 100-8 4 4 0 000 8z M4 21a8 8 0 0116 0',
  python: 'M5 2h9l5 5v15H5z M14 2v6h5 M9 13c0 1.1.9 2 2 2h1 M14 13v2a2 2 0 01-2 2 M9 11v-1a2 2 0 012-2h1 M14 11c0-1.1-.9-2-2-2',
  markdown: 'M5 2h9l5 5v15H5z M14 2v6h5 M8 12h8 M8 16h8 M8 8h3',
  lang: 'M12 21a9 9 0 100-18 9 9 0 000 18z M3 12h18 M12 3c2.5 2.5 3.8 5.5 3.8 9s-1.3 6.5-3.8 9c-2.5-2.5-3.8-5.5-3.8-9S9.5 5.5 12 3z',
  voice: 'M12 3a3 3 0 00-3 3v6a3 3 0 006 0V6a3 3 0 00-3-3z M5 11a7 7 0 0014 0 M12 18v3',
  tts: 'M4 9h4l5-4v14l-5-4H4z M16 9a4 4 0 010 6 M18.5 6.5a7.5 7.5 0 010 11',
  service: 'M12 15a3 3 0 100-6 3 3 0 000 6z M19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z',
  image: 'M3 4h18v16H3z M3 16l5-5 4 4 3-3 6 6 M15.5 9.5a1.5 1.5 0 100-3 1.5 1.5 0 000 3z',
  audio: 'M9 18V5l12-2v13 M9 18a3 3 0 11-6 0 3 3 0 016 0z M21 16a3 3 0 11-6 0 3 3 0 016 0z',
  json: 'M8 3H7a2 2 0 00-2 2v4a2 2 0 01-2 2 2 2 0 012 2v4a2 2 0 002 2h1 M16 3h1a2 2 0 012 2v4a2 2 0 002 2 2 2 0 00-2 2v4a2 2 0 01-2 2h-1',
  file: 'M5 2h9l5 5v15H5z M14 2v6h5',
}

const BY_EXT: Record<string, ExplorerIconKind> = {
  '.hs': 'hanshu',
  '.char': 'character',
  '.py': 'python',
  '.md': 'markdown',
  '.lang': 'lang',
  '.voice': 'voice',
  '.tts': 'tts',
  '.ttsservice': 'service',
  '.png': 'image',
  '.jpg': 'image',
  '.jpeg': 'image',
  '.gif': 'image',
  '.webp': 'image',
  '.svg': 'image',
  '.ogg': 'audio',
  '.mp3': 'audio',
  '.wav': 'audio',
  '.flac': 'audio',
  '.json': 'json',
}

export function fileIconKind(name: string): ExplorerIconKind {
  return BY_EXT[getExtension(name).toLowerCase()] ?? 'file'
}

export function ExplorerIcon({ kind }: { kind: ExplorerIconKind }) {
  return (
    <svg
      className={`explorer-icon is-${kind}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d={PATHS[kind]} />
    </svg>
  )
}
