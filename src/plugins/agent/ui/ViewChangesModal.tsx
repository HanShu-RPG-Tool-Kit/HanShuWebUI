/* oxlint-disable react/only-export-components, react/set-state-in-effect */
import { DiffEditor } from '@monaco-editor/react'
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ProjectHost } from '../../../plugin-sdk/types'
import { getProjectHost } from '../../../project/projectHost'
import { editorLanguageForFile } from '../../../workspace'
import {
  CHAR_THEME_ID,
  registerCharLanguage,
} from '../../../monaco/charLanguage'
import {
  HANSHU_THEME_ID,
  registerHanshuLanguage,
} from '../../../monaco/hanshuLanguage'

export type ChangedPathDiff = {
  path: string
  before: string
  after: string
  kind: 'created' | 'modified' | 'deleted'
}

type ChangeReader = Pick<ProjectHost, 'readCurrentText' | 'readSavedText'>

const CHANGE_KIND_LABEL: Record<ChangedPathDiff['kind'], string> = {
  created: '新建',
  modified: '修改',
  deleted: '删除',
}

/** `.char` 走角色语言主题；其余（含 `.hs` / `.lang`）沿用汉书主题。 */
function isCharPath(path: string): boolean {
  return path.toLowerCase().endsWith('.char')
}

/**
 * 只读比较：逐路径读取「当前草稿」与「上次保存」，跳过内容相等或两边都不存在的路径。
 * 单独抽出以便测试注入 fake ProjectHost；顺序与传入 paths 一致，重复路径只保留一次。
 */
export async function diffChangedPaths(
  host: ChangeReader,
  paths: readonly string[],
): Promise<ChangedPathDiff[]> {
  const unique = [...new Set(paths.filter((path) => path.length > 0))]
  const results = await Promise.all(
    unique.map(async (path): Promise<ChangedPathDiff | null> => {
      const current = host.readCurrentText(path)
      const saved = await host.readSavedText(path)
      if (current === null && saved === null) return null
      if (current === null && saved !== null) {
        return { path, before: saved, after: '', kind: 'deleted' }
      }
      if (saved === null && current !== null) {
        return { path, before: '', after: current, kind: 'created' }
      }
      if (current === saved) return null
      return { path, before: saved ?? '', after: current ?? '', kind: 'modified' }
    }),
  )
  return results.filter((item): item is ChangedPathDiff => item !== null)
}

/** 文件列表单独导出，便于 SSR 断言路径与变更类型（DiffEditor 不适合服务端渲染）。 */
export function ViewChangesFileList({
  diffs,
  selected,
  onSelect,
}: {
  diffs: readonly ChangedPathDiff[]
  selected: string | null
  onSelect: (path: string) => void
}) {
  return (
    <nav className="view-changes-list" aria-label="变更文件列表">
      {diffs.map((diff) => (
        <button
          key={diff.path}
          type="button"
          className={`view-changes-item${diff.path === selected ? ' active' : ''}`}
          title={diff.path}
          onClick={() => onSelect(diff.path)}
        >
          <span className="view-changes-path">{diff.path}</span>
          <span className={`view-changes-kind ${diff.kind}`}>
            {CHANGE_KIND_LABEL[diff.kind]}
          </span>
        </button>
      ))}
    </nav>
  )
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export type ViewChangesModalProps = {
  open: boolean
  paths: readonly string[]
  onClose: () => void
}

/**
 * 「查看变更」只读面板：仅展示活跃段里 Agent 改过的文件与左右对照。
 * 没有接受／拒绝入口，拒绝语义由回滚负责。
 */
export function ViewChangesModal({ open, paths, onClose }: ViewChangesModalProps) {
  const [diffs, setDiffs] = useState<ChangedPathDiff[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoading(true)
    setError('')
    setDiffs([])
    setSelected(null)
    const host = getProjectHost()
    if (!host) {
      setLoading(false)
      setError('当前没有打开的工程，无法查看变更。')
      return
    }
    void diffChangedPaths(host, paths)
      .then((next) => {
        if (cancelled) return
        setDiffs(next)
        setSelected(next[0]?.path ?? null)
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(`读取变更失败：${errorText(cause)}`)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, paths])

  if (!open) return null

  const active =
    diffs.find((diff) => diff.path === selected) ?? diffs[0] ?? null

  const content = (
    <div
      className="view-changes-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="查看 Agent 变更"
    >
      <div className="view-changes-modal">
        <header className="view-changes-header">
          <div className="view-changes-title">
            查看变更
            <span className="view-changes-count">
              {loading ? '读取中…' : `${diffs.length} 个文件`}
            </span>
          </div>
          <button type="button" className="view-changes-close" onClick={onClose}>
            关闭
          </button>
        </header>
        {loading ? (
          <div className="view-changes-empty">正在读取变更…</div>
        ) : error ? (
          <div className="view-changes-empty view-changes-error" role="alert">
            {error}
          </div>
        ) : diffs.length === 0 ? (
          <div className="view-changes-empty">
            这些文件与已保存内容一致，没有可查看的变更。
          </div>
        ) : (
          <>
            <div className="view-changes-body">
              <ViewChangesFileList
                diffs={diffs}
                selected={active?.path ?? null}
                onSelect={setSelected}
              />
              <div className="view-changes-diff">
                {active && (
                  <DiffEditor
                    height="100%"
                    original={active.before}
                    modified={active.after}
                    language={editorLanguageForFile(active.path)}
                    theme={
                      isCharPath(active.path) ? CHAR_THEME_ID : HANSHU_THEME_ID
                    }
                    beforeMount={(monaco) => {
                      registerHanshuLanguage(monaco)
                      registerCharLanguage(monaco)
                    }}
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
                )}
              </div>
            </div>
            <footer className="view-changes-footer">
              只读预览：左侧为已保存内容，右侧为当前草稿。这里不能接受或拒绝；如需撤销，请使用「回滚」。
            </footer>
          </>
        )}
      </div>
    </div>
  )

  // 面板本身在停靠容器里可能处于较低的层叠上下文，直接渲染会被编辑器里的
  // 键名/布局边界等浮层盖住；挂到 body 并配高 z-index 才能保证对话框在最上层。
  // SSR（验收脚本用 renderToStaticMarkup）没有 document，退回内联渲染。
  if (typeof document === 'undefined') return content
  return createPortal(content, document.body)
}
