// 文件发送:对端在线优先直转(边传边收+落盘),否则/失败回落 tus 寄存上传。
import { api, ApiError, type CompleteResp } from './api'
import { openSaveSink, pumpReaderToSink } from './saveStream'
import { uploadFile, type UploadHandle, type UploadProgress } from './upload'

export type { UploadProgress, UploadHandle }

/**
 * @param peerOnline 目标设备是否在线(大厅或未知时传 false → 直接寄存)
 */
export function sendFile(
  file: File,
  conversationId: string,
  deviceId: string,
  peerOnline: boolean,
  onProgress: (progress: UploadProgress) => void,
): UploadHandle {
  // 大厅多接收方,无法 1:1 拼接;离线必须寄存。
  if (!peerOnline || conversationId === 'lobby') {
    return uploadFile(file, conversationId, deviceId, onProgress)
  }

  const controller = new AbortController()
  let relayId: string | null = null
  let fallback: UploadHandle | null = null

  const promise = (async (): Promise<CompleteResp> => {
    try {
      const created = await api.createRelay(deviceId, file.name, file.size, conversationId)
      if (controller.signal.aborted) throw new DOMException('已取消', 'AbortError')
      relayId = created.relay_id

      // XMLHttpRequest 才能拿到上传进度(fetch 对 request body 进度支持差)。
      const resp = await putRelayWithProgress(created.relay_id, deviceId, file, controller.signal, onProgress)
      onProgress({ sentBytes: file.size, speed: 0 })
      return resp
    } catch (err) {
      if (controller.signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) {
        throw new DOMException('已取消', 'AbortError')
      }
      // 对端离线/实时窗口错过/中枢错误 → 回落 tus 寄存(字节仍会落盘可取)
      fallback = uploadFile(file, conversationId, deviceId, onProgress)
      return fallback.promise
    }
  })()

  return {
    promise,
    cancel: () => {
      controller.abort()
      fallback?.cancel()
      if (relayId) {
        void fetch(api.relayUrl(relayId), {
          method: 'DELETE',
          headers: { 'X-Noobty-Device': deviceId },
        }).catch(() => undefined)
      }
    },
  }
}

export interface BatchProgress {
  /** 已完成字节(各文件合计) */
  sentBytes: number
  /** 全部文件总大小 */
  totalBytes: number
  speed: number
  /** 当前完成的文件数 */
  doneFiles: number
  fileCount: number
}

/**
 * 多文件/文件夹:各文件 tus 只寄存(不发消息),全部完成后 POST 一条 file_group。
 * 并发上限 2,避免打满中枢与客户端带宽。
 */
export function sendFileBatch(
  files: File[],
  conversationId: string,
  deviceId: string,
  onProgress: (p: BatchProgress) => void,
): UploadHandle {
  const controller = new AbortController()
  const handles: UploadHandle[] = []
  const totalBytes = files.reduce((s, f) => s + f.size, 0)
  const perFile = new Array(files.length).fill(0) as number[]

  const promise = (async (): Promise<CompleteResp> => {
    const fileIds: string[] = new Array(files.length)
    let next = 0
    const workers = Math.min(2, files.length)

    const report = (speed: number, doneFiles: number) => {
      const sentBytes = perFile.reduce((a, b) => a + b, 0)
      onProgress({ sentBytes, totalBytes, speed, doneFiles, fileCount: files.length })
    }

    await Promise.all(
      Array.from({ length: workers }, async () => {
        for (;;) {
          const i = next++
          if (i >= files.length) return
          if (controller.signal.aborted) throw new DOMException('已取消', 'AbortError')
          const file = files[i]!
          const handle = uploadFile(file, undefined, deviceId, ({ sentBytes, speed }) => {
            perFile[i] = sentBytes
            report(speed, perFile.filter((n, idx) => n >= (files[idx]?.size ?? 0)).length)
          })
          handles.push(handle)
          const resp = await handle.promise
          perFile[i] = file.size
          fileIds[i] = resp.file_id
          report(0, fileIds.filter(Boolean).length)
        }
      }),
    )

    if (controller.signal.aborted) throw new DOMException('已取消', 'AbortError')
    const message = await api.postFileGroup(conversationId, deviceId, fileIds)
    onProgress({
      sentBytes: totalBytes,
      totalBytes,
      speed: 0,
      doneFiles: files.length,
      fileCount: files.length,
    })
    return { file_id: fileIds[0]!, message }
  })()

  return {
    promise,
    cancel: () => {
      controller.abort()
      for (const h of handles) h.cancel()
    },
  }
}

function putRelayWithProgress(
  relayId: string,
  deviceId: string,
  file: File,
  signal: AbortSignal,
  onProgress: (p: UploadProgress) => void,
): Promise<CompleteResp> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('PUT', api.relayUrl(relayId))
    xhr.setRequestHeader('X-Noobty-Device', deviceId)
    xhr.setRequestHeader('Content-Type', 'application/octet-stream')
    xhr.responseType = 'json'

    const started = Date.now()
    xhr.upload.onprogress = (ev) => {
      if (!ev.lengthComputable) return
      const elapsed = Math.max(0.25, (Date.now() - started) / 1000)
      onProgress({ sentBytes: ev.loaded, speed: ev.loaded / elapsed })
    }

    const onAbort = () => {
      xhr.abort()
      reject(new DOMException('已取消', 'AbortError'))
    }
    signal.addEventListener('abort', onAbort, { once: true })

    xhr.onload = () => {
      signal.removeEventListener('abort', onAbort)
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(xhr.response as CompleteResp)
        return
      }
      const errBody = xhr.response as { error?: string } | null
      reject(new ApiError(xhr.status, errBody?.error ?? `直转失败(${xhr.status})`))
    }
    xhr.onerror = () => {
      signal.removeEventListener('abort', onAbort)
      reject(new ApiError(0, '直转网络错误'))
    }
    xhr.send(file)
  })
}

/** 接收方实时拉取直转流(与 PUT tee 并行);失败时调用方改走普通取件。优先磁盘流式落盘。 */
export function receiveRelay(
  relayId: string,
  deviceId: string,
  file: { file_id: string; name: string; size: number },
  onProgress: (p: { receivedBytes: number; totalBytes: number; speed: number }) => void,
): { promise: Promise<void>; cancel: () => void } {
  const controller = new AbortController()

  const promise = (async () => {
    const sink = await openSaveSink(file.name, file.size)
    const state = { received: 0, startedAt: Date.now(), totalBytes: file.size }
    try {
      const res = await fetch(api.relayUrl(relayId), {
        headers: { 'X-Noobty-Device': deviceId },
        signal: controller.signal,
      })
      if (!res.ok) throw new ApiError(res.status, `直转接收失败(${res.status})`)
      const reader = res.body?.getReader()
      if (!reader) throw new Error('直转响应无正文')
      await pumpReaderToSink(reader, sink, state, onProgress)
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
