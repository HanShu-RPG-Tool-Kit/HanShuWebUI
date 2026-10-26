import { useState } from 'react'
import { TextField } from './Fields'
import { conditionStatesFor, createConditionRule, type ProgressConditionRule } from './conditions'
import { AddButton, ItemCatalogContext, ItemList, KitExprContext, ModifierPanel, Panel, ParamPanel, RemoveButton } from './KitEditor'
import { KitScriptField, type KitScriptOptions } from './KitScriptField'
import { activeKitModifiers, activeKitParams, createKitItem, createKitModifier, createKitParam, kitScriptRefs, type ItemCatalog, type KitItem } from './kit'
import { buildKitModifierEnv } from './kitExpr'
import { createShopEntry, parseShop, STOCK_SUBJECTS, stringifyShop, type ShopDocument, type ShopEntry } from './shop'
import './ShopEditor.css'

const itemSummary = (items: KitItem[]) => items.length ? items.map(item => `${item.item || item.id || '未选择物品'} ×${item.count}`).join('、') : '未设置'

export function ShopEditor({ source, disabled, onChange, resolveText, setText, itemCatalog, scriptOptions, onOpenScript }: {
  source: string; disabled: boolean; onChange: (source: string) => void
  resolveText?: (key: string) => string; setText?: (key: string, value: string) => void; itemCatalog: ItemCatalog
  scriptOptions?: KitScriptOptions; onOpenScript?: (key: string) => void
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [view, setView] = useState<'form' | 'table'>('form')
  const [preview, setPreview] = useState<Record<string, unknown>>({})
  let doc: ShopDocument
  try { doc = parseShop(source, true) } catch (cause) {
    return <div className="flow-kit-pane shop-editor"><div className="kit-page"><p className="kit-banner" role="alert">{String(cause)}</p><TextField label="商店 JSON 源码" multiline disabled={disabled} value={source} onChange={onChange} /></div></div>
  }
  const update = (patch: Partial<ShopDocument>) => { if (!disabled) onChange(stringifyShop({ ...doc, ...patch })) }
  const entry = (id: string, patch: Partial<ShopEntry>) => update({ entries: doc.entries.map(e => e.id === id ? { ...e, ...patch } : e) })
  const env = buildKitModifierEnv(activeKitParams(doc.params), activeKitModifiers(doc.modifiers), preview)
  const selected = doc.entries.find(e => e.id === selectedId) ?? doc.entries[0]
  const selectedIndex = doc.entries.indexOf(selected)
  const move = (offset: number, id = selected?.id) => {
    const entries = [...doc.entries]
    const index = entries.findIndex(value => value.id === id)
    const next = index + offset
    if (index < 0) return
    if (next < 0 || next >= entries.length) return
    ;[entries[index], entries[next]] = [entries[next], entries[index]]
    setSelectedId(id)
    update({ entries })
  }
  const addEntry = () => { const value = createShopEntry(); update({ entries: [...doc.entries, value] }); setSelectedId(value.id) }
  const add = (label: string, onClick: () => void) => <AddButton label={label} disabled={disabled} onClick={onClick} />
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
  return <div className="flow-kit-pane shop-editor"><div className="kit-editor"><div className="kit-page shop-page">
    <header className="kit-header">
      <label className="kit-name-field"><span className="kit-name-label">名称</span><input className="kit-title" aria-label="商店名称" placeholder="未命名商店" value={resolveText?.(doc.name) ?? doc.name} disabled={disabled || !setText} onChange={e => setText?.(doc.name, e.target.value)} /></label>
      <span className="shop-template-badge">商店模板</span>
    </header>
    <div className="shop-meta">
      <label><span>库存主体</span><select aria-label="库存主体类型" disabled={disabled} value={doc.stockSubject} onChange={e => update({ stockSubject: e.target.value as ShopDocument['stockSubject'] })}>{Object.entries(STOCK_SUBJECTS).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label>
      <span className="shop-meta-note">主体收款并供货 · 具体实体由实例绑定</span>
      <details className="shop-identity"><summary>模板 ID</summary><label className="kit-field"><span>模板 ID</span><input aria-label="模板 ID" value={doc.id} disabled={disabled} onChange={e => update({ id: e.target.value })} /></label></details>
    </div>
    <div className="shop-toolbar">
      <span>商品条目 <span className="kit-badge">{doc.entries.length}</span></span>
      <div className="kit-segment" role="group" aria-label="商品视图">
        <button type="button" className={view === 'form' ? 'is-active' : ''} aria-pressed={view === 'form'} onClick={() => setView('form')}>表单视图</button>
        <button type="button" className={view === 'table' ? 'is-active' : ''} aria-pressed={view === 'table'} onClick={() => setView('table')}>表格视图</button>
      </div>
      {add('添加商品条目', addEntry)}
    </div>
    <ItemCatalogContext.Provider value={itemCatalog}><KitExprContext.Provider value={{ env, modifiers: activeKitModifiers(doc.modifiers).filter(m => env.declared.has(m.id)).map(m => ({ id: m.id, label: m.label })) }}>
      {view === 'table' ? <div className="shop-sheet-scroll" tabIndex={0} role="region" aria-label="商品表格滚动区域"><table className="shop-sheet" aria-label="商品交易表格">
        <colgroup><col className="shop-sheet-number" /><col /><col /><col /><col /><col className="shop-sheet-actions" /></colgroup>
        <thead><tr><th scope="col">序号</th><th scope="col">支付内容</th><th scope="col">获得内容</th><th scope="col">可见性表达式</th><th scope="col">可用性表达式</th><th scope="col">操作</th></tr></thead>
        <tbody>{doc.entries.map((value, index) => <tr key={value.id} data-entry-id={value.id} className={selected?.id === value.id ? 'is-selected' : ''} onFocus={() => setSelectedId(value.id)} onClick={() => setSelectedId(value.id)}>
          <th scope="row"><button type="button" className="shop-row-select" aria-label={`选择交易 ${index + 1}`} aria-pressed={selected?.id === value.id} title={value.id} onClick={() => setSelectedId(value.id)}>{index + 1}</button></th>
          {(['payment', 'goods'] as const).map(field => <td key={field}><button type="button" className="shop-cell-items" aria-label={`编辑交易 ${index + 1} ${field === 'payment' ? '支付' : '获得'}物品`} onClick={() => { setSelectedId(value.id); setView('form') }}>
            {value[field].length ? <ul>{value[field].map((item, itemIndex) => <li key={itemIndex}><span title={item.item || item.id}>{item.item || item.id || '未选择物品'}</span><b>×{item.count}</b></li>)}</ul> : <span className="shop-cell-empty">未设置</span>}
            <span className="shop-cell-edit">{disabled ? '查看物品详情 ↗' : '编辑物品详情 ↗'}</span>
          </button></td>)}
          <td><input aria-label={`交易 ${index + 1} 可见性表达式`} value={value.visibility} disabled={disabled} placeholder="不限制" onChange={e => entry(value.id, { visibility: e.target.value })} /></td>
          <td><input aria-label={`交易 ${index + 1} 可用性表达式`} value={value.availability} disabled={disabled} placeholder="不限制" onChange={e => entry(value.id, { availability: e.target.value })} /></td>
          <td><div className="shop-entry-actions"><button className="shop-order" type="button" aria-label={`上移交易 ${index + 1}`} disabled={disabled || index === 0} onClick={() => move(-1, value.id)}>↑</button><button className="shop-order" type="button" aria-label={`下移交易 ${index + 1}`} disabled={disabled || index === doc.entries.length - 1} onClick={() => move(1, value.id)}>↓</button><RemoveButton label={`删除交易 ${index + 1}`} disabled={disabled} onClick={() => update({ entries: doc.entries.filter(e => e.id !== value.id) })} /></div></td>
        </tr>)}</tbody>
      </table>{!doc.entries.length && <p className="kit-empty">暂无商品条目，点击上方“添加商品条目”建立交易。</p>}</div> : <div className="shop-trades" aria-label="商品表单">
        <Panel title="交易目录" count={doc.entries.length} className="shop-directory">
          {doc.entries.length ? <div className="shop-entry-list" role="listbox" aria-label="商品条目列表">{doc.entries.map((value, index) => <button type="button" role="option" aria-selected={value.id === selected.id} className="shop-entry-option" key={value.id} onClick={() => setSelectedId(value.id)}>
            <span className="shop-entry-number">{String(index + 1).padStart(2, '0')}</span><span className="shop-entry-summary"><strong>交易 {index + 1}</strong><span title={itemSummary(value.goods)}>{itemSummary(value.goods)}</span><small title={itemSummary(value.payment)}>支付 · {itemSummary(value.payment)}</small></span>
          </button>)}</div> : <p className="kit-empty">添加第一条交易<br />配置支付与获得的物品</p>}
        </Panel>
        {selected ? <section className="shop-entry" aria-label={`交易 ${selectedIndex + 1}`}>
          <header className="shop-entry-head"><strong>交易 {selectedIndex + 1}</strong><span className="shop-entry-id" title={selected.id}>{selected.id}</span><div className="shop-entry-actions"><button className="shop-order" type="button" aria-label="上移条目" disabled={disabled || selectedIndex === 0} onClick={() => move(-1)}>↑</button><button className="shop-order" type="button" aria-label="下移条目" disabled={disabled || selectedIndex === doc.entries.length - 1} onClick={() => move(1)}>↓</button><RemoveButton label="删除条目" disabled={disabled} onClick={() => update({ entries: doc.entries.filter(e => e.id !== selected.id) })} /></div></header>
          <Panel title="支付内容" subtitle="玩家交付 → 库存主体" count={selected.payment.length} action={add('添加支付物品', () => entry(selected.id, { payment: [...selected.payment, createKitItem()] }))}><ItemList header items={selected.payment} disabled={disabled} onChange={payment => entry(selected.id, { payment })} /></Panel>
          <Panel title="获得内容" subtitle="库存主体 → 玩家" count={selected.goods.length} action={add('添加获得物品', () => entry(selected.id, { goods: [...selected.goods, createKitItem()] }))}><ItemList header items={selected.goods} disabled={disabled} onChange={goods => entry(selected.id, { goods })} /></Panel>
          <section className="shop-advanced" aria-label="商品高级条件"><div className="shop-expression-fields"><TextField label="商品可见性表达式" disabled={disabled} value={selected.visibility} placeholder="留空表示直接满足" onChange={visibility => entry(selected.id, { visibility })} /><TextField label="商品可用性表达式" disabled={disabled} value={selected.availability} placeholder="留空表示直接满足" onChange={availability => entry(selected.id, { availability })} /></div><p className="kit-hint">表达式可引用本模板超参数与修饰器；只作用于当前商品。</p></section>
        </section> : <div className="shop-blank"><span aria-hidden>⇄</span><strong>建立一笔交易</strong><p>左侧添加商品，再选择玩家支付与获得的物品。</p></div>}
      </div>}
      <div className="kit-stack shop-settings" role="region" aria-label="商店条件与参数">
        <div className="shop-condition-columns">{conditions('visibility', '商店可见性条件组')}{conditions('availability', '商店可用性条件组')}</div>
        <Panel title="超参数" subtitle="由实例注入 · 此处为默认值" count={doc.params.length} action={add('添加超参数', () => update({ params: [...doc.params, createKitParam()] }))}><ParamPanel params={doc.params} preview={preview} disabled={disabled} onChange={params => update({ params })} onPreview={(id, value) => setPreview(p => ({ ...p, [id]: value }))} /></Panel>
        <Panel title="修饰器" subtitle="一元函数 f(x) · 仅本模板作用域" count={doc.modifiers.length} action={add('添加修饰器', () => update({ modifiers: [...doc.modifiers, createKitModifier()] }))}><ModifierPanel modifiers={doc.modifiers} env={env} disabled={disabled} onChange={modifiers => update({ modifiers })} />{env.errors.map((error, i) => <p className="kit-banner" role="alert" key={i}>{error}</p>)}</Panel>
        <Panel title="脚本" subtitle="按列表顺序执行" count={doc.script.length} className="kit-script" action={<span className="kit-lang">Python</span>}><KitScriptField value={doc.script} options={scriptOptions} resourceLabel="工程脚本" disabled={disabled} onOpen={onOpenScript} onChange={script => update({ script: kitScriptRefs(script).map(ref => ({ ref })) })} /></Panel>
        <p className="shop-scope-note">组合与参数注入在商店实例中配置；组合保留各模板边界与独立参数作用域。</p>
      </div>
    </KitExprContext.Provider></ItemCatalogContext.Provider>
  </div></div></div>
}
