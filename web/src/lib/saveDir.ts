// 浏览器端「默认保存文件夹」:File System Access 目录句柄持久化到 IndexedDB。
// 托盘壳走 Rust 配置,不使用本模块落盘。

const DB_NAME = 'noobty-prefs'
const STORE = 'handles'
const KEY = 'saveDir'
const LABEL_KEY = 'noobty.saveDirLabel'

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'))
  })
}

async function idbGet(): Promise<FileSystemDirectoryHandle | null> {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly')
    const req = tx.objectStore(STORE).get(KEY)
    req.onsuccess = () => resolve((req.result as FileSystemDirectoryHandle | undefined) ?? null)
    req.onerror = () => reject(req.error ?? new Error('IndexedDB get failed'))
  })
}

async function idbSet(handle: FileSystemDirectoryHandle): Promise<void> {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).put(handle, KEY)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB put failed'))
  })
}

async function idbClear(): Promise<void> {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).delete(KEY)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB delete failed'))
  })
}

export function canPickSaveDir(): boolean {
  return typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function'
}

export function saveDirLabel(): string | null {
  try {
    return localStorage.getItem(LABEL_KEY)
  } catch {
    return null
  }
}

export async function clearSaveDir(): Promise<void> {
  try {
    localStorage.removeItem(LABEL_KEY)
  } catch {
    /* */
  }
  await idbClear().catch(() => undefined)
}

/** 弹出目录选择并持久化。返回显示名(文件夹名)。 */
export async function pickSaveDir(): Promise<string | null> {
  const pick = window.showDirectoryPicker
  if (!pick) return null
  try {
    const handle = await pick({ mode: 'readwrite' })
    await idbSet(handle)
    try {
      localStorage.setItem(LABEL_KEY, handle.name)
    } catch {
      /* */
    }
    return handle.name
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') return null
    throw err
  }
}

async function ensurePermission(handle: FileSystemDirectoryHandle): Promise<boolean> {
  const opts = { mode: 'readwrite' as const }
  const query = handle.queryPermission?.bind(handle)
  const request = handle.requestPermission?.bind(handle)
  if (!query || !request) return true
  if ((await query(opts)) === 'granted') return true
  if ((await request(opts)) === 'granted') return true
  return false
}

/** 若已配置默认目录且仍有写权限,返回该目录句柄。 */
export async function getGrantedSaveDir(): Promise<FileSystemDirectoryHandle | null> {
  if (!canPickSaveDir()) return null
  try {
    const handle = await idbGet()
    if (!handle) return null
    if (!(await ensurePermission(handle))) return null
    return handle
  } catch {
    return null
  }
}
