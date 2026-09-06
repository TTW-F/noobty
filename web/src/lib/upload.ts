// 分块上传 + 断点续传(docs/API.md Upload 一节)
// ≤ SHA256_MAX_BYTES 的文件计算 sha256 参与续传/秒传匹配;更大文件由服务端按 名字+大小 匹配。
// 增量哈希:避免 file.arrayBuffer() 整文件入堆(10+ GiB 归档根本不会哈希;≤128 MiB 也不再 O(n) RAM)。
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { api, type CompleteResp } from './api'

const SHA256_MAX_BYTES = 128 * 1024 * 1024
const MAX_RETRIES = 5

export interface UploadProgress {
  sentBytes: number
  speed: number // B/s,近 3 秒滑动窗口
}

async function sha256Hex(file: File): Promise<string | undefined> {
  if (file.size > SHA256_MAX_BYTES || typeof file.stream !== 'function') return undefined
  try {
    const hasher = sha256.create()
    const reader = file.stream().getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value && value.byteLength > 0) hasher.update(value)
    }
    return bytesToHex(hasher.digest())
  } catch {
    return undefined
  }
}

export interface UploadHandle {
  promise: Promise<CompleteResp>
  cancel: () => void
}

export function uploadFile(
  file: File,
  conversationId: string | undefined,
  deviceId: string,
  onProgress: (progress: UploadProgress) => void,
): UploadHandle {
  const controller = new AbortController()
  let uploadId: string | null = null

  const promise = (async (): Promise<CompleteResp> => {
    const hash = await sha256Hex(file)
    if (controller.signal.aborted) throw new DOMException('已取消', 'AbortError')

    const session = await api.createUpload(deviceId, file.name, file.size, hash)
    uploadId = session.upload_id
    const chunkSize = session.chunk_size > 0 ? session.chunk_size : 4 * 1024 * 1024
    let offset = Math.min(session.received_bytes, file.size)

    // 近 3 秒速度窗口:[时间戳 ms, 累计字节];进度回调约 150ms 节流,避免大文件打爆 React。
    const window: Array<[number, number]> = []
    let lastReport = 0
    const report = (force = false) => {
      const now = Date.now()
      if (!force && now - lastReport < 150 && offset < file.size) return
      lastReport = now
      window.push([now, offset])
      while (window.length > 1 && now - window[0]![0] > 3_000) window.shift()
      const first = window[0]!
      const speed = window.length > 1 && now > first[0] ? ((offset - first[1]) * 1000) / (now - first[0]) : 0
      onProgress({ sentBytes: offset, speed })
    }

    report(true)
    while (offset < file.size) {
      if (controller.signal.aborted) throw new DOMException('已取消', 'AbortError')
      const end = Math.min(offset + chunkSize, file.size)
      const chunk = file.slice(offset, end)

      let retries = 0
      for (;;) {
        try {
          const res = await api.putChunk(uploadId, deviceId, offset, chunk)
          offset = Math.max(res.received_bytes, offset + chunk.size)
          break
        } catch (err) {
          if (controller.signal.aborted) throw new DOMException('已取消', 'AbortError')
          retries++
          if (retries > MAX_RETRIES) throw err
          // 断点续传:查询服务端实际收到的字节数后继续
          await new Promise((r) => setTimeout(r, Math.min(1000 * 2 ** (retries - 1), 8000)))
          const state = await api.queryUpload(uploadId, deviceId)
          offset = Math.min(state.received_bytes, file.size)
          report(true)
        }
      }
      report(false)
    }

    const resp = await api.completeUpload(uploadId, deviceId, conversationId)
    onProgress({ sentBytes: file.size, speed: 0 })
    return resp
  })()

  return {
    promise,
    cancel: () => {
      controller.abort()
      void uploadId
    },
  }
}
