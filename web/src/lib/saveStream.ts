// Prefer File System Access streaming to disk; OPFS when no user gesture (auto relay);
// Blob+<a download> only for small files. Multi-GiB archives must not accumulate in heap.

import { getGrantedSaveDir } from './saveDir'

export interface SaveProgress {
  receivedBytes: number
  totalBytes: number
  speed: number
}

/** Above this size, Blob fallback is refused (would OOM / thrash). */
export const BLOB_FALLBACK_MAX_BYTES = 64 * 1024 * 1024

type FilePickerWindow = Window &
  typeof globalThis & {
    showSaveFilePicker?: (options?: {
      suggestedName?: string
      excludeAcceptAllOption?: boolean
    }) => Promise<FileSystemFileHandle>
  }

export interface SaveSink {
  /** `'stream'` = disk/OPFS; `'blob'` = in-memory accumulate. */
  readonly mode: 'stream' | 'blob'
  write(chunk: Uint8Array): Promise<void>
  /** Server restarted from byte 0 — wipe already-written bytes. */
  reset(): Promise<void>
  /** Flush and trigger browser save (blob) or close the file (stream). */
  finish(): Promise<void>
  /** Best-effort cleanup without saving. */
  abort(): Promise<void>
}

function heapFriendlyError(name: string, size: number): Error {
  const gib = (size / (1024 * 1024 * 1024)).toFixed(1)
  return new Error(
    `无法流式保存「${name}」（约 ${gib} GiB）：当前浏览器不支持直接写入磁盘。请使用 Chrome/Edge，或 Windows 托盘客户端。`,
  )
}

function triggerAnchorDownload(url: string, filename: string): void {
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.append(a)
  a.click()
  a.remove()
}

async function openPickerSink(suggestedName: string): Promise<SaveSink | null> {
  const w = window as FilePickerWindow
  if (typeof w.showSaveFilePicker !== 'function') return null
  try {
    const handle = await w.showSaveFilePicker({ suggestedName })
    const writable = await handle.createWritable()
    return {
      mode: 'stream',
      async write(chunk) {
        await writable.write(chunk as BlobPart)
      },
      async reset() {
        await writable.seek(0)
        await writable.truncate(0)
      },
      async finish() {
        await writable.close()
      },
      async abort() {
        try {
          await writable.abort()
        } catch {
          /* already closed */
        }
      },
    }
  } catch (err) {
    // User cancelled — abort the whole download.
    if (err instanceof DOMException && err.name === 'AbortError') throw err
    // No user gesture (auto relay) / permission — fall through to OPFS.
    return null
  }
}

/**
 * Origin Private File System: writable without a user gesture (needed for live relay
 * auto-accept). On finish, try promoting via save picker; else object-URL download
 * from the OPFS File handle (Chromium keeps it disk-backed).
 */
async function openOpfsSink(filename: string): Promise<SaveSink | null> {
  if (!navigator.storage?.getDirectory) return null
  let root: FileSystemDirectoryHandle
  try {
    root = await navigator.storage.getDirectory()
  } catch {
    return null
  }
  const opfsName = `${Date.now()}-${filename.replace(/[/\\?%*:|"<>]/g, '_')}`
  let fileHandle: FileSystemFileHandle
  let writable: FileSystemWritableFileStream
  try {
    fileHandle = await root.getFileHandle(opfsName, { create: true })
    writable = await fileHandle.createWritable()
  } catch {
    return null
  }

  const removeOpfs = async () => {
    try {
      await root.removeEntry(opfsName)
    } catch {
      /* ignore */
    }
  }

  return {
    mode: 'stream',
    async write(chunk) {
      await writable.write(chunk as BlobPart)
    },
    async reset() {
      await writable.seek(0)
      await writable.truncate(0)
    },
    async finish() {
      await writable.close()
      // Prefer a real user path when a gesture is available (manual 取件).
      try {
        const picked = await openPickerSink(filename)
        if (picked) {
          const file = await fileHandle.getFile()
          const reader = file.stream().getReader()
          try {
            for (;;) {
              const { done, value } = await reader.read()
              if (done) break
              if (value && value.byteLength > 0) await picked.write(value)
            }
            await picked.finish()
          } catch (err) {
            await picked.abort()
            throw err
          } finally {
            await removeOpfs()
          }
          return
        }
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') {
          await removeOpfs()
          throw err
        }
        // No gesture on finish — fall through to anchor download.
      }

      const file = await fileHandle.getFile()
      const url = URL.createObjectURL(file)
      triggerAnchorDownload(url, filename)
      setTimeout(() => {
        URL.revokeObjectURL(url)
        void removeOpfs()
      }, 60_000)
    },
    async abort() {
      try {
        await writable.abort()
      } catch {
        try {
          await writable.close()
        } catch {
          /* */
        }
      }
      await removeOpfs()
    },
  }
}

function openBlobSink(filename: string): SaveSink {
  const parts: BlobPart[] = []
  return {
    mode: 'blob',
    async write(chunk) {
      parts.push(chunk.slice().buffer as ArrayBuffer)
    },
    async reset() {
      parts.length = 0
    },
    async finish() {
      const blob = new Blob(parts)
      parts.length = 0
      const url = URL.createObjectURL(blob)
      triggerAnchorDownload(url, filename)
      setTimeout(() => URL.revokeObjectURL(url), 30_000)
    },
    async abort() {
      parts.length = 0
    },
  }
}

async function openDirHandleSink(
  dir: FileSystemDirectoryHandle,
  filename: string,
): Promise<SaveSink> {
  const safe = filename.replace(/[/\\?%*:|"<>]/g, '_') || '未命名文件'
  let name = safe
  for (let i = 0; i < 10_000; i++) {
    const candidate =
      i === 0
        ? safe
        : (() => {
            const dot = safe.lastIndexOf('.')
            if (dot > 0) return `${safe.slice(0, dot)} (${i})${safe.slice(dot)}`
            return `${safe} (${i})`
          })()
    try {
      await dir.getFileHandle(candidate)
      // exists — try next
    } catch {
      name = candidate
      break
    }
  }
  const fileHandle = await dir.getFileHandle(name, { create: true })
  const writable = await fileHandle.createWritable()
  return {
    mode: 'stream',
    async write(chunk) {
      await writable.write(chunk as BlobPart)
    },
    async reset() {
      await writable.seek(0)
      await writable.truncate(0)
    },
    async finish() {
      await writable.close()
    },
    async abort() {
      try {
        await writable.abort()
      } catch {
        /* */
      }
    },
  }
}

/**
 * Open a save sink.
 * Order: remembered default folder → save-picker → OPFS → Blob (≤64 MiB) → error.
 */
export async function openSaveSink(filename: string, totalBytes: number): Promise<SaveSink> {
  try {
    const remembered = await getGrantedSaveDir()
    if (remembered) return await openDirHandleSink(remembered, filename)
  } catch {
    /* fall through */
  }

  const picked = await openPickerSink(filename)
  if (picked) return picked

  const opfs = await openOpfsSink(filename)
  if (opfs) return opfs

  if (totalBytes > BLOB_FALLBACK_MAX_BYTES) {
    throw heapFriendlyError(filename, totalBytes)
  }
  return openBlobSink(filename)
}

/**
 * 清理 OPFS 里残留的流式临时文件(命名 `${Date.now()}-…`)。
 * 仅在无进行中的写入时调用(如 park / 关窗),避免删掉正在落盘的文件。
 */
export async function sweepAbandonedOpfsSaves(): Promise<void> {
  if (!navigator.storage?.getDirectory) return
  let root: FileSystemDirectoryHandle
  try {
    root = await navigator.storage.getDirectory()
  } catch {
    return
  }
  const doomed: string[] = []
  try {
    // FileSystemDirectoryHandle async iterator (Chromium)
    const dir = root as FileSystemDirectoryHandle & {
      entries?: () => AsyncIterableIterator<[string, FileSystemHandle]>
    }
    if (typeof dir.entries !== 'function') return
    for await (const [name, handle] of dir.entries()) {
      if (handle.kind === 'file' && /^\d{10,}-/.test(name)) doomed.push(name)
    }
  } catch {
    return
  }
  for (const name of doomed) {
    try {
      await root.removeEntry(name)
    } catch {
      /* in use or already gone */
    }
  }
}

/** Read a fetch body into `sink`, updating progress. Does not call finish/abort.
 * Progress is throttled (~150ms) so multi‑GiB transfers do not flood Zustand. */
export async function pumpReaderToSink(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  sink: SaveSink,
  state: { received: number; startedAt: number; totalBytes: number },
  onProgress: (p: SaveProgress) => void,
): Promise<void> {
  let lastReport = 0
  const report = (force: boolean) => {
    const now = Date.now()
    if (!force && now - lastReport < 150) return
    lastReport = now
    const elapsed = Math.max(0.25, (now - state.startedAt) / 1000)
    onProgress({
      receivedBytes: state.received,
      totalBytes: state.totalBytes,
      speed: state.received / elapsed,
    })
  }

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value && value.byteLength > 0) {
      await sink.write(value)
      state.received += value.byteLength
      report(false)
    }
  }
  report(true)
}
