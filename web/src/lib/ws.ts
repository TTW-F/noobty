// 中枢 WebSocket:心跳 + 指数退避重连 + 事件分发
import type { ClientFrame, ConnectionState, ServerFrame } from './types'

const HEARTBEAT_MS = 25_000
const RECONNECT_BASE_MS = 1_000
const RECONNECT_MAX_MS = 15_000

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

  constructor(private readonly handlers: HubSocketHandlers) {}

  connect(deviceId: string): void {
    this.closedByUser = false
    this.open(deviceId)
  }

  close(): void {
    this.closedByUser = true
    this.teardown()
    this.handlers.onStatus('offline')
  }

  /** 断线横幅上的"重试":立即重连,不等退避计时 */
  reconnectNow(deviceId: string): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.ws && this.ws.readyState !== WebSocket.CLOSED) return
    this.open(deviceId)
  }

  send(frame: ClientFrame): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(frame))
    }
  }

  private open(deviceId: string): void {
    this.handlers.onStatus(this.attempts === 0 ? 'connecting' : 'reconnecting')

    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    const ws = new WebSocket(`${proto}://${location.host}/api/ws?device_id=${encodeURIComponent(deviceId)}`)
    this.ws = ws

    ws.onopen = () => {
      this.attempts = 0
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

    ws.onclose = () => {
      this.stopHeartbeat()
      if (this.closedByUser) return
      this.scheduleReconnect(deviceId)
    }

    ws.onerror = () => {
      // onclose 会跟着触发,由 onclose 统一安排重连
      ws.close()
    }
  }

  private scheduleReconnect(deviceId: string): void {
    this.attempts++
    this.handlers.onStatus(this.attempts > 1 ? 'reconnecting' : 'offline')
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** (this.attempts - 1), RECONNECT_MAX_MS)
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
