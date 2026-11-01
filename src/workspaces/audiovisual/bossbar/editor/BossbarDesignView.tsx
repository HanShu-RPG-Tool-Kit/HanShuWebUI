import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  inspectBossbar,
  parseBossbarDocument,
  stringifyBossbar,
  upgradeBossbarV1,
  describeDiagnostic,
  type BossbarInspection,
} from '../parse'
import {
  isPaintable,
  type BossbarBox,
  type BossbarDiagnostic,
  type BossbarDocument,
  type BossbarValueMap,
  type BossbarVariable,
} from '../protocol'
import {
  addComponent,
  allocateComponentId,
  createComponent,
  displayRegionOf,
  duplicateComponent,
  fitRegionToComponents,
  moveComponent,
  removeComponent,
  translateAll,
  updateComponent,
} from '../document'
import { evaluateBars } from '../render/animation'
import { resolveValues } from '../rules/values'
import type { BossbarBarView } from '../render/scene'
import { ALIGN_ACTIONS, alignBoxes, clampMoveDelta, movableSelection, unionBox, type AlignAction, type ViewTransform } from './editorGeometry'
import {
  buildScenarios,
  defaultsForVariables,
  loadEditorViewState,
  saveEditorViewState,
  useBossbarHistory,
  edgeCaseScenarios,
  type BossbarEditorViewState,
} from './editorState'
import { BossbarCanvasStage } from './BossbarCanvasStage'
import { BossbarLayersPanel } from './BossbarLayersPanel'
import { BossbarInspector, type BossbarPaintSlot } from './BossbarInspector'
import { BossbarVariablesPanel } from './BossbarVariablesPanel'
import { BossbarAtlasPanel, type BossbarUvTarget } from './BossbarAtlasPanel'
import { BossbarSimulationControls } from './BossbarSimulationControls'
import { Button } from './BossbarEditorUi'
import { useBossbarTexture, useReferenceImage } from './useBossbarImages'
import { updatePaintUv } from './editorPaint'
import '../BossbarEditor.css'

/**
 * 设计视图总装。
 *
 * 源码是唯一草稿：任何编辑都先序列化成规范文档并完整校验，通过后才写回草稿。
 * 设计视图不接受非法状态（缺显示区域、组件越界、UV 越界等），
 * 源码视图里的非法原文不会被这里悄悄覆盖。
 */

const ALIGN_LABELS: Record<AlignAction, string> = {
  left: '左对齐',
  'center-x': '水平居中',
  right: '右对齐',
  top: '顶对齐',
  'middle-y': '垂直居中',
  bottom: '底对齐',
  'distribute-x': '水平等距',
  'distribute-y': '垂直等距',
}

export function BossbarDesignView({
  fileId,
  fileName,
  content,
  readOnly,
  projectId,
  packageId,
  assets,
  active,
  onChange,
}: {
  fileId: string
  fileName: string
  content: string
  readOnly: boolean
  projectId: string
  packageId: string | null
  assets: readonly { path: string; mime: string }[]
  active: boolean
  onChange: (content: string) => void
}) {
  const inspection: BossbarInspection = useMemo(() => inspectBossbar(content), [content])
  const [lastValid, setLastValid] = useState<BossbarDocument | null>(
    inspection.status === 'ok' ? inspection.document : null,
  )
  useEffect(() => {
    if (inspection.status === 'ok') setLastValid(inspection.document)
  }, [inspection])

  const document = inspection.status === 'ok' ? inspection.document : lastValid
  const sourceValid = inspection.status === 'ok'
  const editable = sourceValid && !readOnly

  const [view, setViewState] = useState<BossbarEditorViewState>(() =>
    loadEditorViewState(projectId, fileId),
  )
  useEffect(() => {
    setViewState(loadEditorViewState(projectId, fileId))
  }, [fileId, projectId])
  const setView = useCallback(
    (change: Partial<BossbarEditorViewState> | ((previous: BossbarEditorViewState) => BossbarEditorViewState)) => {
      setViewState((previous) => {
        const next = typeof change === 'function' ? change(previous) : { ...previous, ...change }
        saveEditorViewState(projectId, fileId, next)
        return next
      })
    },
    [fileId, projectId],
  )

  const [selection, setSelection] = useState<string[]>([])
  const [draftBoxes, setDraftBoxes] = useState<Record<string, BossbarBox> | null>(null)
  const draftRef = useRef<Record<string, BossbarBox> | null>(null)
  const [problems, setProblems] = useState<string[]>([])
  const [uvTarget, setUvTarget] = useState<BossbarUvTarget | null>(null)
  const [values, setValues] = useState<BossbarValueMap>(() =>
    document ? defaultsForVariables(document) : {},
  )
  const [playing, setPlaying] = useState(true)
  const [timeMs, setTimeMs] = useState(0)
  const [fitRequest, setFitRequest] = useState(0)

  const history = useBossbarHistory(content)

  const previousVariablesRef = useRef(document?.variables ?? {})
  useEffect(() => {
    if (!document) return
    const previousVariables = previousVariablesRef.current
    previousVariablesRef.current = document.variables
    setValues((previous) => {
      const next = defaultsForVariables(document)
      for (const name of Object.keys(next)) {
        if (previousVariables[name]?.type === document.variables[name].type) {
          if (Object.hasOwn(previous, name)) next[name] = previous[name]
          else delete next[name]
        }
      }
      return Object.keys(previous).length === Object.keys(next).length &&
        Object.keys(next).every((name) => next[name] === previous[name]) ? previous : next
    })
  }, [document])

  const resolved = useMemo(
    () => document ? resolveValues(document, values) : { values: {}, issues: [] },
    [document, values],
  )

  const textureContext = projectId + ':' + fileId
  const texture = useBossbarTexture(document?.texture ?? '', textureContext)
  const referenceImage = useReferenceImage(packageId, view.referenceAsset, textureContext)

  const animationRef = useRef<ReturnType<typeof evaluateBars>['state'] | null>(null)
  const bars = useMemo<Record<string, BossbarBarView>>(() => {
    if (!document) return {}
    const result = evaluateBars(animationRef.current, document, resolved.values, timeMs)
    animationRef.current = result.state
    return result.view
  }, [document, timeMs, resolved.values])

  useEffect(() => {
    if (!playing || !active) return
    let frame = 0
    let last = performance.now()
    const tick = (now: number) => {
      const delta = now - last
      last = now
      setTimeMs((value) => value + delta * view.playbackSpeed)
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [active, playing, view.playbackSpeed])

  const effectiveDocument = useMemo<BossbarDocument | null>(() => {
    if (!document) return null
    if (!draftBoxes) return document
    return {
      ...document,
      components: document.components.map((component) =>
        draftBoxes[component.id] ? { ...component, box: draftBoxes[component.id] } : component,
      ),
    }
  }, [document, draftBoxes])

  const applyDocument = useCallback(
    (next: BossbarDocument, options: { history?: boolean } = {}) => {
      if (!editable) return
      const canonical = stringifyBossbar(next)
      if (canonical === content) return
      const parsed = parseBossbarDocument(canonical)
      if (!parsed.ok) {
        setProblems(parsed.diagnostics.map(describeDiagnostic))
        return
      }
      setProblems([])
      if (options.history !== false) history.commit(canonical)
      onChange(canonical)
    },
    [content, editable, history, onChange],
  )

  const handleBoxes = useCallback(
    (changes: Record<string, BossbarBox>, done: boolean) => {
      if (done) {
        const merged = draftRef.current
        draftRef.current = null
        setDraftBoxes(null)
        if (!merged || !document) return
        const next: BossbarDocument = {
          ...document,
          components: document.components.map((component) =>
            merged[component.id] ? { ...component, box: merged[component.id] } : component,
          ),
        }
        applyDocument(next)
        return
      }
      const merged = { ...(draftRef.current ?? {}), ...changes }
      draftRef.current = merged
      setDraftBoxes(merged)
    },
    [applyDocument, document],
  )

  const nudge = useCallback(
    (dx: number, dy: number) => {
      if (!document || !editable || !selection.length) return
      const region = displayRegionOf(document)
      const selected = movableSelection(document.components, selection, view.locked)
      if (!selected.length) return
      const { x: stepX, y: stepY } = clampMoveDelta(selected.map((component) => component.box), { x: dx, y: dy }, region?.box ?? null)
      if (stepX === 0 && stepY === 0) return
      const movingIds = new Set(selected.map((component) => component.id))
      applyDocument({
        ...document,
        components: document.components.map((component) =>
          movingIds.has(component.id)
            ? { ...component, box: { ...component.box, x: component.box.x + stepX, y: component.box.y + stepY } }
            : component,
        ),
      })
    },
    [applyDocument, document, editable, selection, view.locked],
  )

  const removeSelected = useCallback(() => {
    if (!document || !editable) return
    let next = document
    for (const id of selection) {
      const result = removeComponent(next, id)
      if (result.ok) next = result.document
    }
    if (next !== document) {
      applyDocument(next)
      setSelection([])
    }
  }, [applyDocument, document, editable, selection])

  const duplicateSelected = useCallback(() => {
    if (!document || !editable || selection.length !== 1) return
    const result = duplicateComponent(document, selection[0])
    if (result.ok) {
      applyDocument(result.document)
      const last = result.document.components[result.document.components.length - 1]
      if (last) setSelection([last.id])
    }
  }, [applyDocument, document, editable, selection])

  useEffect(() => {
    if (!active || readOnly) return
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable || target.tagName === 'SELECT')) {
        return
      }
      const meta = event.metaKey || event.ctrlKey
      if (meta && event.key.toLowerCase() === 'z') {
        event.preventDefault()
        const restored = event.shiftKey ? history.redo() : history.undo()
        if (restored !== null) onChange(restored)
        return
      }
      if (meta && event.key.toLowerCase() === 'y') {
        event.preventDefault()
        const restored = history.redo()
        if (restored !== null) onChange(restored)
        return
      }
      if (meta && event.key.toLowerCase() === 'd') {
        event.preventDefault()
        duplicateSelected()
        return
      }
      if (event.key === 'Delete' || event.key === 'Backspace') {
        if (!selection.length) return
        event.preventDefault()
        removeSelected()
        return
      }
      const step = event.shiftKey ? 10 : 1
      if (event.key === 'ArrowLeft') {
        event.preventDefault()
        nudge(-step, 0)
      } else if (event.key === 'ArrowRight') {
        event.preventDefault()
        nudge(step, 0)
      } else if (event.key === 'ArrowUp') {
        event.preventDefault()
        nudge(0, -step)
      } else if (event.key === 'ArrowDown') {
        event.preventDefault()
        nudge(0, step)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [active, duplicateSelected, history, nudge, onChange, readOnly, removeSelected, selection])

  const scenarios = useMemo(
    () => (document ? [...buildScenarios(document), ...edgeCaseScenarios(document)] : []),
    [document],
  )

  const referenceAssets = useMemo(
    () => assets.filter((asset) => /.(png|jpg|jpeg)$/i.test(asset.path)).map((asset) => asset.path),
    [assets],
  )

  if (!document && inspection.status !== 'v1') {
    return (
      <div className="bb-design bb-design-broken">
        <div className="bb-banner bb-banner-error">
          <strong>无法显示设计视图</strong>
          <ul>
            {inspection.status === 'invalid' &&
              inspection.diagnostics.slice(0, 8).map((diagnostic) => (
                <li key={diagnostic.path + diagnostic.code}>{describeDiagnostic(diagnostic)}</li>
              ))}
            {inspection.status === 'unsupported' && <li>不支持 version {String(inspection.version)}</li>}
          </ul>
        </div>
      </div>
    )
  }

  const region = document ? displayRegionOf(document) : null

  return (
    <div className="bb-design" aria-label={'BossBar 设计视图 ' + fileName}>
      {inspection.status === 'v1' && (
        <div className="bb-banner">
          <strong>这是 v1 文档</strong>
          <span>升级将修改草稿，保存后生效。</span>
          <Button
            variant="primary"
            disabled={readOnly}
            onClick={() => {
              const upgraded = upgradeBossbarV1({
                format: 'hanshu.bossbar',
                version: 1,
                id: inspection.document.id,
              })
              const next = stringifyBossbar(upgraded)
              history.commit(next)
              onChange(next)
            }}
          >
            升级为可视化血条
          </Button>
        </div>
      )}
      {document && inspection.status !== 'v1' && (
        <>
          {!sourceValid && (
            <div className="bb-banner">
              <strong>源码当前无效</strong>
              <span>显示上次有效预览，请修复 JSON 后继续编辑。</span>
              {inspection.status === 'invalid' && <ul>{inspection.diagnostics.slice(0, 8).map((diagnostic) =>
                <li key={diagnostic.path + diagnostic.code}>{describeDiagnostic(diagnostic)}</li>,
              )}</ul>}
            </div>
          )}
          {problems.length > 0 && (
            <div className="bb-banner bb-banner-error">
              <strong>无法应用修改</strong>
              <ul>
                {problems.slice(0, 6).map((problem, index) => (
                  <li key={index}>{problem}</li>
                ))}
              </ul>
            </div>
          )}
          <div className="bb-design-body">
            <BossbarLayersPanel
              document={document}
              selection={selection}
              locked={view.locked}
              hidden={view.hidden}
              readOnly={!editable}
              onSelectionChange={setSelection}
              onLockToggle={(id) =>
                setView((previous) => ({
                  ...previous,
                  locked: previous.locked.includes(id)
                    ? previous.locked.filter((entry) => entry !== id)
                    : [...previous.locked, id],
                }))
              }
              onHiddenToggle={(id) =>
                setView((previous) => ({
                  ...previous,
                  hidden: previous.hidden.includes(id)
                    ? previous.hidden.filter((entry) => entry !== id)
                    : [...previous.hidden, id],
                }))
              }
              onReorder={(id, direction) => {
                const index = document.components.findIndex((component) => component.id === id)
                if (index < 0) return
                applyDocument(moveComponent(document, id, index + direction))
              }}
              onDuplicate={(id) => {
                const result = duplicateComponent(document, id)
                if (result.ok) applyDocument(result.document)
              }}
              onRemove={(id) => {
                const result = removeComponent(document, id)
                if (result.ok) {
                  applyDocument(result.document)
                  setSelection((previous) => previous.filter((entry) => entry !== id))
                }
              }}
              onAdd={(type) => {
                if (!region) return
                const id = allocateComponentId(document, type)
                const component = createComponent(type, id, region.box)
                applyDocument(addComponent(document, component))
                setSelection([id])
              }}
            />
            <div className="bb-design-center">
              <div className="bb-toolbar">
                <span className="bb-toolbar-group">
                  <Button disabled={readOnly || !history.canUndo} onClick={() => {
                    const restored = history.undo()
                    if (restored !== null) onChange(restored)
                  }}>
                    撤销
                  </Button>
                  <Button disabled={readOnly || !history.canRedo} onClick={() => {
                    const restored = history.redo()
                    if (restored !== null) onChange(restored)
                  }}>
                    重做
                  </Button>
                </span>
                <span className="bb-toolbar-group">
                  <Button onClick={() => setView({ zoom: Math.max(0.1, view.zoom / 1.25) })}>−</Button>
                  <span className="bb-tag">{Math.round(view.zoom * 100)}%</span>
                  <Button onClick={() => setView({ zoom: Math.min(16, view.zoom * 1.25) })}>＋</Button>
                  <Button
                    onClick={() => setFitRequest((request) => request + 1)}
                  >
                    定位显示区域
                  </Button>
                </span>
                <span className="bb-toolbar-group">
                  <label className="bb-toggle">
                    <input
                      type="checkbox"
                      checked={view.showGrid}
                      onChange={(event) => setView({ showGrid: event.target.checked })}
                    />
                    <span>网格</span>
                  </label>
                  <input
                    className="bb-grid-size"
                    type="number"
                    min={1}
                    max={64}
                    value={view.grid}
                    onChange={(event) => setView({ grid: Math.max(1, Number(event.target.value) || 1) })}
                  />
                  <Button onClick={() => setView({ panX: 0, panY: 0, zoom: 1 })}>回到原点</Button>
                </span>
                {selection.length > 1 && (
                  <span className="bb-toolbar-group bb-toolbar-align">
                    {ALIGN_ACTIONS.map((action) => (
                      <Button
                        key={action}
                        disabled={!editable}
                        onClick={() => {
                          const boxes = document.components.filter(
                            (component) => selection.includes(component.id) && isPaintable(component),
                          )
                          if (boxes.length < 2) return
                          const aligned = alignBoxes(boxes.map((component) => component.box), action)
                          const byId = new Map(boxes.map((component, index) => [component.id, aligned[index]]))
                          applyDocument({
                            ...document,
                            components: document.components.map((component) =>
                              byId.has(component.id) ? { ...component, box: byId.get(component.id)! } : component,
                            ),
                          })
                        }}
                      >
                        {ALIGN_LABELS[action]}
                      </Button>
                    ))}
                    <span className="bb-tag">
                      并集 {Math.round(unionBox(document.components.filter((component) => selection.includes(component.id)).map((component) => component.box))?.width ?? 0)}×
                      {Math.round(unionBox(document.components.filter((component) => selection.includes(component.id)).map((component) => component.box))?.height ?? 0)}
                    </span>
                  </span>
                )}
              </div>
              <BossbarCanvasStage
                key={projectId + ':' + fileId}
                document={effectiveDocument ?? document}
                values={resolved.values}
                bars={bars}
                timeMs={timeMs}
                texture={texture.image}
                textureWidth={texture.size.width}
                textureHeight={texture.size.height}
                view={{ zoom: view.zoom, panX: view.panX, panY: view.panY } as ViewTransform}
                fitRequest={fitRequest}
                grid={view.grid}
                showGrid={view.showGrid}
                showRulers={view.showRulers}
                locked={view.locked}
                hidden={view.hidden}
                selection={selection}
                reference={{ image: referenceImage, opacity: view.referenceOpacity }}
                onSelectionChange={setSelection}
                onBoxesChange={handleBoxes}
                onViewChange={(next) =>
                  setView({ zoom: next.zoom, panX: next.panX, panY: next.panY })
                }
              />
              <BossbarSimulationControls
                document={document}
                timeMs={timeMs}
                playing={playing}
                speed={view.playbackSpeed}
                issues={[...(texture.error ? [texture.error] : []), ...resolved.issues.map(describeDiagnostic)]}
                scenarios={scenarios}
                onPlayingChange={setPlaying}
                onTimeChange={(nextTime) => {
                  if (nextTime < timeMs) animationRef.current = null
                  setTimeMs(nextTime)
                }}
                onSpeedChange={(speed) => setView({ playbackSpeed: speed })}
                onScenario={(scenario) => {
                  const toggleName = scenario.id.startsWith('toggle-') ? scenario.id.slice('toggle-'.length) : null
                  setValues(toggleName
                    ? { ...values, [toggleName]: { type: 'bool', value: resolved.values[toggleName]?.value !== true } }
                    : { ...scenario.values })
                  setPlaying(true)
                }}
              />
            </div>
            <aside className="bb-side">
              <div className="bb-tabs">
                {(
                  [
                    ['component', '属性'],
                    ['variables', '变量'],
                    ['atlas', '图集'],
                  ] as const
                ).map(([id, label]) => (
                  <button
                    key={id}
                    type="button"
                    className={view.inspectorTab === id ? 'is-active' : undefined}
                    onClick={() => setView({ inspectorTab: id })}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <div className="bb-tab-body">
                {view.inspectorTab === 'component' && (
                  <BossbarInspector
                    document={document}
                    selection={selection}
                    texture={texture.size}
                    readOnly={!editable}
                    onChange={applyDocument}
                    onMoveAll={(dx, dy) => applyDocument(translateAll(document, dx, dy))}
                    onFitRegion={() => {
                      const result = fitRegionToComponents(document)
                      if (result.ok) applyDocument(result.document)
                    }}
                    onFocusRegion={() => setFitRequest((request) => request + 1)}
                    onPickUv={(slot, frameIndex) => {
                      if (selection.length !== 1) return
                      setUvTarget({ componentId: selection[0], slot, frameIndex })
                      setView({ inspectorTab: 'atlas' })
                    }}
                  />
                )}
                {view.inspectorTab === 'variables' && (
                  <BossbarVariablesPanel
                    document={document}
                    values={values}
                    readOnly={!editable}
                    onDocumentChange={applyDocument}
                    onValuesChange={setValues}
                    onSelectComponent={(id) => {
                      setSelection([id])
                      setView({ inspectorTab: 'component' })
                    }}
                  />
                )}
                {view.inspectorTab === 'atlas' && (
                  <BossbarAtlasPanel
                    document={document}
                    textureImage={texture.image}
                    textureSize={texture.size}
                    target={uvTarget}
                    readOnly={!editable}
                    onProblems={setProblems}
                    onClearTarget={() => setUvTarget(null)}
                    onTextureChange={(base64) => {
                      applyDocument({ ...document, texture: base64 })
                    }}
                    onUvChange={(uv) => {
                      if (!uvTarget) return
                      const component = document.components.find((entry) => entry.id === uvTarget.componentId)
                      if (!component) return
                      if (uvTarget.slot === 'paint' && component.type === 'background' && component.paint.kind === 'texture') {
                        applyDocument(
                          updateComponent(document, component.id, {
                            paint: updatePaintUv(component.paint, uv, uvTarget.frameIndex),
                          } as Partial<typeof component>),
                        )
                        return
                      }
                      if (component.type === 'bar') {
                        if (uvTarget.slot === 'fill' && component.fill.kind === 'texture') {
                          applyDocument(
                            updateComponent(document, component.id, {
                              fill: updatePaintUv(component.fill, uv, uvTarget.frameIndex),
                            } as Partial<typeof component>),
                          )
                          return
                        }
                        if (uvTarget.slot === 'trail' && component.trail && component.trail.paint.kind === 'texture') {
                          applyDocument(
                            updateComponent(document, component.id, {
                              trail: {
                                ...component.trail,
                                paint: updatePaintUv(component.trail.paint, uv, uvTarget.frameIndex),
                              },
                            } as Partial<typeof component>),
                          )
                        }
                      }
                    }}
                  />
                )}
              </div>
            </aside>
          </div>
          <footer className="bb-design-footer">
            <label className="bb-footer-field">
              <span>参考底图</span>
              <select
                className="bb-input"
                value={view.referenceAsset ?? ''}
                onChange={(event) => setView({ referenceAsset: event.target.value || null })}
              >
                <option value="">无</option>
                {referenceAssets.map((path) => (
                  <option key={path} value={path}>
                    {path}
                  </option>
                ))}
              </select>
            </label>
            {view.referenceAsset && <label className="bb-footer-field">
              <span>透明度</span>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={view.referenceOpacity}
                onChange={(event) => setView({ referenceOpacity: Number(event.target.value) })}
              />
            </label>}
            <span className="bb-footer-sep" />
            <Button
              disabled={!editable}
              onClick={() => applyDocument({ ...document, variables: document.variables })}
            >
              整理 JSON
            </Button>
          </footer>
        </>
      )}
      {inspection.status === 'unsupported' && (
        <div className="bb-banner bb-banner-error">
          <strong>不支持的协议版本</strong>
          <span>请在 JSON 视图检查版本。</span>
        </div>
      )}
    </div>
  )
}

export type { BossbarDiagnostic, BossbarVariable, BossbarPaintSlot }
