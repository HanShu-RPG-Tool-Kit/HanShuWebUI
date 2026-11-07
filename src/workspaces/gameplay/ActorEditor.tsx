import { useState, type MouseEvent } from 'react'
import { AddButton, ItemCatalogContext, ItemList, KitTagField, Panel, RemoveButton } from './KitEditor'
import { ConditionRulesEditor } from './ConditionRulesEditor'
import { IconButton, JsonRepairPane, PendingBanner, RefBadge, SheetField, SheetToggle, useSheetDraft } from './SheetParts'
import {
  ACTOR_DESPAWN_MODES,
  actorLootRowToKitItem,
  createActor,
  createActorLootItemRow,
  kitItemToActorLootRow,
  parseActor,
  stringifyActor,
  type ActorDialogue,
  type ActorDialogueEntry,
  type ActorDespawnMode,
  type ActorDisplaySpec,
  type ActorDocument,
  type ActorInteractService,
  type ActorLootItemRow,
  type ActorLootItemSpec,
  type ActorLootSpec,
  type ActorLootXp,
  type ActorLootXpMode,
  type ActorReputationSpec,
  type ProgressConditionRule,
} from './actor'
import type { ItemCatalog } from './kit'
import './ActorEditor.css'
import './ProgressEditor.css'

const ENTRY_ROW_CONTROLS = 'input,select,textarea,button,a,label,.actor-row-tools,.actor-ref-field'
const whenSummary = (when: ProgressConditionRule[]) => when.length ? `${when.length} 项条件` : '恒真'

type RefOption = { ref: string; label: string; key?: string }

type SideEffectUiMode = 'omit' | 'set' | 'clear'

const SIDE_EFFECT_UI_MODES: { id: SideEffectUiMode; label: string }[] = [
  { id: 'omit', label: '不修改' },
  { id: 'set', label: '写入' },
  { id: 'clear', label: '清除' },
]

const LOOT_XP_MODES: { id: ActorLootXpMode; label: string; unit: string }[] = [
  { id: 'leave', label: '跟原版', unit: '' },
  { id: 'dropXp', label: '掉经验球', unit: '点' },
  { id: 'giveXp', label: '直接给经验', unit: '点' },
  { id: 'giveLv', label: '直接给等级', unit: '级' },
]

type LootItemMode = 'vanilla' | 'append' | 'replace'

const LOOT_ITEM_MODES: { id: LootItemMode; label: string; hint: string }[] = [
  { id: 'vanilla', label: '跟原版', hint: '不改动原版掉落' },
  { id: 'append', label: '追加', hint: '原版照掉，再掷下列掉落' },
  { id: 'replace', label: '替换', hint: '清空原版掉落（含装备），只掷下列掉落' },
]

function displayModeOf(value: ActorDisplaySpec | null | undefined): SideEffectUiMode {
  return !value || value.mode === 'leave' ? 'omit' : value.mode
}

function reputationModeOf(value: ActorReputationSpec | null | undefined): SideEffectUiMode {
  return !value || value.mode === 'leave' ? 'omit' : value.mode
}

function lootItemModeOf(value: ActorLootItemSpec | null | undefined): LootItemMode {
  return !value ? 'vanilla' : value.leave ? 'append' : 'replace'
}

function nextDisplay(mode: SideEffectUiMode, previous: ActorDisplaySpec | null): ActorDisplaySpec | null {
  if (mode === 'omit') return null
  if (mode === 'set') return previous?.mode === 'set' ? previous : { mode: 'set', title: '', subtitle: '' }
  return { mode }
}

function nextReputation(mode: SideEffectUiMode, previous: ActorReputationSpec | null): ActorReputationSpec | null {
  if (mode === 'omit') return null
  if (mode === 'set') return previous?.mode === 'set' ? previous : { mode: 'set', id: '' }
  return { mode }
}

function nextLootXp(mode: ActorLootXpMode, previous: ActorLootXp | null): ActorLootXp | undefined {
  if (mode === 'leave') return previous?.mode === 'leave' ? previous : undefined
  return { mode, amount: previous && previous.mode !== 'leave' ? previous.amount : 0 }
}

function nextLootItem(mode: LootItemMode, previous: ActorLootItemSpec | null, stashed: ActorLootItemRow[]): ActorLootItemSpec | undefined {
  if (mode === 'vanilla') return undefined
  return { leave: mode === 'append', items: previous?.items ?? stashed }
}

const percentOf = (chance: number) => Number((chance * 100).toFixed(2))
const chanceOf = (percent: number) => Number((Math.min(100, Math.max(0, percent)) / 100).toFixed(4))

function patchLoot(loot: ActorLootSpec | null, patch: Partial<ActorLootSpec>): ActorLootSpec {
  return { ...(loot ?? {}), ...patch }
}

function ModeSelect({
  label, value, disabled, onChange,
}: {
  label: string
  value: SideEffectUiMode
  disabled: boolean
  onChange(mode: SideEffectUiMode): void
}) {
  return <select className="sheet-select" aria-label={label} disabled={disabled} value={value} onChange={e => onChange(e.target.value as SideEffectUiMode)}>
    {SIDE_EFFECT_UI_MODES.map(mode => <option key={mode.id} value={mode.id}>{mode.label}</option>)}
  </select>
}

function swap<T>(list: T[], index: number, delta: number): T[] {
  const next = [...list], target = index + delta
  ;[next[index], next[target]] = [next[target], next[index]]
  return next
}

function InjectSelect({ label, value, options, disabled, onChange }: { label: string; value: string; options: RefOption[]; disabled: boolean; onChange: (value: string) => void }) {
  const known = !value || options.some(option => option.ref === value)
  return <span className="actor-ref-field">
    <select className="sheet-select" aria-label={label} aria-invalid={!value} disabled={disabled} value={value} onChange={e => onChange(e.target.value)}>
      <option value="">选择 @inject…</option>
      {options.map(option => <option key={option.ref} value={option.ref}>{option.label}</option>)}
      {!known && <option value={value}>{value}（未索引）</option>}
    </select>
    <RefBadge missing={!known} text="未索引" />
  </span>
}

function LootItemsEditor({
  items, disabled, onChange,
}: {
  items: ActorLootItemRow[]
  disabled: boolean
  onChange(items: ActorLootItemRow[]): void
}) {
  const patchRow = (index: number, patch: Partial<ActorLootItemRow>) => onChange(items.map((row, i) => i === index ? { ...row, ...patch } : row))
  return <ItemList
    className="actor-loot-items"
    items={items.map(row => ({ ...actorLootRowToKitItem(row), chance: row.chance, playerKill: row.playerKill }))}
    header
    disabled={disabled}
    emptyText="还没有掉落物 · 拖入 .item / .itemstack 或点右上角添加"
    extraColumns={{
      head: ['概率', '击杀者'],
      render: index => {
        const row = items[index], n = index + 1
        return <>
          <label className="actor-loot-chance">
            <input
              className="kit-num"
              type="number"
              min={0}
              max={100}
              step={5}
              aria-label={`掉落物品 ${n} 概率（%）`}
              disabled={disabled}
              value={percentOf(row.chance)}
              onChange={e => {
                const percent = Number(e.target.value)
                if (Number.isFinite(percent)) patchRow(index, { chance: chanceOf(percent) })
              }}
            />
            <span aria-hidden>%</span>
          </label>
          <button
            type="button"
            className={`kit-chip actor-loot-killer${row.playerKill ? ' has-value' : ''}`}
            aria-pressed={row.playerKill}
            aria-label={`掉落物品 ${n} 仅玩家击杀`}
            title={row.playerKill ? '仅玩家击杀时掉落' : '任何死因都掉落'}
            disabled={disabled}
            onClick={() => patchRow(index, { playerKill: !row.playerKill })}
          >{row.playerKill ? '仅玩家' : '任意'}</button>
        </>
      },
    }}
    onChange={next => onChange(next.map(item => kitItemToActorLootRow(item, 'chance' in item ? item as ActorLootItemRow : undefined)))}
  />
}

export function ActorEditor({
  source, disabled, onChange, scriptOptions, reputationOptions = [], shopOptions = [], injectOptions = [], itemCatalog, onOpenScript,
}: {
  source: string
  disabled: boolean
  onChange(source: string): void
  scriptOptions: RefOption[]
  reputationOptions?: RefOption[]
  shopOptions?: RefOption[]
  injectOptions?: RefOption[]
  itemCatalog?: ItemCatalog
  onOpenScript(key: string): void
}) {
  const [repairing, setRepairing] = useState(false)
  const [lootStash, setLootStash] = useState<ActorLootItemRow[]>([])
  const [expandedEntry, setExpandedEntry] = useState<number | null>(null)
  const { pending, commit, discard } = useSheetDraft(source, disabled, parseActor, stringifyActor, onChange)
  let parsed: ActorDocument = createActor(), error = ''
  try { parsed = parseActor(source) } catch (cause) { error = cause instanceof Error ? cause.message : String(cause) }
  if (error || repairing) return <JsonRepairPane
    key={error ? 'invalid' : 'manual'}
    title="演员模板"
    label="演员模板 JSON"
    source={source}
    error={error}
    disabled={disabled}
    apply={text => { onChange(stringifyActor(parseActor(text))); setRepairing(false) }}
    onCancel={error ? undefined : () => setRepairing(false)}
  />

  const doc = pending?.doc ?? parsed
  const update = (patch: Partial<ActorDocument>) => commit({ ...doc, ...patch })
  const display = doc.display ?? null
  const dialogue = doc.dialogue ?? null
  const service = doc.interactService ?? null
  const loot = doc.loot ?? null
  const lootItem = loot?.item ?? null
  const setDialogue = (next: Partial<ActorDialogue>) => { if (dialogue) update({ dialogue: { ...dialogue, ...next } }) }
  const setEntries = (entries: ActorDialogueEntry[]) => {
    setDialogue({ entries })
    if (expandedEntry != null && expandedEntry >= entries.length) setExpandedEntry(null)
  }
  const patchEntry = (index: number, patch: Partial<ActorDialogueEntry>) => {
    if (dialogue) setEntries(dialogue.entries.map((entry, i) => i === index ? { ...entry, ...patch } : entry))
  }
  const toggleEntry = (index: number) => setExpandedEntry(current => current === index ? null : index)
  const entryClick = (event: MouseEvent<HTMLElement>, index: number) => {
    if (!(event.target as Element).closest(ENTRY_ROW_CONTROLS)) toggleEntry(index)
  }
  const addDialogueEntry = () => {
    if (!dialogue) return
    const entries = [...dialogue.entries, { when: [] as ProgressConditionRule[], inject: '' }]
    setEntries(entries)
    setExpandedEntry(entries.length - 1)
  }
  const removeDialogueEntry = (index: number) => {
    if (!dialogue) return
    setEntries(dialogue.entries.filter((_, i) => i !== index))
    setExpandedEntry(current => {
      if (current == null) return null
      if (current === index) return null
      return current > index ? current - 1 : current
    })
  }
  const changeServiceType = (type: ActorInteractService['type']) => {
    if (service?.type === type) return
    update({ interactService: type === 'shop' ? { type: 'shop', param: { templates: [] } } : { type: 'vault', param: {} } })
  }
  const setShopTemplates = (templates: string[]) => update({ interactService: { type: 'shop', param: { templates } } })
  const setLoot = (next: ActorLootSpec | null) => update({ loot: next })
  const patchLootFields = (patch: Partial<ActorLootSpec>) => setLoot(patchLoot(loot, patch))
  const add = (label: string, onClick: () => void) => <AddButton label={label} disabled={disabled} onClick={onClick} />

  const availableScripts = scriptOptions.filter(option => !doc.scripts.includes(option.ref))
  const reputationId = doc.reputation?.mode === 'set' ? doc.reputation.id : ''
  const reputationMissing = !!reputationId && !reputationOptions.some(option => option.ref === reputationId)
  const shopTemplates = service?.type === 'shop' ? service.param.templates : []
  const availableShops = shopOptions.filter(option => !shopTemplates.includes(option.ref))
  const shopMissing = shopTemplates.filter(id => !shopOptions.some(option => option.ref === id))
  const talkIdIssue = dialogue && (!dialogue.talkId.trim() ? '必填' : dialogue.talkId.trim() === dialogue.playerRole.trim() ? '不能与玩家角色相同' : '')
  const playerRoleIssue = dialogue && !dialogue.playerRole.trim() ? '必填' : ''
  const reputationIdIssue = doc.reputation?.mode === 'set' && !reputationId.trim() ? '写入时必填阵营 ID' : ''

  const scriptPanel = <Panel title="演员脚本" subtitle="按列表顺序执行 · 共享同一实例黑板" count={doc.scripts.length} className="actor-scripts"
    action={<select className="sheet-select actor-add-select" aria-label="添加演员脚本" value="" disabled={disabled} onChange={e => { if (e.target.value) update({ scripts: [...doc.scripts, e.target.value] }) }}>
      <option value="">{availableScripts.length ? '+ 添加脚本…' : scriptOptions.length ? '已全部添加' : '没有演员脚本'}</option>
      {availableScripts.map(option => <option key={option.ref} value={option.ref}>{option.label}</option>)}
    </select>}>
    {doc.scripts.length === 0
      ? <p className="kit-empty">{scriptOptions.length ? '尚未绑定脚本。从右上角选择 src/script/actor 下的脚本。' : '项目中还没有演员脚本。在 src/script/actor 下新建 .js 后即可绑定。'}</p>
      : <ol className="kit-list actor-script-list">
        {doc.scripts.map((id, index) => {
          const option = scriptOptions.find(s => s.ref === id)
          return <li key={id} className={`kit-row actor-script-row${option ? '' : ' is-missing'}`}>
            <span className="kit-row-index">{index + 1}</span>
            <span className="actor-script-name">
              <code>{id}</code>
              {option && option.label !== id && <small>{option.label}</small>}
              <RefBadge missing={!option} />
            </span>
            {option?.key ? <button type="button" className="sheet-btn is-quiet" onClick={() => onOpenScript(option.key!)}>打开脚本</button> : <span />}
            <span className="actor-row-tools">
              <IconButton label={`上移 ${id}`} glyph="↑" disabled={disabled || index === 0} onClick={() => update({ scripts: swap(doc.scripts, index, -1) })} />
              <IconButton label={`下移 ${id}`} glyph="↓" disabled={disabled || index === doc.scripts.length - 1} onClick={() => update({ scripts: swap(doc.scripts, index, 1) })} />
              <RemoveButton label={`移除 ${id}`} disabled={disabled} onClick={() => update({ scripts: doc.scripts.filter(s => s !== id) })} />
            </span>
          </li>
        })}
      </ol>}
  </Panel>

  const displayPanel = <Panel title="显示名牌" subtitle="绑定时副作用" className={`sheet-panel${display?.mode === 'set' ? '' : display?.mode === 'clear' ? '' : ' is-off'}`}>
    <div className="sheet-panel-body">
      <SheetField label="副作用" hint="写入时 title／subtitle 可用 & 颜色码。">
        <ModeSelect label="名牌副作用" value={displayModeOf(display)} disabled={disabled} onChange={mode => update({ display: nextDisplay(mode, display) })} />
      </SheetField>
      {display?.mode === 'set' && <>
        <SheetField label="主标题"><input aria-label="名牌主标题" disabled={disabled} value={display.title} placeholder={'&6村长'} onChange={e => update({ display: { mode: 'set', title: e.target.value, subtitle: display.subtitle } })} /></SheetField>
        <SheetField label="副标题"><input aria-label="名牌副标题" disabled={disabled} value={display.subtitle} placeholder={'&7右键交谈'} onChange={e => update({ display: { mode: 'set', title: display.title, subtitle: e.target.value } })} /></SheetField>
      </>}
      {display?.mode === 'clear' && <p className="sheet-note">绑定时清除实体名牌。</p>}
      {(!display || display.mode === 'leave') && <p className="sheet-off">不修改实体名牌</p>}
      <p className="sheet-note">Boss 血条请在脚本中调用 <code>api.bossBar()</code>，不要写进模板。</p>
    </div>
  </Panel>

  const reputationPanel = <Panel title="声誉成员" subtitle={'reputations/<id>.rep'} className={`sheet-panel${doc.reputation?.mode === 'set' || doc.reputation?.mode === 'clear' ? '' : ' is-off'}`}>
    <div className="sheet-panel-body">
      <SheetField label="副作用" hint="写入需要已发布阵营 ID。">
        <ModeSelect label="声誉副作用" value={reputationModeOf(doc.reputation)} disabled={disabled} onChange={mode => update({ reputation: nextReputation(mode, doc.reputation ?? null) })} />
      </SheetField>
      {doc.reputation?.mode === 'set' && <SheetField label="阵营" invalid={!!reputationIdIssue || reputationMissing} hint={reputationIdIssue || (reputationMissing ? '找不到对应的 .rep 资源。' : '绑定时写入实体的阵营成员关系。')}>
        <span className="actor-ref-field">
          <select aria-label="声誉阵营" aria-invalid={!!reputationIdIssue || reputationMissing} disabled={disabled} value={reputationId} onChange={e => update({ reputation: { mode: 'set', id: e.target.value } })}>
            <option value="">选择阵营…</option>
            {reputationOptions.map(option => <option key={option.ref} value={option.ref}>{option.label}</option>)}
            {reputationMissing && <option value={reputationId}>{reputationId}（引用缺失）</option>}
          </select>
          <RefBadge missing={reputationMissing} />
        </span>
      </SheetField>}
      {doc.reputation?.mode === 'clear' && <p className="sheet-note">绑定时清除实体声誉成员。</p>}
      {(!doc.reputation || doc.reputation.mode === 'leave') && <p className="sheet-off">不修改声誉成员</p>}
    </div>
  </Panel>

  const dialoguePanel = <Panel title="对话路由" subtitle="脚本 interact 之后匹配 · 首条条件组全部满足的条目生效" count={dialogue ? dialogue.entries.length : undefined} className={`sheet-panel actor-dialogue${dialogue ? '' : ' is-off'}`}
    action={<>
      {dialogue && add('添加对话条目', addDialogueEntry)}
      <SheetToggle label="启用" ariaLabel="启用对话路由" checked={dialogue != null} disabled={disabled} onChange={on => { update({ dialogue: on ? { talkId: '', playerRole: '玩家', entries: [] } : null }); setExpandedEntry(null) }} />
    </>}>
    {dialogue ? <div className="sheet-panel-body">
      <div className="actor-dialogue-roles">
        <SheetField label="角色 ID" invalid={!!talkIdIssue} hint={talkIdIssue || '对话脚本中 NPC 的角色名'}><input aria-label="对话角色 ID" aria-invalid={!!talkIdIssue} disabled={disabled} value={dialogue.talkId} placeholder="村长" onChange={e => setDialogue({ talkId: e.target.value })} /></SheetField>
        <SheetField label="玩家角色 ID" invalid={!!playerRoleIssue} hint={playerRoleIssue || '对话脚本中代表玩家的角色名'}><input aria-label="对话玩家角色 ID" aria-invalid={!!playerRoleIssue} disabled={disabled} value={dialogue.playerRole} onChange={e => setDialogue({ playerRole: e.target.value })} /></SheetField>
      </div>
      <p className="sheet-note actor-dialogue-hint">点击条目展开条件组；与任务 visibility 同一套叶子，导出编译为表达式。</p>
      {dialogue.entries.length === 0
        ? <p className="kit-empty actor-dialogue-empty">没有对话条目，右键时直接落到交互服务。</p>
        : <ol className="actor-entries">
          {dialogue.entries.map((entry, entryIndex) => {
            const n = entryIndex + 1
            const open = expandedEntry === entryIndex
            const detailId = `actor-dialogue-detail-${entryIndex}`
            return <li key={entryIndex} className={`actor-entry${open ? ' is-expanded' : ''}${entry.inject ? '' : ' is-incomplete'}`}>
              <header
                className="actor-entry-head"
                role="button"
                tabIndex={0}
                aria-expanded={open}
                aria-controls={open ? detailId : undefined}
                onClick={e => entryClick(e, entryIndex)}
                onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleEntry(entryIndex) } }}
              >
                <span className="actor-entry-index" aria-hidden>#{n}</span>
                <span className="actor-entry-verb">进入</span>
                <InjectSelect label={`对话条目 ${n} 注入点`} value={entry.inject} options={injectOptions} disabled={disabled} onChange={inject => patchEntry(entryIndex, { inject })} />
                <span className="actor-entry-when-summary" title={whenSummary(entry.when)}>{whenSummary(entry.when)}</span>
                <span className="actor-row-tools">
                  <IconButton label={`上移对话条目 ${n}`} glyph="↑" disabled={disabled || entryIndex === 0} onClick={() => {
                    setEntries(swap(dialogue.entries, entryIndex, -1))
                    setExpandedEntry(current => current === entryIndex ? entryIndex - 1 : current === entryIndex - 1 ? entryIndex : current)
                  }} />
                  <IconButton label={`下移对话条目 ${n}`} glyph="↓" disabled={disabled || entryIndex === dialogue.entries.length - 1} onClick={() => {
                    setEntries(swap(dialogue.entries, entryIndex, 1))
                    setExpandedEntry(current => current === entryIndex ? entryIndex + 1 : current === entryIndex + 1 ? entryIndex : current)
                  }} />
                  <RemoveButton label={`移除对话条目 ${n}`} disabled={disabled} onClick={() => removeDialogueEntry(entryIndex)} />
                </span>
              </header>
              {open && <section className="actor-entry-detail progress-editor" id={detailId} role="region" aria-label={`对话条目 ${n} 条件组`}>
                <header className="actor-entry-detail-head">
                  <strong>条件组</strong>
                  <small>全部满足（AND）· 空组恒真</small>
                  <span className="actor-entry-detail-presets">
                    <button type="button" className="sheet-btn is-quiet" disabled={disabled} onClick={() => patchEntry(entryIndex, { when: [] })}>清空恒真</button>
                    <button type="button" className="sheet-btn is-quiet" disabled={disabled || !entry.inject} onClick={() => patchEntry(entryIndex, { when: [...entry.when, { kind: 'talk', op: 'unread', injectId: entry.inject }] })}>＋未读本条</button>
                    <button type="button" className="sheet-btn is-quiet" disabled={disabled || !entry.inject} onClick={() => patchEntry(entryIndex, { when: [...entry.when, { kind: 'talk', op: 'read', injectId: entry.inject }] })}>＋已读本条</button>
                  </span>
                  <button type="button" className="actor-entry-detail-close" aria-label={`收起对话条目 ${n} 条件组`} onClick={() => setExpandedEntry(null)}>收起 ▴</button>
                </header>
                <ConditionRulesEditor
                  title={`对话条目 ${n} 条件`}
                  rules={entry.when}
                  disabled={disabled}
                  emptyHint="没有条件，直接满足。"
                  onChange={when => patchEntry(entryIndex, { when })}
                />
              </section>}
            </li>
          })}
        </ol>}
      {!injectOptions.length && <p className="sheet-note">项目中还没有带 @inject 的 .hs 对话脚本，注入点只能手写到 JSON。</p>}
    </div> : <p className="sheet-off">未启用 · 右键不触发对话</p>}
  </Panel>

  const servicePanel = <Panel title="交互服务" subtitle="对话未命中后打开" className={`sheet-panel actor-service${service ? '' : ' is-off'}`}
    action={<SheetToggle label="启用" ariaLabel="启用交互服务" checked={service != null} disabled={disabled} onChange={on => update({ interactService: on ? { type: 'shop', param: { templates: [] } } : null })} />}>
    {service ? <div className="sheet-panel-body">
      <div className="actor-service-types" role="radiogroup" aria-label="交互服务类型">
        {([['shop', '商店', '打开一个或多个商店模板'], ['vault', '本地仓库', '打开玩家个人仓库，无需配置']] as const).map(([type, title, hint]) =>
          <button key={type} type="button" role="radio" aria-checked={service.type === type} className={`actor-service-type${service.type === type ? ' is-active' : ''}`} disabled={disabled} onClick={() => changeServiceType(type)}>
            <b>{title}</b><small>{hint}</small>
          </button>)}
      </div>
      {service.type === 'shop'
        ? <>
          <div className={`sheet-field actor-shop-field${!shopTemplates.length || shopMissing.length ? ' is-invalid' : ''}`} role="group" aria-label="商店模板">
            <div className="actor-shop-head">
              <span className="sheet-field-label">商店模板{shopTemplates.length > 0 && <span className="actor-shop-count">{shopTemplates.length}</span>}</span>
              <select
                className="sheet-select actor-add-select"
                aria-label="添加商店模板"
                value=""
                disabled={disabled}
                onChange={e => { if (e.target.value) setShopTemplates([...shopTemplates, e.target.value]) }}
              >
                <option value="">{availableShops.length ? '+ 添加商店…' : shopOptions.length ? '已全部添加' : '没有商店模板'}</option>
                {availableShops.map(option => <option key={option.ref} value={option.ref}>{option.label}</option>)}
              </select>
            </div>
            <div className={`actor-shop-templates${shopTemplates.length ? '' : ' is-empty'}`}>
              {shopTemplates.length === 0
                ? <p className="kit-empty">{shopOptions.length ? '尚未添加商店。从右上角选择 src/shop 下的模板。' : '项目中还没有商店模板。在 src/shop 下新建后即可添加。'}</p>
                : <ol className="kit-list">
                  {shopTemplates.map((id, index) => {
                    const option = shopOptions.find(s => s.ref === id)
                    return <li key={id} className={`kit-row actor-shop-row${option ? '' : ' is-missing'}`}>
                      <span className="kit-row-index">{index + 1}</span>
                      <span className="actor-script-name">
                        <code>{id}</code>
                        {option && option.label !== id && <small>{option.label}</small>}
                        <RefBadge missing={!option} />
                      </span>
                      <span className="actor-row-tools">
                        <IconButton label={`上移 ${id}`} glyph="↑" disabled={disabled || index === 0} onClick={() => setShopTemplates(swap(shopTemplates, index, -1))} />
                        <IconButton label={`下移 ${id}`} glyph="↓" disabled={disabled || index === shopTemplates.length - 1} onClick={() => setShopTemplates(swap(shopTemplates, index, 1))} />
                        <RemoveButton label={`移除 ${id}`} disabled={disabled} onClick={() => setShopTemplates(shopTemplates.filter(t => t !== id))} />
                      </span>
                    </li>
                  })}
                </ol>}
            </div>
            <small className="sheet-field-hint">{!shopTemplates.length
              ? '至少添加一个商店模板。'
              : shopMissing.length
                ? `找不到商店模板：${shopMissing.join('、')}。请移除或恢复对应文件。`
                : '多个商店按列表顺序显示为页签。'}</small>
          </div>
          <p className="sheet-note actor-shop-note">库存按模板的库存主体自动绑定：<b>无限</b> 不绑定 · <b>玩家</b> 当前交易玩家 · <b>游戏</b> 全局共享 · <b>角色</b> 本演员 ID。</p>
        </>
        : <p className="sheet-note">右键时打开该玩家的本地仓库。</p>}
    </div> : <p className="sheet-off">未启用 · 对话未命中时不做任何事</p>}
  </Panel>

  const lootXp = loot?.xp ?? null
  const lootXpMode = lootXp?.mode ?? 'leave'
  const lootXpUnit = LOOT_XP_MODES.find(mode => mode.id === lootXpMode)?.unit ?? ''
  const lootItemMode = lootItemModeOf(lootItem)
  const changeLootItemMode = (mode: LootItemMode) => {
    if (mode === lootItemMode) return
    if (mode === 'vanilla' && lootItem?.items.length) setLootStash(lootItem.items)
    patchLootFields({ item: nextLootItem(mode, lootItem, lootStash) })
  }
  const lootPanel = <Panel title="死亡掉落" subtitle="死亡时套用 · 先于脚本 hook" count={lootItem ? lootItem.items.length : undefined} className={`sheet-panel actor-loot${loot ? '' : ' is-off'}`}
    action={<>
      {lootItem && add('添加掉落物', () => patchLootFields({ item: { ...lootItem, items: [...lootItem.items, createActorLootItemRow()] } }))}
      <SheetToggle label="启用" ariaLabel="启用死亡掉落" checked={loot != null} disabled={disabled} onChange={on => setLoot(on ? {} : null)} />
    </>}>
    {loot ? <div className="sheet-panel-body">
      <div className="actor-loot-axes">
        <div className={`actor-loot-axis${lootXp && lootXp.mode !== 'leave' ? ' is-custom' : ''}`}>
          <span className="actor-loot-axis-label">经验</span>
          <div className="actor-loot-axis-controls">
            <select className="sheet-select actor-loot-xp-mode" aria-label="掉落经验模式" disabled={disabled} value={lootXpMode} onChange={e => patchLootFields({ xp: nextLootXp(e.target.value as ActorLootXpMode, lootXp) })}>
              {LOOT_XP_MODES.map(mode => <option key={mode.id} value={mode.id}>{mode.label}</option>)}
            </select>
            {lootXp && lootXp.mode !== 'leave' && <label className="actor-loot-amount">
              <input type="number" min={0} step={1} aria-label="掉落经验数量" disabled={disabled} value={lootXp.amount} onChange={e => {
                const amount = Number(e.target.value)
                if (Number.isFinite(amount) && amount >= 0) patchLootFields({ xp: { mode: lootXp.mode, amount } })
              }} />
              <span aria-hidden>{lootXpUnit}</span>
            </label>}
          </div>
          {lootXp && lootXp.mode !== 'leave' && <small className="actor-loot-axis-hint">替换原版经验 · 仅玩家击杀时结算</small>}
        </div>
        <div className={`actor-loot-axis${lootItem ? ' is-custom' : ''}`}>
          <span className="actor-loot-axis-label">物品</span>
          <div className="actor-loot-axis-controls actor-loot-segments" role="radiogroup" aria-label="掉落物品模式">
            {LOOT_ITEM_MODES.map(mode =>
              <button key={mode.id} type="button" role="radio" aria-checked={lootItemMode === mode.id} title={mode.hint} className={`actor-loot-segment${lootItemMode === mode.id ? ' is-active' : ''}`} disabled={disabled} onClick={() => changeLootItemMode(mode.id)}>{mode.label}</button>)}
          </div>
          {lootItem && <small className="actor-loot-axis-hint">{LOOT_ITEM_MODES.find(mode => mode.id === lootItemMode)?.hint}</small>}
        </div>
      </div>
      {lootItem
        ? <LootItemsEditor items={lootItem.items} disabled={disabled} onChange={items => patchLootFields({ item: { ...lootItem, items } })} />
        : !lootXp || lootXp.mode === 'leave' ? <p className="sheet-note">两项都跟原版，当前等同未启用。</p> : null}
    </div> : <p className="sheet-off">未启用 · 掉落完全跟原版，脚本 hook 仍可改写</p>}
  </Panel>

  const body = <div className="flow-kit-pane sheet-editor actor-editor" aria-label="演员模板编辑器"><div className="kit-editor"><div className="kit-page sheet-page">
    <header className="kit-header sheet-header">
      <div className="sheet-heading">
        <h2>演员模板</h2>
        <span className="sheet-kind">.actor</span>
      </div>
      <span className="sheet-header-hint">模板 ID 使用文件名；重新绑定或重载会重建会话。</span>
      <div className="sheet-header-actions">
        <button type="button" className="sheet-btn is-quiet" disabled={disabled} onClick={() => { discard(); setRepairing(true) }}>编辑 JSON</button>
      </div>
    </header>
    <div className="actor-primary">
      <SheetToggle label="软冻结原版 AI" hint="停用原版目标与行为，保留导航与控制" checked={doc.freezeAi} disabled={disabled} onChange={freezeAi => update({ freezeAi })} />
      <label className="actor-despawn">
        <span>消失行为</span>
        <select className="sheet-select" aria-label="消失行为" disabled={disabled} value={doc.despawn} onChange={e => update({ despawn: e.target.value as ActorDespawnMode })}>
          {ACTOR_DESPAWN_MODES.map(mode => <option key={mode.id} value={mode.id} title={mode.hint}>{mode.label}</option>)}
        </select>
      </label>
      <KitTagField label="演员标签" tags={doc.tags} disabled={disabled} onChange={tags => update({ tags })} />
    </div>
    {pending && <PendingBanner issue={pending.issue} onDiscard={discard} />}
    <div className="sheet-columns">
      {scriptPanel}
      {lootPanel}
    </div>
    <div className="sheet-columns">
      {displayPanel}
      {reputationPanel}
    </div>
    <p className="sheet-note is-info"><span>名牌／声誉副作用在有脚本时于会话 init 应用，无脚本时于绑定时应用；模板可显式 <code>clear</code>。<b>解绑本身不会回滚</b>这两项。</span></p>
    <div className="sheet-columns">
      {dialoguePanel}
      {servicePanel}
    </div>
  </div></div></div>

  return itemCatalog
    ? <ItemCatalogContext.Provider value={itemCatalog}>{body}</ItemCatalogContext.Provider>
    : body
}
