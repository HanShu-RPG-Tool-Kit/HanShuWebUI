const DB_NAME = 'hanshu.assets.v1'
const STORE = 'blobs'
const DB_VERSION = 1

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
  return `${packageId}::${path}`
}

export async function putAssetBlob(
  packageId: string,
  path: string,
  blob: Blob,
): Promise<void> {
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
  const db = await openDb()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).delete(assetKey(packageId, path))
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error('deleteAssetBlob failed'))
  })
  db.close()
}

/** 删除某包下全部资产二进制 */
export async function deletePackageAssetBlobs(
  packageId: string,
): Promise<void> {
  const db = await openDb()
  const prefix = `${packageId}::`
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    const store = tx.objectStore(STORE)
    const req = store.openCursor()
    req.onsuccess = () => {
      const cursor = req.result
      if (!cursor) return
      if (typeof cursor.key === 'string' && cursor.key.startsWith(prefix)) {
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
