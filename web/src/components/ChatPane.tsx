// 会话视图:头部、连接横幅、消息流(分组 + 吸附日期 + 分页)、拖拽发送、发送器
import { useEffect, useLayoutEffect, useRef, useState, type DragEvent } from 'react'
import {
  ArrowDown,
  ArrowLeft,
  Broadcast,
  CircleNotch,
  Plugs,
  PlugsConnected,
} from '@phosphor-icons/react'
import { useHub } from '../store/hub'
import { Button, EmptyState, IconButton, PresenceDot, Skeleton } from './ui'
import { MessageRow } from './messages'
import { Composer } from './Composer'
import { formatDayLabel, formatRelative } from '../lib/format'
import type { ConversationId, Message } from '../lib/types'

const GROUP_WINDOW_MS = 3 * 60_000
const JUMP_THRESHOLD_PX = 240
const STICK_THRESHOLD_PX = 120

// ---------- 消息流 ----------

function MessageList({ conv, convName, isLobby, emptyIcon }: {
  conv: ConversationId
  convName: string
  isLobby: boolean
  emptyIcon: React.ReactNode
}) {
  const me = useHub((s) => s.me)
  const devices = useHub((s) => s.devices)
  const messages = useHub((s) => s.messages[conv])
  const historyStatus = useHub((s) => s.historyStatus[conv])
  const hasMore = useHub((s) => s.hasMore[conv] ?? false)
  const loadingMore = useHub((s) => s.loadingMore[conv] ?? false)
  const loadOlder = useHub((s) => s.loadOlder)

  const listRef = useRef<HTMLDivElement>(null)
  const stickToBottom = useRef(true)
  const lastLenRef = useRef(0)
  const anchorRef = useRef<{ height: number; top: number } | null>(null)
  const [pending, setPending] = useState(0)
  const [showJump, setShowJump] = useState(false)

  // 切换会话:直接到底(刻意只依赖 conv;messages 长度由 followOrCount 单独跟踪)
  useEffect(
    function jumpToBottom() {
      const el = listRef.current
      if (!el) return
      el.scrollTop = el.scrollHeight
      stickToBottom.current = true
      lastLenRef.current = messages?.length ?? 0
      setPending(0)
      setShowJump(false)
    },
    [conv],
  )

  // 新消息:贴底则跟随,否则累计到"回到底部"按钮
  useEffect(
    function followOrCount() {
      const el = listRef.current
      if (!el) return
      const len = messages?.length ?? 0
      const delta = len - lastLenRef.current
      lastLenRef.current = len
      if (delta <= 0) return
      if (stickToBottom.current) {
        el.scrollTop = el.scrollHeight
      } else {
        setPending((p) => p + delta)
      }
    },
    [messages],
  )

  // 加载更早后恢复滚动位置
  useLayoutEffect(
    function restoreAnchor() {
      const anchor = anchorRef.current
      const el = listRef.current
      if (!anchor || !el) return
      anchorRef.current = null
      el.scrollTop = el.scrollHeight - anchor.height + anchor.top
    },
    [messages],
  )

  const onScroll = () => {
    const el = listRef.current
    if (!el) return
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight
    stickToBottom.current = distance < STICK_THRESHOLD_PX
    setShowJump(distance > JUMP_THRESHOLD_PX)
    if (stickToBottom.current) setPending(0)
  }

  const jumpToLatest = () => {
    const el = listRef.current
    if (!el) return
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches
    el.scrollTo({ top: el.scrollHeight, behavior: reduce ? 'auto' : 'smooth' })
    stickToBottom.current = true
    setPending(0)
  }

  const requestOlder = () => {
    const el = listRef.current
    if (el) anchorRef.current = { height: el.scrollHeight, top: el.scrollTop }
    loadOlder(conv)
  }

  if (historyStatus === undefined || historyStatus === 'loading') {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5" aria-busy="true">
        <div className="mx-auto flex max-w-[720px] flex-col gap-3">
          <Skeleton className="h-3 w-16 self-center" />
          <Skeleton className="h-16 w-64 self-start" />
          <Skeleton className="h-10 w-52 self-end" />
          <Skeleton className="h-24 w-72 self-start" />
        </div>
      </div>
    )
  }

  if (!messages || messages.length === 0) {
    return isLobby ? (
      <EmptyState
        icon={<Broadcast size={26} />}
        title="大厅是空的"
        hint="发到这里的内容,所有设备都可见可取。适合随手丢一个链接、验证码或文件。"
      />
    ) : (
      <EmptyState
        icon={emptyIcon}
        title={`与「${convName}」的对话是空的`}
        hint="把文件拖进来,或直接输入文字发送。对方在线即达,离线则寄存到中枢。"
      />
    )
  }

  const rows: React.ReactNode[] = []
  let prev: Message | null = null
  let prevDay = ''
  for (const m of messages) {
    const day = formatDayLabel(m.created_at)
    if (day !== prevDay) {
      rows.push(
        <div key={`d-${m.message_id}`} className="sticky top-0 z-10 -mx-2 bg-bg/85 px-2 py-1.5 backdrop-blur-sm">
          <div className="flex items-center gap-3">
            <span className="h-px flex-1 bg-line" />
            <span className="text-[11.5px] text-muted">{day}</span>
            <span className="h-px flex-1 bg-line" />
          </div>
        </div>,
      )
      prevDay = day
      prev = null
    }
    const mine = m.from_device_id === me?.device_id
    const grouped =
      prev !== null &&
      prev.from_device_id === m.from_device_id &&
      new Date(m.created_at).getTime() - new Date(prev.created_at).getTime() < GROUP_WINDOW_MS
    const sender = devices.find((d) => d.device_id === m.from_device_id)
    rows.push(<MessageRow key={m.message_id} message={m} mine={mine} grouped={grouped} sender={sender} />)
    prev = m
  }

  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={listRef}
        onScroll={onScroll}
        role="log"
        aria-live="polite"
        className="h-full overflow-y-auto px-3 py-4 sm:px-4"
      >
        {hasMore && (
          <div className="mb-3 flex justify-center">
            <Button
              variant="ghost"
              loading={loadingMore}
              onClick={requestOlder}
              className="h-8 text-[12.5px] text-muted"
            >
              查看更早的消息
            </Button>
          </div>
        )}
        <div className="mx-auto flex max-w-[720px] flex-col gap-1.5">{rows}</div>
      </div>

      {showJump && (
        <button
          onClick={jumpToLatest}
          aria-label={pending > 0 ? `回到底部,有 ${pending} 条新消息` : '回到最新消息'}
          className="anim-rise absolute bottom-4 right-4 flex h-11 w-11 items-center justify-center rounded-full border border-line bg-bg text-ink shadow-lg transition-transform duration-150 hover:-translate-y-0.5 active:scale-95"
        >
          <ArrowDown size={17} weight="bold" />
          {pending > 0 && (
            <span className="num absolute -right-1 -top-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1 text-[10.5px] font-semibold text-on-primary">
              {pending > 99 ? '99+' : pending}
            </span>
          )}
        </button>
      )}
    </div>
  )
}

// ---------- 会话视图 ----------

export function ChatPane({ mobile = false, onBack }: { mobile?: boolean; onBack?: () => void }) {
  const me = useHub((s) => s.me)
  const devices = useHub((s) => s.devices)
  const activeConv = useHub((s) => s.activeConv)
  const sendFiles = useHub((s) => s.sendFiles)
  const status = useHub((s) => s.status)
  const retryConnection = useHub((s) => s.retryConnection)
  const [dragging, setDragging] = useState(false)
  const dragDepth = useRef(0)

  if (!activeConv || !me) {
    return (
      <section className="flex h-full min-h-0 flex-1 flex-col">
        <EmptyState
          icon={<Broadcast size={26} />}
          title="选择一个会话"
          hint="从左侧选择大厅或某台设备,开始收发文字与文件。"
        />
      </section>
    )
  }

  const isLobby = activeConv === 'lobby'
  const peerId = isLobby ? null : activeConv.slice('private:'.length)
  const peer = peerId ? devices.find((d) => d.device_id === peerId) : undefined
  const convName = isLobby ? '大厅' : (peer?.name ?? '已离开的设备')

  const onDragEnter = (e: DragEvent) => {
    e.preventDefault()
    if (!e.dataTransfer.types.includes('Files')) return
    dragDepth.current++
    setDragging(true)
  }
  const onDragOver = (e: DragEvent) => e.preventDefault()
  const onDragLeave = (e: DragEvent) => {
    e.preventDefault()
    dragDepth.current = Math.max(0, dragDepth.current - 1)
    if (dragDepth.current === 0) setDragging(false)
  }
  const onDrop = (e: DragEvent) => {
    e.preventDefault()
    dragDepth.current = 0
    setDragging(false)
    const files = Array.from(e.dataTransfer.files)
    if (files.length > 0) sendFiles(activeConv, files)
  }

  return (
    <section
      className="relative flex h-full min-h-0 flex-1 flex-col bg-bg"
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {/* 头部 */}
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-line bg-bg px-2.5 sm:px-4">
        {mobile && (
          <IconButton label="返回会话列表" onClick={onBack} className="-ml-1">
            <ArrowLeft size={18} />
          </IconButton>
        )}
        <span
          className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] ${
            isLobby ? 'bg-primary text-on-primary' : 'bg-surface-2 text-muted'
          }`}
        >
          {isLobby ? (
            <Broadcast size={18} weight="fill" />
          ) : peer ? (
            <span className="text-[14px] font-semibold">{peer.name.slice(0, 1)}</span>
          ) : (
            <PlugsConnected size={16} />
          )}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="truncate text-[15px] font-semibold">{convName}</span>
            {!isLobby && peer && (
              <span className="flex items-center gap-1.5 text-[11.5px] text-muted">
                <PresenceDot online={peer.online} connecting={status !== 'online'} />
                {peer.online ? '在线' : peer.last_seen ? `最后见于 ${formatRelative(peer.last_seen)}` : '离线'}
              </span>
            )}
          </span>
          <span className="block truncate text-[11.5px] text-muted">
            {isLobby
              ? '所有设备可见可取的广播会话'
              : peer?.online
                ? '对方在线,发送即时可达'
                : '对方离线,文件将寄存到中枢'}
          </span>
        </span>
      </header>

      {/* 连接状态横幅 */}
      {status !== 'online' && (
        <div
          aria-live="assertive"
          className={`anim-drop flex shrink-0 items-center gap-2 px-4 py-2 text-[12.5px] ${
            status === 'offline' ? 'bg-danger-soft text-ink' : 'bg-surface text-muted'
          }`}
        >
          {status === 'offline' ? (
            <>
              <Plugs size={15} className="text-danger" />
              <span className="flex-1">与中枢断开了连接</span>
              <button
                onClick={retryConnection}
                className="h-7 rounded-full bg-danger px-3 text-[12px] font-medium text-white transition-opacity hover:opacity-90"
              >
                重试
              </button>
            </>
          ) : (
            <>
              <span className="inline-flex animate-spin">
                <CircleNotch size={15} />
              </span>
              {status === 'connecting' ? '正在连接中枢…' : '与中枢的连接中断,正在重连…'}
            </>
          )}
        </div>
      )}

      <MessageList
        conv={activeConv}
        convName={convName}
        isLobby={isLobby}
        emptyIcon={<Plugs size={26} />}
      />
      <Composer conv={activeConv} />

      {/* 拖拽遮罩 */}
      {dragging && (
        <div className="anim-fade pointer-events-none absolute inset-0 z-30 m-3 flex items-center justify-center rounded-[14px] border-2 border-dashed border-primary bg-primary-soft/85 backdrop-blur-[2px]">
          <div className="flex items-center gap-2 rounded-full bg-bg px-4 py-2 text-[14px] font-medium shadow">
            <span>松开发送到「{convName}」</span>
          </div>
        </div>
      )}
    </section>
  )
}
