import {decodeTextComponent} from './codec'
import {parseFeedbackText,stringifyFeedbackText} from './model'

/** Only normalize supported literal structures; preserve advanced components verbatim. */
export function normalizeTextComponent(component: unknown): unknown {
  const decoded=decodeTextComponent(component)
  if(!decoded.editable||decoded.segments.every(segment=>!segment.text))return component
  const value=stringifyFeedbackText(parseFeedbackText(JSON.stringify(typeof component==='string'?{text:component}:component)))
  if(/^\s*[[{"]/.test(value)){try{return JSON.parse(value)}catch{/* literal */}}
  return {text:value}
}
