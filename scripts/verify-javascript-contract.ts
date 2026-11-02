import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { transformDialect } from '../src/monaco/javascript/dialect'

// The same golden corpus lives in ModRPGToolKit/src/test/resources.
const cases=JSON.parse(readFileSync('scripts/fixtures/javascript-dialect-contract.json','utf8'))
for(const entry of cases){
 const result=transformDialect(entry.source)
 assert.equal(result.diagnostics.length===0,entry.valid,`${entry.name}: ${JSON.stringify(result.diagnostics)}`)
 if(entry.valid){
  assert.equal(result.source,entry.output,entry.name)
  assert.deepEqual(result.hooks,entry.hooks,entry.name)
  assert.deepEqual(result.goal,entry.goal,entry.name)
  const editor=transformDialect(entry.source,'editor')
  assert.deepEqual(editor.diagnostics,[],entry.name)
  assert.deepEqual(editor.goal,result.goal,entry.name)
  assert.equal(editor.source.split('\n').length,entry.source.split('\n').length,entry.name)
  if(entry.editorOutput!==undefined)assert.equal(editor.source,entry.editorOutput,entry.name)
  assert.equal(result.source.split('\n').length,entry.source.split('\n').length,entry.name)
 }
}
console.log(`JavaScript cross-runtime dialect contract: ${cases.length} cases passed`)
