/**
 * 删除一个活跃段（及其对话条目）。
 *
 * 为什么需要直接摸 IndexedDB：pi-durable 1.5.0 的 `Storage` 只有「写入/读取」，没有
 * 「删除某个会话」的 API；`IndexedDbStorage.delete()` 删的是**整库**（会把同窗口其它段一起删掉）。
 * 所以这里在**运行时关闭之后**，按 pi-durable 1.5.0 的库结构逐条删除该会话的记录。
 *
 * 与版本的耦合：**锁定 `@earendil-works/pi-durable` 1.5.0**（package.json 精确版本）。
 * 升级 PI 时必须重新核对 `dist/storage/indexeddb.js` 里的 STORES / INDEXES 与记录字段；
 * 这里对不认识的库结构 fail-closed（找不到 object store 就报错，不做猜测性删除）。
 */

/** pi-durable 1.5.0 的 IndexedDB 库结构（DATABASE_VERSION = 1） */
const STORES = {
  meta: 'meta',
  recordIds: 'record_ids',
  conversations: 'conversations',
  entries: 'entries',
  tasks: 'tasks',
  submissions: 'submissions',
  documents: 'documents',
  documentRevisions: 'document_revisions',
} as const

const INDEXES = {
  entriesByConversation: 'entries_by_conversation',
  tasksByConversation: 'tasks_by_conversation',
  submissionsByConversation: 'submissions_by_conversation',
  documentsByScope: 'documents_by_scope',
} as const

const MAX_KEY = Number.MAX_SAFE_INTEGER

export type DeleteSegmentInput = {
  /** 活跃段库名：`hanshu.agent.session.<windowId>.<scope>` */
  databaseName: string
  conversationId: number
  /** 便于 Node 测试注入；浏览器默认 globalThis.indexedDB */
  indexedDB?: IDBFactory
}

export type DeleteSegmentResult = {
  deleted: boolean
  entries: number
  documents: number
  tasks: number
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.addEventListener('success', () => resolve(request.result), { once: true })
    request.addEventListener('error', () => reject(request.error), { once: true })
  })
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.addEventListener('complete', () => resolve(), { once: true })
    transaction.addEventListener('abort', () => reject(transaction.error), { once: true })
    transaction.addEventListener('error', () => reject(transaction.error), { once: true })
  })
}

/** 打开一个已存在的库；库不存在时返回 null（不要顺手创建空库，否则 PI 下次打开会因缺 metadata 报错） */
async function openExisting(factory: IDBFactory, name: string): Promise<IDBDatabase | null> {
  const databases = factory.databases
  if (typeof databases === 'function') {
    const list = await databases.call(factory)
    if (!list.some((entry) => entry.name === name)) return null
  }
  let created = false
  const request = factory.open(name)
  request.addEventListener('upgradeneeded', () => {
    created = true
  })
  const database = await requestResult(request)
  if (created) {
    // 库本来不存在：这次 open 只是把它建出来，删掉后当作"没有可删的"
    database.close()
    await requestResult(factory.deleteDatabase(name))
    return null
  }
  if (!database.objectStoreNames.contains(STORES.entries)) {
    database.close()
    throw new Error('活跃段库结构与 pi-durable 1.5.0 不符，已中止删除')
  }
  return database
}

/**
 * 删除一段：会话记录、条目、任务、提交、文档与文档版本、以及这些 id 的保留记录。
 * 调用前**必须**先关闭该库上的 Harness（pi-durable 要求一个库只有一个 owner）。
 */
export async function deleteSegmentRecords(
  input: DeleteSegmentInput,
): Promise<DeleteSegmentResult> {
  const factory = input.indexedDB ?? globalThis.indexedDB
  if (!factory) throw new Error('当前环境没有 IndexedDB')

  const database = await openExisting(factory, input.databaseName)
  if (!database) return { deleted: false, entries: 0, documents: 0, tasks: 0 }

  const conversationId = input.conversationId
  const result: DeleteSegmentResult = { deleted: true, entries: 0, documents: 0, tasks: 0 }

  try {
    const storeNames = Object.values(STORES).filter((name) =>
      database.objectStoreNames.contains(name),
    )
    const transaction = database.transaction(storeNames, 'readwrite')
    const done = transactionDone(transaction)
    const deletedIds: IDBValidKey[] = [conversationId]

    // 会话本体
    transaction.objectStore(STORES.conversations).delete(conversationId)

    // 条目（索引 entries_by_conversation = [conversationId, id]）
    const entriesStore = transaction.objectStore(STORES.entries)
    {
      const range = IDBKeyRange.bound([conversationId, 0], [conversationId, MAX_KEY])
      const cursor = await requestResult(
        entriesStore.index(INDEXES.entriesByConversation).openKeyCursor(range),
      )
      let current: IDBCursor | null = cursor
      while (current) {
        if (current.primaryKey !== undefined) {
          deletedIds.push(current.primaryKey)
          entriesStore.delete(current.primaryKey)
          result.entries += 1
        }
        current = await nextCursor(current)
      }
    }

    // 任务 / 提交
    const tasksStore = transaction.objectStore(STORES.tasks)
    const submissionsStore = transaction.objectStore(STORES.submissions)
    const collectIds = async (
      store: IDBObjectStore,
      indexName: string,
      counter: () => void,
    ): Promise<void> => {
      const range = IDBKeyRange.bound([conversationId, 0], [conversationId, MAX_KEY])
      const cursor = await requestResult(store.index(indexName).openKeyCursor(range))
      let current: IDBCursor | null = cursor
      while (current) {
        if (current.primaryKey !== undefined) {
          deletedIds.push(current.primaryKey)
          store.delete(current.primaryKey)
          counter()
        }
        current = await nextCursor(current)
      }
    }
    await collectIds(tasksStore, INDEXES.tasksByConversation, () => (result.tasks += 1))
    await collectIds(submissionsStore, INDEXES.submissionsByConversation, () => undefined)

    // 会话文档（documents_by_scope = [scopeKind, ownerId, id]）与会话文档版本
    const documentsStore = transaction.objectStore(STORES.documents)
    const revisionsStore = transaction.objectStore(STORES.documentRevisions)
    {
      const range = IDBKeyRange.bound(
        ['conversation', conversationId, 0],
        ['conversation', conversationId, MAX_KEY],
      )
      const cursor = await requestResult(
        documentsStore.index(INDEXES.documentsByScope).openCursor(range),
      )
      let current: IDBCursorWithValue | null = cursor
      while (current) {
        const documentId = current.primaryKey
        if (documentId !== undefined) {
          deletedIds.push(documentId)
          documentsStore.delete(documentId)
          // 版本记录主键是 [documentId, seq]
          revisionsStore.delete(IDBKeyRange.bound([documentId, 0], [documentId, MAX_KEY]))
          result.documents += 1
        }
        current = await nextCursor(current)
      }
    }

    // 任务文档：scopeKind = 'task'，ownerId 是被删任务 id
    const taskIds = deletedIds.slice(1).filter((id): id is number => typeof id === 'number')
    if (result.tasks > 0 && taskIds.length > 0) {
      const taskDocuments = transaction.objectStore(STORES.documents)
      const range = IDBKeyRange.bound(['task', 0, 0], ['task', MAX_KEY, MAX_KEY])
      const cursor = await requestResult(
        taskDocuments.index(INDEXES.documentsByScope).openKeyCursor(range),
      )
      let current: IDBCursor | null = cursor
      while (current) {
        // 索引键序 [scopeKind, ownerId, id]；ownerId 是这里的第 2 段
        const ownerId = Array.isArray(current.key) ? Number(current.key[1]) : Number.NaN
        if (taskIds.includes(ownerId) && current.primaryKey !== undefined) {
          deletedIds.push(current.primaryKey)
          taskDocuments.delete(current.primaryKey)
          revisionsStore.delete(
            IDBKeyRange.bound([current.primaryKey, 0], [current.primaryKey, MAX_KEY]),
          )
          result.documents += 1
        }
        current = await nextCursor(current)
      }
    }

    // 保留 id（PI 用它避免 id 复用）
    const recordIdsStore = transaction.objectStore(STORES.recordIds)
    for (const id of deletedIds) {
      recordIdsStore.delete(id)
    }

    await done
    return result
  } finally {
    database.close()
  }
}

/**
 * 游标前进一项。事件在**产生游标的那个 request** 上触发（`IDBCursor` 不是 EventTarget），
 * 所以监听 `cursor.request`；必须**先挂监听再 continue**，否则可能错过成功事件。
 */
function nextCursor<T extends IDBCursor>(cursor: T): Promise<T | null> {
  const request = cursor.request as IDBRequest<T | null>
  return new Promise((resolve, reject) => {
    request.addEventListener('success', () => resolve(request.result ?? null), { once: true })
    request.addEventListener('error', () => reject(request.error), { once: true })
    cursor.continue()
  })
}
