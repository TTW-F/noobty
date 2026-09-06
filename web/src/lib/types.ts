// 与 docs/API.md 保持一致的类型契约(后端拥有该契约,前端对齐它)

export interface Device {
  device_id: string
  name: string
  online: boolean
  last_seen: string | null
}

export interface FileRef {
  file_id: string
  name: string
  size: number
}

export type MessageKind = 'text' | 'file' | 'file_group'
export type TransferMode = 'stored' | 'relay'

export interface Message {
  message_id: string
  conversation_id: string
  from_device_id: string
  /** 线程内单调序号(server 分配);断线补拉用 after_seq,比 message_id 游标更稳 */
  seq?: number
  created_at: string
  kind: MessageKind
  text?: string
  file?: FileRef
  files?: FileRef[]
  mode?: TransferMode
  /** 对方确认已看到的时间(server:MessageView.acked_at);仅对自己发的消息有意义 */
  acked_at?: string
}

export type ConversationId = string // 'lobby' | `private:<device_id>`

export interface StorageInfo {
  used_bytes: number
  max_total_bytes: number
  retention_days: number
}

/** `GET /api/files` 仓库条目(中枢寄存清单) */
export interface StoredFileItem {
  file_id: string
  name: string
  size: number
  device_id: string
  uploaded_at: string
  expires_at: string
}

export interface HubVersion {
  ok: boolean
  name: string
  version: string
}

// ---- WebSocket 帧 ----

export type ServerFrame =
  | { type: 'hello'; device_id: string; devices: Device[] }
  | { type: 'presence'; device_id: string; online: boolean }
  | (Message & { type: 'message' })
  | { type: 'transfer_progress'; transfer_id: string; message_id: string; bytes_done: number; bytes_total: number }
  | { type: 'message_acked'; message_id: string }
  | { type: 'message_deleted'; message_id: string; conversation_id: string }
  | { type: 'file_deleted'; file_id: string }
  | {
      type: 'relay_offer'
      relay_id: string
      from_device_id: string
      conversation_id: string
      name: string
      size: number
      file_id: string
    }
  | { type: 'pong' }

export type ClientFrame = { type: 'ping' } | { type: 'ack_message'; message_id: string }

// ---- 上传会话 ----

export interface UploadSession {
  upload_id: string
  file_id: string
  chunk_size: number
  received_bytes: number
}

// 本地发送队列里的文件任务(比 Message 更细的进度粒度)
export interface TransferTask {
  id: string
  conversationId: ConversationId
  name: string
  size: number
  sentBytes: number
  speed: number // B/s,滑动窗口
  status: 'uploading' | 'done' | 'error'
  error?: string
  /** 原始文件引用(仅内存,用于失败重试;不参与持久化) */
  file?: File
}

export type ConnectionState = 'connecting' | 'online' | 'reconnecting' | 'offline'
