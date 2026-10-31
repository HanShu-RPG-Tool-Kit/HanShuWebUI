import { Fragment, useContext, useMemo, useState, type DragEvent, type MouseEvent } from 'react'
import { TextField } from './Fields'
import { conditionStatesFor, createConditionRule, type ProgressConditionRule } from './conditions'
import { acceptKitItemDrops, AddButton, hasKitItemDrag, ItemCatalogContext, ItemList, ItemVisual, KitExprContext, KitTagField, ModifierPanel, Panel, ParamPanel, RemoveButton } from './KitEditor'
import { KitScriptField, type KitScriptOptions } from './KitScriptField'
import { ItemSnapshotPanelStatus } from './ItemSnapshotPanelStatus'
import { useItemPresentation } from './itemPresentation'
import { activeKitModifiers, activeKitParams, createKitItem, createKitModifier, createKitParam, expandKitItem, kitScriptRefs, type ItemCatalog, type KitItem } from './kit'
import { buildKitModifierEnv } from './kitExpr'
import { createShopEntry, parseShop, STOCK_SUBJECTS, stringifyShop, type ShopDocument, type ShopEntry } from './shop'
import './ShopEditor.css'

const itemSummary = (items: KitItem[]) => items.length ? items.map(item => `${item.item || item.id || '未选择物品'} ×${item.count}`).join('、') : '未设置'
const capacityLabel = (value: ShopEntry, subject: ShopDocument['stockSubject']) => subject === 'infinite'
  ? (value.initialCapacity < value.maxCapacity ? '∞' : '关闭')
  : `剩余 ${Math.max(0, value.maxCapacity - value.initialCapacity)}`
const capacityHint = (value: ShopEntry, subject: ShopDocument['stockSubject']) => `当前额度 = 初始额度 + delta，每交易一次增加 1，与物品数量无关。${subject === 'infinite'
  ? `无限主体：${value.initialCapacity < value.maxCapacity ? '∞（无主体、无 delta）' : '额度关闭'}`
  : `默认剩余次数：${Math.max(0, value.maxCapacity - value.initialCapacity)}，实例按主体共享 delta。`}`
const parseCapacity = (raw: string) => { const n = Number(raw); return Number.isSafeInteger(n) && n >= 0 ? n : null }
const TRADE_SIDES = { payment: { label: '支付', title: '支付内容', flow: '玩家交付 → 库存主体' }, goods: { label: '获得', title: '获得内容', flow: '库存主体 → 玩家' } } as const
const SHEET_COLUMNS = 7
const ROW_CONTROLS = 'input,select,textarea,button,a,label,.kit-tags-row'

function ShopItemIcon({ item }: { item: KitItem }) {
  const catalog = useContext(ItemCatalogContext)
  const resolved = useMemo(() => expandKitItem(item, catalog), [item, catalog])
  const presentation = useItemPresentation(resolved)
  return <ItemVisual item={resolved} presentation={presentation} />
}

export function ShopEditor({ source, disabled, onChange, resolveText, setText, itemCatalog, scriptOptions, onOpenScript }: {
  source: string; disabled: boolean; onChange: (source: string) => void
  resolveText?: (key: string) => string; setText?: (key: string, value: string) => void; itemCatalog: ItemCatalog
  scriptOptions?: KitScriptOptions; onOpenScript?: (key: string) => void
}) {
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const [preview, setPreview] = useState<Record<string, unknown>>({})
  let doc: ShopDocument
  try { doc = parseShop(source, true) } catch (cause) {
    return <div className="flow-kit-pane shop-editor"><div className="kit-page"><p className="kit-banner" role="alert">{String(cause)}</p><TextField label="商店 JSON 源码" multiline disabled={disabled} value={source} onChange={onChange} /></div></div>
  }
  const update = (patch: Partial<ShopDocument>) => { if (!disabled) onChange(stringifyShop({ ...doc, ...patch })) }
  const entry = (id: string, patch: Partial<ShopEntry>) => update({ entries: doc.entries.map(e => e.id === id ? { ...e, ...patch } : e) })
  const env = buildKitModifierEnv(activeKitParams(doc.params), activeKitModifiers(doc.modifiers), preview)
  const displayName = resolveText?.(doc.name) ?? ''
  const toggle = (id: string) => setExpandedId(current => current === id ? null : id)
  const dropKey = (id: string, field: 'payment' | 'goods') => `${id}:${field}`
  const onItemDragOver = (event: DragEvent<HTMLButtonElement>, key: string) => {
    if (disabled || !hasKitItemDrag(event.dataTransfer)) return
    event.preventDefault()
    event.stopPropagation()
    event.dataTransfer.dropEffect = 'copy'
    if (dropTarget !== key) setDropTarget(key)
  }
  const onItemDrop = (event: DragEvent<HTMLButtonElement>, id: string, field: 'payment' | 'goods') => {
    event.preventDefault()
    event.stopPropagation()
    setDropTarget(null)
    if (disabled) return
    const current = doc.entries.find(value => value.id === id)
    if (!current) return
    void acceptKitItemDrops(event, (dropped) => {
      if (!dropped.length) return
      entry(id, { [field]: [...current[field], ...dropped] })
    }, () => {})
  }
  const move = (offset: number, id: string) => {
    const entries = [...doc.entries]
    const index = entries.findIndex(value => value.id === id)
    const next = index + offset
    if (index < 0) return
    if (next < 0 || next >= entries.length) return
    ;[entries[index], entries[next]] = [entries[next], entries[index]]
    update({ entries })
  }
  const addEntry = () => { const value = createShopEntry(); update({ entries: [...doc.entries, value] }); setExpandedId(value.id) }
  const removeEntry = (id: string) => { update({ entries: doc.entries.filter(e => e.id !== id) }); if (expandedId === id) setExpandedId(null) }
  const setCapacity = (id: string, field: 'initialCapacity' | 'maxCapacity', raw: string) => { const n = parseCapacity(raw); if (n !== null) entry(id, { [field]: n }) }
  const add = (label: string, onClick: () => void) => <AddButton label={label} disabled={disabled} onClick={onClick} />
  const emptyHint = disabled ? '当前为只读，该商店模板还没有商品条目。' : '点击「添加商品条目」建立第一笔交易。'
  function conditions(field: 'visibility' | 'availability', title: string) {
    const replace = (index: number, rule: ProgressConditionRule) => update({ [field]: doc[field].map((r, i) => i === index ? rule : r) })
    return <Panel title={title} count={doc[field].length} subtitle="全部满足" action={add(`添加${title}`, () => update({ [field]: [...doc[field], createConditionRule('task')] }))}>
      {doc[field].length === 0 ? <p className="kit-empty">没有条件，直接满足</p> : <div className="shop-rules">
        {doc[field].map((rule, index) => <div className="shop-rule" key={index}>
          <span className="kit-row-index">{index + 1}</span>
          <select disabled={disabled} aria-label={`${title} ${index + 1} 类型`} value={rule.kind} onChange={e => replace(index, createConditionRule(e.target.value as 'task' | 'dialogue' | 'expr'))}><option value="task">任务</option><option value="dialogue">对话</option><option value="expr">求值</option></select>
          <select disabled={disabled} aria-label={`${title} ${index + 1} 状态`} value={rule.state} onChange={e => replace(index, { ...rule, state: e.target.value } as ProgressConditionRule)}>{Object.entries(conditionStatesFor(rule.kind)).map(([id, label]) => <option value={id} key={id}>{label}</option>)}</select>
          <input disabled={disabled} aria-label={`${title} ${index + 1} 对象`} placeholder={rule.kind === 'expr' ? '条件表达式' : rule.kind === 'task' ? '任务对象' : '对话对象'} value={rule.target} onChange={e => { if (rule.kind !== 'repeat') replace(index, { ...rule, target: e.target.value }) }} />
          <RemoveButton label={`移除${title} ${index + 1}`} disabled={disabled} onClick={() => update({ [field]: doc[field].filter((_, i) => i !== index) })} />
        </div>)}
      </div>}
    </Panel>
  }
  const tradeSide = (value: ShopEntry, field: 'payment' | 'goods') => <Panel title={TRADE_SIDES[field].title} subtitle={TRADE_SIDES[field].flow} count={value[field].length} className={`shop-trade-side is-${field}`}
    action={<><ItemSnapshotPanelStatus items={value[field]} catalog={itemCatalog} disabled={disabled} />{add(`添加${TRADE_SIDES[field].label}物品`, () => entry(value.id, { [field]: [...value[field], createKitItem()] }))}</>}>
    <ItemList header items={value[field]} disabled={disabled} onChange={items => entry(value.id, { [field]: items })} />
  </Panel>
  const rowClick = (event: MouseEvent<HTMLTableRowElement>, id: string) => { if (!(event.target as Element).closest(ROW_CONTROLS)) toggle(id) }
  const rows = doc.entries.map((value, index) => {
    const open = value.id === expandedId
    const detailId = `shop-detail-${value.id}`
    const invalid = value.initialCapacity > value.maxCapacity
    return <Fragment key={value.id}>
      <tr data-entry-id={value.id} className={`shop-sheet-row${open ? ' is-expanded' : ''}`} onClick={e => rowClick(e, value.id)}>
        <th scope="row"><button type="button" className="shop-row-toggle" aria-label={`交易 ${index + 1}`} aria-expanded={open} aria-controls={open ? detailId : undefined} title={value.id} onClick={() => toggle(value.id)}>
          <span className="shop-row-chevron" aria-hidden>▸</span>{index + 1}
        </button></th>
        {(['payment', 'goods'] as const).map(field => {
          const key = dropKey(value.id, field)
          return <td key={field}><button type="button"
            className={`shop-cell-items${dropTarget === key ? ' is-drop' : ''}`}
            aria-label={`交易 ${index + 1} ${TRADE_SIDES[field].label}物品`}
            aria-expanded={open}
            aria-controls={open ? detailId : undefined}
            title={itemSummary(value[field]) || (disabled ? '未设置' : '点击展开，或拖入 .item / .itemstack')}
            onClick={() => toggle(value.id)}
            onDragEnter={e => onItemDragOver(e, key)}
            onDragOver={e => onItemDragOver(e, key)}
            onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropTarget(current => current === key ? null : current) }}
            onDrop={e => onItemDrop(e, value.id, field)}
          >
            {value[field].length
              ? <ul className="shop-item-icons">{value[field].map((item, itemIndex) => <li key={itemIndex}><ShopItemIcon item={item} /></li>)}</ul>
              : <span className="shop-cell-empty">{disabled ? '未设置' : '拖入物品或点击展开'}</span>}
          </button></td>
        })}
        <td><div className="shop-cell shop-cell-fields">
          <label><span>初始</span><input type="number" min="0" step="1" aria-label={`交易 ${index + 1} 初始额度`} aria-invalid={invalid} value={value.initialCapacity} disabled={disabled} onChange={e => setCapacity(value.id, 'initialCapacity', e.target.value)} /></label>
          <label><span>最大</span><input type="number" min="0" step="1" aria-label={`交易 ${index + 1} 最大额度`} aria-invalid={invalid} value={value.maxCapacity} disabled={disabled} onChange={e => setCapacity(value.id, 'maxCapacity', e.target.value)} /></label>
          <span className={`shop-cell-note${invalid ? ' is-invalid' : ''}`} title={capacityHint(value, doc.stockSubject)}>{invalid ? '初始超过最大' : capacityLabel(value, doc.stockSubject)}</span>
        </div></td>
        <td><div className="shop-cell shop-cell-fields">
          <label><span>可见</span><input aria-label={`交易 ${index + 1} 可见性表达式`} value={value.visibility} disabled={disabled} placeholder="不限制" title={value.visibility} onChange={e => entry(value.id, { visibility: e.target.value })} /></label>
          <label><span>可用</span><input aria-label={`交易 ${index + 1} 可用性表达式`} value={value.availability} disabled={disabled} placeholder="不限制" title={value.availability} onChange={e => entry(value.id, { availability: e.target.value })} /></label>
        </div></td>
        <td><div className="shop-cell shop-cell-tags"><KitTagField label={`交易 ${index + 1} 标签`} tags={value.tags} disabled={disabled} onChange={tags => entry(value.id, { tags })} /></div></td>
        <td><div className="shop-cell shop-row-actions">
          <button className="shop-order" type="button" aria-label={`上移交易 ${index + 1}`} title="上移" disabled={disabled || index === 0} onClick={() => move(-1, value.id)}>↑</button>
          <button className="shop-order" type="button" aria-label={`下移交易 ${index + 1}`} title="下移" disabled={disabled || index === doc.entries.length - 1} onClick={() => move(1, value.id)}>↓</button>
          <RemoveButton label={`删除交易 ${index + 1}`} disabled={disabled} onClick={() => removeEntry(value.id)} />
        </div></td>
      </tr>
      {open && <tr className="shop-sheet-detail"><td colSpan={SHEET_COLUMNS}>
        <section className="shop-detail" id={detailId} role="region" aria-label={`交易 ${index + 1} 物品`}>
          <header className="shop-detail-head">
            <strong>交易 {index + 1} · 物品</strong>
            <span className="shop-detail-id" title={value.id}>{value.id}</span>
            <button type="button" className="shop-detail-close" aria-label={`收起交易 ${index + 1} 物品`} onClick={() => setExpandedId(null)}>收起 ▴</button>
          </header>
          <div className="shop-detail-trade">
            {tradeSide(value, 'payment')}
            <span className="shop-detail-arrow" aria-hidden><b>→</b><small>换取</small></span>
            {tradeSide(value, 'goods')}
          </div>
        </section>
      </td></tr>}
    </Fragment>
  })
  const sheet = <div className="shop-sheet-scroll" tabIndex={0} role="region" aria-label="商品表格滚动区域"><table className="shop-sheet" aria-label="商品交易表格">
    <colgroup>
      <col className="shop-sheet-number" />
      <col className="shop-sheet-items" />
      <col className="shop-sheet-items" />
      <col className="shop-sheet-capacity" />
      <col className="shop-sheet-conditions" />
      <col className="shop-sheet-tags" />
      <col className="shop-sheet-actions" />
    </colgroup>
    <thead><tr>
      <th scope="col">序号</th>
      <th scope="col">支付内容<small>玩家交付</small></th>
      <th scope="col">获得内容<small>玩家获得</small></th>
      <th scope="col">额度<small>初始 / 最大</small></th>
      <th scope="col">条件<small>商品表达式</small></th>
      <th scope="col">标签</th>
      <th scope="col">操作</th>
    </tr></thead>
    <tbody>{doc.entries.length ? rows : <tr className="shop-sheet-empty"><td colSpan={SHEET_COLUMNS}><div className="shop-blank"><span aria-hidden>⇄</span><strong>暂无商品条目</strong><p>{emptyHint}</p></div></td></tr>}</tbody>
  </table></div>
  return <div className="flow-kit-pane shop-editor"><div className="kit-editor"><div className="kit-page shop-page">
    <header className="kit-header shop-header">
      <label className="kit-name-field"><span className="kit-name-label">名称</span><input className="kit-title" aria-label="商店名称" placeholder="未命名商店" value={displayName} disabled={disabled || !setText} onChange={e => setText?.(doc.name, e.target.value)} /></label>
      <label className="shop-stock-field"><span>库存主体</span><select aria-label="库存主体类型" disabled={disabled} value={doc.stockSubject} onChange={e => update({ stockSubject: e.target.value as ShopDocument['stockSubject'] })}>{Object.entries(STOCK_SUBJECTS).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label>
      <span className="shop-meta-note">主体收款并供货 · 具体实体由实例绑定</span>
      <span className="shop-template-badge">商店模板</span>
      <details className="shop-identity"><summary>模板 ID</summary><label className="kit-field"><span>模板 ID</span><input aria-label="模板 ID" value={doc.id} disabled={disabled} onChange={e => update({ id: e.target.value })} /></label></details>
    </header>
    <div className="shop-header-secondary">
      <KitTagField label="商店标签" disabled={disabled} tags={doc.tags} onChange={tags => update({ tags })} />
      <ItemCatalogContext.Provider value={itemCatalog}>
        <Panel title="图标" subtitle="分类书签显示的物品 · 留空使用绿宝石" className="shop-icon-slot"
          action={!doc.icon ? add('设置图标', () => update({ icon: createKitItem() })) : undefined}>
          <ItemList items={doc.icon ? [doc.icon] : []} singleItem disabled={disabled}
            onChange={items => update({ icon: items[0] ? { ...items[0], count: 1, mods: undefined } : null })} />
        </Panel>
      </ItemCatalogContext.Provider>
    </div>
    <div className="shop-toolbar">
      <span className="shop-toolbar-title">商品条目 <span className="kit-badge">{doc.entries.length}</span></span>
      <span className="shop-toolbar-hint">点击行展开编辑支付与获得物品；额度、条件、标签直接在表格中修改</span>
      {add('添加商品条目', addEntry)}
    </div>
    {doc.entries.filter(value => value.initialCapacity > value.maxCapacity).map(value => <p className="kit-banner" role="alert" key={value.id}>交易 {doc.entries.indexOf(value) + 1}：初始额度不能超过最大额度。</p>)}
    <ItemCatalogContext.Provider value={itemCatalog}><KitExprContext.Provider value={{ env, modifiers: activeKitModifiers(doc.modifiers).filter(m => env.declared.has(m.id)).map(m => ({ id: m.id, label: m.label })) }}>
      {sheet}
      <p className="kit-hint shop-sheet-note">商品表达式可引用本模板超参数与修饰器，留空直接满足；与下方商店级条件组分开求值。</p>
      <div className="kit-stack shop-settings" role="region" aria-label="商店条件与参数">
        <div className="shop-condition-columns">{conditions('visibility', '商店可见性条件组')}{conditions('availability', '商店可用性条件组')}</div>
        <Panel title="超参数" subtitle="由实例注入 · 此处为默认值" count={doc.params.length} action={add('添加超参数', () => update({ params: [...doc.params, createKitParam()] }))}><ParamPanel params={doc.params} preview={preview} disabled={disabled} onChange={params => update({ params })} onPreview={(id, value) => setPreview(p => ({ ...p, [id]: value }))} /></Panel>
        <Panel title="修饰器" subtitle="一元函数 f(x) · 仅本模板作用域" count={doc.modifiers.length} action={add('添加修饰器', () => update({ modifiers: [...doc.modifiers, createKitModifier()] }))}><ModifierPanel modifiers={doc.modifiers} env={env} disabled={disabled} onChange={modifiers => update({ modifiers })} />{env.errors.map((error, i) => <p className="kit-banner" role="alert" key={i}>{error}</p>)}</Panel>
        <Panel title="脚本" subtitle="按列表顺序执行" count={doc.script.length} className="kit-script" action={<span className="kit-lang">Python</span>}><KitScriptField value={doc.script} options={scriptOptions} resourceLabel="商店脚本" disabled={disabled} onOpen={onOpenScript} onChange={script => update({ script: kitScriptRefs(script).map(ref => ({ ref })) })} /></Panel>
        <p className="shop-scope-note">组合与参数注入在商店实例中配置；组合保留各模板边界与独立参数作用域。</p>
      </div>
    </KitExprContext.Provider></ItemCatalogContext.Provider>
  </div></div></div>
}
