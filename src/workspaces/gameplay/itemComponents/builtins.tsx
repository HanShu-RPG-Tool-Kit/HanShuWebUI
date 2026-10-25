/* Registration module; editors are mounted by the card host. */
/* oxlint-disable react/only-export-components */
import { registerItemComponentEditor, type ComponentEditorProps } from './registry'

function numberEditor(label: string) {
  return function NumberEditor({ value, disabled, onChange }: ComponentEditorProps) {
    return <label className="item-card-field"><span>{label}</span><input type="number" step="1" min="0" max="2147483647" value={value.value as number} disabled={disabled}
      onChange={event => { const n = event.target.valueAsNumber; if (Number.isInteger(n) && n >= 0 && n <= 2147483647) onChange({type: 'int', value:n}) }} /></label>
  }
}

for (const [key, title, initial] of [
  ['damage', '损耗值', 0], ['max_damage', '最大耐久', 100],
  ['max_stack_size', '堆叠上限', 64], ['repair_cost', '修复费用', 0],
] as const) {
  registerItemComponentEditor({
    id: `minecraft:${key}`, title, tone: 'amber', createValue: () => ({type:'int',value:initial}),
    accepts: value => value.type === 'int' && Number.isInteger(value.value), Editor: numberEditor(title),
  })
}

registerItemComponentEditor({
  id: 'minecraft:rarity', title: '稀有度', tone: 'violet', createValue: () => ({type:'string',value:'common'}),
  accepts: value => value.type === 'string' && ['common', 'uncommon', 'rare', 'epic'].includes(value.value),
  Editor: ({ value, disabled, onChange }) => <label className="item-card-field"><span>稀有度</span>
    <select disabled={disabled} value={value.value as string} onChange={event => onChange({type:'string',value:event.target.value})}>
      <option value="common">普通</option><option value="uncommon">罕见</option><option value="rare">稀有</option><option value="epic">史诗</option>
    </select></label>,
})
registerItemComponentEditor({
  id: 'minecraft:enchantment_glint_override', title: '附魔光效', tone: 'green', createValue: () => ({type:'byte',value:1}),
  accepts: value => value.type === 'byte' && (value.value === 0 || value.value === 1),
  Editor: ({ value, disabled, onChange }) => <label className="item-card-field"><span>显示光效</span>
    <input type="checkbox" role="switch" disabled={disabled} checked={value.value === 1} onChange={event => onChange({type:'byte',value:event.target.checked ? 1 : 0})} /></label>,
})
