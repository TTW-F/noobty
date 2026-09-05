// 流式下载:fetch 计进度,Range 断点续传(会话内),完成后触发浏览器另存
import { api } from './api'
import type { FileRef } from './types'

export interface DownloadProgress {
  receivedBytes: number
  totalBytes: number
  speed: number
}

export interface DownloadHandle {
  promise: Promise<void>
  cancel: () => void
}

export function downloadFile(file: FileRef, onProgress: (p: DownloadProgress) => void): DownloadHandle {
  const controller = new AbortController()
  const parts: BlobPart[] = []
  let received = 0
  const startedAt = Date.now()

  const promise = (async () => {
    let attemptRangeResume = true

    for (;;) {
      const headers: HeadersInit = attemptRangeResume && received > 0 ? { Range: `bytes=${received}-` } : {}
      const res = await fetch(api.fileUrl(file.file_id), { headers, signal: controller.signal })

      if (!res.ok && res.status !== 206) throw new Error(`下载失败(${res.status})`)
      if (res.status !== 206) {
        // 服务端不支持 Range 或会话过期:从零开始
        parts.length = 0
        received = 0
      }

      const total = file.size
      const reader = res.body?.getReader()
      if (!reader) break

      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (value) {
          parts.push(value.slice().buffer as ArrayBuffer)
          received += value.byteLength
          const elapsed = Math.max(0.25, (Date.now() - startedAt) / 1000)
          onProgress({ receivedBytes: received, totalBytes: total, speed: received / elapsed })
        }
      }
      break
    }

    const blob = new Blob(parts)
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = file.name
    document.body.append(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 30_000)
  })()

  return {
    promise,
    cancel: () => controller.abort(),
  }
}
