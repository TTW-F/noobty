// Mock 中枢:?mock=1(或 VITE_MOCK=1)时拦截 fetch 与 WebSocket,
// 在浏览器内模拟一台中枢,用于无服务端开发、演示与视觉验收。生产构建不受影响。
import type { ConversationId, Device, Message } from '../lib/types'

export const mockEnabled =
  new URLSearchParams(location.search).has('mock') || import.meta.env.VITE_MOCK === '1'

const SELF_ID = 'self-device'

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString()
const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString()
const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString()

const DEVICES: Device[] = [
  { device_id: 'dev-desk', name: '书房台式机', online: true, last_seen: minutesAgo(0) },
  { device_id: 'dev-laptop', name: '卧室笔记本', online: true, last_seen: minutesAgo(1) },
  { device_id: 'dev-phone', name: '小米手机', online: false, last_seen: hoursAgo(14) },
  { device_id: 'dev-guest', name: '客人的 iPhone', online: false, last_seen: daysAgo(2) },
]

interface MockFile {
  file_id: string
  name: string
  size: number
  image: boolean
}

const FILES: Record<string, MockFile> = {}

function file(name: string, size: number, image = false): MockFile {
  const id = `f-${Object.keys(FILES).length + 1}`
  const ref: MockFile = { file_id: id, name, size, image }
  FILES[id] = ref
  return ref
}

// 预置的演示数据
const fZip = file('品牌设计-定稿.zip', 1_976_442_368)
const fShot = file('IMG_20260905_2213.jpg', 3_918_442, true)
const fTrip = file('旅行照片-精选.zip', 825_417_113)
const fPlan = file('行程安排.xlsx', 38_912)
const fSetup = file('SiliconNote-Setup.exe', 214_883_328)
const fPatch = file('hotfix-1.4.2.zip', 12_884_901)
const fDeck = file('周会演示.key', 96_337_725)

const now = () => new Date().toISOString()

const SEED: string[] = []
const MESSAGES = new Map<string, Message[]>()

function seed(conv: string, messages: Array<Omit<Message, 'conversation_id'>>): void {
  SEED.push(conv)
  MESSAGES.set(
    conv,
    messages.map((m) => ({ ...m, conversation_id: conv })),
  )
}

seed('lobby', [
  { message_id: 'm1', from_device_id: 'dev-desk', created_at: hoursAgo(26), kind: 'text', text: '路由器管理密码改好了,放在备忘录那个文件里,需要的自己取。' },
  { message_id: 'm2', from_device_id: 'dev-laptop', created_at: hoursAgo(25), kind: 'file_group', mode: 'stored', files: [fTrip, fPlan].map((f) => ({ file_id: f.file_id, name: f.name, size: f.size })) },
  { message_id: 'm3', from_device_id: 'dev-guest', created_at: hoursAgo(24.2), kind: 'text', text: '谢谢,照片我拷走了,很好看!' },
  { message_id: 'm4', from_device_id: 'dev-desk', created_at: hoursAgo(3), kind: 'text', text: '打印机驱动换新的了,shared 文件夹里有备份。' },
])

seed('private:dev-desk', [
  { message_id: 'm5', from_device_id: 'dev-desk', created_at: hoursAgo(5.2), kind: 'text', text: '源文件打包好了,今晚记得取件,过期就没了。' },
  { message_id: 'm6', from_device_id: 'dev-desk', created_at: hoursAgo(5.1), kind: 'file', mode: 'stored', file: { file_id: fZip.file_id, name: fZip.name, size: fZip.size } },
  { message_id: 'm7', from_device_id: SELF_ID, created_at: hoursAgo(4.8), kind: 'text', text: '收到,在路上了,到家就取。' },
])

seed('private:dev-phone', [
  { message_id: 'm8', from_device_id: 'dev-phone', created_at: hoursAgo(14.3), kind: 'file', mode: 'stored', file: { file_id: fShot.file_id, name: fShot.name, size: fShot.size } },
  { message_id: 'm9', from_device_id: 'dev-phone', created_at: hoursAgo(14.2), kind: 'text', text: '这张截图帮我看看,布局好像有点怪。' },
])

seed('private:dev-laptop', [
  { message_id: 'm10', from_device_id: 'dev-laptop', created_at: hoursAgo(7.5), kind: 'file_group', mode: 'stored', files: [fSetup, fPatch, fDeck].map((f) => ({ file_id: f.file_id, name: f.name, size: f.size })) },
  { message_id: 'm11', from_device_id: SELF_ID, created_at: hoursAgo(7.1), kind: 'text', text: '装好把安装包删了吧,省点寄存空间。' },
])

seed('private:dev-guest', [])

// ---------------- 状态 ----------------

const sockets = new Set<MockWebSocket>()
let uploadCounter = 0
let msgCounter = 100
const uploads = new Map<
  string,
  { received: number; chunk: number; name: string; size: number; conv: ConversationId }
>()

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

function toMessageDTO(m: Message): Record<string, unknown> {
  const dto: Record<string, unknown> = {
    message_id: m.message_id,
    conversation_id: m.conversation_id,
    from_device_id: m.from_device_id,
    created_at: m.created_at,
    kind: m.kind,
  }
  if (m.text !== undefined) dto.text = m.text
  if (m.file) dto.file = m.file
  if (m.files) dto.files = m.files
  if (m.mode) dto.mode = m.mode
  return dto
}

function broadcast(m: Message): void {
  const frame = JSON.stringify({ type: 'message', ...toMessageDTO(m) })
  for (const s of sockets) s.receive(frame)
}

function historyOf(conv: string): Message[] {
  return MESSAGES.get(conv) ?? []
}

function lastOf(conv: string): Message | undefined {
  const list = historyOf(conv)
  return list[list.length - 1]
}

// ---------------- fetch 拦截 ----------------

async function handleApi(
  url: URL,
  method: string,
  body: unknown,
  offsetHeader: string | null,
): Promise<Response> {
  const path = url.pathname

  if (path === '/api/healthz') return json({ ok: true, name: 'noobty', version: '0.1.0-demo' })

  if (path === '/api/storage')
    return json({ used_bytes: 12_944_127_488, max_total_bytes: 32_212_254_720, retention_days: 5 })

  if (path === '/api/devices' && method === 'GET') return json(DEVICES)

  if (path === '/api/devices/register' && method === 'POST') {
    const name = (body as { name?: string })?.name ?? '未命名设备'
    return json({ device_id: SELF_ID, name })
  }

  if (path === '/api/conversations' && method === 'GET') {
    const convs = SEED.map((c) => ({
      conversation_id: c,
      last_message: lastOf(c) ? toMessageDTO(lastOf(c)!) : undefined,
      unread: c === 'private:dev-phone' ? 2 : 0,
    }))
    return json(convs)
  }

  const msgMatch = path.match(/^\/api\/conversations\/(.+)\/messages$/)
  if (msgMatch && method === 'GET') {
    const conv = decodeURIComponent(msgMatch[1]!)
    const list = [...historyOf(conv)].reverse() // 契约:最新在前
    return json({ messages: list.map(toMessageDTO) })
  }

  const textMatch = path.match(/^\/api\/conversations\/(.+)\/texts$/)
  if (textMatch && method === 'POST') {
    const conv = decodeURIComponent(textMatch[1]!)
    const text = (body as { text?: string })?.text ?? ''
    const m: Message = {
      message_id: `m-${msgCounter++}`,
      conversation_id: conv,
      from_device_id: SELF_ID,
      created_at: now(),
      kind: 'text',
      text,
    }
    MESSAGES.set(conv, [...historyOf(conv), m])
    broadcast(m)
    void autoReply(conv)
    return json(toMessageDTO(m))
  }

  if (path.startsWith('/api/messages/') && method === 'DELETE') {
    const id = decodeURIComponent(path.slice('/api/messages/'.length))
    for (const [conv, list] of MESSAGES) {
      MESSAGES.set(conv, list.filter((m) => m.message_id !== id))
    }
    return json({ ok: true })
  }

  if (path === '/api/uploads' && method === 'POST') {
    const b = body as { name?: string; size?: number }
    const id = `up-${++uploadCounter}`
    uploads.set(id, {
      received: 0,
      chunk: 4 * 1024 * 1024,
      name: b?.name ?? 'file',
      size: b?.size ?? 0,
      conv: '',
    })
    return json({
      upload_id: id,
      file_id: `f-up-${uploadCounter}`,
      chunk_size: 4 * 1024 * 1024,
      received_bytes: 0,
    })
  }

  const upMatch = path.match(/^\/api\/uploads\/([^/]+)(\/complete)?$/)
  if (upMatch) {
    const id = decodeURIComponent(upMatch[1]!)
    const up = uploads.get(id)
    if (!up) return json({ error: '上传会话不存在' }, 404)

    if (upMatch[2] && method === 'POST') {
      // complete:落一条文件消息并广播
      const fid = file(up.name, up.size || 1_048_576)
      const m: Message = {
        message_id: `m-${msgCounter++}`,
        conversation_id: up.conv,
        from_device_id: SELF_ID,
        created_at: now(),
        kind: 'file',
        mode: 'stored',
        file: { file_id: fid.file_id, name: fid.name, size: fid.size },
      }
      MESSAGES.set(up.conv, [...historyOf(up.conv), m])
      broadcast(m)
      return json({ file_id: fid.file_id })
    }
    if (method === 'GET') return json({ received_bytes: up.received, chunk_size: up.chunk })
    if (method === 'PUT') {
      const offset = Number(offsetHeader ?? '0')
      const blobSize = (body as { __blobSize?: number })?.__blobSize ?? 0
      await delay(90) // 模拟内网传输耗时,让进度可感知
      up.received = Math.min(up.size, Math.max(up.received, offset + blobSize))
      return json({ received_bytes: up.received })
    }
  }

  const fileMatch = path.match(/^\/api\/files\/([^/]+)(\/meta)?$/)
  if (fileMatch) {
    const id = decodeURIComponent(fileMatch[1]!)
    const f = FILES[id]
    if (!f) return json({ error: '文件不存在' }, 404)
    if (fileMatch[2]) {
      return json({
        file_id: f.file_id,
        name: f.name,
        size: f.size,
        uploaded_at: hoursAgo(5),
        expires_at: daysAgo(-5),
      })
    }
    if (method === 'DELETE') return json({ ok: true })
    // 演示文件:图片给一张 SVG,其余给说明文本
    if (f.image) {
      const svg = demoImage(f.name)
      return new Response(svg, { headers: { 'Content-Type': 'image/svg+xml' } })
    }
    const text = `Noobty 演示文件\n\n文件名:${f.name}\n大小:${f.size} 字节\n\n这是 mock 中枢生成的占位内容。`
    return new Response(text, { headers: { 'Content-Type': 'text/plain;charset=utf-8' } })
  }

  return json({ error: `mock 未实现:${method} ${path}` }, 404)
}

function demoImage(name: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600" viewBox="0 0 800 600">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#9fd8e3"/>
      <stop offset="0.55" stop-color="#3d97ad"/>
      <stop offset="1" stop-color="#17607a"/>
    </linearGradient>
  </defs>
  <rect width="800" height="600" fill="url(#g)"/>
  <circle cx="620" cy="150" r="64" fill="#ffffff" opacity="0.85"/>
  <path d="M0 470 L210 330 L360 430 L520 300 L800 480 L800 600 L0 600 Z" fill="#0d4557" opacity="0.9"/>
  <path d="M0 520 L180 420 L420 520 L640 440 L800 520 L800 600 L0 600 Z" fill="#082f3d" opacity="0.9"/>
  <text x="40" y="72" font-family="system-ui, sans-serif" font-size="26" fill="#ffffff" opacity="0.95">${name}</text>
  <text x="40" y="104" font-family="system-ui, sans-serif" font-size="16" fill="#ffffff" opacity="0.7">mock 中枢 · 演示图片</text>
</svg>`
}

// 私聊对方自动回一句,让演示界面有来有回
const REPLIED = new Set<string>()
async function autoReply(conv: string): Promise<void> {
  const target = conv.startsWith('private:') ? conv.slice('private:'.length) : null
  if (!target || target === SELF_ID || REPLIED.has(conv)) return
  REPLIED.add(conv)
  await delay(1600)
  const device = DEVICES.find((d) => d.device_id === target)
  if (!device) return
  const m: Message = {
    message_id: `m-${msgCounter++}`,
    conversation_id: conv,
    from_device_id: target,
    created_at: now(),
    kind: 'text',
    text: target === 'dev-laptop' ? '好,收到!' : '嗯嗯,这边看到了。',
  }
  MESSAGES.set(conv, [...historyOf(conv), m])
  broadcast(m)
}

// ---------------- WebSocket 替身 ----------------

export class MockWebSocket {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSING = 2
  static CLOSED = 3

  readyState = MockWebSocket.CONNECTING
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  onmessage: ((ev: { data: string }) => void) | null = null

  constructor(url: string) {
    const match = url.match(/device_id=([^&]+)/)
    const deviceId = match ? decodeURIComponent(match[1]!) : SELF_ID

    setTimeout(() => {
      if (this.readyState === MockWebSocket.CLOSED) return
      this.readyState = MockWebSocket.OPEN
      sockets.add(this)
      this.onopen?.()
      this.receive(
        JSON.stringify({
          type: 'hello',
          device_id: deviceId,
          devices: DEVICES.map((d) =>
            d.device_id === deviceId ? { ...d, online: true, last_seen: now() } : d,
          ),
        }),
      )
    }, 260)
  }

  send(data: string): void {
    try {
      const frame = JSON.parse(data) as { type: string }
      if (frame.type === 'ping') {
        setTimeout(() => this.receive(JSON.stringify({ type: 'pong' })), 40)
      }
    } catch {
      /* 忽略 */
    }
  }

  close(): void {
    this.readyState = MockWebSocket.CLOSED
    sockets.delete(this)
    this.onclose?.()
  }

  /** mock 中枢 → 客户端 */
  receive(text: string): void {
    this.onmessage?.({ data: text })
  }
}

export function installMockHub(): void {
  const originalFetch = window.fetch.bind(window)

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      input instanceof URL
        ? input
        : new URL(input instanceof Request ? input.url : String(input), location.origin)
    if (url.origin === location.origin && url.pathname.startsWith('/api/')) {
      let body: unknown = undefined
      if (init?.body) {
        if (typeof init.body === 'string') {
          try {
            body = JSON.parse(init.body)
          } catch {
            body = init.body
          }
        } else {
          body = { __blobSize: (init.body as Blob).size }
        }
      }
      const headers = new Headers(init?.headers)
      const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
      return await handleApi(url, method, body, headers.get('X-Noobty-Offset'))
    }
    return originalFetch(input, init)
  }

  ;(window as unknown as { WebSocket: unknown }).WebSocket = MockWebSocket
}
