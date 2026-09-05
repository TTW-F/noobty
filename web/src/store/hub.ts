// 应用状态:连接、设备、会话、消息、传输、存储
import { create } from 'zustand'
import { api, clearIdentity, loadIdentity, saveIdentity, type StoredIdentity } from '../lib/api'
import { downloadFile, type DownloadHandle } from '../lib/download'
import { uploadFile, type UploadHandle } from '../lib/upload'
import { HubSocket } from '../lib/ws'
import type {
  ConnectionState,
  ConversationId,
  Device,
  FileRef,
  Message,
  ServerFrame,
  StorageInfo,
  TransferTask,
} from '../lib/types'

export interface Toast {
  id: string
  kind: 'error' | 'ok'
  text: string
}

export type DownloadState =
  | { status: 'downloading'; receivedBytes: number; totalBytes: number; speed: number }
  | { status: 'saved' }
  | { status: 'error'; message: string }

interface HubState {
  status: ConnectionState
  hubVersion: string | null
  me: StoredIdentity | null
  devices: Device[]

  activeConv: ConversationId | null
  messages: Record<string, Message[]>
  /** 会话摘要(最后一条消息):来自 /api/conversations,未打开会话时列表也能显示预览 */
  lastMessages: Record<string, Message>
  historyStatus: Record<string, 'loading' | 'ready'>
  /** 是否还有更早的历史可加载 */
  hasMore: Record<string, boolean>
  loadingMore: Record<string, boolean>
  unread: Record<string, number>

  uploads: TransferTask[]
  downloads: Record<string, DownloadState>
  storage: StorageInfo | null

  toasts: Toast[]

  // ---- 动作 ----
  boot: () => void
  register: (name: string) => Promise<void>
  renameDevice: (name: string) => Promise<void>
  forgetDevice: () => void
  retryConnection: () => void
  setActiveConv: (conv: ConversationId | null) => void
  sendText: (conv: ConversationId, text: string) => Promise<boolean>
  sendFiles: (conv: ConversationId, files: File[]) => void
  retryUpload: (taskId: string) => void
  cancelUpload: (taskId: string) => void
  loadOlder: (conv: ConversationId) => void
  download: (file: FileRef) => void
  deleteMessage: (message: Message) => void
  refreshStorage: () => void
  pushToast: (kind: Toast['kind'], text: string) => void
  dismissToast: (id: string) => void
}

let socket: HubSocket | null = null
const uploadHandles = new Map<string, UploadHandle>()
const downloadHandles = new Map<string, DownloadHandle>()
let seq = 0

/** 历史分页大小,与 API 契约的示例值一致 */
const HISTORY_PAGE = 50

const newId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${(seq++).toString(36)}`

function isAbort(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError'
}

export const useHub = create<HubState>((set, get) => {
  // ---------- 内部工具 ----------

  function upsertMessage(m: Message): void {
    set((s) => {
      const list = s.messages[m.conversation_id] ?? []
      if (list.some((x) => x.message_id === m.message_id)) {
        // 内容对账后仍要刷新摘要时间线
        const last = s.lastMessages[m.conversation_id]
        if (!last || m.created_at >= last.created_at) {
          return { lastMessages: { ...s.lastMessages, [m.conversation_id]: m } }
        }
        return s
      }
      // 上传完成的 pending 占位与中枢广播对账:同一 file_id 视为同一条消息
      const pendingIndex = m.file
        ? list.findIndex(
            (x) =>
              x.message_id.startsWith('pending-') &&
              x.from_device_id === m.from_device_id &&
              x.file?.file_id === m.file?.file_id,
          )
        : -1
      const next =
        pendingIndex >= 0
          ? list.map((x, i) => (i === pendingIndex ? m : x))
          : [...list, m].sort((a, b) => a.created_at.localeCompare(b.created_at))
      const last = s.lastMessages[m.conversation_id]
      const lastMessages =
        !last || m.created_at >= last.created_at
          ? { ...s.lastMessages, [m.conversation_id]: m }
          : s.lastMessages
      return { messages: { ...s.messages, [m.conversation_id]: next }, lastMessages }
    })
  }

  function bumpUnread(conv: ConversationId, fromDeviceId: string): void {
    if (fromDeviceId === get().me?.device_id) return
    if (get().activeConv === conv && document.visibilityState === 'visible') return
    set((s) => ({ unread: { ...s.unread, [conv]: (s.unread[conv] ?? 0) + 1 } }))
  }

  function ack(m: Message): void {
    socket?.send({ type: 'ack_message', message_id: m.message_id })
  }

  async function loadHistory(conv: ConversationId): Promise<void> {
    const me = get().me
    if (!me) return
    if (get().historyStatus[conv] === 'ready') return
    set((s) => ({ historyStatus: { ...s.historyStatus, [conv]: 'loading' } }))
    try {
      const { messages } = await api.history(conv, me.device_id, undefined, HISTORY_PAGE)
      const { merged } = mergeMessages(conv, messages)
      set((s) => ({
        messages: { ...s.messages, [conv]: merged },
        historyStatus: { ...s.historyStatus, [conv]: 'ready' },
        hasMore: { ...s.hasMore, [conv]: messages.length >= HISTORY_PAGE },
      }))
    } catch {
      set((s) => {
        const next = { ...s.historyStatus }
        delete next[conv]
        return { historyStatus: next }
      })
      get().pushToast('error', '历史加载失败,请重试')
    }
  }

  async function syncSnapshot(): Promise<void> {
    const me = get().me
    if (!me) return
    try {
      const [devices, convs, healthz] = await Promise.all([
        api.listDevices(),
        api.listConversations(me.device_id).catch(() => []),
        api.healthz().catch(() => null),
      ])
      const patch: Partial<HubState> = { devices }
      if (healthz) patch.hubVersion = healthz.version
      const seeded = { ...get().unread }
      const lastMessages = { ...get().lastMessages }
      for (const c of convs) {
        if (c.unread > 0) seeded[c.conversation_id] = Math.max(seeded[c.conversation_id] ?? 0, c.unread)
        // 本地没打开过的会话,用服务端摘要补列表预览
        if (c.last_message && !get().messages[c.conversation_id]?.length) {
          const m = c.last_message
          lastMessages[c.conversation_id] = {
            message_id: m.message_id,
            conversation_id: m.conversation_id,
            from_device_id: m.from_device_id,
            created_at: m.created_at,
            kind: m.kind,
            text: m.text,
            file: m.file,
            files: m.files,
            mode: m.mode,
          }
        }
      }
      patch.unread = seeded
      patch.lastMessages = lastMessages
      set(patch)
      get().refreshStorage()
    } catch {
      // 快照失败不致命,重连后再同步
    }
  }

  function handleFrame(frame: ServerFrame): void {
    switch (frame.type) {
      case 'hello': {
        set({ devices: frame.devices })
        break
      }
      case 'presence': {
        set((s) => ({
          devices: s.devices.map((d) =>
            d.device_id === frame.device_id
              ? {
                  ...d,
                  online: frame.online,
                  last_seen: frame.online ? new Date().toISOString() : d.last_seen,
                }
              : d,
          ),
        }))
        break
      }
      case 'message': {
        const m: Message = {
          message_id: frame.message_id,
          conversation_id: frame.conversation_id,
          from_device_id: frame.from_device_id,
          created_at: frame.created_at,
          kind: frame.kind,
          text: frame.text,
          file: frame.file,
          files: frame.files,
          mode: frame.mode,
        }
        upsertMessage(m)
        bumpUnread(m.conversation_id, m.from_device_id)
        ack(m)
        break
      }
      default:
        break
    }
  }

  function connectSocket(deviceId: string): void {
    socket?.close()
    socket = new HubSocket({
      onFrame: handleFrame,
      onStatus: (status) => {
        set({ status })
        if (status === 'online') {
          void syncSnapshot()
          const conv = get().activeConv
          if (conv) void loadHistory(conv)
        }
      },
    })
    socket.connect(deviceId)
  }

  function mergeMessages(conv: ConversationId, incoming: Message[]): { merged: Message[]; added: number } {
    const existing = get().messages[conv] ?? []
    const seen = new Set(existing.map((m) => m.message_id))
    const fresh: Message[] = []
    for (const m of incoming) {
      if (!seen.has(m.message_id)) {
        seen.add(m.message_id)
        fresh.push(m)
      }
    }
    const merged = [...fresh, ...existing].sort((a, b) => a.created_at.localeCompare(b.created_at))
    return { merged, added: fresh.length }
  }

  function runUpload(task: TransferTask, file: File): void {
    const me = get().me
    if (!me) return
    const handle = uploadFile(file, task.conversationId, me.device_id, ({ sentBytes, speed }) => {
      set((s) => ({
        uploads: s.uploads.map((t) => (t.id === task.id ? { ...t, sentBytes, speed } : t)),
      }))
    })
    uploadHandles.set(task.id, handle)
    handle.promise
      .then(() => {
        // 消息本体由中枢广播(或与 pending 占位对账),这里只收尾任务条
        set((s) => ({ uploads: s.uploads.filter((t) => t.id !== task.id) }))
        uploadHandles.delete(task.id)
      })
      .catch((err: unknown) => {
        uploadHandles.delete(task.id)
        if (isAbort(err)) {
          set((s) => ({ uploads: s.uploads.filter((t) => t.id !== task.id) }))
          return
        }
        const message = err instanceof Error ? err.message : '上传失败'
        set((s) => ({
          uploads: s.uploads.map((t) =>
            t.id === task.id
              ? { ...t, status: 'error' as const, error: message, sentBytes: 0, speed: 0 }
              : t,
          ),
        }))
        get().pushToast('error', `${file.name}:${message}`)
      })
  }

  // ---------- 动作 ----------

  return {
    status: 'connecting',
    hubVersion: null,
    me: null,
    devices: [],

    activeConv: null,
    messages: {},
    lastMessages: {},
    historyStatus: {},
    hasMore: {},
    loadingMore: {},
    unread: {},

    uploads: [],
    downloads: {},
    storage: null,

    toasts: [],

    boot: () => {
      const identity = loadIdentity()
      if (!identity) return
      set({ me: identity })
      connectSocket(identity.device_id)
    },

    register: async (name) => {
      const identity = await api.registerDevice(name)
      saveIdentity(identity)
      set({ me: identity })
      connectSocket(identity.device_id)
    },

    renameDevice: async (name) => {
      const me = get().me
      if (!me) return
      // 契约:重新注册采用同 device_id,仅更新名字
      const identity = await api.registerDevice(name)
      const next = { device_id: me.device_id, name: identity.name }
      saveIdentity(next)
      set((s) => ({
        me: next,
        devices: s.devices.map((d) =>
          d.device_id === me.device_id ? { ...d, name: next.name } : d,
        ),
      }))
    },

    forgetDevice: () => {
      clearIdentity()
      socket?.close()
      socket = null
      set({
        me: null,
        devices: [],
        messages: {},
        lastMessages: {},
        historyStatus: {},
        hasMore: {},
        loadingMore: {},
        unread: {},
        activeConv: null,
        status: 'connecting',
      })
    },

    retryConnection: () => {
      const me = get().me
      if (!me) return
      socket?.reconnectNow(me.device_id)
    },

    setActiveConv: (conv) => {
      set((s) => {
        const unread = { ...s.unread }
        if (conv) delete unread[conv]
        return { activeConv: conv, unread }
      })
      if (conv) void loadHistory(conv)
    },

    sendText: async (conv, text) => {
      const me = get().me
      if (!me) return false
      try {
        const m = await api.sendText(conv, me.device_id, text)
        upsertMessage(m)
        return true
      } catch (err) {
        get().pushToast('error', err instanceof Error ? err.message : '发送失败,请重试')
        return false
      }
    },

    sendFiles: (conv, files) => {
      const me = get().me
      if (!me || files.length === 0) return
      for (const f of files) {
        const task: TransferTask = {
          id: newId('task'),
          conversationId: conv,
          name: f.name,
          size: f.size,
          sentBytes: 0,
          speed: 0,
          status: 'uploading',
          file: f,
        }
        set((s) => ({ uploads: [...s.uploads, task] }))
        runUpload(task, f)
      }
    },

    retryUpload: (taskId) => {
      const task = get().uploads.find((t) => t.id === taskId)
      if (!task?.file) return
      set((s) => ({
        uploads: s.uploads.map((t) =>
          t.id === taskId ? { ...t, status: 'uploading' as const, error: undefined, sentBytes: 0, speed: 0 } : t,
        ),
      }))
      runUpload(task, task.file)
    },

    cancelUpload: (taskId) => {
      const handle = uploadHandles.get(taskId)
      if (handle) {
        handle.cancel() // abort 分支会把任务从列表移除
      } else {
        set((s) => ({ uploads: s.uploads.filter((t) => t.id !== taskId) }))
      }
    },

    loadOlder: (conv) => {
      const me = get().me
      if (!me || get().loadingMore[conv] || !get().hasMore[conv]) return
      const first = (get().messages[conv] ?? []).find((m) => !m.message_id.startsWith('pending-'))
      if (!first) return
      set((s) => ({ loadingMore: { ...s.loadingMore, [conv]: true } }))
      void (async () => {
        try {
          const { messages } = await api.history(conv, me.device_id, first.message_id, HISTORY_PAGE)
          const { merged } = mergeMessages(conv, messages)
          set((s) => ({
            messages: { ...s.messages, [conv]: merged },
            hasMore: { ...s.hasMore, [conv]: messages.length >= HISTORY_PAGE },
            loadingMore: { ...s.loadingMore, [conv]: false },
          }))
        } catch {
          set((s) => ({ loadingMore: { ...s.loadingMore, [conv]: false } }))
          get().pushToast('error', '更早的消息加载失败,请重试')
        }
      })()
    },

    download: (file) => {
      if (downloadHandles.has(file.file_id)) return
      set((s) => ({
        downloads: {
          ...s.downloads,
          [file.file_id]: { status: 'downloading', receivedBytes: 0, totalBytes: file.size, speed: 0 },
        },
      }))
      const handle = downloadFile(file, ({ receivedBytes, totalBytes, speed }) => {
        set((s) => {
          const cur = s.downloads[file.file_id]
          if (!cur || cur.status !== 'downloading') return s
          return {
            downloads: {
              ...s.downloads,
              [file.file_id]: { status: 'downloading', receivedBytes, totalBytes, speed },
            },
          }
        })
      })
      downloadHandles.set(file.file_id, handle)
      handle.promise
        .then(() => {
          set((s) => ({ downloads: { ...s.downloads, [file.file_id]: { status: 'saved' } } }))
        })
        .catch((err: unknown) => {
          if (isAbort(err)) {
            set((s) => {
              const next = { ...s.downloads }
              delete next[file.file_id]
              return { downloads: next }
            })
            return
          }
          set((s) => ({
            downloads: {
              ...s.downloads,
              [file.file_id]: { status: 'error', message: err instanceof Error ? err.message : '下载失败' },
            },
          }))
          get().pushToast('error', `${file.name}:下载失败`)
        })
        .finally(() => downloadHandles.delete(file.file_id))
    },

    deleteMessage: (message) => {
      const me = get().me
      if (!me) return
      const fileIds =
        message.kind === 'file' && message.file
          ? [message.file]
          : message.kind === 'file_group'
            ? (message.files ?? [])
            : []
      void (async () => {
        try {
          await api.deleteMessage(message.message_id, me.device_id)
          set((s) => {
            const list = (s.messages[message.conversation_id] ?? []).filter(
              (m) => m.message_id !== message.message_id,
            )
            const lastMessages = { ...s.lastMessages }
            const remaining = list[list.length - 1]
            if (remaining) {
              lastMessages[message.conversation_id] = remaining
            } else {
              delete lastMessages[message.conversation_id]
            }
            return {
              messages: { ...s.messages, [message.conversation_id]: list },
              lastMessages,
            }
          })
          // 消息删除后同步清理寄存文件(尽力而为)
          for (const f of fileIds) void api.deleteFile(f.file_id, me.device_id).catch(() => undefined)
        } catch (err) {
          get().pushToast('error', err instanceof Error ? err.message : '删除失败')
        }
      })()
    },

    refreshStorage: () => {
      void api
        .storage()
        .then((storage) => set({ storage }))
        .catch(() => undefined)
    },

    pushToast: (kind, text) => {
      const id = newId('toast')
      set((s) => ({ toasts: [...s.toasts.slice(-3), { id, kind, text }] }))
      setTimeout(() => get().dismissToast(id), kind === 'ok' ? 4000 : 8000)
    },

    dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  }
})

// 便捷选择器
export const selectOtherDevices = (s: HubState): Device[] =>
  s.devices.filter((d) => d.device_id !== s.me?.device_id)
