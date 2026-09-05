// 消息原子组件:文本气泡、文件卡、图片卡、文件组卡、图片灯箱
import { memo, useEffect, useMemo, useState } from 'react'
import { create } from 'zustand'
import {
  ArrowsClockwise,
  CheckCircle,
  Copy,
  DownloadSimple,
  File,
  PlugsConnected,
  TrashSimple,
  Warning,
  X,
} from '@phosphor-icons/react'
import { useHub } from '../store/hub'
import { Button, ConfirmDialog, Dialog, Progress } from './ui'
import { KIND_ICON, fileKind, isImage } from '../lib/files'
import { formatBytes, formatClock, formatSpeed } from '../lib/format'
import type { Device, FileRef, Message } from '../lib/types'

// ---------- 图片灯箱 ----------

interface LightboxState {
  file: FileRef | null
  objectUrl: string | null
  open: (file: FileRef, objectUrl: string) => void
  close: () => void
}

const useLightbox = create<LightboxState>((set) => ({
  file: null,
  objectUrl: null,
  open: (file, objectUrl) => set({ file, objectUrl }),
  close: () => set({ file: null, objectUrl: null }),
}))

export function Lightbox() {
  const file = useLightbox((s) => s.file)
  const objectUrl = useLightbox((s) => s.objectUrl)
  const close = useLightbox((s) => s.close)
  return (
    <Dialog open={file !== null} onClose={close} width="max-w-[min(92vw,960px)]">
      <div className="flex flex-col gap-3">
        {objectUrl && file && (
          <img src={objectUrl} alt={file.name} className="max-h-[76vh] w-full self-center rounded-[10px] object-contain" />
        )}
        <div className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{file?.name}</span>
          <span className="num shrink-0 text-[12px] text-muted">{file ? formatBytes(file.size) : ''}</span>
          <button
            aria-label="关闭大图"
            onClick={close}
            className="shrink-0 rounded p-1.5 text-muted hover:bg-surface-2 hover:text-ink"
          >
            <X size={15} weight="bold" />
          </button>
        </div>
      </div>
    </Dialog>
  )
}

// ---------- 文件卡 ----------

export function FileCard({ file, mine, compact = false }: { file: FileRef; mine: boolean; compact?: boolean }) {
  const download = useHub((s) => s.download)
  const state = useHub((s) => s.downloads[file.file_id])
  const Icon = KIND_ICON[fileKind(file.name)]

  const onGet = () => download(file)

  const statusLine = () => {
    if (!mine && state?.status === 'downloading') {
      return (
        <span className="num text-[11.5px] text-primary-ink">
          {formatBytes(state.receivedBytes)} / {formatBytes(state.totalBytes)} · {formatSpeed(state.speed)}
        </span>
      )
    }
    if (!mine && state?.status === 'saved')
      return (
        <span className="flex items-center gap-1 text-[11.5px] text-primary-ink">
          <CheckCircle size={12} weight="fill" /> 已保存
        </span>
      )
    if (!mine && state?.status === 'error')
      return (
        <span className="flex items-center gap-1 text-[11.5px] text-danger">
          <Warning size={12} weight="fill" /> {state.message.includes('404') ? '已过期或已删除' : '下载失败'}
        </span>
      )
    return <span className="num text-[11.5px] text-muted">{formatBytes(file.size)}</span>
  }

  const action = () => {
    if (mine) return null
    if (state?.status === 'downloading')
      return (
        <span className="num text-[11.5px] font-medium text-primary-ink">
          {Math.round((state.receivedBytes / Math.max(1, state.totalBytes)) * 100)}%
        </span>
      )
    if (state?.status === 'saved')
      return (
        <Button variant="ghost" className="h-7 px-2 text-[12px]" onClick={onGet}>
          <ArrowsClockwise size={13} /> 重新下载
        </Button>
      )
    if (state?.status === 'error')
      return (
        <Button variant="secondary" className="h-7 px-2 text-[12px]" onClick={onGet}>
          重试
        </Button>
      )
    return (
      <Button variant="secondary" className="h-7 gap-1 px-2.5 text-[12px]" onClick={onGet}>
        <DownloadSimple size={13} weight="bold" /> 取件
      </Button>
    )
  }

  if (compact) {
    return (
      <div className="flex items-center gap-2.5 px-3 py-2">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[8px] bg-primary-soft text-primary-ink">
          <Icon size={16} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium">{file.name}</span>
          <span className="block">{statusLine()}</span>
        </span>
        {action()}
      </div>
    )
  }

  return (
    <div className="w-[300px] max-w-full rounded-[12px] border border-line bg-bg p-3">
      <div className="flex items-start gap-2.5">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px] bg-primary-soft text-primary-ink">
          <Icon size={20} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13.5px] font-medium leading-snug" title={file.name}>
            {file.name}
          </span>
          <span className="mt-0.5 block">{statusLine()}</span>
        </span>
        <span className="shrink-0 pt-0.5">{action()}</span>
      </div>
      {!mine && state?.status === 'downloading' && (
        <div className="mt-2.5">
          <Progress value={state.totalBytes > 0 ? state.receivedBytes / state.totalBytes : 0} />
        </div>
      )}
    </div>
  )
}

// ---------- 图片卡 ----------

export function ImageCard({ file }: { file: FileRef }) {
  const [loaded, setLoaded] = useState(false)
  const [failed, setFailed] = useState(false)
  const [objectUrl, setObjectUrl] = useState<string | null>(null)
  const openLightbox = useLightbox((s) => s.open)
  const src = useMemo(() => `/api/files/${encodeURIComponent(file.file_id)}`, [file.file_id])

  // 走 fetch(可被 mock 拦截)取 blob,而非 <img src> 直连——后者绕过 fetch 层
  useEffect(
    function loadImage() {
      let revoked: string | null = null
      let alive = true
      setLoaded(false)
      setFailed(false)
      setObjectUrl(null)
      fetch(src)
        .then((res) => {
          if (!res.ok) throw new Error(String(res.status))
          return res.blob()
        })
        .then((blob) => {
          if (!alive) return
          revoked = URL.createObjectURL(blob)
          setObjectUrl(revoked)
        })
        .catch(() => {
          if (alive) setFailed(true)
        })
      return () => {
        alive = false
        if (revoked) URL.revokeObjectURL(revoked)
      }
    },
    [src],
  )

  if (failed) return <FileCard file={file} mine={false} />

  return (
    <button
      onClick={() => objectUrl && openLightbox(file, objectUrl)}
      className="block max-w-[320px] cursor-zoom-in overflow-hidden rounded-[12px] bg-surface-2"
      title={`${file.name} · ${formatBytes(file.size)} · 点按放大`}
    >
      {objectUrl && (
        <img
          src={objectUrl}
          alt={file.name}
          onLoad={() => setLoaded(true)}
          className={`max-h-64 w-full object-cover transition-opacity duration-200 ${loaded ? 'opacity-100' : 'h-40 opacity-0'}`}
        />
      )}
      {!objectUrl && <div className="h-32 w-64" />}
    </button>
  )
}

// ---------- 文件组卡 ----------

export function FileGroupCard({ files, mine }: { files: FileRef[]; mine: boolean }) {
  const total = files.reduce((sum, f) => sum + f.size, 0)
  return (
    <div className="w-[340px] max-w-full overflow-hidden rounded-[12px] border border-line bg-bg">
      <div className="flex items-baseline justify-between border-b border-line px-3.5 py-2">
        <span className="text-[12px] font-medium text-muted">{files.length} 个文件</span>
        <span className="num text-[11.5px] text-muted">{formatBytes(total)}</span>
      </div>
      <div className="divide-y divide-line">
        {files.map((f) => (
          <FileCard key={f.file_id} file={f} mine={mine} compact />
        ))}
      </div>
    </div>
  )
}

// ---------- 消息体 ----------

export function MessageBody({ message, mine }: { message: Message; mine: boolean }) {
  if (message.kind === 'text') {
    return (
      <div
        className={`max-w-[78%] whitespace-pre-wrap break-words rounded-[14px] px-3.5 py-2 text-[14.5px] leading-relaxed ${
          mine ? 'rounded-br-[4px] bg-primary text-on-primary' : 'rounded-bl-[4px] bg-surface text-ink'
        }`}
      >
        {message.text}
      </div>
    )
  }
  if (message.kind === 'file' && message.file) {
    if (isImage(message.file.name)) return <ImageCard file={message.file} />
    return <FileCard file={message.file} mine={mine} />
  }
  if (message.kind === 'file_group' && message.files && message.files.length > 0) {
    return <FileGroupCard files={message.files} mine={mine} />
  }
  return (
    <div className="flex items-center gap-1.5 rounded-[14px] bg-surface px-3.5 py-2 text-[13px] text-muted">
      <File size={14} /> 不支持的消息
    </div>
  )
}

// ---------- 消息行(memo:仅自身数据变化时重渲染) ----------

interface MessageRowProps {
  message: Message
  mine: boolean
  grouped: boolean
  sender: Device | undefined
}

export const MessageRow = memo(function MessageRow({ message, mine, grouped, sender }: MessageRowProps) {
  const deleteMessage = useHub((s) => s.deleteMessage)
  const pushToast = useHub((s) => s.pushToast)
  const [confirming, setConfirming] = useState(false)

  const copyText = async () => {
    try {
      await navigator.clipboard.writeText(message.text ?? '')
      pushToast('ok', '已复制到剪贴板')
    } catch {
      pushToast('error', '复制失败:剪贴板不可用')
    }
  }

  return (
    <div
      className={`group list-culling flex items-end gap-2 ${mine ? 'flex-row-reverse' : ''} ${
        grouped ? 'mt-0.5' : 'mt-2.5'
      }`}
    >
      {!mine && (
        <span
          className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-[8px] bg-surface-2 text-muted ${
            grouped ? 'opacity-0' : ''
          }`}
        >
          {sender ? <span className="text-[11px] font-semibold">{sender.name.slice(0, 1)}</span> : <PlugsFallback />}
        </span>
      )}
      <div className={`flex min-w-0 flex-col ${mine ? 'items-end' : 'items-start'} anim-in`}>
        {!mine && !grouped && sender && (
          <span className="mb-1 px-1 text-[11.5px] text-muted">{sender.name}</span>
        )}
        <MessageBody message={message} mine={mine} />
      </div>
      <span className="num shrink-0 select-none pb-0.5 text-[10.5px] text-muted/80">
        {formatClock(message.created_at)}
      </span>
      <span className={`mb-1 flex shrink-0 items-center gap-0.5 ${mine ? 'flex-row-reverse' : ''}`}>
        {message.kind === 'text' && (
          <button
            aria-label="复制这条消息"
            title="复制"
            onClick={() => void copyText()}
            className="rounded p-1 text-muted opacity-0 transition-opacity hover:bg-surface-2 hover:text-ink focus-visible:opacity-100 group-hover:opacity-100"
          >
            <Copy size={13} />
          </button>
        )}
        <button
          aria-label="删除这条消息"
          title="删除"
          onClick={() => setConfirming(true)}
          className="rounded p-1 text-muted opacity-0 transition-opacity hover:bg-surface-2 hover:text-danger focus-visible:opacity-100 group-hover:opacity-100"
        >
          <TrashSimple size={13} />
        </button>
      </span>
      <ConfirmDialog
        open={confirming}
        onClose={() => setConfirming(false)}
        title="删除这条消息?"
        body={message.kind === 'text' ? undefined : '对应的寄存文件也会一并删除,其他设备将无法再取件。'}
        onConfirm={() => deleteMessage(message)}
      />
    </div>
  )
})

function PlugsFallback() {
  return <PlugsConnected size={14} />
}
