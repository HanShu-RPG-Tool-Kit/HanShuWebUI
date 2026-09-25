import { DiffEditor } from '@monaco-editor/react'
import { useEffect, useState } from 'react'
import { HANSHU_THEME_ID, registerHanshuLanguage } from './monaco/hanshuLanguage'
import { languageForFile } from './workspace'

export type AgentDiffSnapshot = {
  fileName: string
  before: string
  after: string
  created?: boolean
}

type AgentDiffModalProps = {
  diffs: AgentDiffSnapshot[]
  onClose: () => void
  onAccept: (index: number) => void
  onUndo: (index: number) => void
  onAcceptAll: () => void
  onUndoAll: () => void
}

export function AgentDiffModal({
  diffs,
  onClose,
  onAccept,
  onUndo,
  onAcceptAll,
  onUndoAll,
}: AgentDiffModalProps) {
  const [index, setIndex] = useState(0)

  useEffect(() => {
    setIndex((prev) => Math.min(prev, Math.max(0, diffs.length - 1)))
  }, [diffs.length])

  if (diffs.length === 0) return null

  const safeIndex = Math.min(index, diffs.length - 1)
  const diff = diffs[safeIndex]
  const multi = diffs.length > 1

  return (
    <div className="diff-modal-backdrop" role="dialog" aria-modal="true">
      <div className="diff-modal">
        <header className="diff-modal-header">
          <div>
            <strong>Agent 修改对比</strong>
            {multi && (
              <span className="diff-modal-file">
                （{safeIndex + 1}/{diffs.length}）
              </span>
            )}
            <span className="diff-modal-file">{diff.fileName}</span>
            {diff.created && <span className="diff-modal-tag">新建</span>}
          </div>
          <button type="button" onClick={onClose}>
            关闭
          </button>
        </header>
        {multi && (
          <div className="diff-modal-tabs">
            {diffs.map((item, i) => (
              <button
                key={`${item.fileName}-${i}`}
                type="button"
                className={`diff-tab${i === safeIndex ? ' active' : ''}`}
                onClick={() => setIndex(i)}
              >
                {item.created ? '+ ' : ''}
                {item.fileName}
              </button>
            ))}
          </div>
        )}
        <div className="diff-modal-body">
          <DiffEditor
            height="100%"
            original={diff.before}
            modified={diff.after}
            language={languageForFile(diff.fileName)}
            theme={HANSHU_THEME_ID}
            beforeMount={registerHanshuLanguage}
            options={{
              readOnly: true,
              renderSideBySide: true,
              fontSize: 15,
              lineHeight: 24,
              minimap: { enabled: false },
              wordWrap: 'on',
              automaticLayout: true,
              scrollBeyondLastLine: false,
              stickyScroll: { enabled: false },
            }}
          />
        </div>
        <footer className="diff-modal-footer">
          <span className="diff-modal-hint">
            左：修改前 · 右：修改后（已写入；可撤销回改前
            {diff.created ? '，新建将删除' : ''}）
          </span>
          <div className="diff-modal-actions">
            {multi && (
              <>
                <button
                  type="button"
                  className="diff-btn diff-btn-danger"
                  onClick={onUndoAll}
                >
                  全部撤销
                </button>
                <button
                  type="button"
                  className="diff-btn"
                  onClick={onAcceptAll}
                >
                  全部接受
                </button>
              </>
            )}
            <button
              type="button"
              className="diff-btn diff-btn-danger"
              onClick={() => onUndo(safeIndex)}
            >
              撤销
            </button>
            <button
              type="button"
              className="diff-btn diff-btn-primary"
              onClick={() => onAccept(safeIndex)}
            >
              接受
            </button>
          </div>
        </footer>
      </div>
    </div>
  )
}
