import {sha256Fallback} from '../../project/crypto'
import type {EntityDocument} from './entityDoc'
export const entityFingerprint=(doc:EntityDocument)=>sha256Fallback(new TextEncoder().encode(JSON.stringify(doc.entity)))
let revision=0
const listeners=new Set<()=>void>()
export const entitySnapshotRevision=()=>revision
export function subscribeEntitySnapshots(listener:()=>void){listeners.add(listener);return()=>{listeners.delete(listener)}}
function db():Promise<IDBDatabase>{return new Promise((resolve,reject)=>{const r=indexedDB.open('hanshu-entity-snapshots',1);r.onupgradeneeded=()=>{r.result.createObjectStore('snapshots',{keyPath:'key'}).createIndex('at','at')};r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)})}
export async function readEntitySnapshot(key:string):Promise<string|null>{try{const d=await db();return await new Promise((resolve,reject)=>{const t=d.transaction('snapshots'),r=t.objectStore('snapshots').get(key);r.onsuccess=()=>resolve(r.result?.png??null);r.onerror=()=>reject(r.error);t.oncomplete=()=>d.close()})}catch{return null}}
export async function saveEntitySnapshot(key:string,png:string):Promise<void>{try{const d=await db();await new Promise<void>((resolve,reject)=>{const t=d.transaction('snapshots','readwrite'),s=t.objectStore('snapshots');s.put({key,png,at:Date.now()});const count=s.count();count.onsuccess=()=>{let remove=count.result-200;if(remove<=0)return;const cursor=s.index('at').openCursor();cursor.onsuccess=()=>{const c=cursor.result;if(c&&remove-->0){c.delete();c.continue()}}};t.oncomplete=()=>{d.close();revision++;listeners.forEach(f=>f());resolve()};t.onerror=()=>{d.close();reject(t.error)}})}catch{/* Local display cache may be unavailable. */}}
export function decodeEntityFrame(buffer:ArrayBuffer):{width:number;height:number;pixels:Uint8ClampedArray}{
 const v=new DataView(buffer);if(buffer.byteLength<32||v.getUint32(0,true)!==0x52505346||v.getUint16(4,true)!==32||v.getUint16(6,true)!==1)throw Error('预览帧格式无效')
 const width=v.getUint32(8,true),height=v.getUint32(12,true),stride=v.getUint32(16,true)
 if(!width||!height||width>2048||height>2048||stride!==width*4||buffer.byteLength!==32+height*stride)throw Error('预览帧尺寸无效')
 return {width,height,pixels:new Uint8ClampedArray(buffer.slice(32))}
}

export type EntityStreamFrame={width:number;height:number;encoding:'rgba';pixels:Uint8ClampedArray}|{width:number;height:number;encoding:'jpeg';payload:Uint8Array}
export function readEntityStreamFrame(buffer:ArrayBuffer):EntityStreamFrame{
 const v=new DataView(buffer);if(buffer.byteLength<32||v.getUint32(0,true)!==0x52505346||v.getUint16(4,true)!==32)throw Error('预览帧格式无效')
 if(v.getUint16(6,true)===1)return {...decodeEntityFrame(buffer),encoding:'rgba'}
 const width=v.getUint32(8,true),height=v.getUint32(12,true)
 if(v.getUint16(6,true)!==2||!width||!height||width>2048||height>2048||v.getUint32(16,true)!==0||buffer.byteLength<=32||buffer.byteLength>2*1024*1024)throw Error('预览压缩帧无效')
 return {width,height,encoding:'jpeg',payload:new Uint8Array(buffer.slice(32))}
}
