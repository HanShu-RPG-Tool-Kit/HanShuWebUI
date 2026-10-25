import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {decodeTextComponent} from '../src/textComponent/codec'
import {normalizeTextComponent} from '../src/textComponent/normalize'
import {
  applyFeedbackStyleRange,
  clearFeedbackStyles,
  parseFeedbackText,
  replaceFeedbackPlainText,
  stringifyFeedbackText,
} from '../src/workspaces/gameplay/feedbackText'
import { textComponentSegments, itemNameBaseStyle } from '../src/workspaces/gameplay/itemTooltip'

function roundTrip(raw: string) {
  return stringifyFeedbackText(parseFeedbackText(raw))
}

assert.equal(stringifyFeedbackText([{ text: '' }]), '')
assert.equal(stringifyFeedbackText([{ text: '欢迎' }]), '欢迎')
assert.deepEqual(parseFeedbackText('欢迎'), [{ text: '欢迎' }])

const gold = stringifyFeedbackText([{ text: '欢迎', color: '#FFAA00' }])
assert.equal(gold, JSON.stringify({ text: '欢迎', color: '#FFAA00' }))
assert.deepEqual(parseFeedbackText(gold), [{ text: '欢迎', color: '#FFAA00' }])
assert.equal(roundTrip(gold), gold)

const named = stringifyFeedbackText([{ text: '红', color: '#FF5555', bold: true }])
assert.equal(
  named,
  JSON.stringify({ text: '红', color: '#FF5555', bold: true }),
)
assert.deepEqual(parseFeedbackText(named), [
  { text: '红', color: '#FF5555', bold: true },
])

const multi = stringifyFeedbackText([
  { text: 'A', color: '#FFFFFF' },
  { text: 'B', color: '#55FFFF', italic: true },
])
assert.equal(
  multi,
  JSON.stringify({
    text: '',
    extra: [
      { text: 'A', color: '#FFFFFF' },
      { text: 'B', color: '#55FFFF', italic: true },
    ],
  }),
)
assert.deepEqual(parseFeedbackText(multi), [
  { text: 'A', color: '#FFFFFF' },
  { text: 'B', color: '#55FFFF', italic: true },
])
assert.equal(roundTrip(multi), multi)

const scary = stringifyFeedbackText([{ text: '{"text":"x"}' }])
assert.equal(scary, JSON.stringify({ text: '{"text":"x"}' }))
assert.deepEqual(parseFeedbackText(scary), [{ text: '{"text":"x"}' }])

assert.deepEqual(parseFeedbackText(JSON.stringify({ text: '金', color: 'gold' })), [
  { text: '金', color: '#FFAA00' },
])

assert.deepEqual(textComponentSegments(multi), [
  { text: 'A', color: '#FFFFFF' },
  { text: 'B', color: '#55FFFF', italic: true },
])

// 选区上色 → 自动拆段；同款相邻再合并
const painted = applyFeedbackStyleRange(
  [{ text: '你好世界' }],
  2,
  4,
  { color: '#FF5555' },
)
assert.deepEqual(painted, [
  { text: '你好' },
  { text: '世界', color: '#FF5555' },
])

const whole = applyFeedbackStyleRange(painted, 0, 4, { bold: true })
assert.deepEqual(whole, [
  { text: '你好', bold: true },
  { text: '世界', color: '#FF5555', bold: true },
])

const merged = applyFeedbackStyleRange(whole, 0, 4, { color: '#FF5555' })
assert.deepEqual(merged, [
  { text: '你好世界', color: '#FF5555', bold: true },
])

// Inserted text inherits its preceding style while unchanged suffix keeps its own style.
const rewritten = replaceFeedbackPlainText(painted, '你好啊世界')
assert.deepEqual(rewritten, [
  { text: '你好啊' },
  { text: '世界', color: '#FF5555' },
])

assert.deepEqual(replaceFeedbackPlainText(painted, ''), [{ text: '' }])
assert.equal(stringifyFeedbackText([{ text: '' }]), '')

assert.deepEqual(clearFeedbackStyles(merged, 0, 4), [{ text: '你好世界' }])
assert.deepEqual(clearFeedbackStyles(painted, 2, 4), [{ text: '你好世界' }])

console.log('通过：feedback 文本组件编解码 / 选区样式拆合 / 清除样式')

// Rich text preserves explicit false separately from inheritance.
assert.deepEqual(parseFeedbackText('{"text":"A","bold":true,"extra":[{"text":"B","bold":false},{"text":"C"}]}'),[
  {text:'A',bold:true},{text:'B',bold:false},{text:'C',bold:true},
])
assert.deepEqual(parseFeedbackText(stringifyFeedbackText([{text:'A',italic:false},{text:'B'}])),[{text:'A',italic:false},{text:'B'}])
assert.deepEqual(applyFeedbackStyleRange([{text:'A'}],0,1,{bold:false}),[{text:'A',bold:false}])
assert.deepEqual(clearFeedbackStyles([{text:'A',bold:false}],0,1),[{text:'A'}])
assert.equal(stringifyFeedbackText([{text:' '}]),' ')
assert.equal(stringifyFeedbackText([{text:''},{text:'A',bold:true},{text:''}]),'{"text":"A","bold":true}')

// Shared with IBE's Java tests; unsupported structures are retained by reference.
const vectors=JSON.parse(readFileSync(new URL('./fixtures/text-component-vectors.json',import.meta.url),'utf8')) as Array<{id:string;input:unknown;editable:boolean;text:string;segments?:unknown}>
for(const vector of vectors){
  const decoded=decodeTextComponent(vector.input)
  assert.equal(decoded.editable,vector.editable,vector.id)
  assert.strictEqual(decoded.original,vector.input,vector.id)
  if(vector.editable){
    const segments=parseFeedbackText(JSON.stringify(vector.input))
    assert.deepEqual(segments,vector.segments,vector.id)
    assert.equal(segments.map(segment=>segment.text).join(''),vector.text,vector.id)
    assert.deepEqual(parseFeedbackText(JSON.stringify(normalizeTextComponent(vector.input))),segments,vector.id)
  }else assert.strictEqual(normalizeTextComponent(vector.input),vector.input,vector.id)
}
console.log('通过：Java/TypeScript 共用 Component 测试向量、三态样式和高级结构只读保留')

// Empty styled Components are distinct from an unset field or an unstyled empty value.
assert.deepEqual(parseFeedbackText('{"text":"","italic":false,"color":"gold"}'),[{text:'',italic:false,color:'#FFAA00'}])
assert.equal(stringifyFeedbackText([{text:'',italic:false}]),'{"text":"","italic":false}')
const emptyStyled=applyFeedbackStyleRange([{text:''}],0,0,{color:'#FFAA00',italic:false})
assert.deepEqual(emptyStyled,[{text:'',color:'#FFAA00',italic:false}])
assert.deepEqual(replaceFeedbackPlainText(emptyStyled,'新名称'),[{text:'新名称',color:'#FFAA00',italic:false}])
assert.deepEqual(clearFeedbackStyles(emptyStyled,0,0),[{text:''}])
assert.deepEqual(replaceFeedbackPlainText([{text:'名称',italic:false}],''),[{text:'',italic:false}])

// Minecraft array siblings inherit from the first root even when that root is itself an array.
assert.deepEqual(parseFeedbackText('[[{"text":"A","bold":true,"color":"gold"}],{"text":"B"},{"text":"C","bold":false}]'),[
  {text:'AB',bold:true,color:'#FFAA00'},{text:'C',bold:false,color:'#FFAA00'},
])

const richSuffix=[{text:'AB',bold:true},{text:'CD',italic:false,color:'#FF5555'}]
assert.deepEqual(replaceFeedbackPlainText(richSuffix,'AXBCD'),[
  {text:'AXB',bold:true},{text:'CD',italic:false,color:'#FF5555'},
])
assert.deepEqual(replaceFeedbackPlainText(richSuffix,'ACD'),[
  {text:'A',bold:true},{text:'CD',italic:false,color:'#FF5555'},
])
assert.deepEqual(replaceFeedbackPlainText(richSuffix,'XCD'),[
  {text:'XCD',italic:false,color:'#FF5555'},
])
assert.deepEqual(replaceFeedbackPlainText([{text:'颜色',color:'#FF5555'}],'前颜色'),[{text:'前颜色',color:'#FF5555'}])

assert.deepEqual(itemNameBaseStyle({}),{color:'#FFFFFF'})
assert.deepEqual(itemNameBaseStyle({'minecraft:rarity':{type:'string',value:'rare'}}),{color:'#55FFFF'})
