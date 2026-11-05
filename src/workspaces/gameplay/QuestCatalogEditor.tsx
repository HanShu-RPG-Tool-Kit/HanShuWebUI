import { useState } from 'react'
import { Panel, RemoveButton } from './KitEditor'
import { IconButton, JsonRepairPane, PendingBanner, RefBadge, errorText, useSheetDraft } from './SheetParts'
import {
  QUEST_CATALOG_FILE_NAME,
  QUEST_CATALOG_LABEL,
  QUEST_CATALOG_PATH,
  createQuestCatalog,
  createQuestCatalogDirectory,
  parseQuestCatalog,
  readQuestCatalogSource,
  stringifyQuestCatalog,
  type QuestCatalogDirectory,
  type QuestCatalogDocument,
} from './questCatalog'
import './ActorEditor.css'

export type QuestCatalogOption = { ref: string; label: string; key?: string }

export function QuestCatalogEditor({
  source,
  disabled,
  questOptions,
  resolveText,
  setText,
  onChange,
  onLocaleSeeds,
  onOpenQuest,
}: {
  source: string
  disabled?: boolean
  questOptions: QuestCatalogOption[]
  resolveText?: (key: string) => string
  setText?: (key: string, value: string) => void
  onChange: (source: string) => void
  onLocaleSeeds?: (seeds: Record<string, string>) => void
  onOpenQuest: (key: string) => void
}) {
  const parsed = readQuestCatalogSource(source)
  const [repairing, setRepairing] = useState(false)
  const { pending, commit, discard } = useSheetDraft(
    source,
    !!disabled,
    parseQuestCatalog,
    stringifyQuestCatalog,
    onChange,
  )
  const doc: QuestCatalogDocument = pending?.doc ?? parsed.doc ?? createQuestCatalog()
  const error = parsed.error
  const update = (patch: Partial<QuestCatalogDocument>) => commit({ ...doc, ...patch })

  if (error || repairing) {
    return <JsonRepairPane
      title={QUEST_CATALOG_LABEL}
      label={QUEST_CATALOG_PATH}
      source={source}
      error={error || '手动编辑 JSON'}
      disabled={!!disabled}
      apply={text => {
        try {
          parseQuestCatalog(text)
          setRepairing(false)
          onChange(text.endsWith('\n') ? text : `${text}\n`)
        } catch (cause) {
          throw new Error(errorText(cause))
        }
      }}
      onCancel={error ? undefined : () => setRepairing(false)}
    />
  }

  const addDirectory = () => {
    if (disabled) return
    const { directory, localeSeeds } = createQuestCatalogDirectory()
    update({ directories: [...doc.directories, directory] })
    onLocaleSeeds?.(localeSeeds)
  }

  const patchDirectory = (id: string, patch: Partial<QuestCatalogDirectory>) => {
    update({
      directories: doc.directories.map(directory =>
        directory.id === id ? { ...directory, ...patch } : directory,
      ),
    })
  }

  const toggleQuest = (directoryId: string, questId: string) => {
    const directory = doc.directories.find(item => item.id === directoryId)
    if (!directory || disabled) return
    const has = directory.quests.includes(questId)
    patchDirectory(directoryId, {
      quests: has
        ? directory.quests.filter(id => id !== questId)
        : [...directory.quests, questId],
    })
  }

  return <div className="flow-kit-pane sheet-editor actor-editor" aria-label={`${QUEST_CATALOG_LABEL}编辑器`}>
    <div className="kit-editor"><div className="kit-page sheet-page">
      <header className="kit-header sheet-header">
        <div className="sheet-heading">
          <h2>{QUEST_CATALOG_LABEL}</h2>
          <span className="sheet-kind">{QUEST_CATALOG_FILE_NAME}</span>
        </div>
        <span className="sheet-header-hint">固定路径 {QUEST_CATALOG_PATH} · 目录 id 自动生成 · 任务集合无序去重</span>
        <div className="sheet-header-actions">
          <button type="button" className="sheet-btn is-quiet" disabled={disabled} onClick={() => { discard(); setRepairing(true) }}>编辑 JSON</button>
          <button type="button" className="sheet-btn" disabled={disabled} onClick={addDirectory}>+ 添加目录</button>
        </div>
      </header>
      {pending && <PendingBanner issue={pending.issue} onDiscard={discard} />}
      {doc.directories.length === 0
        ? <p className="kit-empty">还没有分类目录。添加目录后，把任务加入集合即可在 UI 中按类浏览。</p>
        : doc.directories.map(directory => {
          const title = resolveText?.(directory.title) ?? ''
          const available = questOptions.filter(option => !directory.quests.includes(option.ref))
          return <Panel
            key={directory.id}
            title={title || '未命名目录'}
            subtitle={`id ${directory.id}`}
            count={directory.quests.length}
            className="actor-scripts"
            action={<select
              className="sheet-select actor-add-select"
              aria-label={`向${title || directory.id}添加任务`}
              value=""
              disabled={disabled}
              onChange={e => {
                if (e.target.value) toggleQuest(directory.id, e.target.value)
              }}
            >
              <option value="">{available.length ? '+ 添加任务…' : questOptions.length ? '已全部添加' : '没有可添加的任务'}</option>
              {available.map(option => (
                <option key={option.ref} value={option.ref}>{option.label}</option>
              ))}
            </select>}
          >
            <label className="kit-name-field">
              <span className="kit-name-label">标题</span>
              <input
                className="kit-title"
                aria-label="分类目录标题"
                placeholder="未命名目录"
                value={title}
                disabled={disabled || !setText}
                onChange={e => setText?.(directory.title, e.target.value)}
              />
            </label>
            {directory.quests.length === 0
              ? <p className="kit-empty">集合为空。从下拉添加任务；同一任务可出现在多个目录。</p>
              : <ul className="kit-list actor-script-list">
                {directory.quests.map(questId => {
                  const option = questOptions.find(item => item.ref === questId)
                  return <li key={questId} className={`kit-row actor-script-row${option ? '' : ' is-missing'}`}>
                    <span className="actor-script-name">
                      <code>{questId}</code>
                      {option && option.label !== questId && <small>{option.label}</small>}
                      <RefBadge missing={!option} />
                    </span>
                    {option?.key
                      ? <button type="button" className="sheet-btn is-quiet" onClick={() => onOpenQuest(option.key!)}>打开任务</button>
                      : <span />}
                    <span className="actor-row-tools">
                      <RemoveButton
                        label={`移除 ${questId}`}
                        disabled={disabled}
                        onClick={() => toggleQuest(directory.id, questId)}
                      />
                    </span>
                  </li>
                })}
              </ul>}
            <div className="actor-row-tools" style={{ marginTop: 8 }}>
              <IconButton
                label={`删除目录 ${title || directory.id}`}
                glyph="⌫"
                disabled={disabled}
                onClick={() => update({ directories: doc.directories.filter(item => item.id !== directory.id) })}
              />
            </div>
          </Panel>
        })}
      <p className="sheet-note is-info">
        <span>目录 id 对作者透明，标题走本地化键。任务集合无序去重；缺失引用导出时记为警告。同一任务可属于多个目录。</span>
      </p>
    </div></div>
  </div>
}
