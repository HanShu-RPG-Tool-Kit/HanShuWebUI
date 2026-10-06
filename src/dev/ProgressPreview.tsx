import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { ProgressEditor } from '../workspaces/progress/ProgressEditor'
import { createProgress, createProgressGoal, parseProgress, stringifyProgress } from '../workspaces/progress/progressDoc'
import { buildGoalDefinitionCatalog, type GoalDefinitionCatalog } from '../workspaces/progress/goalDefinitions'
import { loadFlowWorkspace } from '../workspaces/progress/storage'
import { isKitDocument } from '../workspaces/progress/library'
import { kitRefFromFileName, readKitSource } from '../workspaces/progress/kit'
import '../workspaces/ProgressFlowWorkspace.css'
import './ProgressPreview.css'

// Review the production form using this origin's actual workspace scripts, never a second type registry.
function loadCatalogs() {
  const { state, error } = loadFlowWorkspace()
  const goals = buildGoalDefinitionCatalog(state)
  const kits = state.documents.filter(isKitDocument).flatMap(document => {
    const ref = kitRefFromFileName(document.name)
    const result = readKitSource(document.source)
    return ref && !result.error ? [{ ref, label: result.kit.name || ref }] : []
  })
  return { goals, kits, error }
}
function example(catalog: GoalDefinitionCatalog) {
  const doc = createProgress('新的旅程')
  doc.description = '填写这项进度的故事与要求。'
  doc.goals = catalog.definitions.slice(0, 2).map(definition => createProgressGoal(definition.kind, catalog.definitions))
  return stringifyProgress(doc)
}
function App() {
  const [catalogs, setCatalogs] = useState(loadCatalogs)
  const [history, setHistory] = useState(() => ({ source: example(catalogs.goals), past: [] as string[], future: [] as string[] }))
  const [showSource, setShowSource] = useState(false)
  const doc = parseProgress(history.source)
  const change = (source: string) => setHistory(state => source === state.source ? state : { source, past: [...state.past.slice(-99), state.source], future: [] })
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if ((event.target as HTMLElement).closest('input,textarea,select')) return
      if ((event.ctrlKey || event.metaKey) && ['z', 'y'].includes(event.key.toLowerCase())) {
        event.preventDefault()
        const redo = event.shiftKey || event.key.toLowerCase() === 'y'
        setHistory(state => {
          const list = redo ? state.future : state.past
          if (!list.length) return state
          return redo ? { source: list[list.length - 1]!, past: [...state.past, state.source], future: state.future.slice(0, -1) }
            : { source: list[list.length - 1]!, past: state.past.slice(0, -1), future: [...state.future, state.source] }
        })
      }
    }
    const refresh = () => setCatalogs(loadCatalogs())
    window.addEventListener('keydown', listener)
    window.addEventListener('storage', refresh)
    window.addEventListener('focus', refresh)
    return () => { window.removeEventListener('keydown', listener); window.removeEventListener('storage', refresh); window.removeEventListener('focus', refresh) }
  }, [])
  function download() {
    const url = URL.createObjectURL(new Blob([history.source], { type: 'application/json' }))
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'progress.progress'; anchor.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  return <div className="progress-preview-shell">
    <header className="preview-app-header"><strong>HanShu <span>RPG Tool Kit</span></strong><span>进度流程 <i>/</i> 进度项目</span><button onClick={() => setCatalogs(loadCatalogs())}>刷新脚本目录</button><button onClick={download}>导出 .progress</button></header>
    <div className="preview-app-body"><aside className="preview-app-sidebar"><div className="preview-sidebar-title">资源管理器</div><p>⌄　进度</p><button className="preview-file-active" onClick={() => setShowSource(false)}>◇　progress.progress</button><p>⌄　脚本 / 目标定义</p>{catalogs.goals.definitions.map(item => <span key={item.kind}>{item.sourceName} · {item.kind}</span>)}{!catalogs.goals.definitions.length && <span>当前工作区没有目标定义脚本</span>}<div className="preview-sidebar-actions"><button onClick={() => change(stringifyProgress(createProgress()))}>新建空白</button><button onClick={() => setShowSource(value => !value)}>{showSource ? '返回表单' : '查看数据'}</button><a href="/" target="_blank" rel="noreferrer">打开工作区管理脚本</a></div></aside>
      <main className="flow-workspace"><div className="preview-file-tab">◇　{doc.name || '新建进度'}.progress <span>表单</span></div>
        {catalogs.error && <p role="alert">{catalogs.error}</p>}
        {showSource ? <pre className="preview-source">{history.source}</pre> : <ProgressEditor doc={doc} goalCatalog={catalogs.goals} kitOptions={catalogs.kits} onChange={change} />}
      </main>
    </div><footer className="preview-app-footer"><span>试用页 · Goal 来自当前工作区脚本 · 表单修改不写入工程</span></footer>
  </div>
}
const root = createRoot(document.getElementById('root')!)
root.render(<App />)
if (import.meta.hot) import.meta.hot.dispose(() => root.unmount())
