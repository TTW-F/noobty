// 发送器:输入、附件、粘贴发送、上传队列(失败可重试)
import { useEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent } from 'react'
import { ArrowsClockwise, FolderSimple, PaperPlaneTilt, Paperclip, Warning, X } from '@phosphor-icons/react'
import { useHub } from '../store/hub'
import { Progress } from './ui'
import { formatSpeed } from '../lib/format'
import type { ConversationId } from '../lib/types'

function UploadQueue({ conv }: { conv: ConversationId }) {
  const uploads = useHub((s) => s.uploads)
  const cancelUpload = useHub((s) => s.cancelUpload)
  const retryUpload = useHub((s) => s.retryUpload)
  const tasks = uploads.filter((t) => t.conversationId === conv)
  if (tasks.length === 0) return null

  return (
    <div className="border-t border-line px-3 pb-1 pt-2 sm:px-4">
      {tasks.map((t) => {
        const ratio = t.size > 0 ? t.sentBytes / t.size : 0
        return (
          <div key={t.id} className="flex items-center gap-2.5 py-1.5">
            {t.status === 'error' ? (
              <Warning size={15} className="shrink-0 text-danger" weight="fill" />
            ) : (
              <span className="h-4 w-4 shrink-0" />
            )}
            <span className="min-w-0 flex-1">
              <span className="flex items-baseline justify-between gap-2">
                <span className="truncate text-[12.5px] font-medium">{t.name}</span>
                <span className={`num shrink-0 text-[11px] ${t.status === 'error' ? 'text-danger' : 'text-muted'}`}>
                  {t.status === 'error'
                    ? (t.error ?? '上传失败')
                    : `${Math.round(ratio * 100)}% · ${formatSpeed(t.speed)}`}
                </span>
              </span>
              <span className="mt-1 block">
                <Progress value={ratio} tone={t.status === 'error' ? 'warning' : 'primary'} />
              </span>
            </span>
            {t.status === 'error' && (
              <button
                aria-label={`重新上传 ${t.name}`}
                title="重新上传"
                onClick={() => retryUpload(t.id)}
                className="shrink-0 rounded p-1 text-muted hover:bg-surface-2 hover:text-ink"
              >
                <ArrowsClockwise size={14} />
              </button>
            )}
            <button
              aria-label={t.status === 'error' ? '移除记录' : '取消上传'}
              title={t.status === 'error' ? '移除记录' : '取消上传'}
              onClick={() => cancelUpload(t.id)}
              className="shrink-0 rounded p-1 text-muted hover:bg-surface-2 hover:text-ink"
            >
              <X size={13} weight="bold" />
            </button>
          </div>
        )
      })}
    </div>
  )
}

export function Composer({ conv, disabled = false }: { conv: ConversationId; disabled?: boolean }) {
  const sendText = useHub((s) => s.sendText)
  const sendFiles = useHub((s) => s.sendFiles)
  const [text, setText] = useState('')
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const folderRef = useRef<HTMLInputElement>(null)

  // 桌面端切换会话后聚焦输入框,手机端不弹键盘
  useEffect(
    function focusOnConversationSwitch() {
      if (!disabled && matchMedia('(min-width: 1024px)').matches) {
        inputRef.current?.focus({ preventScroll: true })
      }
    },
    [conv, disabled],
  )

  const canSend = text.trim().length > 0

  const submit = async () => {
    const value = text.trim()
    if (!value) return
    setText('')
    if (inputRef.current) inputRef.current.style.height = 'auto'
    const ok = await sendText(conv, value)
    if (!ok) {
      // 发送失败:把文字还给输入框,不丢内容
      setText(value)
      requestAnimationFrame(() => {
        if (inputRef.current) {
          inputRef.current.style.height = 'auto'
          inputRef.current.style.height = `${Math.min(inputRef.current.scrollHeight, 132)}px`
        }
      })
    }
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // 中文输入法组词期间的 Enter 不发送
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      void submit()
    }
  }

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(e.clipboardData.files)
    if (files.length > 0) {
      e.preventDefault()
      sendFiles(conv, files)
    }
  }

  const autoGrow = (el: HTMLTextAreaElement) => {
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 132)}px`
  }

  return (
    <div className="border-t border-line bg-bg">
      <UploadQueue conv={conv} />
      <div className="flex items-end gap-1.5 px-2.5 py-2.5 sm:px-4 sm:py-3">
        <button
          aria-label="选择文件发送"
          title="选择文件发送"
          disabled={disabled}
          onClick={() => fileRef.current?.click()}
          className="mb-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px] text-muted transition-colors hover:bg-surface-2 hover:text-ink active:scale-[0.98] disabled:opacity-40"
        >
          <Paperclip size={19} />
        </button>
        <button
          aria-label="选择文件夹发送"
          title="选择文件夹发送"
          disabled={disabled}
          onClick={() => folderRef.current?.click()}
          className="mb-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px] text-muted transition-colors hover:bg-surface-2 hover:text-ink active:scale-[0.98] disabled:opacity-40"
        >
          <FolderSimple size={19} />
        </button>
        <input
          ref={fileRef}
          type="file"
          multiple
          hidden
          disabled={disabled}
          onChange={(e) => {
            const files = Array.from(e.target.files ?? [])
            if (files.length > 0) sendFiles(conv, files)
            e.target.value = ''
          }}
        />
        <input
          ref={folderRef}
          type="file"
          multiple
          hidden
          disabled={disabled}
          {...({ webkitdirectory: '', directory: '' } as Record<string, string>)}
          onChange={(e) => {
            const list = e.target.files
            if (!list || list.length === 0) {
              e.target.value = ''
              return
            }
            // webkitdirectory 给出的 File 带 webkitRelativePath
            const files = Array.from(list).map((f) => {
              const rel = (f as File & { webkitRelativePath?: string }).webkitRelativePath
              if (rel && rel !== f.name) {
                return new File([f], rel, { type: f.type, lastModified: f.lastModified })
              }
              return f
            })
            sendFiles(conv, files)
            e.target.value = ''
          }}
        />
        <textarea
          ref={inputRef}
          value={text}
          rows={1}
          disabled={disabled}
          placeholder={disabled ? '大厅暂不可用' : '输入文字,或直接拖入、粘贴文件'}
          onChange={(e) => {
            setText(e.target.value)
            autoGrow(e.target)
          }}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          className="max-h-[132px] min-h-10 flex-1 resize-none rounded-[10px] border border-line bg-bg px-3 py-2 text-[14.5px] leading-relaxed outline-none transition-colors placeholder:text-muted/70 focus:border-primary disabled:bg-surface disabled:text-muted"
        />
        <button
          aria-label="发送"
          title="发送"
          disabled={!canSend || disabled}
          onClick={() => void submit()}
          className="mb-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px] bg-primary text-on-primary transition-[opacity,transform] hover:opacity-90 active:scale-[0.95] disabled:opacity-30"
        >
          <PaperPlaneTilt size={18} weight="fill" />
        </button>
      </div>
      <div className="hidden px-4 pb-2 text-[11px] text-muted sm:block">
        {disabled ? '当前中枢尚未开放大厅' : 'Enter 发送 · Shift+Enter 换行 · 可多选文件或文件夹'}
      </div>
    </div>
  )
}
