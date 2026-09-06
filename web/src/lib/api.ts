// REST 客户端 — 端点与语义见 docs/API.md,并已对齐 server 的实现:
// - DELETE 返回 204 无响应体
// - 上传链路(PUT/GET/complete)同样要求 X-Noobty-Device 头
// - complete 返回 { file_id, message }(message 为服务端生成的消息本体)
// - 会话摘要为 { conversation_id, peer, last_message?: brief },无 unread 字段
// - 大厅(lobby)为广播会话;旧中枢可能拒绝,客户端以探测结果门控
import type {
  ConversationId,
  Device,
  HubVersion,
  Message,
  StorageInfo,
  StoredFileItem,
  UploadSession,
} from './types'

export const DEVICE_STORAGE_KEY = 'noobty.device.v1'

export interface StoredIdentity {
  device_id: string
  name: string
}

export function loadIdentity(): StoredIdentity | null {
  try {
    const raw = localStorage.getItem(DEVICE_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<StoredIdentity>
    if (typeof parsed.device_id === 'string' && typeof parsed.name === 'string') {
      return { device_id: parsed.device_id, name: parsed.name }
    }
    return null
  } catch {
    return null
  }
}

export function saveIdentity(identity: StoredIdentity): void {
  try {
    localStorage.setItem(DEVICE_STORAGE_KEY, JSON.stringify(identity))
  } catch {
    // 隐私模式等场景下写入失败不致命:本次会话仍可用
  }
}

export function clearIdentity(): void {
  try {
    localStorage.removeItem(DEVICE_STORAGE_KEY)
  } catch {
    /* 同上 */
  }
}

export class ApiError extends Error {
  readonly status: number
  readonly fallback?: string

  constructor(status: number, message: string, fallback?: string) {
    super(message)
    this.status = status
    this.name = 'ApiError'
    this.fallback = fallback
  }
}

async function request<T>(path: string, init?: RequestInit & { deviceId?: string }): Promise<T> {
  const headers = new Headers(init?.headers)
  if (init?.deviceId) headers.set('X-Noobty-Device', init.deviceId)
  if (init?.body && typeof init.body === 'string') headers.set('Content-Type', 'application/json')

  const res = await fetch(path, { ...init, headers })
  if (res.status === 204) return undefined as T
  if (!res.ok) {
    let message = `请求失败(${res.status})`
    let fallback: string | undefined
    try {
      const body = (await res.json()) as { error?: string; fallback?: string }
      if (typeof body.error === 'string' && body.error) message = body.error
      if (typeof body.fallback === 'string') fallback = body.fallback
    } catch {
      // 非 JSON 错误体,保留默认文案
    }
    throw new ApiError(res.status, message, fallback)
  }
  return (await res.json()) as T
}

/** 会话摘要里的"最后一条消息"简报(服务端形状) */
export interface LastMessageBrief {
  message_id: string
  created_at: string
  kind: string
  preview: string | null
}

export interface ConversationSummaryDTO {
  conversation_id: string
  peer: Device
  last_message?: LastMessageBrief
}

export interface CompleteResp {
  file_id: string
  message?: Message
}

/** Tauri updater / web download payload from GET /releases/shell/latest.json */
export interface ShellRelease {
  version: string
  notes?: string
  pub_date?: string
  url: string
  signature: string
}

export const api = {
  healthz: () => request<HubVersion>('/api/healthz'),

  storage: () => request<StorageInfo>('/api/storage'),

  /** `null` when hub has no staged shell installer (204). */
  shellLatest: async (): Promise<ShellRelease | null> => {
    const r = await request<ShellRelease | undefined>('/releases/shell/latest.json')
    return r ?? null
  },

  registerDevice: (name: string) =>
    request<StoredIdentity>('/api/devices/register', {
      method: 'POST',
      body: JSON.stringify({ name }),
    }),

  listDevices: () => request<Device[]>('/api/devices'),

  listConversations: (deviceId: string) =>
    request<ConversationSummaryDTO[]>('/api/conversations', { deviceId }),

  history: (
    conversationId: ConversationId,
    deviceId: string,
    opts: { before?: string; after?: string; after_seq?: number; limit?: number } = {},
  ) => {
    const query = new URLSearchParams()
    if (opts.before) query.set('before', opts.before)
    if (opts.after) query.set('after', opts.after)
    if (opts.after_seq != null) query.set('after_seq', String(opts.after_seq))
    query.set('limit', String(opts.limit ?? 50))
    return request<{ messages: Message[] }>(
      `/api/conversations/${encodeURIComponent(conversationId)}/messages?${query}`,
      { deviceId },
    )
  },

  sendText: (conversationId: ConversationId, deviceId: string, text: string) =>
    request<Message>(`/api/conversations/${encodeURIComponent(conversationId)}/texts`, {
      method: 'POST',
      deviceId,
      body: JSON.stringify({ text }),
    }),

  deleteMessage: (messageId: string, deviceId: string) =>
    request<undefined>(`/api/messages/${encodeURIComponent(messageId)}`, {
      method: 'DELETE',
      deviceId,
    }),

  deleteFile: (fileId: string, deviceId: string) =>
    request<undefined>(`/api/files/${encodeURIComponent(fileId)}`, {
      method: 'DELETE',
      deviceId,
    }),

  createUpload: (deviceId: string, name: string, size: number, sha256?: string) =>
    request<UploadSession>('/api/uploads', {
      method: 'POST',
      deviceId,
      body: JSON.stringify({ name, size, ...(sha256 ? { sha256 } : {}) }),
    }),

  queryUpload: (uploadId: string, deviceId: string) =>
    request<{ received_bytes: number; chunk_size: number }>(`/api/uploads/${encodeURIComponent(uploadId)}`, {
      deviceId,
    }),

  putChunk: (uploadId: string, deviceId: string, offset: number, chunk: Blob) =>
    request<{ received_bytes: number }>(`/api/uploads/${encodeURIComponent(uploadId)}`, {
      method: 'PUT',
      deviceId,
      headers: { 'X-Noobty-Offset': String(offset), 'Content-Type': 'application/octet-stream' },
      body: chunk,
    }),

  completeUpload: (uploadId: string, deviceId: string, conversationId?: ConversationId) =>
    request<CompleteResp>(`/api/uploads/${encodeURIComponent(uploadId)}/complete`, {
      method: 'POST',
      deviceId,
      body: JSON.stringify(
        conversationId
          ? { conversation_id: conversationId, as_message: true }
          : {},
      ),
    }),

  postFileGroup: (conversationId: ConversationId, deviceId: string, fileIds: string[]) =>
    request<Message>(`/api/conversations/${encodeURIComponent(conversationId)}/file-groups`, {
      method: 'POST',
      deviceId,
      body: JSON.stringify({ file_ids: fileIds }),
    }),

  /** 发送开始即通知对端(短暂卡片,不入库) */
  announceTransfer: (
    conversationId: ConversationId,
    deviceId: string,
    transferId: string,
    files: { name: string; size: number }[],
  ) =>
    request<void>(`/api/conversations/${encodeURIComponent(conversationId)}/transfers/announce`, {
      method: 'POST',
      deviceId,
      body: JSON.stringify({ transfer_id: transferId, files }),
    }),

  createRelay: (deviceId: string, name: string, size: number, conversationId: ConversationId) =>
    request<RelayCreated>('/api/relays', {
      method: 'POST',
      deviceId,
      body: JSON.stringify({ name, size, conversation_id: conversationId }),
    }),

  /** 直转 PUT:整文件 body,边落盘边推接收方 */
  putRelay: async (relayId: string, deviceId: string, body: Blob, signal?: AbortSignal) => {
    const headers = new Headers({
      'X-Noobty-Device': deviceId,
      'Content-Type': 'application/octet-stream',
    })
    const res = await fetch(`/api/relays/${encodeURIComponent(relayId)}`, {
      method: 'PUT',
      headers,
      body,
      signal,
    })
    if (!res.ok) {
      let message = `直转失败(${res.status})`
      try {
        const b = (await res.json()) as { error?: string }
        if (b.error) message = b.error
      } catch {
        /* keep default */
      }
      throw new ApiError(res.status, message)
    }
    return (await res.json()) as CompleteResp
  },

  relayUrl: (relayId: string) => `/api/relays/${encodeURIComponent(relayId)}`,

  fileMeta: (fileId: string) =>
    request<{ file_id: string; name: string; size: number; uploaded_at: string; expires_at: string }>(
      `/api/files/${encodeURIComponent(fileId)}/meta`,
    ),

  /** 文件仓库:中枢当前寄存的文件(最新在前)。`before` = 游标(更旧一页)。 */
  listFiles: (limit = 100, before?: string) => {
    const q = new URLSearchParams({ limit: String(limit) })
    if (before) q.set('before', before)
    return request<{ files: StoredFileItem[] }>(`/api/files?${q}`)
  },

  fileUrl: (fileId: string) => `/api/files/${encodeURIComponent(fileId)}`,

  /** 小图预览(JPEG);非图片或过大时 404 */
  thumbUrl: (fileId: string) => `/api/files/${encodeURIComponent(fileId)}/thumb`,
}

export interface RelayCreated {
  relay_id: string
  file_id: string
  name: string
  size: number
  conversation_id: string
  to_device_id: string
}
