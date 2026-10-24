import assert from 'node:assert/strict'
import { wireGeometry, portSide, portOffset, normalizeConnection } from '../src/nodeEditor/geometry'
import type { PortSide, EditorNode } from '../src/nodeEditor/types'
const normals={left:{x:-1,y:0},right:{x:1,y:0},top:{x:0,y:-1},bottom:{x:0,y:1}}
for(const from of Object.keys(normals) as PortSide[])for(const to of Object.keys(normals) as PortSide[]){
 const result=wireGeometry({x:12,y:20},{x:130,y:180},false,from,to),a=result.sample(0),b=result.sample(1),first=result.sample(.00001),last=result.sample(.99999)
 assert.deepEqual(a,{x:12,y:20});assert.deepEqual(b,{x:130,y:180})
 assert((first.x-a.x)*normals[from].x+(first.y-a.y)*normals[from].y>0)
 assert((last.x-b.x)*normals[to].x+(last.y-b.y)*normals[to].y>0)
 assert(!/NaN|Infinity/.test(result.path))
 const loop=wireGeometry({x:0,y:0},{x:30,y:60},true,from,to);assert(!/NaN|Infinity/.test(loop.path))
}
assert.equal(portSide({direction:'input'}),'left');assert.equal(portSide({direction:'output'}),'right')
assert.equal(portSide({direction:'input',side:'bottom'}),'bottom')
assert.equal(portOffset({direction:'output',side:'top',x:36,y:80}),36)
assert.equal(portOffset({direction:'output',side:'left',x:36,y:80}),80)
assert.equal(portOffset({direction:'input',side:'bottom'}),'50%')
const nodes:EditorNode[]=[{id:'a',type:'test',position:{x:0,y:0},width:200,height:100,label:'A',data:{},ports:[{id:'out',direction:'output',side:'bottom',label:'输出'}]},{id:'b',type:'test',position:{x:0,y:200},width:200,height:100,label:'B',data:{},ports:[{id:'in',direction:'input',side:'top',label:'输入'}]}]
assert.deepEqual(normalizeConnection(nodes,{source:'b',target:'a',sourcePort:'in',targetPort:'out'}),{source:'a',target:'b',sourcePort:'out',targetPort:'in'})
assert.equal(wireGeometry({x:0,y:0},{x:100,y:0}).path,'M 0 0 C 45 0, 55 0, 100 0')
console.log('PASS directional geometry: 16 side pairs, loop paths, defaults, axis offsets, and semantic reverse connection')
