import { randomId } from '../project/crypto'

const DB_NAME = 'hanshu.assets.v1'
const STORE = 'blobs'
const DB_VERSION = 1
// IndexedDB is shared by every tab on an origin. This cache is a C-side draft
// projection, so it must be private to this page runtime, including duplicate tabs.
// Reconnects in this runtime reuse it; reload rebuilds from S plus draft/outbox recovery.
const CACHE_NAMESPACE = `runtime:${randomId()}::`
const epochs = new Map<string, number>()
export function assetCacheEpoch(packageId: string, path: string): number { return epochs.get(assetKey(packageId,path)) ?? 0 }
function touch(packageId: string, path: string) { const key=assetKey(packageId,path);epochs.set(key,(epochs.get(key)??0)+1) }

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE)
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'))
  })
}

function assetKey(packageId: string, path: string) {
  return `${CACHE_NAMESPACE}${packageId}::${path}`
}

export async function putAssetBlob(
  packageId: string,
  path: string,
  blob: Blob,
): Promise<void> {
  touch(packageId,path)
  const db = await openDb()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).put(blob, assetKey(packageId, path))
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error('putAssetBlob failed'))
  })
  db.close()
}

export async function getAssetBlob(
  packageId: string,
  path: string,
): Promise<Blob | null> {
  const db = await openDb()
  const blob = await new Promise<Blob | null>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly')
    const req = tx.objectStore(STORE).get(assetKey(packageId, path))
    req.onsuccess = () => resolve((req.result as Blob | undefined) ?? null)
    req.onerror = () => reject(req.error ?? new Error('getAssetBlob failed'))
  })
  db.close()
  return blob
}

export async function deleteAssetBlob(
  packageId: string,
  path: string,
): Promise<void> {
  touch(packageId,path)
  const db = await openDb()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).delete(assetKey(packageId, path))
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error('deleteAssetBlob failed'))
  })
  db.close()
}

/** A remote fetch must not replace a local recording/import that started while it was in flight. */
export async function cacheRemoteAsset(packageId: string,path: string,blob: Blob,expectedEpoch: number): Promise<boolean> {
  const db=await openDb()
  if(assetCacheEpoch(packageId,path)!==expectedEpoch){db.close();return false}
  touch(packageId,path)
  await new Promise<void>((resolve,reject)=>{const tx=db.transaction(STORE,'readwrite');tx.objectStore(STORE).put(blob,assetKey(packageId,path));tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error)})
  db.close();return true
}

/** Remove an acknowledged remote deletion only if no newer local import won. */
export async function deleteCachedAsset(packageId: string, path: string, expectedEpoch: number): Promise<boolean> {
  const db = await openDb()
  if (assetCacheEpoch(packageId, path) !== expectedEpoch) { db.close(); return false }
  touch(packageId, path)
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).delete(assetKey(packageId, path))
    tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error)
  })
  db.close(); return true
}

/** 删除某包下全部资产二进制 */
export async function deletePackageAssetBlobs(
  packageId: string,
): Promise<void> {
  await deleteByPrefix(`${CACHE_NAMESPACE}${packageId}::`)
}

/** Best-effort lifecycle cleanup only touches this runtime, never another live C. */
export async function deleteCurrentAssetCache(): Promise<void> {
  await deleteByPrefix(CACHE_NAMESPACE)
}

async function deleteByPrefix(prefix: string): Promise<void> {
  const db = await openDb()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    const store = tx.objectStore(STORE)
    const req = store.openCursor(IDBKeyRange.bound(prefix, `${prefix}\uffff`))
    req.onsuccess = () => {
      const cursor = req.result
      if (!cursor) return
      if (typeof cursor.key === 'string' && cursor.key.startsWith(prefix)) {
        epochs.set(cursor.key, (epochs.get(cursor.key) ?? 0) + 1)
        cursor.delete()
      }
      cursor.continue()
    }
    tx.oncomplete = () => resolve()
    tx.onerror = () =>
      reject(tx.error ?? new Error('deletePackageAssetBlobs failed'))
  })
  db.close()
}

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', event => {
    // BFCache can resume the same runtime, which still needs its own projection.
    if (!event.persisted) void deleteCurrentAssetCache().catch(() => undefined)
  })
}
