import { randomId } from './crypto'
import type { FileEdit } from './serviceClient'
export type PendingSubmission = {
  id: number; requestId: string; label: string; phase: string; message: string; code: string
  edits: FileEdit[]; stagedPaths: string[]
}
export type EditJournal = { load(): Promise<PendingSubmission[]>; save(records: PendingSubmission[]): Promise<void> }

const WINDOW_KEY = 'hanshu.editWindow'
const CHANNEL = 'hanshu.editWindow.claim.v1'
const CLAIM_MS = 250
type Scope = { id: string; instance: string; channel: BroadcastChannel; active: boolean }
type Claim = { type: 'probe' | 'contender' | 'owner'; id: string; instance: string; to?: string }
let database: Promise<IDBDatabase> | undefined
let scope: Scope | undefined
let claiming: Promise<Scope> | undefined
let instance: string | undefined
let generation = 0
let lifecycleInstalled = false
let pageActive = true
const liveScopes = new Set<Scope>()
function loseScope(owner: Scope) {
  owner.active = false; owner.channel.close(); liveScopes.delete(owner)
  if (scope === owner) scope = undefined
}

function db(): Promise<IDBDatabase> {
  if (!database) database = new Promise((resolve, reject) => {
    let abandoned = false
    const request = indexedDB.open('hanshu.editJournal.v1', 2)
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains('submissions')) request.result.createObjectStore('submissions')
      if (!request.result.objectStoreNames.contains('windows')) request.result.createObjectStore('windows')
    }
    request.onsuccess = () => {
      if (abandoned) { request.result.close(); return }
      request.result.onversionchange = () => { request.result.close(); database = undefined }
      resolve(request.result)
    }
    request.onerror = () => { abandoned = true; database = undefined; reject(request.error) }
    request.onblocked = () => { abandoned = true; database = undefined; reject(new Error('提交记录存储正在升级，请关闭旧版本页面后重试')) }
  })
  return database
}

function installLifecycle() {
  if (lifecycleInstalled) return
  lifecycleInstalled = true
  // Refresh and BFCache both release the live channel. A restored page must
  // claim again; its old in-memory journal may no longer own the durable scope.
  window.addEventListener('pagehide', () => {
    pageActive = false; generation++; claiming = undefined
    for (const candidate of liveScopes) { candidate.active = false; candidate.channel.close() }
    liveScopes.clear(); scope = undefined
  })
  window.addEventListener('pageshow', () => { pageActive = true })
}

async function readOwner(id: string): Promise<string | undefined> {
  const connection = await db()
  return new Promise((resolve, reject) => {
    const tx = connection.transaction('windows')
    const request = tx.objectStore('windows').get(id)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

/** Atomic compare-and-set fences simultaneous claims, including delayed messages. */
async function storeOwner(id: string, expected: string | undefined, owner: string): Promise<boolean> {
  const connection = await db()
  return new Promise((resolve, reject) => {
    const tx = connection.transaction('windows', 'readwrite')
    const request = tx.objectStore('windows').get(id)
    let claimed = false
    request.onsuccess = () => {
      if (request.result !== expected) return
      tx.objectStore('windows').put(owner, id); claimed = true
    }
    tx.oncomplete = () => resolve(claimed)
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error)
  })
}

async function claimWindow(): Promise<Scope> {
  installLifecycle()
  if (!pageActive) throw new Error('页面尚未恢复，提交记录暂时不可写')
  if (scope?.active) return scope
  if (claiming) return claiming
  const claimGeneration = generation
  instance ??= randomId()
  const owner = instance
  const attempt = async (): Promise<Scope> => {
    let id = sessionStorage.getItem(WINDOW_KEY) || randomId()
    for (;;) {
      if (typeof BroadcastChannel === 'undefined') throw new Error('此浏览器不支持窗口间协调，无法安全打开提交记录')
      const channel = new BroadcastChannel(CHANNEL)
      let activeOwner = false; let earlierContender = false; let established = false
      const candidate: Scope = { id, instance: owner, channel, active: true }
      liveScopes.add(candidate)
      const send = (type: Claim['type'], to?: string) => channel.postMessage({type,id:candidate.id,instance:owner,to} satisfies Claim)
      channel.onmessage = event => {
        if (!candidate.active) return
        const message = event.data as Partial<Claim> | null
        if (!message || message.id !== candidate.id || typeof message.instance !== 'string' || message.instance === owner || (message.to && message.to !== owner)) return
        if (message.type === 'probe') {
          send(established ? 'owner' : 'contender', message.instance)
          if (!established && message.instance < owner) earlierContender = true
        } else if (message.type === 'owner') activeOwner = true
        else if (message.type === 'contender' && message.instance < owner) earlierContender = true
      }
      try {
        const previousOwner = await readOwner(id)
        send('probe')
        await new Promise<void>(resolve => setTimeout(resolve, CLAIM_MS / 2))
        if (!candidate.active) throw new Error('页面已离开，提交记录初始化已取消')
        send('probe')
        await new Promise<void>(resolve => setTimeout(resolve, CLAIM_MS / 2))
        if (claimGeneration !== generation || !pageActive) throw new Error('页面已离开，提交记录初始化已取消')
        if (activeOwner || earlierContender || !await storeOwner(id, previousOwner, owner)) {
          candidate.active = false; channel.close(); liveScopes.delete(candidate)
          // Duplicates inherit sessionStorage. Only the duplicate gets a new scope;
          // pending submissions remain with the original live owner.
          id = randomId(); sessionStorage.setItem(WINDOW_KEY,id)
          continue
        }
        if (claimGeneration !== generation || !pageActive) throw new Error('页面已离开，提交记录初始化已取消')
        established = true; send('owner')
        sessionStorage.setItem(WINDOW_KEY,id)
        scope = candidate
        return candidate
      } catch (error) { candidate.active = false; channel.close(); liveScopes.delete(candidate); throw error }
    }
  }
  const pending = attempt()
  claiming = pending
  try { return await pending }
  finally { if (claiming === pending) claiming = undefined }
}

/** IndexedDB stores Blobs before submission and never stores credentials.
 * BroadcastChannel distinguishes refresh from a live duplicate. Reads/writes
 * verify the instance owner in the same IDB transaction; a delayed or resumed
 * page cannot overwrite another owner's pending submissions.
 */
export function openEditJournal(projectKey: string): EditJournal {
  let windowId: string | undefined
  let tail: Promise<void> = Promise.resolve()
  async function location() {
    const owner = await claimWindow()
    if (windowId !== undefined && windowId !== owner.id) throw new Error('此窗口的提交记录已由另一个页面占用；原修改仍保留，请导出备份后重新连接')
    windowId = owner.id
    return {owner,key:projectKey + ':' + owner.id,connection:await db()}
  }
  return {
    async load() {
      const {owner,key,connection} = await location()
      return new Promise((resolve, reject) => {
        const tx = connection.transaction(['windows','submissions'])
        const identity = tx.objectStore('windows').get(owner.id)
        let records: PendingSubmission[] = []
        let failure: Error | undefined
        identity.onsuccess = () => {
          if (!owner.active || identity.result !== owner.instance) { loseScope(owner); failure = new Error('提交记录的窗口写权已变化，请保留草稿并重新连接'); tx.abort(); return }
          const request = tx.objectStore('submissions').get(key)
          request.onsuccess = () => { records = request.result ?? [] }
        }
        tx.oncomplete = () => resolve(records)
        tx.onerror = () => reject(failure ?? tx.error)
        tx.onabort = () => reject(failure ?? tx.error)
      })
    },
    save(records) {
      const snapshot = structuredClone(records)
      const write = tail.then(async () => {
        const {owner,key,connection} = await location()
        await new Promise<void>((resolve, reject) => {
          const tx = connection.transaction(['windows','submissions'], 'readwrite')
          const identity = tx.objectStore('windows').get(owner.id)
          let failure: Error | undefined
          identity.onsuccess = () => {
            if (!owner.active || identity.result !== owner.instance) { loseScope(owner); failure = new Error('提交记录的窗口写权已变化，请保留草稿并重新连接'); tx.abort(); return }
            if (snapshot.length) tx.objectStore('submissions').put(snapshot,key)
            else tx.objectStore('submissions').delete(key)
          }
          tx.oncomplete = () => resolve()
          tx.onerror = () => reject(failure ?? tx.error)
          tx.onabort = () => reject(failure ?? tx.error)
        })
      })
      tail = write.catch(() => undefined)
      return write
    },
  }
}
