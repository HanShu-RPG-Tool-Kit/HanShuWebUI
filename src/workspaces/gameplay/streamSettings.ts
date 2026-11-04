export type StreamSettings = { maxWidth: number; fps: number; jpegQuality: number }
export const STREAM_WIDTHS = [0,1280,1600,1920,2560,3840] as const
export const STREAM_RATES = [20,30,45,60,90,120] as const
export const DEFAULT_STREAM_SETTINGS: StreamSettings = { maxWidth:1920,fps:60,jpegQuality:.85 }
const KEY='hanshu.regionStream.v1'
export function normalizeStreamSettings(value: unknown): StreamSettings {
  const v=value as Partial<StreamSettings>|null
  return {
    maxWidth:STREAM_WIDTHS.some(n=>n===v?.maxWidth)?v!.maxWidth!:DEFAULT_STREAM_SETTINGS.maxWidth,
    fps:STREAM_RATES.some(n=>n===v?.fps)?v!.fps!:DEFAULT_STREAM_SETTINGS.fps,
    jpegQuality:typeof v?.jpegQuality==='number'&&Number.isFinite(v.jpegQuality)?Math.max(.5,Math.min(.95,v.jpegQuality)):DEFAULT_STREAM_SETTINGS.jpegQuality,
  }
}
export function loadStreamSettings(): StreamSettings {
  try{return normalizeStreamSettings(JSON.parse(localStorage.getItem(KEY)??'null'))}catch{return {...DEFAULT_STREAM_SETTINGS}}
}
export function saveStreamSettings(value: StreamSettings) { try{localStorage.setItem(KEY,JSON.stringify(normalizeStreamSettings(value)))}catch{/* Session settings still work when storage is unavailable. */} }
export function streamStartBody(value: StreamSettings){return {mode:'interactive',picture:'jpeg',...normalizeStreamSettings(value)} as const}
