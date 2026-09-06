// 本机「已下载」回执:按设备隔离,跨刷新/park 保留(对齐 QQ 已下载)。

const KEY = 'noobty.downloaded.v1'

export interface DownloadReceipt {
  at: number
  path?: string
}

type Store = Record<string, Record<string, DownloadReceipt>>

function readStore(): Store {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as Store
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function writeStore(store: Store): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(store))
  } catch {
    /* private mode */
  }
}

export function listDownloadedIds(deviceId: string): string[] {
  const map = readStore()[deviceId]
  return map ? Object.keys(map) : []
}

export function isDownloaded(deviceId: string, fileId: string): boolean {
  return Boolean(readStore()[deviceId]?.[fileId])
}

export function markDownloaded(
  deviceId: string,
  fileId: string,
  opts?: { path?: string },
): void {
  const store = readStore()
  const map = { ...(store[deviceId] ?? {}) }
  map[fileId] = {
    at: Date.now(),
    ...(opts?.path ? { path: opts.path } : map[fileId]?.path ? { path: map[fileId]!.path } : {}),
  }
  const keys = Object.keys(map)
  if (keys.length > 500) {
    keys
      .sort((a, b) => map[a]!.at - map[b]!.at)
      .slice(0, keys.length - 400)
      .forEach((k) => delete map[k])
  }
  store[deviceId] = map
  writeStore(store)
}

export function clearDownloaded(deviceId: string, fileId: string): void {
  const store = readStore()
  const map = store[deviceId]
  if (!map || !(fileId in map)) return
  delete map[fileId]
  writeStore(store)
}
