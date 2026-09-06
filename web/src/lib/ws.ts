// 中枢 WebSocket:心跳 + Full Jitter 指数退避重连 + 事件分发
//
// 退避公式学自 Centrifugo JS SDK / AWS "Exponential Backoff and Jitter":
//   delay = randomInt(0, min(max, base · 2^(attempt-1)))
// Full Jitter 避免多设备同时断线后齐步重连打满中枢(惊群)。
//
// 关闭码 4001 = 被同 device_id 的更新会话抢占:停止互踢风暴,改长间隔再试。
import type { ClientFrame, ConnectionState, ServerFrame } from './types'

/** 应用层 ping 间隔;须明显小于服务端 IDLE_TIMEOUT(90s) */
export const HEARTBEAT_MS = 25_000
export const RECONNECT_BASE_MS = 1_000
export const RECONNECT_MAX_MS = 15_000
/** 被其他窗口抢占后,自动再试的下限(避免与对端互踢) */
export const SUPERSEDED_RETRY_MS = 25_000
/** WebSocket private-use: hub kicked this session because another took the device */
export const WS_CLOSE_SUPERSEDED = 4001

/**
 * Full Jitter 退避延迟(纯函数,便于单测与文档引用)。
 * `attempt` 从 1 起:第 1 次重连上限 base,第 2 次 2·base,…,封顶 max。
 */
export function reconnectDelayMs(
  attempt: number,
  random: () => number = Math.random,
  base = RECONNECT_BASE_MS,
  max = RECONNECT_MAX_MS,
): number {
  const exp = Math.max(0, attempt - 1)
  const ceiling = Math.min(max, base * 2 ** exp)
  return Math.floor(random() * (ceiling + 1))
}

export interface HubSocketHandlers {
  onFrame: (frame: ServerFrame) => void
  onStatus: (status: ConnectionState) => void
}

export class HubSocket {
  private ws: WebSocket | null = null
  private heartbeat: ReturnType<typeof setInterval> | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private attempts = 0
  private closedByUser = false
  /** 最近一次关闭是否为被抢占(横幅文案用) */
  private lastSuperseded = false

  constructor(private readonly handlers: HubSocketHandlers) {}

  connect(deviceId: string): void {
    this.closedByUser = false
    this.attempts = 0
    this.lastSuperseded = false
    this.open(deviceId)
  }

  close(): void {
    this.closedByUser = true
    this.teardown()
    this.handlers.onStatus('offline')
  }

  /** 断线横幅上的"重试":立即重连,不等退避计时 */
  reconnectNow(deviceId: string): void {
    this.closedByUser = false
    this.lastSuperseded = false
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.open(deviceId)
  }

  send(frame: ClientFrame): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(frame))
    }
  }

  private open(deviceId: string): void {
    // 丢弃进行中的旧套接字,避免同实例双连接互踢
    if (this.ws) {
      this.ws.onclose = null
      this.ws.onerror = null
      try {
        this.ws.close()
      } catch {
        /* ignore */
      }
      this.ws = null
    }
    this.stopHeartbeat()

    this.handlers.onStatus(
      this.lastSuperseded ? 'taken' : this.attempts === 0 ? 'connecting' : 'reconnecting',
    )

    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    const ws = new WebSocket(
      `${proto}://${location.host}/api/ws?device_id=${encodeURIComponent(deviceId)}`,
    )
    this.ws = ws

    ws.onopen = () => {
      this.attempts = 0
      this.lastSuperseded = false
      this.handlers.onStatus('online')
      this.startHeartbeat()
    }

    ws.onmessage = (event) => {
      try {
        this.handlers.onFrame(JSON.parse(event.data as string) as ServerFrame)
      } catch {
        // 非 JSON 帧:忽略
      }
    }

    ws.onclose = (event) => {
      this.stopHeartbeat()
      if (this.ws === ws) this.ws = null
      if (this.closedByUser) return
      if (event.code === WS_CLOSE_SUPERSEDED) {
        this.lastSuperseded = true
        this.handlers.onStatus('taken')
        // 长间隔再试:对端已关则恢复;对端仍在则再被踢,但不会亚秒级狂闪
        const delay = SUPERSEDED_RETRY_MS + Math.floor(Math.random() * 10_000)
        this.scheduleReconnect(deviceId, delay)
        return
      }
      this.lastSuperseded = false
      this.scheduleReconnect(deviceId)
    }

    ws.onerror = () => {
      try {
        ws.close()
      } catch {
        /* ignore */
      }
    }
  }

  private scheduleReconnect(deviceId: string, delayOverride?: number): void {
    this.attempts++
    if (delayOverride == null) {
      this.handlers.onStatus(this.attempts > 1 ? 'reconnecting' : 'offline')
    }
    const delay = delayOverride ?? reconnectDelayMs(this.attempts)
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = setTimeout(() => this.open(deviceId), delay)
  }

  private startHeartbeat(): void {
    this.stopHeartbeat()
    this.heartbeat = setInterval(() => this.send({ type: 'ping' }), HEARTBEAT_MS)
  }

  private stopHeartbeat(): void {
    if (this.heartbeat) {
      clearInterval(this.heartbeat)
      this.heartbeat = null
    }
  }

  private teardown(): void {
    this.stopHeartbeat()
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.attempts = 0
    if (this.ws) {
      this.ws.onclose = null
      this.ws.onerror = null
      this.ws.close()
      this.ws = null
    }
  }
}

const TAB_LOCK_KEY = 'noobty.ws.leader.v1'

/**
 * 同起源多标签选主(localStorage)。持锁标签跑 `onLead`,丢锁时 `onYield`。
 * 托盘与系统浏览器存储隔离,跨进程互踢仍靠 4001。
 */
export function bindWsTabLeader(onLead: () => void, onYield: () => void): () => void {
  const tabId =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`

  let leading = false

  const claim = () => {
    try {
      localStorage.setItem(TAB_LOCK_KEY, tabId)
    } catch {
      /* private mode */
    }
    if (!leading) {
      leading = true
      onLead()
    }
  }

  const onStorage = (ev: StorageEvent) => {
    if (ev.key !== TAB_LOCK_KEY || ev.newValue == null) return
    if (ev.newValue === tabId) return
    if (leading) {
      leading = false
      onYield()
    }
  }

  window.addEventListener('storage', onStorage)
  claim()

  return () => {
    window.removeEventListener('storage', onStorage)
    try {
      if (localStorage.getItem(TAB_LOCK_KEY) === tabId) localStorage.removeItem(TAB_LOCK_KEY)
    } catch {
      /* ignore */
    }
    leading = false
  }
}
