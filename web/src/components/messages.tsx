// 消息原子组件:文本气泡、文件卡、图片卡、文件组卡、图片灯箱
import { memo, useEffect, useMemo, useState } from 'react'
import {
  ArrowsClockwise,
  Checks,
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
import { KIND_ICON, KIND_LABEL, fileKind, isImage } from '../lib/files'
import { formatBytes, formatClock, formatSpeed } from '../lib/format'
import { useLightbox } from '../lib/lightbox'
import type { FileRef, Message } from '../lib/types'

// ---------- 图片灯箱 ----------

export function Lightbox() {
  const file = useLightbox((s) => s.file)
  const src = useLightbox((s) => s.src)
  const close = useLightbox((s) => s.close)
  return (
    <Dialog open={file !== null} onClose={close} width="max-w-[min(92vw,960px)]" dim="deep">
      <div className="flex flex-col gap-3">
        {src && file && (
          <img src={src} alt={file.name} className="max-h-[76vh] w-full self-center rounded-[10px] object-contain" />
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

// ---------- 文件卡(附件卡) ----------

export function FileCard({ file, mine, compact = false }: { file: FileRef; mine: boolean; compact?: boolean }) {
  const download = useHub((s) => s.download)
  const state = useHub((s) => s.downloads[file.file_id])
  const dead = useHub((s) => Boolean(s.deadFiles[file.file_id]))
  const retention = useHub((s) => s.storage?.retention_days)
  const kind = fileKind(file.name)
  const Icon = KIND_ICON[kind]

  const onGet = () => download(file)

  const statusLine = () => {
    if (dead)
      return (
        <span className="flex items-center gap-1 text-[12px] text-warning">
          <Warning size={13} weight="fill" /> 已过期或已删除
        </span>
      )
    if (!mine && state?.status === 'downloading') {
      return (
        <span className="num text-[12px] text-primary-ink">
          {formatBytes(state.receivedBytes)} / {formatBytes(state.totalBytes)} · {formatSpeed(state.speed)}
        </span>
      )
    }
    if (!mine && state?.status === 'saved')
      return (
        <span className="flex items-center gap-1 text-[12px] text-primary-ink">
          <CheckCircle size={13} weight="fill" /> 已保存
        </span>
      )
    if (!mine && state?.status === 'error')
      return (
        <span className="flex items-center gap-1 text-[12px] text-danger">
          <Warning size={13} weight="fill" /> {state.message.includes('404') ? '已过期或已删除' : '下载失败'}
        </span>
      )
    return <span className="num text-[12px] text-muted">{formatBytes(file.size)}</span>
  }

  const action = () => {
    if (mine || dead) return null
    if (state?.status === 'downloading')
      return (
        <span className="num text-[12px] font-medium text-primary-ink">
          {Math.round((state.receivedBytes / Math.max(1, state.totalBytes)) * 100)}%
        </span>
      )
    if (state?.status === 'saved')
      return (
        <Button variant="ghost" className="h-8 px-2.5 text-[12.5px]" onClick={onGet}>
          <ArrowsClockwise size={14} /> 重新下载
        </Button>
      )
    if (state?.status === 'error')
      return (
        <Button variant="secondary" className="h-8 gap-1 px-3 text-[12.5px]" onClick={onGet}>
          重试
        </Button>
      )
    return (
      <Button variant="secondary" className="h-8 gap-1 px-3 text-[12.5px]" onClick={onGet}>
        <DownloadSimple size={14} weight="bold" /> 取件
      </Button>
    )
  }

  if (compact) {
    return (
      <div className="flex items-center gap-3 px-3.5 py-2.5">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[9px] bg-primary-soft text-primary-ink">
          <Icon size={18} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13.5px] font-medium leading-snug">{file.name}</span>
          <span className="mt-0.5 block">{statusLine()}</span>
        </span>
        <span className="shrink-0">{action()}</span>
      </div>
    )
  }

  // 附件卡:大图标 + 名称 + 类型/大小 + 状态 + 全宽主按钮,与消息条明显区分
  return (
    <div className="w-[340px] max-w-full overflow-hidden rounded-[14px] border border-line bg-bg shadow-sm">
      <div className="flex items-start gap-3 p-3.5 pb-3">
        <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-[12px] bg-primary-soft text-primary-ink">
          <Icon size={26} />
        </span>
        <span className="min-w-0 flex-1 pt-0.5">
          <span className="block break-all text-[15px] font-semibold leading-snug" title={file.name}>
            {file.name}
          </span>
          <span className="num mt-1 block text-[12px] text-muted">
            {KIND_LABEL[kind]} · {formatBytes(file.size)}
          </span>
        </span>
      </div>
      {!mine && state?.status === 'downloading' && (
        <div className="px-3.5">
          <Progress value={state.totalBytes > 0 ? state.receivedBytes / state.totalBytes : 0} />
        </div>
      )}
      <div className="flex items-center justify-between gap-2 px-3.5 pb-3.5 pt-2.5">
        {/* 空闲态的尺寸已在头部展示,底部只放动态状态或一句提示 */}
        {(() => {
          const dynamic = !dead && state && state.status !== undefined
          if (dynamic || dead) return statusLine()
          return (
            <span className="text-[12px] text-muted">
              {mine
                ? `已寄存${retention ? `,对方 ${retention} 天内可取` : ''}`
                : `点击取件${retention ? `,文件保留 ${retention} 天` : ''}`}
            </span>
          )
        })()}
        {action()}
      </div>
    </div>
  )
}

// ---------- 图片卡 ----------

/** 灯箱才拉原图;超过此大小点按仍用 FileCard 取件,避免整文件进堆。 */
const LIGHTBOX_MAX_BYTES = 8 * 1024 * 1024

export function ImageCard({ file }: { file: FileRef }) {
  const [visible, setVisible] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [thumbFailed, setThumbFailed] = useState(false)
  const [rootEl, setRootEl] = useState<HTMLButtonElement | null>(null)
  const openLightbox = useLightbox((s) => s.open)
  const thumbSrc = useMemo(() => `/api/files/${encodeURIComponent(file.file_id)}/thumb`, [file.file_id])
  // inline=1: hub 用 Content-Disposition:inline + image/*，浏览器流式解码，不经 JS Blob
  const fullSrc = useMemo(
    () => `/api/files/${encodeURIComponent(file.file_id)}?inline=1`,
    [file.file_id],
  )

  useEffect(() => {
    if (!rootEl || typeof IntersectionObserver === 'undefined') {
      setVisible(true)
      return
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setVisible(true)
          io.disconnect()
        }
      },
      { rootMargin: '200px' },
    )
    io.observe(rootEl)
    return () => io.disconnect()
  }, [rootEl])

  if (thumbFailed) return <FileCard file={file} mine={false} />

  const openFull = () => {
    if (file.size > LIGHTBOX_MAX_BYTES) return
    openLightbox(file, fullSrc)
  }

  return (
    <button
      ref={setRootEl}
      onClick={openFull}
      className={`relative block max-w-[340px] overflow-hidden rounded-[14px] bg-surface-2 ${
        file.size > LIGHTBOX_MAX_BYTES ? 'cursor-default' : 'cursor-zoom-in'
      }`}
      title={`${file.name} · ${formatBytes(file.size)}${file.size > LIGHTBOX_MAX_BYTES ? '' : ' · 点按放大'}`}
    >
      {visible && (
        <img
          src={thumbSrc}
          alt={file.name}
          onLoad={() => setLoaded(true)}
          onError={() => setThumbFailed(true)}
          className={`max-h-72 w-full object-cover transition-opacity duration-200 ${loaded ? 'opacity-100' : 'h-44 opacity-0'}`}
        />
      )}
      {!visible && <div className="h-36 w-72" />}
      {loaded && (
        <span className="absolute inset-x-0 bottom-0 flex items-center gap-2 bg-gradient-to-t from-black/65 to-transparent px-3 pb-2 pt-6">
          <span className="min-w-0 flex-1 truncate text-left text-[12.5px] font-medium text-white">{file.name}</span>
          <span className="num shrink-0 text-[11.5px] text-white/85">{formatBytes(file.size)}</span>
        </span>
      )}
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
  senderName: string | undefined
}

export const MessageRow = memo(function MessageRow({ message, mine, grouped, senderName }: MessageRowProps) {
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
          {senderName ? (
            <span className="text-[11px] font-semibold">{senderName.slice(0, 1)}</span>
          ) : (
            <PlugsFallback />
          )}
        </span>
      )}
      <div className={`flex min-w-0 flex-col ${mine ? 'items-end' : 'items-start'} anim-in`}>
        {!mine && !grouped && senderName && (
          <span className="mb-1 px-1 text-[11.5px] text-muted">{senderName}</span>
        )}
        <MessageBody message={message} mine={mine} />
      </div>
      <span className="num flex shrink-0 select-none items-center gap-0.5 pb-0.5 text-[10.5px] text-muted/80">
        {mine && message.acked_at && (
          <span title={`对方已于 ${formatClock(message.acked_at)} 看到`} className="text-primary-ink">
            <Checks size={11} weight="bold" />
          </span>
        )}
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
