// 流式下载:fetch 计进度,Range 断点续传(会话内),优先写入磁盘(FS Access);
// 无流式能力时回退浏览器原生下载(系统下载器,不进 JS 堆)。
import { api } from './api'
import {
  nativeBrowserDownload,
  openSaveSink,
  pumpReaderToSink,
  type SaveProgress,
} from './saveStream'
import type { FileRef } from './types'

export type DownloadProgress = SaveProgress

export interface DownloadHandle {
  promise: Promise<void>
  cancel: () => void
  /** True when handed to the OS/browser download manager (no byte progress). */
  native?: boolean
}

export function downloadFile(file: FileRef, onProgress: (p: DownloadProgress) => void): DownloadHandle {
  const controller = new AbortController()
  let native = false

  const promise = (async () => {
    const sink = await openSaveSink(file.name, file.size)
    if (!sink) {
      native = true
      nativeBrowserDownload(api.fileUrl(file.file_id), file.name)
      onProgress({ receivedBytes: file.size, totalBytes: file.size, speed: 0 })
      return
    }

    const state = { received: 0, startedAt: Date.now(), totalBytes: file.size }
    // Sliding window for speed (align with upload).
    const window: Array<[number, number]> = []
    let lastReport = 0
    const report = (received: number, force: boolean) => {
      const now = Date.now()
      if (!force && now - lastReport < 150) return
      lastReport = now
      window.push([now, received])
      while (window.length > 1 && now - window[0]![0] > 3_000) window.shift()
      const first = window[0]!
      const speed =
        window.length > 1 && now > first[0] ? ((received - first[1]) * 1000) / (now - first[0]) : 0
      onProgress({ receivedBytes: received, totalBytes: state.totalBytes, speed })
    }

    try {
      let attemptRangeResume = true

      for (;;) {
        if (controller.signal.aborted) throw new DOMException('已取消', 'AbortError')

        const headers: HeadersInit =
          attemptRangeResume && state.received > 0 ? { Range: `bytes=${state.received}-` } : {}
        const res = await fetch(api.fileUrl(file.file_id), { headers, signal: controller.signal })

        if (!res.ok && res.status !== 206) throw new Error(`下载失败(${res.status})`)
        if (res.status !== 206) {
          await sink.reset()
          state.received = 0
        }

        const reader = res.body?.getReader()
        if (!reader) break

        await pumpReaderToSink(reader, sink, state, ({ receivedBytes, totalBytes }) => {
          state.totalBytes = totalBytes
          report(receivedBytes, false)
        })
        report(state.received, true)
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
    get native() {
      return native
    },
  }
}
