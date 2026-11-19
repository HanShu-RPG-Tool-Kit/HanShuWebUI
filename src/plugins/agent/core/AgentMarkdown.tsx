import { marked } from 'marked'
import DOMPurify from 'dompurify'
import { useMemo } from 'react'

marked.setOptions({
  gfm: true,
  breaks: true,
})

type Props = {
  source: string
  className?: string
}

/** Agent 气泡内的 Markdown 渲染 */
export function AgentMarkdown({ source, className = '' }: Props) {
  const html = useMemo(() => {
    if (!source.trim()) return ''
    const rendered = marked.parse(source, { async: false }) as string
    return DOMPurify.sanitize(rendered)
  }, [source])

  if (!html) {
    return <div className={`agent-msg-body ${className}`}>…</div>
  }

  return (
    <div
      className={`agent-msg-body agent-md ${className}`}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}
