/** 记住上次工程目录句柄（IndexedDB），便于开发时恢复 */

const DB_NAME = 'hanshu.project.v1'
const STORE = 'handles'
const KEY_LAST = 'lastDirectory'

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE)
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('project IDB open failed'))
  })
}

export async function saveLastDirectoryHandle(
  handle: FileSystemDirectoryHandle,
): Promise<void> {
  const db = await openDb()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).put(handle, KEY_LAST)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error('save handle failed'))
  })
  db.close()
}

export async function loadLastDirectoryHandle(): Promise<FileSystemDirectoryHandle | null> {
  const db = await openDb()
  const handle = await new Promise<FileSystemDirectoryHandle | null>(
    (resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly')
      const req = tx.objectStore(STORE).get(KEY_LAST)
      req.onsuccess = () =>
        resolve((req.result as FileSystemDirectoryHandle | undefined) ?? null)
      req.onerror = () => reject(req.error ?? new Error('load handle failed'))
    },
  )
  db.close()
  return handle
}

export async function clearLastDirectoryHandle(): Promise<void> {
  const db = await openDb()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).delete(KEY_LAST)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error('clear handle failed'))
  })
  db.close()
}
