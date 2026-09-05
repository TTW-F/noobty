// 分块上传 + 断点续传(docs/API.md Upload 一节)
// ≤ SHA256_MAX_BYTES 的文件计算 sha256 参与续传/秒传匹配;更大文件由服务端按 名字+大小 匹配。
import { api } from './api'

const SHA256_MAX_BYTES = 128 * 1024 * 1024
const MAX_RETRIES = 5

export interface UploadProgress {
  sentBytes: number
  speed: number // B/s,近 3 秒滑动窗口
}

async function sha256Hex(file: File): Promise<string | undefined> {
  if (file.size > SHA256_MAX_BYTES || !file.stream) return undefined
  try {
    const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer())
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
  } catch {
    return undefined
  }
}

export interface UploadHandle {
  promise: Promise<void>
  cancel: () => void
}

export function uploadFile(
  file: File,
  conversationId: string,
  deviceId: string,
  onProgress: (progress: UploadProgress) => void,
): UploadHandle {
  const controller = new AbortController()
  let uploadId: string | null = null

  const promise = (async () => {
    const hash = await sha256Hex(file)
    if (controller.signal.aborted) throw new DOMException('已取消', 'AbortError')

    const session = await api.createUpload(deviceId, file.name, file.size, hash)
    uploadId = session.upload_id
    const chunkSize = session.chunk_size > 0 ? session.chunk_size : 4 * 1024 * 1024
    let offset = Math.min(session.received_bytes, file.size)

    // 近 3 秒速度窗口:[时间戳 ms, 累计字节]
    const window: Array<[number, number]> = []
    const report = () => {
      const now = Date.now()
      window.push([now, offset])
      while (window.length > 1 && now - window[0]![0] > 3_000) window.shift()
      const first = window[0]!
      const speed = window.length > 1 && now > first[0] ? ((offset - first[1]) * 1000) / (now - first[0]) : 0
      onProgress({ sentBytes: offset, speed })
    }

    report()
    while (offset < file.size) {
      if (controller.signal.aborted) throw new DOMException('已取消', 'AbortError')
      const end = Math.min(offset + chunkSize, file.size)
      const chunk = file.slice(offset, end)

      let retries = 0
      for (;;) {
        try {
          const res = await api.putChunk(uploadId, offset, chunk)
          offset = Math.max(res.received_bytes, offset + chunk.size)
          break
        } catch (err) {
          if (controller.signal.aborted) throw new DOMException('已取消', 'AbortError')
          retries++
          if (retries > MAX_RETRIES) throw err
          // 断点续传:查询服务端实际收到的字节数后继续
          await new Promise((r) => setTimeout(r, Math.min(1000 * 2 ** (retries - 1), 8000)))
          const state = await api.queryUpload(uploadId)
          offset = Math.min(state.received_bytes, file.size)
          report()
        }
      }
      report()
    }

    await api.completeUpload(uploadId, conversationId)
    onProgress({ sentBytes: file.size, speed: 0 })
  })()

  return {
    promise,
    cancel: () => {
      controller.abort()
      // 已建立的上传会话留在服务端,续传语义允许下次复用
      void uploadId
    },
  }
}
