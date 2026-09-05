// REST 客户端 — 端点与语义见 docs/API.md
import type { ConversationId, Device, HubVersion, Message, StorageInfo, UploadSession } from './types'

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

  constructor(status: number, message: string) {
    super(message)
    this.status = status
    this.name = 'ApiError'
  }
}

async function request<T>(path: string, init?: RequestInit & { deviceId?: string }): Promise<T> {
  const headers = new Headers(init?.headers)
  if (init?.deviceId) headers.set('X-Noobty-Device', init.deviceId)
  if (init?.body && typeof init.body === 'string') headers.set('Content-Type', 'application/json')

  const res = await fetch(path, { ...init, headers })
  if (!res.ok) {
    let message = `请求失败(${res.status})`
    try {
      const body = (await res.json()) as { error?: string }
      if (typeof body.error === 'string' && body.error) message = body.error
    } catch {
      // 非 JSON 错误体,保留默认文案
    }
    throw new ApiError(res.status, message)
  }
  return (await res.json()) as T
}

export const api = {
  healthz: () => request<HubVersion>('/api/healthz'),

  storage: () => request<StorageInfo>('/api/storage'),

  registerDevice: (name: string) =>
    request<StoredIdentity>('/api/devices/register', {
      method: 'POST',
      body: JSON.stringify({ name }),
    }),

  listDevices: () => request<Device[]>('/api/devices'),

  listConversations: (deviceId: string) =>
    request<{ conversation_id: string; last_message?: Message; unread: number }[]>(
      '/api/conversations',
      { deviceId },
    ),

  history: (conversationId: ConversationId, deviceId: string, before?: string, limit = 50) => {
    const query = new URLSearchParams()
    if (before) query.set('before', before)
    query.set('limit', String(limit))
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
    request<{ ok: boolean }>(`/api/messages/${encodeURIComponent(messageId)}`, {
      method: 'DELETE',
      deviceId,
    }),

  deleteFile: (fileId: string, deviceId: string) =>
    request<{ ok: boolean }>(`/api/files/${encodeURIComponent(fileId)}`, {
      method: 'DELETE',
      deviceId,
    }),

  createUpload: (deviceId: string, name: string, size: number, sha256?: string) =>
    request<UploadSession>('/api/uploads', {
      method: 'POST',
      deviceId,
      body: JSON.stringify(size >= 0 ? { name, size, ...(sha256 ? { sha256 } : {}) } : { name, size }),
    }),

  queryUpload: (uploadId: string) =>
    request<{ received_bytes: number; chunk_size: number }>(`/api/uploads/${encodeURIComponent(uploadId)}`),

  putChunk: (uploadId: string, offset: number, chunk: Blob) =>
    request<{ received_bytes: number }>(`/api/uploads/${encodeURIComponent(uploadId)}`, {
      method: 'PUT',
      headers: { 'X-Noobty-Offset': String(offset), 'Content-Type': 'application/octet-stream' },
      body: chunk,
    }),

  completeUpload: (uploadId: string, conversationId: ConversationId) =>
    request<{ file_id: string }>(`/api/uploads/${encodeURIComponent(uploadId)}/complete`, {
      method: 'POST',
      body: JSON.stringify({ conversation_id: conversationId, as_message: true }),
    }),

  fileMeta: (fileId: string) =>
    request<{ file_id: string; name: string; size: number; uploaded_at: string; expires_at: string }>(
      `/api/files/${encodeURIComponent(fileId)}/meta`,
    ),

  fileUrl: (fileId: string) => `/api/files/${encodeURIComponent(fileId)}`,
}
