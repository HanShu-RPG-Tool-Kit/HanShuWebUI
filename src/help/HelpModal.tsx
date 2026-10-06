import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react'
import { Marked } from 'marked'
import DOMPurify from 'dompurify'
import { helpGroups, helpTopic, isHelpTopicId, type HelpTopicId } from './topics'
import './HelpModal.css'

type HelpModalProps = {
  topicId: HelpTopicId
  onClose: () => void
  onOpenTopic: (id: HelpTopicId) => void
}

const markdown = new Marked({ gfm: true, breaks: false })

type Heading = { id: string; text: string }

export function HelpModal({ topicId, onClose, onOpenTopic }: HelpModalProps) {
  const topic = useMemo(() => helpTopic(topicId), [topicId])
  const groups = useMemo(() => helpGroups(), [])
  const html = useMemo(() => DOMPurify.sanitize(markdown.parse(topic.body, { async: false }) as string), [topic])
  const articleRef = useRef<HTMLElement>(null)
  const [headings, setHeadings] = useState<Heading[]>([])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  useEffect(() => {
    const article = articleRef.current
    if (!article) return
    article.scrollTop = 0
    const found: Heading[] = []
    article.querySelectorAll('h2').forEach((node, index) => {
      node.id = `help-sec-${index + 1}`
      found.push({ id: node.id, text: node.textContent ?? '' })
    })
    setHeadings(found)
  }, [html])

  function onArticleClick(event: MouseEvent<HTMLElement>) {
    const anchor = (event.target as HTMLElement).closest('a')
    if (!anchor) return
    const href = anchor.getAttribute('href') ?? ''
    event.preventDefault()
    if (href.startsWith('#')) {
      const target = href.slice(1)
      if (isHelpTopicId(target)) onOpenTopic(target)
      else articleRef.current?.querySelector(`#${CSS.escape(target)}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      return
    }
    if (/^https?:\/\//i.test(href)) window.open(href, '_blank', 'noopener,noreferrer')
  }

  function scrollTo(id: string) {
    articleRef.current?.querySelector(`#${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  return (
    <div className="help-backdrop" role="dialog" aria-modal="true" aria-labelledby="help-title" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <div className="help-modal">
        <header className="help-header">
          <strong id="help-title">帮助</strong>
          <span className="help-header-topic">{topic.title}</span>
          <button type="button" className="help-close" onClick={onClose} aria-label="关闭帮助">
            <svg viewBox="0 0 16 16" aria-hidden><path d="M4 4l8 8M12 4l-8 8" /></svg>
          </button>
        </header>
        <div className="help-layout">
          <nav className="help-nav" aria-label="帮助目录">
            {groups.map(({ group, topics }) => (
              <div key={group} className="help-nav-group">
                <div className="help-nav-heading">{group}</div>
                {topics.map((item) => (
                  <div key={item.id}>
                    <button
                      type="button"
                      className={`help-nav-item${item.id === topicId ? ' is-active' : ''}`}
                      aria-current={item.id === topicId ? 'page' : undefined}
                      onClick={() => onOpenTopic(item.id)}
                    >
                      {item.title}
                    </button>
                    {item.id === topicId && headings.length > 1 && (
                      <ul className="help-toc">
                        {headings.map((heading) => (
                          <li key={heading.id}>
                            <button type="button" onClick={() => scrollTo(heading.id)}>{heading.text}</button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                ))}
              </div>
            ))}
          </nav>
          <article ref={articleRef} className="help-article" onClick={onArticleClick}>
            <div className="help-md" dangerouslySetInnerHTML={{ __html: html }} />
          </article>
        </div>
      </div>
    </div>
  )
}
