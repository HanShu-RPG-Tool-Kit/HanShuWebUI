import { useEffect, useMemo, useState } from 'react'
import { DiffEditor } from '@monaco-editor/react'
import {
  formatVersionTime,
  listFileVersions,
  listHistoryFileNames,
  reasonLabel,
  type FileVersion,
} from './history/fileHistory'
import { HANSHU_THEME_ID, registerHanshuLanguage } from './monaco/hanshuLanguage'
import { languageForFile } from './workspace'

type HistoryModalProps = {
  open: boolean
  /** 默认选中的文件名 */
  initialFileName: string
  currentContent: string
  onClose: () => void
  onRestore: (fileName: string, content: string) => void
}

export function HistoryModal({
  open,
  initialFileName,
  currentContent,
  onClose,
  onRestore,
}: HistoryModalProps) {
  const fileNames = useMemo(() => {
    const all = listHistoryFileNames()
    if (
      initialFileName &&
      !all.some((n) => n.toLowerCase() === initialFileName.toLowerCase())
    ) {
      return [initialFileName, ...all]
    }
    return all.length > 0 ? all : initialFileName ? [initialFileName] : []
  }, [open, initialFileName])

  const [fileName, setFileName] = useState(initialFileName)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    if (!open) return
    setFileName(initialFileName)
    setSelectedId(null)
    setTick((n) => n + 1)
  }, [open, initialFileName])

  const versions = useMemo(() => {
    void tick
    return listFileVersions(fileName)
  }, [fileName, tick, open])

  const selected: FileVersion | null =
    versions.find((v) => v.id === selectedId) ?? versions[0] ?? null

  if (!open) return null

  return (
    <div className="diff-modal-backdrop" role="dialog" aria-modal="true">
      <div className="diff-modal history-modal">
        <header className="diff-modal-header">
          <div>
            <strong>历史版本</strong>
            <span className="diff-modal-file">{fileName || '（无）'}</span>
          </div>
          <button type="button" onClick={onClose}>
            关闭
          </button>
        </header>

        <div className="history-layout">
          <aside className="history-sidebar">
            <label className="history-file-pick">
              文件
              <select
                value={fileName}
                onChange={(e) => {
                  setFileName(e.target.value)
                  setSelectedId(null)
                }}
              >
                {fileNames.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
            <ul className="history-list">
              {versions.map((v) => (
                <li key={v.id}>
                  <button
                    type="button"
                    className={`history-item${
                      selected?.id === v.id ? ' active' : ''
                    }`}
                    onClick={() => setSelectedId(v.id)}
                  >
                    <span className="history-item-time">
                      {formatVersionTime(v.savedAt)}
                    </span>
                    <span className="history-item-reason">
                      {reasonLabel(v.reason)}
                    </span>
                    <span className="history-item-size">
                      {v.content.length} 字
                    </span>
                  </button>
                </li>
              ))}
              {versions.length === 0 && (
                <li className="history-empty">暂无历史（保存或 Agent 写入后产生）</li>
              )}
            </ul>
          </aside>

          <div className="history-main">
            {selected ? (
              <>
                <div className="history-toolbar">
                  <span>
                    左：当前编辑器 · 右：历史快照（
                    {reasonLabel(selected.reason)}）
                  </span>
                  <button
                    type="button"
                    className="history-restore"
                    onClick={() => {
                      if (
                        !window.confirm(
                          `用该版本覆盖「${fileName}」当前内容？\n（覆盖前会再存一份「恢复前」快照）`,
                        )
                      ) {
                        return
                      }
                      onRestore(fileName, selected.content)
                      setTick((n) => n + 1)
                    }}
                  >
                    恢复此版本
                  </button>
                </div>
                <div className="diff-modal-body history-diff">
                  <DiffEditor
                    height="100%"
                    original={currentContent}
                    modified={selected.content}
                    language={languageForFile(fileName)}
                    theme={HANSHU_THEME_ID}
                    beforeMount={registerHanshuLanguage}
                    options={{
                      readOnly: true,
                      renderSideBySide: true,
                      fontSize: 14,
                      lineHeight: 22,
                      minimap: { enabled: false },
                      wordWrap: 'on',
                      automaticLayout: true,
                      scrollBeyondLastLine: false,
                      stickyScroll: { enabled: false },
                    }}
                  />
                </div>
              </>
            ) : (
              <div className="history-empty-main">选择左侧一个版本查看</div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
