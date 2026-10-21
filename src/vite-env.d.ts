/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_DEEPSEEK_API_KEY?: string
  readonly VITE_DEEPSEEK_BASE_URL?: string
  readonly VITE_DEEPSEEK_MODEL?: string
  readonly VITE_DEEPSEEK_TEMPERATURE?: string
}

declare module '*.md?raw' {
  const content: string
  export default content
}

declare module '*.py?raw' {
  const content: string
  export default content
}

declare module '*.ogg' {
  const src: string
  export default src
}
