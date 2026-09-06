// 流式下载:fetch 计进度,Range 断点续传(会话内),优先写入磁盘(FS Access)
import { api } from './api'
import { openSaveSink, pumpReaderToSink, type SaveProgress } from './saveStream'
import type { FileRef } from './types'

export type DownloadProgress = SaveProgress

export interface DownloadHandle {
  promise: Promise<void>
  cancel: () => void
}

export function downloadFile(file: FileRef, onProgress: (p: DownloadProgress) => void): DownloadHandle {
  const controller = new AbortController()

  const promise = (async () => {
    const sink = await openSaveSink(file.name, file.size)
    const state = { received: 0, startedAt: Date.now(), totalBytes: file.size }

    try {
      let attemptRangeResume = true

      for (;;) {
        if (controller.signal.aborted) throw new DOMException('已取消', 'AbortError')

        const headers: HeadersInit =
          attemptRangeResume && state.received > 0 ? { Range: `bytes=${state.received}-` } : {}
        const res = await fetch(api.fileUrl(file.file_id), { headers, signal: controller.signal })

        if (!res.ok && res.status !== 206) throw new Error(`下载失败(${res.status})`)
        if (res.status !== 206) {
          // 服务端不支持 Range 或会话过期:从零开始
          await sink.reset()
          state.received = 0
        }

        const reader = res.body?.getReader()
        if (!reader) break

        await pumpReaderToSink(reader, sink, state, onProgress)
        break
      }

      await sink.finish()
    } catch (err) {
      await sink.abort()
      throw err
    }
  })()

  return {
    promise,
    cancel: () => controller.abort(),
  }
}
