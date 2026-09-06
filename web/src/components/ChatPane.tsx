// 会话视图:头部、连接横幅、消息流(虚拟列表 + 分组 + 吸附日期 + 分页)、拖拽发送、发送器
import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react'
import {
  ArrowDown,
  ArrowLeft,
  Broadcast,
  CircleNotch,
  Plugs,
  PlugsConnected,
} from '@phosphor-icons/react'
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso'
import { useShallow } from 'zustand/react/shallow'
import { useHub } from '../store/hub'
import { Button, EmptyState, IconButton, PresenceDot, Skeleton } from './ui'
import { MessageRow } from './messages'
import { Composer } from './Composer'
import { formatBytes, formatDayLabel, formatRelative } from '../lib/format'
import { filesFromDataTransfer } from '../lib/pick'
import type { ConversationId, Message } from '../lib/types'

const GROUP_WINDOW_MS = 3 * 60_000
/** Virtuoso prepend 基准:加载更早时向下递减,避免重排已渲染项 */
const VIRT_START = 100_000

function IncomingTransferBanner({ conv }: { conv: ConversationId }) {
  const transfers = useHub(
    useShallow((s) => s.incomingTransfers.filter((t) => t.conversationId === conv)),
  )
  const devices = useHub((s) => s.devices)
  if (transfers.length === 0) return null
  return (
    <div className="shrink-0 space-y-1 border-b border-line bg-primary-soft/40 px-4 py-2">
      {transfers.map((t) => {
        const name = devices.find((d) => d.device_id === t.fromDeviceId)?.name ?? '对方'
        const total = t.files.reduce((s, f) => s + f.size, 0)
        const label =
          t.files.length === 1
            ? t.files[0]!.name
            : `${t.files.length} 个文件（${formatBytes(total)}）`
        return (
          <div key={t.transferId} className="flex items-center gap-2 text-[12.5px] text-ink">
            <span className="inline-flex animate-spin text-primary">
              <CircleNotch size={14} />
            </span>
            <span className="min-w-0 flex-1 truncate">
              <span className="font-medium">{name}</span> 正在发送 {label}
            </span>
          </div>
        )
      })}
    </div>
  )
}

type ListRow =
  | { kind: 'day'; key: string; day: string }
  | { kind: 'msg'; key: string; message: Message; grouped: boolean; senderName: string | undefined }

function buildRows(messages: Message[], names: Record<string, string>): ListRow[] {
  const rows: ListRow[] = []
  let prev: Message | null = null
  let prevDay = ''
  for (const m of messages) {
    const day = formatDayLabel(m.created_at)
    if (day !== prevDay) {
      rows.push({ kind: 'day', key: `d-${m.message_id}`, day })
      prevDay = day
      prev = null
    }
    const grouped =
      prev !== null &&
      prev.from_device_id === m.from_device_id &&
      new Date(m.created_at).getTime() - new Date(prev.created_at).getTime() < GROUP_WINDOW_MS
    rows.push({
      kind: 'msg',
      key: m.message_id,
      message: m,
      grouped,
      senderName: names[m.from_device_id],
    })
    prev = m
  }
  return rows
}

// ---------- 消息流 ----------

function MessageList({
  conv,
  convName,
  isLobby,
  lobbyM2,
  emptyIcon,
}: {
  conv: ConversationId
  convName: string
  isLobby: boolean
  lobbyM2: boolean
  emptyIcon: React.ReactNode
}) {
  const me = useHub((s) => s.me)
  // 只取名字表:presence 上下线不触发整表 rebuild(客户端 CPU)
  const deviceNames = useHub(
    useShallow((s) => {
      const names: Record<string, string> = {}
      for (const d of s.devices) names[d.device_id] = d.name
      return names
    }),
  )
  const messages = useHub((s) => s.messages[conv])
  const historyStatus = useHub((s) => s.historyStatus[conv])
  const hasMore = useHub((s) => s.hasMore[conv] ?? false)
  const loadingMore = useHub((s) => s.loadingMore[conv] ?? false)
  const loadOlder = useHub((s) => s.loadOlder)

  const virtuosoRef = useRef<VirtuosoHandle>(null)
  const stickToBottom = useRef(true)
  const prependPending = useRef(false)
  const prevRowLen = useRef(0)
  const [firstItemIndex, setFirstItemIndex] = useState(VIRT_START)
  const [pending, setPending] = useState(0)
  const [showJump, setShowJump] = useState(false)

  const rows = useMemo(() => buildRows(messages ?? [], deviceNames), [messages, deviceNames])

  useEffect(
    function resetOnConv() {
      setFirstItemIndex(VIRT_START)
      prevRowLen.current = 0
      prependPending.current = false
      stickToBottom.current = true
      setPending(0)
      setShowJump(false)
    },
    [conv],
  )

  useEffect(
    function trackLength() {
      const len = rows.length
      const prev = prevRowLen.current
      const delta = len - prev
      prevRowLen.current = len
      if (delta <= 0 || prev === 0) return
      if (prependPending.current) {
        setFirstItemIndex((v) => v - delta)
        prependPending.current = false
        return
      }
      if (!stickToBottom.current) {
        setPending((p) => p + delta)
      }
    },
    [rows.length],
  )

  const jumpToLatest = () => {
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches
    virtuosoRef.current?.scrollToIndex({
      index: 'LAST',
      align: 'end',
      behavior: reduce ? 'auto' : 'smooth',
    })
    stickToBottom.current = true
    setPending(0)
    setShowJump(false)
  }

  const requestOlder = () => {
    prependPending.current = true
    loadOlder(conv)
  }

  if (isLobby && lobbyM2) {
    return (
      <EmptyState
        icon={<Broadcast size={26} />}
        title="当前中枢尚未开放大厅"
        hint="所有设备可见可取的广播会话需要中枢支持。先和某台设备私聊,或升级中枢后再试。"
      />
    )
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
        hint="把文件拖进来,或直接输入文字发送。对方在线可直转,离线则先入库。"
      />
    )
  }

  return (
    <div className="relative min-h-0 flex-1">
      <Virtuoso
        ref={virtuosoRef}
        data={rows}
        firstItemIndex={firstItemIndex}
        initialTopMostItemIndex={rows.length - 1}
        increaseViewportBy={{ top: 480, bottom: 240 }}
        followOutput={() => (stickToBottom.current ? 'smooth' : false)}
        atBottomStateChange={(atBottom) => {
          stickToBottom.current = atBottom
          setShowJump(!atBottom)
          if (atBottom) setPending(0)
        }}
        atBottomThreshold={120}
        className="h-full px-3 sm:px-4"
        role="log"
        aria-live="polite"
        components={{
          Header: () =>
            hasMore ? (
              <div className="mb-3 flex justify-center pt-4">
                <Button
                  variant="ghost"
                  loading={loadingMore}
                  onClick={requestOlder}
                  className="h-8 text-[12.5px] text-muted"
                >
                  查看更早的消息
                </Button>
              </div>
            ) : (
              <div className="h-4" />
            ),
          Footer: () => <div className="h-4" />,
        }}
        itemContent={(_index, row) => {
          if (row.kind === 'day') {
            return (
              <div className="mx-auto max-w-[720px] py-1.5">
                <div className="sticky top-0 z-10 bg-bg/85 px-2 py-1.5 backdrop-blur-sm">
                  <div className="flex items-center gap-3">
                    <span className="h-px flex-1 bg-line" />
                    <span className="text-[11.5px] text-muted">{row.day}</span>
                    <span className="h-px flex-1 bg-line" />
                  </div>
                </div>
              </div>
            )
          }
          const mine = row.message.from_device_id === me?.device_id
          return (
            <div className="mx-auto max-w-[720px] py-[3px]">
              <MessageRow
                message={row.message}
                mine={mine}
                grouped={row.grouped}
                senderName={row.senderName}
              />
            </div>
          )
        }}
      />

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
  const lobbySupported = useHub((s) => s.lobbySupported)
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

  const lobbySendable = !(isLobby && lobbySupported !== true)

  const onDragEnter = (e: DragEvent) => {
    e.preventDefault()
    if (!lobbySendable) return
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
    if (!lobbySendable) return
    void filesFromDataTransfer(e.dataTransfer).then((files) => {
      if (files.length > 0) sendFiles(activeConv, files)
    })
  }

  return (
    <section
      className="relative flex h-full min-h-0 flex-1 flex-col bg-bg"
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
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
                : '对方离线,文件将先写入文件库'}
          </span>
        </span>
      </header>

      {status !== 'online' && (
        <div
          aria-live="assertive"
          className={`anim-drop flex shrink-0 items-center gap-2 px-4 py-2 text-[12.5px] ${
            status === 'offline' || status === 'taken' ? 'bg-danger-soft text-ink' : 'bg-surface text-muted'
          }`}
        >
          {status === 'offline' || status === 'taken' ? (
            <>
              <Plugs size={15} className="text-danger" />
              <span className="flex-1">
                {status === 'taken'
                  ? '此设备身份正在其他窗口使用（请关掉多余的浏览器标签，或托盘与浏览器不要用同一设备名）'
                  : '与中枢断开了连接'}
              </span>
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

      <IncomingTransferBanner conv={activeConv} />

      <MessageList
        conv={activeConv}
        convName={convName}
        isLobby={isLobby}
        lobbyM2={isLobby && lobbySupported === false}
        emptyIcon={<Plugs size={26} />}
      />
      <Composer conv={activeConv} disabled={isLobby && lobbySupported !== true} />

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
