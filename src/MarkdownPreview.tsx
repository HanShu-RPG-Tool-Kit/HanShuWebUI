import { marked } from 'marked'
import DOMPurify from 'dompurify'
import { useMemo } from 'react'

marked.setOptions({
  gfm: true,
  breaks: true,
})

type MarkdownPreviewProps = {
  source: string
}

export function MarkdownPreview({ source }: MarkdownPreviewProps) {
  const html = useMemo(() => {
    const rendered = marked.parse(source, { async: false }) as string
    return DOMPurify.sanitize(rendered)
  }, [source])

  return (
    <div className="md-preview" aria-label="Markdown 预览">
      <div
        className="md-preview-body"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  )
}
