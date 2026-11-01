import { isDisplayRegion, type BossbarComponent, type BossbarDocument } from '../protocol'
import { Button } from './BossbarEditorUi'

const TYPE_LABEL: Record<BossbarComponent['type'], string> = {
  display_region: '显示区域',
  background: '背景',
  bar: '数值条',
  text: '文本',
}

export function BossbarLayersPanel({
  document,
  selection,
  locked,
  hidden,
  readOnly,
  onSelectionChange,
  onLockToggle,
  onHiddenToggle,
  onReorder,
  onDuplicate,
  onRemove,
  onAdd,
}: {
  document: BossbarDocument
  selection: readonly string[]
  locked: readonly string[]
  hidden: readonly string[]
  readOnly: boolean
  onSelectionChange: (ids: string[]) => void
  onLockToggle: (id: string) => void
  onHiddenToggle: (id: string) => void
  onReorder: (id: string, direction: -1 | 1) => void
  onDuplicate: (id: string) => void
  onRemove: (id: string) => void
  onAdd: (type: 'background' | 'bar' | 'text') => void
}) {
  const region = document.components.find(isDisplayRegion) ?? null
  const paintables = document.components.filter((component) => !isDisplayRegion(component))

  const select = (id: string, additive: boolean) => {
    if (additive) {
      onSelectionChange(selection.includes(id) ? selection.filter((entry) => entry !== id) : [...selection, id])
      return
    }
    onSelectionChange([id])
  }

  return (
    <div className="bb-layers">
      <div className="bb-layers-head">
        <h4>图层</h4>
        <span className="bb-layers-count">{paintables.length}</span>
      </div>
      <ul className="bb-layer-list">
        {region && (
          <li
            className={'bb-layer bb-layer-region' + (selection.includes(region.id) ? ' is-selected' : '')}
            onClick={(event) => select(region.id, event.shiftKey || event.metaKey)}
          >
            <span className="bb-layer-icon">▣</span>
            <span className="bb-layer-name">
              显示区域
              <em>
                {Math.round(region.box.width)}×{Math.round(region.box.height)} @ {Math.round(region.box.x)},
                {Math.round(region.box.y)}
              </em>
            </span>
          </li>
        )}
        {[...paintables].reverse().map((component) => {
          const selected = selection.includes(component.id)
          return (
            <li
              key={component.id}
              className={'bb-layer' + (selected ? ' is-selected' : '') + (hidden.includes(component.id) ? ' is-hidden' : '')}
              onClick={(event) => select(component.id, event.shiftKey || event.metaKey)}
            >
              <span className="bb-layer-icon" data-type={component.type}>
                {component.type === 'background' ? '▤' : component.type === 'bar' ? '▬' : 'T'}
              </span>
              <span className="bb-layer-name">
                {component.id}
                <em>{TYPE_LABEL[component.type]}</em>
              </span>
              <span className="bb-layer-actions" onClick={(event) => event.stopPropagation()}>
                <button
                  type="button"
                  title={locked.includes(component.id) ? '解锁' : '锁定（仅本机）'}
                  className={locked.includes(component.id) ? 'is-on' : undefined}
                  onClick={() => onLockToggle(component.id)}
                >
                  {locked.includes(component.id) ? '🔒' : '🔓'}
                </button>
                <button
                  type="button"
                  title={hidden.includes(component.id) ? '显示（仅本机）' : '临时隐藏（仅本机）'}
                  className={hidden.includes(component.id) ? 'is-on' : undefined}
                  onClick={() => onHiddenToggle(component.id)}
                >
                  {hidden.includes(component.id) ? '◌' : '◉'}
                </button>
              </span>
            </li>
          )
        })}
      </ul>
      <div className="bb-layers-tools">
        <Button disabled={readOnly} onClick={() => onAdd('background')}>
          + 背景
        </Button>
        <Button disabled={readOnly} onClick={() => onAdd('bar')}>
          + 数值条
        </Button>
        <Button disabled={readOnly} onClick={() => onAdd('text')}>
          + 文本
        </Button>
      </div>
      {selection.length === 1 && selection[0] !== region?.id && (
        <div className="bb-layers-tools">
          <Button disabled={readOnly} onClick={() => onReorder(selection[0], 1)} title="向前一层">
            ↑ 上移
          </Button>
          <Button disabled={readOnly} onClick={() => onReorder(selection[0], -1)} title="向后一层">
            ↓ 下移
          </Button>
          <Button disabled={readOnly} onClick={() => onDuplicate(selection[0])}>
            复制
          </Button>
          <Button disabled={readOnly} variant="danger" onClick={() => onRemove(selection[0])}>
            删除
          </Button>
        </div>
      )}
    </div>
  )
}
