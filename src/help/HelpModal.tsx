import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react'
import { Marked } from 'marked'
import DOMPurify from 'dompurify'
import {
  helpGroups,
  helpSearchSnippet,
  helpTopic,
  isHelpTopicId,
  searchHelpTopics,
  type HelpTopic,
  type HelpTopicId,
} from './topics'
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
  const searchRef = useRef<HTMLInputElement>(null)
  const [headings, setHeadings] = useState<Heading[]>([])
  const [query, setQuery] = useState('')

  const filteredGroups = useMemo(() => {
    const needle = query.trim()
    if (!needle) return groups
    const hits = new Set(searchHelpTopics(needle).map((item) => item.id))
    return groups
      .map(({ group, topics }) => ({ group, topics: topics.filter((item) => hits.has(item.id)) }))
      .filter(({ topics }) => topics.length > 0)
  }, [groups, query])

  const hitCount = useMemo(
    () => filteredGroups.reduce((total, group) => total + group.topics.length, 0),
    [filteredGroups],
  )

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (query.trim()) {
          event.preventDefault()
          setQuery('')
          return
        }
        onClose()
        return
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
        event.preventDefault()
        searchRef.current?.focus()
        searchRef.current?.select()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, query])

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

  function topicSnippet(item: HelpTopic): string | null {
    const needle = query.trim()
    if (!needle) return null
    if (item.title.toLowerCase().includes(needle.toLowerCase())) return null
    return helpSearchSnippet(item.body, needle)
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
            <div className="help-nav-search">
              <input
                ref={searchRef}
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜索帮助…"
                aria-label="搜索帮助"
              />
              {query.trim() ? (
                <span className="help-nav-search-meta" aria-live="polite">
                  {hitCount > 0 ? `${hitCount} 篇` : '无匹配'}
                </span>
              ) : null}
            </div>
            <div className="help-nav-list">
              {filteredGroups.length === 0 ? (
                <p className="help-nav-empty">没有匹配「{query.trim()}」的条目</p>
              ) : (
                filteredGroups.map(({ group, topics }) => (
                  <div key={group} className="help-nav-group">
                    <div className="help-nav-heading">{group}</div>
                    {topics.map((item) => {
                      const snippet = topicSnippet(item)
                      return (
                        <div key={item.id}>
                          <button
                            type="button"
                            className={`help-nav-item${item.id === topicId ? ' is-active' : ''}`}
                            aria-current={item.id === topicId ? 'page' : undefined}
                            onClick={() => onOpenTopic(item.id)}
                          >
                            <span className="help-nav-item-title">{item.title}</span>
                            {snippet ? <span className="help-nav-item-snippet">{snippet}</span> : null}
                          </button>
                          {!query.trim() && item.id === topicId && headings.length > 1 && (
                            <ul className="help-toc">
                              {headings.map((heading) => (
                                <li key={heading.id}>
                                  <button type="button" onClick={() => scrollTo(heading.id)}>{heading.text}</button>
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>
                      )
                    })}
                  </div>
                ))
              )}
            </div>
          </nav>
          <article ref={articleRef} className="help-article" onClick={onArticleClick}>
            <div className="help-md" dangerouslySetInnerHTML={{ __html: html }} />
          </article>
        </div>
      </div>
    </div>
  )
}
