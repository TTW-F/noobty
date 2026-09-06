// 应用状态:连接、设备、会话、消息、传输、存储
//
// 线程模型(与 server 对齐):server 把会话按"收件人"组织——发往 B 的消息存于线程
// private:B,发给我的存于 private:<me>。一次双人往来跨两个线程,因此客户端以
// "与某设备的对话"为显示单位,加载时合并两条线程(我→X 的出站线程 + 我的收件箱中
// 来自 X 的部分),分页游标按线程各自维护。发给我的消息在入桶时重映射到发送者的会话。
import { create } from 'zustand'
import { api, clearIdentity, loadIdentity, saveIdentity, type StoredIdentity } from '../lib/api'
import { onIncomingMessage } from '../lib/shell'
import { downloadFile, type DownloadHandle } from '../lib/download'
import { sendFile, sendFileBatch, receiveRelay, type UploadHandle } from '../lib/send'
import { inShell, shellDownloadToDownloads } from '../lib/shell'
import { sweepAbandonedOpfsSaves } from '../lib/saveStream'
import { closeLightbox } from '../lib/lightbox'
import { HubSocket, bindWsTabLeader } from '../lib/ws'
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

export type AppView = 'chats' | 'files'

/** 文件仓库条目:来自 GET /api/files 的中枢寄存清单 */
export interface LibraryEntry {
  file: FileRef
  deviceId: string
  fromName: string
  mine: boolean
  uploadedAt: string
  expiresAt: string
}

/** 一个显示会话背后两条线程的分页游标(out = 我→对方,in = 我的收件箱) */
interface ThreadPages {
  outCursor?: string
  inCursor?: string
  outHasMore: boolean
  inHasMore: boolean
}

const PAGE = 25
/** 常驻托盘客户端:每会话内存消息上限(仍可上翻回拉) */
const MAX_MESSAGES_IN_MEMORY = 200
/** 过期/已删文件标记上限,超出丢最旧键 */
const MAX_DEAD_FILES = 64
/** 下载终态(saved/error)保留时长后从 map 剔除,避免常驻堆积 */
const DOWNLOAD_TERMINAL_TTL_MS = 8_000
/** 窗口隐藏超过此时长后 park:丢掉消息窗与仓库(托盘关窗常挂着) */
const HIDDEN_PARK_MS = 20_000

/** 侧栏摘要只需 kind/text/计数/时间;file_group 不挂全量 FileRef[] */
function slimPreview(m: Message): Message {
  if (m.kind === 'file_group') {
    const n = m.files?.length ?? 0
    return {
      message_id: m.message_id,
      conversation_id: m.conversation_id,
      from_device_id: m.from_device_id,
      created_at: m.created_at,
      kind: 'file_group',
      text: n > 0 ? `${n} 个文件` : m.text,
    }
  }
  if (m.kind === 'file' && m.file) {
    return {
      message_id: m.message_id,
      conversation_id: m.conversation_id,
      from_device_id: m.from_device_id,
      created_at: m.created_at,
      kind: 'file',
      file: { file_id: m.file.file_id, name: m.file.name, size: m.file.size },
    }
  }
  return {
    message_id: m.message_id,
    conversation_id: m.conversation_id,
    from_device_id: m.from_device_id,
    created_at: m.created_at,
    kind: m.kind,
    text: m.text,
  }
}

interface HubState {
  status: ConnectionState
  hubVersion: string | null
  me: StoredIdentity | null
  devices: Device[]
  /** 中枢是否支持大厅:null 表示尚在探测(旧中枢可能拒绝) */
  lobbySupported: boolean | null

  activeConv: ConversationId | null
  /** 顶层视图:聊天 或 文件仓库 */
  view: AppView
  library: LibraryEntry[]
  libraryStatus: 'idle' | 'loading' | 'ready'
  libraryHasMore: boolean
  libraryLoadingMore: boolean
  /** 当前活动会话是否为应用自动代选(用户一旦手动选择即失效) */
  activeConvIsAuto: boolean
  messages: Record<string, Message[]>
  /** 会话摘要(最后一条消息):来自 /api/conversations,未打开会话时列表也能显示预览 */
  lastMessages: Record<string, Message>
  historyStatus: Record<string, 'loading' | 'ready'>
  /** 每个显示会话的双线程分页游标(out=我→对方,in=我的收件箱) */
  threadPages: Record<string, ThreadPages>
  /** 是否还有更早的历史可加载(任一线程还有即算有) */
  hasMore: Record<string, boolean>
  loadingMore: Record<string, boolean>
  unread: Record<string, number>

  uploads: TransferTask[]
  downloads: Record<string, DownloadState>
  /** 已被删除/清理的寄存文件:对应文件卡显示"已过期或已删除"且不可再取件 */
  deadFiles: Record<string, true>
  storage: StorageInfo | null

  toasts: Toast[]

  // ---- 动作 ----
  boot: () => void
  register: (name: string) => Promise<void>
  renameDevice: (name: string) => Promise<void>
  forgetDevice: () => void
  retryConnection: () => void
  setActiveConv: (conv: ConversationId | null) => void
  setView: (view: AppView) => void
  loadLibrary: () => Promise<void>
  loadLibraryMore: () => Promise<void>
  deleteStoredFile: (file: FileRef) => void
  /** 应用代选默认会话:随设备在线状态可被再次纠正;用户手选后不再干预 */
  autoSelectConv: (conv: ConversationId) => void
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
let releaseTabLock: (() => void) | null = null
const uploadHandles = new Map<string, UploadHandle>()
const downloadHandles = new Map<string, DownloadHandle>()
const historyInflight = new Map<string, Promise<void>>()
const downloadClearTimers = new Map<string, ReturnType<typeof setTimeout>>()
let seq = 0
/** 本次页面会话是否成功连上过中枢:区分首次加载与断线重连 */
let everConnected = false
/** 托盘关窗/页签隐藏后进入 park:不持有消息窗,只留 lastMessages */
let parked = false
let parkTimer: ReturnType<typeof setTimeout> | null = null
let visibilityHooked = false

const newId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${(seq++).toString(36)}`

function isAbort(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError'
}

function disconnectSocket(): void {
  releaseTabLock?.()
  releaseTabLock = null
  socket?.close()
  socket = null
}

export const useHub = create<HubState>((set, get) => {
  // ---------- 内部工具 ----------

  /** 下载终态限期剔除:托盘常驻时 downloads map 否则只增不减 */
  function setDownloadTerminal(fileId: string, state: DownloadState): void {
    const prev = downloadClearTimers.get(fileId)
    if (prev) clearTimeout(prev)
    set((s) => ({ downloads: { ...s.downloads, [fileId]: state } }))
    downloadClearTimers.set(
      fileId,
      setTimeout(() => {
        downloadClearTimers.delete(fileId)
        set((s) => {
          const cur = s.downloads[fileId]
          if (!cur || cur.status === 'downloading') return s
          const next = { ...s.downloads }
          delete next[fileId]
          return { downloads: next }
        })
      }, DOWNLOAD_TERMINAL_TTL_MS),
    )
  }

  function clearDownloadEntry(fileId: string): void {
    const t = downloadClearTimers.get(fileId)
    if (t) clearTimeout(t)
    downloadClearTimers.delete(fileId)
    set((s) => {
      if (!(fileId in s.downloads)) return s
      const next = { ...s.downloads }
      delete next[fileId]
      return { downloads: next }
    })
  }

  /** 标记 dead 并裁剪到上限(插入序丢最旧) */
  function markDeadFile(fileId: string, alsoFilterLibrary = true): void {
    set((s) => {
      const deadFiles: Record<string, true> = { ...s.deadFiles, [fileId]: true }
      const keys = Object.keys(deadFiles)
      if (keys.length > MAX_DEAD_FILES) {
        for (const k of keys.slice(0, keys.length - MAX_DEAD_FILES)) delete deadFiles[k]
      }
      return {
        deadFiles,
        ...(alsoFilterLibrary
          ? { library: s.library.filter((e) => e.file.file_id !== fileId) }
          : {}),
      }
    })
  }

  /** 线程键 → 显示键:发给我的消息归档进"与发送者的会话" */
  function uiConvKey(threadId: string, fromDeviceId: string): ConversationId {
    const me = get().me
    if (me && threadId === `private:${me.device_id}`) {
      return `private:${fromDeviceId}`
    }
    return threadId
  }

  function inboxThread(): string {
    return `private:${get().me?.device_id ?? ''}`
  }

  /** 侧栏摘要:不入消息列表(非活跃会话只靠 lastMessages 预览) */
  function touchLastMessage(bucket: ConversationId, m: Message): void {
    const brief = slimPreview(m)
    set((s) => {
      const last = s.lastMessages[bucket]
      if (last && brief.created_at < last.created_at) return s
      return { lastMessages: { ...s.lastMessages, [bucket]: brief } }
    })
  }

  /** 是否正在持有该会话的消息窗口(活跃或已加载历史);park 时一律不持有 */
  function holdingMessages(bucket: ConversationId, s: HubState = get()): boolean {
    if (parked) return false
    return (
      s.activeConv === bucket ||
      s.historyStatus[bucket] === 'ready' ||
      s.historyStatus[bucket] === 'loading'
    )
  }

  /** 关窗/隐藏一段时间后释放常驻内存;再显示时按需重拉 */
  function parkResidentCaches(): void {
    if (parked) return
    parked = true
    evictInactiveCaches(null)
    closeLightbox()

    // 丢掉失败/已完成的上传任务(其 .file 会钉住多 GiB 的 File 句柄);进行中的保留
    set((s) => {
      const downloads: typeof s.downloads = {}
      for (const [id, d] of Object.entries(s.downloads)) {
        if (d.status === 'downloading') downloads[id] = d
      }
      return {
        library: [],
        libraryStatus: 'idle' as const,
        libraryHasMore: false,
        libraryLoadingMore: false,
        toasts: [],
        deadFiles: {},
        downloads,
        uploads: s.uploads.filter((t) => t.status === 'uploading'),
      }
    })

    const me = get().me
    if (me) pruneSidebarMaps(get().devices, me.device_id)

    // 无进行中的落盘时扫 OPFS 残留临时文件
    if (downloadHandles.size === 0) void sweepAbandonedOpfsSaves()
  }

  /** 只保留大厅 + 仍在设备列表中的私聊摘要/未读 */
  function pruneSidebarMaps(devices: Device[], meId: string): void {
    const keep = new Set<string>(['lobby'])
    for (const d of devices) {
      if (d.device_id !== meId) keep.add(`private:${d.device_id}`)
    }
    set((s) => {
      let changed = false
      const lastMessages = { ...s.lastMessages }
      const unread = { ...s.unread }
      for (const k of Object.keys(lastMessages)) {
        if (!keep.has(k)) {
          delete lastMessages[k]
          changed = true
        }
      }
      for (const k of Object.keys(unread)) {
        if (!keep.has(k)) {
          delete unread[k]
          changed = true
        }
      }
      return changed ? { lastMessages, unread } : s
    })
  }

  function resumeFromPark(): void {
    if (!parked) return
    parked = false
    const conv = get().activeConv
    if (conv) void loadHistory(conv)
    if (get().view === 'files') void get().loadLibrary()
  }

  function hookVisibilityPark(): void {
    if (visibilityHooked || typeof document === 'undefined') return
    visibilityHooked = true
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        if (parkTimer) clearTimeout(parkTimer)
        parkTimer = setTimeout(() => {
          parkTimer = null
          if (document.visibilityState === 'hidden') parkResidentCaches()
        }, HIDDEN_PARK_MS)
        return
      }
      if (parkTimer) {
        clearTimeout(parkTimer)
        parkTimer = null
      }
      resumeFromPark()
    })
  }

  /**
   * 切走会话时丢掉其消息窗口与分页游标。侧栏仍用 lastMessages;
   * 再打开时 loadHistory 拉最新一页。避免 N 个会话各留 400 条。
   */
  function evictInactiveCaches(keep: ConversationId | null): void {
    set((s) => {
      const drop = (key: string) => key !== keep
      let changed = false
      const messages: Record<string, Message[]> = {}
      for (const [k, list] of Object.entries(s.messages)) {
        if (drop(k)) {
          if (list.length) changed = true
          continue
        }
        messages[k] = list
      }
      const historyStatus = { ...s.historyStatus }
      const threadPages = { ...s.threadPages }
      const hasMore = { ...s.hasMore }
      const loadingMore = { ...s.loadingMore }
      for (const k of Object.keys(historyStatus)) {
        if (drop(k)) {
          delete historyStatus[k]
          changed = true
        }
      }
      for (const k of Object.keys(threadPages)) {
        if (drop(k)) {
          delete threadPages[k]
          changed = true
        }
      }
      for (const k of Object.keys(hasMore)) {
        if (drop(k)) {
          delete hasMore[k]
          changed = true
        }
      }
      for (const k of Object.keys(loadingMore)) {
        if (drop(k)) {
          delete loadingMore[k]
          changed = true
        }
      }
      if (!changed) return s
      return { messages, historyStatus, threadPages, hasMore, loadingMore }
    })
  }

  /** 把消息放入正确的显示会话(按线程键重映射),已存在则忽略 */
  function upsertMessage(m: Message): void {
    const bucket = uiConvKey(m.conversation_id, m.from_device_id)
    set((s) => {
      const brief = slimPreview(m)
      const last = s.lastMessages[bucket]
      const lastMessages =
        !last || brief.created_at >= last.created_at
          ? { ...s.lastMessages, [bucket]: brief }
          : s.lastMessages

      // 非活跃且未持有窗口:只更新摘要,不堆积 messages
      if (!holdingMessages(bucket, s)) {
        return lastMessages === s.lastMessages ? s : { lastMessages }
      }

      const list = s.messages[bucket] ?? []
      if (list.some((x) => x.message_id === m.message_id)) {
        return lastMessages === s.lastMessages ? s : { lastMessages }
      }
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
      // 贴底滑动窗口,避免活跃会话在推送下无界增长
      const capped =
        next.length > MAX_MESSAGES_IN_MEMORY
          ? next.slice(next.length - MAX_MESSAGES_IN_MEMORY)
          : next
      const hasMorePatch =
        capped.length < next.length ? { ...s.hasMore, [bucket]: true } : undefined
      return {
        messages: { ...s.messages, [bucket]: capped },
        lastMessages,
        ...(hasMorePatch ? { hasMore: hasMorePatch } : {}),
      }
    })
    // 仓库已加载时,把新文件补进清单(避免必须手动刷新)
    if (get().libraryStatus === 'ready') mergeFilesIntoLibrary(m)
  }

  function mergeFilesIntoLibrary(m: Message): void {
    const me = get().me
    if (!me) return
    const files =
      m.kind === 'file' && m.file
        ? [m.file]
        : m.kind === 'file_group'
          ? (m.files ?? [])
          : []
    if (files.length === 0) return
    const mine = m.from_device_id === me.device_id
    const fromName = mine
      ? me.name
      : (get().devices.find((d) => d.device_id === m.from_device_id)?.name ?? '已离开的设备')
    const uploadedAt = m.created_at
    // 列表 API 才有精确 expires_at;增量补丁用保留天数估算,下次刷新会纠正
    const days = get().storage?.retention_days ?? 5
    const expiresAt = new Date(new Date(uploadedAt).getTime() + days * 86400_000).toISOString()
    set((s) => {
      const known = new Set(s.library.map((e) => e.file.file_id))
      const added: LibraryEntry[] = []
      for (const f of files) {
        if (known.has(f.file_id)) continue
        added.push({
          file: f,
          deviceId: m.from_device_id,
          fromName,
          mine,
          uploadedAt,
          expiresAt,
        })
      }
      if (added.length === 0) return s
      const library = [...added, ...s.library].sort((a, b) =>
        b.uploadedAt.localeCompare(a.uploadedAt),
      )
      return { library }
    })
    get().refreshStorage()
  }

  function bumpUnread(conv: ConversationId, fromDeviceId: string): void {
    if (fromDeviceId === get().me?.device_id) return
    if (get().activeConv === conv && document.visibilityState === 'visible') return
    set((s) => ({ unread: { ...s.unread, [conv]: (s.unread[conv] ?? 0) + 1 } }))
  }

  function ack(m: Message): void {
    socket?.send({ type: 'ack_message', message_id: m.message_id })
  }

  /** 合并一批消息进指定显示会话(去重 + 按时间排序)。超限时滑动窗口。 */
  function mergeInto(
    conv: ConversationId,
    incoming: Message[],
    opts?: { preferOlder?: boolean },
  ): void {
    if (incoming.length === 0) return
    set((s) => {
      const existing = s.messages[conv] ?? []
      const seen = new Set(existing.map((m) => m.message_id))
      const fresh = incoming.filter((m) => !seen.has(m.message_id))
      if (fresh.length === 0) return s
      let merged = [...existing, ...fresh].sort((a, b) => a.created_at.localeCompare(b.created_at))
      let hasMorePatch: Record<string, boolean> | undefined
      if (merged.length > MAX_MESSAGES_IN_MEMORY) {
        if (opts?.preferOlder) {
          // 正在往上翻:保留较旧窗口,丢掉最底部多余新消息
          merged = merged.slice(0, MAX_MESSAGES_IN_MEMORY)
        } else {
          // 默认贴底:保留最新窗口,丢掉顶部旧消息并允许再拉
          merged = merged.slice(merged.length - MAX_MESSAGES_IN_MEMORY)
          hasMorePatch = { ...s.hasMore, [conv]: true }
        }
      }
      return {
        messages: { ...s.messages, [conv]: merged },
        ...(hasMorePatch ? { hasMore: hasMorePatch } : {}),
      }
    })
  }

  async function loadHistory(conv: ConversationId): Promise<void> {
    const me = get().me
    if (!me) return
    if (get().historyStatus[conv] === 'ready') return
    // 并发去重:同一会话同时只允许一个加载任务,避免后到者的失败覆盖先到者的结果
    const inflight = historyInflight.get(conv)
    if (inflight) return inflight
    const task = loadHistoryInner(conv)
    historyInflight.set(conv, task)
    try {
      await task
    } finally {
      historyInflight.delete(conv)
    }
  }

  async function loadHistoryInner(conv: ConversationId): Promise<void> {
    const me = get().me
    if (!me) return
    // 大厅探测未决/未支持时不去加载,避免必然失败的请求与报错提示
    if (conv === 'lobby' && get().lobbySupported !== true) {
      if (get().lobbySupported === false) {
        set((s) => ({ historyStatus: { ...s.historyStatus, [conv]: 'ready' } }))
      }
      return
    }
    set((s) => ({ historyStatus: { ...s.historyStatus, [conv]: 'loading' } }))
    try {
      // 大厅是单线程广播,无需双线程合并
      if (conv === 'lobby') {
        const { messages } = await api.history('lobby', me.device_id, { limit: PAGE })
        if (get().activeConv !== conv) return
        mergeInto(conv, messages)
        const pages: ThreadPages = {
          outCursor: messages[messages.length - 1]?.message_id,
          outHasMore: messages.length >= PAGE,
          inHasMore: false,
        }
        set((s) => ({
          threadPages: { ...s.threadPages, [conv]: pages },
          historyStatus: { ...s.historyStatus, [conv]: 'ready' },
          hasMore: { ...s.hasMore, [conv]: pages.outHasMore },
        }))
        return
      }

      const [out, inbox] = await Promise.all([
        api.history(conv, me.device_id, { limit: PAGE }),
        api.history(inboxThread(), me.device_id, { limit: PAGE }),
      ])
      if (get().activeConv !== conv) return
      // 收件箱按发送者分桶:只入当前会话;其他发送者只刷新侧栏摘要,避免顺带填满别的会话窗口
      const toConv: Message[] = []
      for (const m of inbox.messages) {
        const bucket = uiConvKey(m.conversation_id, m.from_device_id)
        if (bucket === conv) toConv.push(m)
        else touchLastMessage(bucket, m)
      }
      mergeInto(conv, [...out.messages, ...toConv])

      const outCursor = out.messages[out.messages.length - 1]?.message_id
      const inCursor = toConv[toConv.length - 1]?.message_id
      const pages: ThreadPages = {
        outCursor: out.messages.length > 0 ? outCursor : get().threadPages[conv]?.outCursor,
        inCursor: toConv.length > 0 ? inCursor : get().threadPages[conv]?.inCursor,
        outHasMore: out.messages.length >= PAGE,
        inHasMore: inbox.messages.length >= PAGE,
      }
      set((s) => ({
        threadPages: { ...s.threadPages, [conv]: pages },
        historyStatus: { ...s.historyStatus, [conv]: 'ready' },
        hasMore: { ...s.hasMore, [conv]: pages.outHasMore || pages.inHasMore },
      }))
    } catch {
      if (get().activeConv !== conv) return
      set((s) => {
        const next = { ...s.historyStatus }
        delete next[conv]
        return { historyStatus: next }
      })
      get().pushToast('error', '历史加载失败,请重试')
    }
  }

  function loadOlderImpl(conv: ConversationId): void {
    const me = get().me
    if (!me || get().loadingMore[conv]) return
    const pages = get().threadPages[conv]
    const canOut = Boolean(pages?.outHasMore && pages.outCursor)
    const canIn = Boolean(pages?.inHasMore && pages.inCursor)
    if (!canOut && !canIn) return
    set((s) => ({ loadingMore: { ...s.loadingMore, [conv]: true } }))
    void (async () => {
      try {
        const requests: Promise<void>[] = []
        if (canOut) {
          requests.push(
            api
              .history(conv, me.device_id, { before: pages!.outCursor, limit: PAGE })
              .then(({ messages }) => {
                if (get().activeConv !== conv) return
                mergeInto(conv, messages, { preferOlder: true })
                set((s) => {
                  const p = s.threadPages[conv]
                  return {
                    threadPages: {
                      ...s.threadPages,
                      [conv]: {
                        outCursor: messages.length > 0 ? messages[messages.length - 1]!.message_id : p?.outCursor,
                        inCursor: p?.inCursor,
                        outHasMore: messages.length >= PAGE,
                        inHasMore: p?.inHasMore ?? false,
                      },
                    },
                  }
                })
              }),
          )
        }
        if (canIn) {
          requests.push(
            api
              .history(inboxThread(), me.device_id, { before: pages!.inCursor, limit: PAGE })
              .then(({ messages }) => {
                if (get().activeConv !== conv) return
                const forConv: Message[] = []
                for (const m of messages) {
                  const bucket = uiConvKey(m.conversation_id, m.from_device_id)
                  if (bucket === conv) forConv.push(m)
                  else touchLastMessage(bucket, m)
                }
                if (forConv.length) mergeInto(conv, forConv, { preferOlder: true })
                set((s) => {
                  const p = s.threadPages[conv]
                  return {
                    threadPages: {
                      ...s.threadPages,
                      [conv]: {
                        outCursor: p?.outCursor,
                        inCursor: forConv.length > 0 ? forConv[forConv.length - 1]!.message_id : p?.inCursor,
                        outHasMore: p?.outHasMore ?? false,
                        inHasMore: messages.length >= PAGE,
                      },
                    },
                  }
                })
              }),
          )
        }
        await Promise.all(requests)
        if (get().activeConv !== conv) return
        set((s) => {
          const p = s.threadPages[conv]
          return {
            hasMore: { ...s.hasMore, [conv]: Boolean(p?.outHasMore || p?.inHasMore) },
            loadingMore: { ...s.loadingMore, [conv]: false },
          }
        })
      } catch {
        if (get().activeConv !== conv) return
        set((s) => ({ loadingMore: { ...s.loadingMore, [conv]: false } }))
        get().pushToast('error', '更早的消息加载失败,请重试')
      }
    })()
  }

  /** 断线重连后按线程最大 seq 用 after_seq 补拉;大厅单线程,私聊双线程 */
  function catchUpImpl(conv: ConversationId): void {
    const me = get().me
    if (!me) return
    const list = get().messages[conv] ?? []
    const known = new Set(list.map((m) => m.message_id))
    /** 该线程已见最大 seq;空线程用 0,保证空会话重连也能补到离线期间的消息 */
    const maxSeqOf = (threadId: string) => {
      let max = 0
      for (const m of list) {
        if (m.conversation_id === threadId && typeof m.seq === 'number' && m.seq > max) max = m.seq
      }
      return max
    }
    void (async () => {
      try {
        if (conv === 'lobby') {
          const { messages } = await api.history('lobby', me.device_id, {
            after_seq: maxSeqOf('lobby'),
            limit: 200,
          })
          for (const m of messages) if (!known.has(m.message_id)) upsertMessage(m)
          return
        }
        const { messages: outMsgs } = await api.history(conv, me.device_id, {
          after_seq: maxSeqOf(conv),
          limit: 200,
        })
        for (const m of outMsgs) if (!known.has(m.message_id)) upsertMessage(m)
        const { messages: inMsgs } = await api.history(inboxThread(), me.device_id, {
          after_seq: maxSeqOf(inboxThread()),
          limit: 200,
        })
        for (const m of inMsgs) if (!known.has(m.message_id)) upsertMessage(m)
      } catch {
        // 补拉失败不打断使用;下次重连会再试
      }
    })()
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
      const lastMessages = { ...get().lastMessages }
      for (const c of convs) {
        // 我的收件箱线程不对应任何侧栏行;其余线程键即显示键
        if (c.conversation_id === inboxThread()) continue
        if (c.last_message && !get().messages[c.conversation_id]?.length) {
          const brief = c.last_message
          const kind: Message['kind'] =
            brief.kind === 'file_group' ? 'file_group' : brief.kind === 'file' ? 'file' : 'text'
          lastMessages[c.conversation_id] = slimPreview({
            message_id: brief.message_id,
            conversation_id: c.conversation_id,
            from_device_id: '',
            created_at: brief.created_at,
            kind,
            text: brief.preview ?? undefined,
          })
        }
      }
      patch.lastMessages = lastMessages
      set(patch)
      if (me) pruneSidebarMaps(devices, me.device_id)
      get().refreshStorage()
      await probeLobby()
    } catch {
      // 快照失败不致命,重连后再同步
    }
  }

  /** 大厅能力探测:用一次最小历史请求判定当前中枢是否开放 lobby */
  async function probeLobby(): Promise<void> {
    const me = get().me
    if (!me || get().lobbySupported !== null) return
    try {
      await api.history('lobby', me.device_id, { limit: 1 })
      set({ lobbySupported: true })
    } catch {
      set({ lobbySupported: false })
    }
  }

  function handleFrame(frame: ServerFrame): void {
    switch (frame.type) {
      case 'hello': {
        set({ devices: frame.devices })
        break
      }
      case 'presence': {
        // presence 帧只带 device_id;新设备上线时本地快照里还没有它,重拉权威列表
        const known = get().devices.some((d) => d.device_id === frame.device_id)
        if (!known) {
          void api
            .listDevices()
            .then((devices) => set({ devices }))
            .catch(() => undefined)
          break
        }
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
          acked_at: (frame as { acked_at?: string }).acked_at,
        }
        // upsertMessage 内部按线程键重映射入桶;message.conversation_id 保持原始线程,
        // 供断线补拉(after 游标)按线程取最新
        upsertMessage(m)
        const bucket = uiConvKey(m.conversation_id, m.from_device_id)
        bumpUnread(bucket, m.from_device_id)
        ack(m)
        // 托盘壳增强:系统通知 + 文件自动接收(仅他人消息)。
        // 通知抑制学桌面 IM:聚焦且正看着该会话时不弹;自动接收仍照常落盘。
        if (m.from_device_id !== get().me?.device_id) {
          const viewingNow = document.hasFocus() && bucket === get().activeConv
          const sender = get().devices.find((d) => d.device_id === m.from_device_id)
          void onIncomingMessage(
            {
              senderName: sender?.name ?? '局域网设备',
              kind: m.kind,
              text: m.text,
              file: m.file,
              files: m.files,
            },
            { notify: !viewingNow },
          )
        }
        break
      }
      case 'message_acked': {
        // 对方已看到自己发的消息
        set((s) => {
          let touched = false
          const messages: Record<string, Message[]> = {}
          for (const [conv, list] of Object.entries(s.messages)) {
            messages[conv] = list.map((m) => {
              if (m.message_id !== frame.message_id || m.acked_at) return m
              touched = true
              return { ...m, acked_at: new Date().toISOString() }
            })
          }
          return touched ? { messages } : s
        })
        break
      }
      case 'message_deleted': {
        // 任一设备删除消息都会广播;按消息 id 幂等移除(线程键与本端显示键可能不同)
        set((s) => {
          let touched = false
          const messages: Record<string, Message[]> = {}
          const lastMessages = { ...s.lastMessages }
          for (const [conv, list] of Object.entries(s.messages)) {
            const next = list.filter((m) => m.message_id !== frame.message_id)
            messages[conv] = next
            if (next.length !== list.length) {
              touched = true
              const remaining = next[next.length - 1]
              if (remaining) lastMessages[conv] = remaining
              else delete lastMessages[conv]
            }
          }
          return touched ? { messages, lastMessages } : s
        })
        break
      }
      case 'file_deleted': {
        // 寄存字节被清理:文件卡不可取件,并从仓库列表移除
        markDeadFile(frame.file_id)
        get().refreshStorage()
        break
      }
      case 'relay_offer': {
        acceptRelayOffer(frame)
        break
      }
      default:
        break
    }
  }

  function connectSocket(deviceId: string): void {
    disconnectSocket()
    releaseTabLock = bindWsTabLeader(
      () => {
        socket?.close()
        socket = new HubSocket({
          onFrame: handleFrame,
          onStatus: (status) => {
            set({ status })
            if (status === 'online') {
              if (everConnected) {
                void syncSnapshot()
                const conv = get().activeConv
                if (conv && get().historyStatus[conv] === 'ready') catchUpImpl(conv)
              } else {
                everConnected = true
                void syncSnapshot()
                const conv = get().activeConv
                if (conv) void loadHistory(conv)
              }
            }
          },
        })
        socket.connect(deviceId)
      },
      () => {
        socket?.close()
        socket = null
        set({ status: 'taken' })
      },
    )
  }

  function runUpload(task: TransferTask, file: File): void {
    const me = get().me
    if (!me) return
    const peerId = task.conversationId.startsWith('private:')
      ? task.conversationId.slice('private:'.length)
      : null
    const peerOnline = peerId
      ? Boolean(get().devices.find((d) => d.device_id === peerId)?.online)
      : false
    const handle = sendFile(
      file,
      task.conversationId,
      me.device_id,
      peerOnline,
      ({ sentBytes, speed }) => {
        set((s) => ({
          uploads: s.uploads.map((t) => (t.id === task.id ? { ...t, sentBytes, speed } : t)),
        }))
      },
    )
    uploadHandles.set(task.id, handle)
    handle.promise
      .then((resp) => {
        // 服务端 complete/直转完成会回传消息本体;中枢的 WS 广播随后由 id 去重
        if (resp?.message) upsertMessage(resp.message)
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
        // 失败任务短暂保留以便重试;超时丢掉 File 句柄,避免常驻托盘钉住大文件
        setTimeout(() => {
          set((s) => {
            const cur = s.uploads.find((t) => t.id === task.id)
            if (!cur || cur.status !== 'error') return s
            return { uploads: s.uploads.filter((t) => t.id !== task.id) }
          })
        }, 60_000)
      })
  }

  /** 收到直转要约:作为目标设备立即 GET 实时流(与对方 PUT 重叠),失败则等消息后普通取件 */
  function acceptRelayOffer(frame: {
    relay_id: string
    from_device_id: string
    name: string
    size: number
    file_id: string
  }): void {
    const me = get().me
    if (!me || frame.from_device_id === me.device_id) return
    if (downloadHandles.has(frame.file_id)) return
    const file = { file_id: frame.file_id, name: frame.name, size: frame.size }
    set((s) => ({
      downloads: {
        ...s.downloads,
        [file.file_id]: {
          status: 'downloading',
          receivedBytes: 0,
          totalBytes: file.size,
          speed: 0,
        },
      },
    }))
    const handle = receiveRelay(frame.relay_id, me.device_id, file, ({ receivedBytes, totalBytes, speed }) => {
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
    downloadHandles.set(file.file_id, {
      promise: handle.promise,
      cancel: handle.cancel,
    })
    handle.promise
      .then(() => {
        downloadHandles.delete(file.file_id)
        setDownloadTerminal(file.file_id, { status: 'saved' })
      })
      .catch(() => {
        downloadHandles.delete(file.file_id)
        // 实时窗口错过:清掉进度,等文件消息到达后用户点「取件」走磁盘路径
        clearDownloadEntry(file.file_id)
      })
  }

  // ---------- 动作 ----------

  return {
    status: 'connecting',
    hubVersion: null,
    me: null,
    devices: [],
    lobbySupported: null,

    activeConv: null,
    activeConvIsAuto: false,
    view: 'chats',
    library: [],
    libraryStatus: 'idle',
    libraryHasMore: false,
    libraryLoadingMore: false,
    messages: {},
    lastMessages: {},
    historyStatus: {},
    threadPages: {},
    hasMore: {},
    loadingMore: {},
    unread: {},

    uploads: [],
    downloads: {},
    deadFiles: {},
    storage: null,

    toasts: [],

    boot: () => {
      hookVisibilityPark()
      const identity = loadIdentity()
      if (!identity) return
      set({ me: identity })
      connectSocket(identity.device_id)
    },

    register: async (name) => {
      hookVisibilityPark()
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
      disconnectSocket()
      for (const t of downloadClearTimers.values()) clearTimeout(t)
      downloadClearTimers.clear()
      if (parkTimer) {
        clearTimeout(parkTimer)
        parkTimer = null
      }
      parked = false
      set({
        me: null,
        devices: [],
        messages: {},
        lastMessages: {},
        historyStatus: {},
        threadPages: {},
        hasMore: {},
        loadingMore: {},
        unread: {},
        downloads: {},
        deadFiles: {},
        lobbySupported: null,
        activeConv: null,
        activeConvIsAuto: false,
        view: 'chats',
        library: [],
        libraryStatus: 'idle',
        libraryHasMore: false,
        libraryLoadingMore: false,
        status: 'connecting',
      })
      everConnected = false
    },

    retryConnection: () => {
      const me = get().me
      if (!me) return
      // 重新抢标签锁并立即重连(被抢占时也能夺回)
      connectSocket(me.device_id)
    },

    setActiveConv: (conv) => {
      set((s) => {
        const unread = { ...s.unread }
        if (conv) delete unread[conv]
        return { activeConv: conv, unread, activeConvIsAuto: false }
      })
      evictInactiveCaches(conv)
      if (conv) void loadHistory(conv)
    },

    setView: (view) => {
      if (view !== 'files' && get().view === 'files') {
        // 常驻托盘:离开仓库即丢掉翻页清单,再进时重拉首页
        set({
          view,
          library: [],
          libraryStatus: 'idle',
          libraryHasMore: false,
          libraryLoadingMore: false,
        })
        return
      }
      set({ view })
      if (view === 'files' && get().libraryStatus === 'idle') void get().loadLibrary()
    },

    /** 文件仓库:分页拉取中枢寄存清单(GET /api/files) */
    loadLibrary: async () => {
      const me = get().me
      if (!me || get().libraryStatus === 'loading') return
      set({ libraryStatus: 'loading' })
      try {
        const pageSize = 100
        const [{ files }, storage] = await Promise.all([
          api.listFiles(pageSize),
          api.storage().catch(() => null),
        ])
        const library: LibraryEntry[] = files.map((f) => {
          const mine = f.device_id === me.device_id
          const fromName = mine
            ? me.name
            : (get().devices.find((d) => d.device_id === f.device_id)?.name ?? '已离开的设备')
          return {
            file: { file_id: f.file_id, name: f.name, size: f.size },
            deviceId: f.device_id,
            fromName,
            mine,
            uploadedAt: f.uploaded_at,
            expiresAt: f.expires_at,
          }
        })
        set({
          library,
          libraryStatus: 'ready',
          libraryHasMore: files.length >= pageSize,
          libraryLoadingMore: false,
          ...(storage ? { storage } : {}),
        })
      } catch {
        set({ libraryStatus: 'ready', libraryHasMore: false, libraryLoadingMore: false })
        get().pushToast('error', '文件仓库加载失败,请重试')
      }
    },

    loadLibraryMore: async () => {
      const me = get().me
      if (!me || get().libraryLoadingMore || !get().libraryHasMore) return
      const cursor = get().library.at(-1)?.file.file_id
      if (!cursor) return
      set({ libraryLoadingMore: true })
      try {
        const pageSize = 100
        const { files } = await api.listFiles(pageSize, cursor)
        const known = new Set(get().library.map((e) => e.file.file_id))
        const added: LibraryEntry[] = []
        for (const f of files) {
          if (known.has(f.file_id)) continue
          const mine = f.device_id === me.device_id
          const fromName = mine
            ? me.name
            : (get().devices.find((d) => d.device_id === f.device_id)?.name ?? '已离开的设备')
          added.push({
            file: { file_id: f.file_id, name: f.name, size: f.size },
            deviceId: f.device_id,
            fromName,
            mine,
            uploadedAt: f.uploaded_at,
            expiresAt: f.expires_at,
          })
        }
        set((s) => ({
          library: [...s.library, ...added],
          libraryHasMore: files.length >= pageSize,
          libraryLoadingMore: false,
        }))
      } catch {
        set({ libraryLoadingMore: false })
        get().pushToast('error', '加载更多文件失败')
      }
    },

    /** 仓库里删除寄存文件:删字节与相关消息;聊天侧靠 file_deleted 标过期 */
    deleteStoredFile: (file) => {
      const me = get().me
      if (!me) return
      void (async () => {
        try {
          await api.deleteFile(file.file_id, me.device_id)
          markDeadFile(file.file_id)
          get().refreshStorage()
        } catch (err) {
          get().pushToast('error', err instanceof Error ? err.message : '删除失败')
        }
      })()
    },

    autoSelectConv: (conv) => {
      if (get().activeConv === conv) return
      set((s) => {
        const unread = { ...s.unread }
        delete unread[conv]
        return { activeConv: conv, unread, activeConvIsAuto: true }
      })
      evictInactiveCaches(conv)
      void loadHistory(conv)
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

      // 单文件:可走直转;多文件/文件夹:并发 tus 寄存后合成一条 file_group
      if (files.length === 1) {
        const f = files[0]!
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
        return
      }

      const total = files.reduce((s, f) => s + f.size, 0)
      const task: TransferTask = {
        id: newId('batch'),
        conversationId: conv,
        name: `${files.length} 个文件`,
        size: total,
        sentBytes: 0,
        speed: 0,
        status: 'uploading',
      }
      set((s) => ({ uploads: [...s.uploads, task] }))
      const handle = sendFileBatch(files, conv, me.device_id, ({ sentBytes, speed }) => {
        set((s) => ({
          uploads: s.uploads.map((t) => (t.id === task.id ? { ...t, sentBytes, speed } : t)),
        }))
      })
      uploadHandles.set(task.id, handle)
      handle.promise
        .then((resp) => {
          if (resp?.message) upsertMessage(resp.message)
          set((s) => ({ uploads: s.uploads.filter((t) => t.id !== task.id) }))
          uploadHandles.delete(task.id)
        })
        .catch((err: unknown) => {
          uploadHandles.delete(task.id)
          if (isAbort(err)) {
            set((s) => ({ uploads: s.uploads.filter((t) => t.id !== task.id) }))
            return
          }
          const message = err instanceof Error ? err.message : '批量发送失败'
          set((s) => ({
            uploads: s.uploads.map((t) =>
              t.id === task.id
                ? { ...t, status: 'error' as const, error: message, sentBytes: 0, speed: 0 }
                : t,
            ),
          }))
          get().pushToast('error', message)
          setTimeout(() => {
            set((s) => {
              const cur = s.uploads.find((t) => t.id === task.id)
              if (!cur || cur.status !== 'error') return s
              return { uploads: s.uploads.filter((t) => t.id !== task.id) }
            })
          }, 60_000)
        })
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

    loadOlder: (conv) => loadOlderImpl(conv),

    download: (file) => {
      if (downloadHandles.has(file.file_id)) return
      {
        const t = downloadClearTimers.get(file.file_id)
        if (t) clearTimeout(t)
        downloadClearTimers.delete(file.file_id)
      }
      set((s) => ({
        downloads: {
          ...s.downloads,
          [file.file_id]: { status: 'downloading', receivedBytes: 0, totalBytes: file.size, speed: 0 },
        },
      }))

      // 托盘壳:流式落到可配置接收目录(可写 D: 等),避免浏览器 OPFS/C 盘缓存。
      if (inShell) {
        const startedAt = Date.now()
        const controller = { cancelled: false }
        const promise = shellDownloadToDownloads(file, ({ received, total }) => {
          if (controller.cancelled) return
          const elapsed = Math.max(0.25, (Date.now() - startedAt) / 1000)
          set((s) => {
            const cur = s.downloads[file.file_id]
            if (!cur || cur.status !== 'downloading') return s
            return {
              downloads: {
                ...s.downloads,
                [file.file_id]: {
                  status: 'downloading',
                  receivedBytes: received,
                  totalBytes: total || file.size,
                  speed: received / elapsed,
                },
              },
            }
          })
        }).then((path) => {
          if (!path) throw new Error('壳下载失败')
        })
        const handle: DownloadHandle = {
          promise,
          cancel: () => {
            controller.cancelled = true
          },
        }
        downloadHandles.set(file.file_id, handle)
        handle.promise
          .then(() => {
            setDownloadTerminal(file.file_id, { status: 'saved' })
          })
          .catch((err: unknown) => {
            if (controller.cancelled || isAbort(err)) {
              clearDownloadEntry(file.file_id)
              return
            }
            setDownloadTerminal(file.file_id, {
              status: 'error',
              message: err instanceof Error ? err.message : '下载失败',
            })
            get().pushToast('error', `${file.name}:下载失败`)
          })
          .finally(() => downloadHandles.delete(file.file_id))
        return
      }

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
          setDownloadTerminal(file.file_id, { status: 'saved' })
        })
        .catch((err: unknown) => {
          if (isAbort(err)) {
            clearDownloadEntry(file.file_id)
            return
          }
          setDownloadTerminal(file.file_id, {
            status: 'error',
            message: err instanceof Error ? err.message : '下载失败',
          })
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
            let touched = false
            const messages: Record<string, Message[]> = {}
            const lastMessages = { ...s.lastMessages }
            for (const [conv, list] of Object.entries(s.messages)) {
              const next = list.filter((m) => m.message_id !== message.message_id)
              messages[conv] = next
              if (next.length !== list.length) {
                touched = true
                const remaining = next[next.length - 1]
                if (remaining) lastMessages[conv] = remaining
                else delete lastMessages[conv]
              }
            }
            return touched ? { messages, lastMessages } : s
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
