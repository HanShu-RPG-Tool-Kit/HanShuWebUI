import type { LevelDocument } from './levelDoc'
import { areaShapeLabel } from './levelLayoutModel'
import type { LevelSelection } from './levelVolumeEdit'

export function LevelObjectTree({
  doc,
  selection,
  openRegions,
  onToggleRegion,
  onSelectRegion,
  onSelectVolume,
  onSelectLandmark,
}: {
  doc: LevelDocument
  selection: LevelSelection
  openRegions: ReadonlySet<string>
  onToggleRegion: (id: string) => void
  onSelectRegion: (id: string) => void
  onSelectVolume: (id: string, area: number) => void
  onSelectLandmark: (id: string) => void
}) {
  const empty = doc.regions.length === 0 && doc.landmarks.length === 0
  return (
    <div className="level-tree-scroll">
      <div className="level-tree-list" role="tree" aria-label="地图对象">
        {doc.regions.map((region) => {
          const open = openRegions.has(region.id)
          const regionCurrent = selection?.kind === 'region' && selection.id === region.id
          return (
            <div key={region.id} className="level-tree-region" role="treeitem" aria-expanded={open} aria-selected={regionCurrent}>
              <div className="level-tree-row">
                <button
                  type="button"
                  className="level-tree-twist"
                  aria-label={`${open ? '折叠' : '展开'}区域 ${region.id}`}
                  onClick={() => onToggleRegion(region.id)}
                >
                  {open ? '▾' : '▸'}
                </button>
                <button
                  type="button"
                  className={regionCurrent ? 'is-selected' : ''}
                  title={region.id}
                  onClick={() => onSelectRegion(region.id)}
                >
                  <span className="level-tree-id">{region.id}</span>
                  <small>{region.areas.length}</small>
                </button>
              </div>
              {open && region.areas.map((area, index) => {
                const selected = regionCurrent && selection.area === index
                const shape = areaShapeLabel(area.kind)
                return (
                  <button
                    key={`${region.id}:${index}`}
                    type="button"
                    className={selected ? 'level-tree-volume is-selected' : 'level-tree-volume'}
                    title={`${region.id} / 体积 ${index + 1}（${shape}）`}
                    role="treeitem"
                    aria-selected={selected}
                    aria-current={selected ? 'true' : undefined}
                    onClick={() => onSelectVolume(region.id, index)}
                  >
                    <ShapeMark kind={area.kind} />
                    <span className="level-tree-id">{index + 1} {shape}</span>
                    <small>{area.y === 'all' ? '全高' : '限高'}</small>
                  </button>
                )
              })}
            </div>
          )
        })}
        <h3>地标</h3>
        {doc.landmarks.map((point) => {
          const selected = selection?.kind === 'landmark' && selection.id === point.id
          return (
            <button
              key={point.id}
              type="button"
              className={selected ? 'level-tree-landmark is-selected' : 'level-tree-landmark'}
              role="treeitem"
              aria-selected={selected}
              aria-current={selected ? 'true' : undefined}
              title={point.id}
              onClick={() => onSelectLandmark(point.id)}
            >
              <ShapeMark kind="landmark" />
              <span className="level-tree-id">{point.id}</span>
            </button>
          )
        })}
        {empty && <p>在视图里画出区域或地标。</p>}
      </div>
    </div>
  )
}

function ShapeMark({ kind }: { kind: 'rect' | 'circle' | 'polygon' | 'landmark' }) {
  const label = kind === 'landmark' ? '地标' : areaShapeLabel(kind)
  return (
    <svg className={`level-shape is-${kind}`} viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
      <title>{label}</title>
      {kind === 'rect' && <rect x="1.5" y="2.5" width="9" height="7" />}
      {kind === 'circle' && <circle cx="6" cy="6" r="4" />}
      {kind === 'polygon' && <path d="M6 1.5 11 10.5H1Z" />}
      {kind === 'landmark' && <path d="M6 1.2 7.4 4.6 11 5 8.3 7.4 9.1 11 6 9.1 2.9 11 3.7 7.4 1 5l3.6-.4Z" />}
    </svg>
  )
}
