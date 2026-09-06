// 文件仓库:各会话寄存文件的聚合视图(NAS 式清单)
import { useEffect, useState } from 'react'
import {
  ArrowCounterClockwise,
  ArrowLeft,
  File,
  HardDrives,
  TrashSimple,
} from '@phosphor-icons/react'
import { useHub } from '../store/hub'
import { ConfirmDialog, EmptyState, Skeleton } from './ui'
import { StorageMeter } from './StorageMeter'
import { KIND_ICON, KIND_LABEL, fileKind } from '../lib/files'
import { formatBytes, formatDayLabel, formatClock } from '../lib/format'

function LibraryRow({ entry, index }: { entry: ReturnType<typeof useHub.getState>['library'][number]; index: number }) {
  const download = useHub((s) => s.download)
  const state = useHub((s) => s.downloads[entry.file.file_id])
  const dead = useHub((s) => Boolean(s.deadFiles[entry.file.file_id]))
  const deleteStoredFile = useHub((s) => s.deleteStoredFile)
  const [confirming, setConfirming] = useState(false)
  const Icon = KIND_ICON[fileKind(entry.file.name)]

  const status = () => {
    if (dead) return <span className="text-[12px] text-warning">已过期或已删除</span>
    if (!entry.mine && state?.status === 'downloading') {
      const ratio = state.totalBytes > 0 ? state.receivedBytes / state.totalBytes : 0
      return (
        <span className="flex min-w-0 flex-1 items-center gap-2">
          <span className="h-1 w-24 overflow-hidden rounded-full bg-surface-2">
            <span
              className="block h-full origin-left rounded-full bg-primary"
              style={{ transform: `scaleX(${Math.min(1, Math.max(0.02, ratio))})` }}
            />
          </span>
          <span className="num text-[11.5px] text-primary-ink">{Math.round(ratio * 100)}%</span>
        </span>
      )
    }
    if (!entry.mine && state?.status === 'saved')
      return <span className="text-[12px] text-primary-ink">已保存</span>
    return null
  }

  return (
    <div className={`group flex items-center gap-3 px-4 py-3 ${index > 0 ? 'border-t border-line' : ''} hover:bg-surface-2/60`} data-lib-file={entry.file.file_id}>
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px] bg-primary-soft text-primary-ink">
        <Icon size={20} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[14px] font-medium leading-snug" title={entry.file.name}>
          {entry.file.name}
        </span>
        <span className="num mt-0.5 block text-[12px] text-muted">
          {KIND_LABEL[fileKind(entry.file.name)]} · {formatBytes(entry.file.size)}
        </span>
        <span className="num mt-0.5 block truncate text-[12px] text-muted">
          {entry.mine ? '发给' : '来自'} {entry.convName === '大厅' ? '大厅' : entry.mine ? entry.convName : entry.fromName} · {formatDayLabel(entry.createdAt)} {formatClock(entry.createdAt)}
        </span>
        {status() && <span className="mt-0.5 block">{status()}</span>}
      </span>
      <span className="flex shrink-0 items-center gap-1">
        {!entry.mine && !dead && state?.status !== 'saved' && (
          <button
            onClick={() => download(entry.file)}
            className="flex h-9 items-center gap-1.5 rounded-[10px] bg-surface-2 px-3.5 text-[13px] font-medium text-ink transition-[background-color,transform] hover:bg-line active:scale-[0.98]"
          >
            取件
          </button>
        )}
        {!entry.mine && dead && (
          <button
            onClick={() => download(entry.file)}
            className="flex h-9 items-center gap-1.5 rounded-[10px] bg-surface-2 px-3.5 text-[13px] font-medium text-ink hover:bg-line"
          >
            <ArrowCounterClockwise size={14} /> 重试
          </button>
        )}
        <button
          aria-label={`删除 ${entry.file.name}`}
          title="删除寄存文件"
          onClick={() => setConfirming(true)}
          className="flex h-9 w-9 items-center justify-center rounded-[10px] text-muted transition-colors hover:bg-danger-soft hover:text-danger"
        >
          <TrashSimple size={16} />
        </button>
      </span>
      <ConfirmDialog
        open={confirming}
        onClose={() => setConfirming(false)}
        title="删除这个寄存文件?"
        body={`「${entry.file.name}」将从中枢删除,所有设备都无法再取件;聊天里的消息会保留并显示为已过期。`}
        confirmLabel="删除"
        onConfirm={() => deleteStoredFile(entry.file, entry.messageId)}
      />
    </div>
  )
}

export function FileLibrary({ mobile = false, onBack }: { mobile?: boolean; onBack?: () => void }) {
  const library = useHub((s) => s.library)
  const status = useHub((s) => s.libraryStatus)
  const loadLibrary = useHub((s) => s.loadLibrary)

  useEffect(
    function ensureLoaded() {
      if (status === 'idle') void loadLibrary()
    },
    [status, loadLibrary],
  )

  const totalSize = library.reduce((sum, e) => sum + e.file.size, 0)

  return (
    <section className="flex h-full min-h-0 flex-1 flex-col bg-bg">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-line px-2.5 sm:px-4">
        {mobile && onBack && (
          <button
            aria-label="返回聊天"
            onClick={onBack}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] text-muted hover:bg-surface-2 hover:text-ink"
          >
            <ArrowLeft size={18} />
          </button>
        )}
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] bg-primary text-on-primary">
          <HardDrives size={18} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[15px] font-semibold">文件仓库</span>
          <span className="num block text-[11.5px] text-muted">
            {library.length > 0 ? `${library.length} 个文件 · ${formatBytes(totalSize)}` : '各会话寄存与收发的文件'}
          </span>
        </span>
        <button
          aria-label="刷新文件仓库"
          title="刷新"
          onClick={() => void loadLibrary()}
          className="flex h-9 w-9 items-center justify-center rounded-[10px] text-muted hover:bg-surface-2 hover:text-ink"
        >
          <ArrowCounterClockwise size={16} />
        </button>
      </header>

      <div className="border-b border-line px-4 py-3">
        <StorageMeter compact />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto" role="region" aria-label="文件仓库列表">
        {status !== 'ready' ? (
          <div aria-busy="true" className="flex flex-col gap-px p-4">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="flex items-center gap-3 py-2">
                <Skeleton className="h-10 w-10 rounded-[10px]" />
                <span className="flex-1 space-y-1.5">
                  <Skeleton className="h-4 w-2/5" />
                  <Skeleton className="h-3 w-1/3" />
                </span>
                <Skeleton className="h-8 w-16 rounded-[10px]" />
              </div>
            ))}
          </div>
        ) : library.length === 0 ? (
          <EmptyState
            icon={<File size={26} />}
            title="仓库还是空的"
            hint="会话里发过、收过的文件都会出现在这里,可随时取件或删除。"
          />
        ) : (
          <div className="mx-auto max-w-[860px] pb-10">
            {library.map((e, i) => (
              <LibraryRow key={e.file.file_id} entry={e} index={i} />
            ))}
            <p className="px-4 pt-4 text-center text-[11.5px] text-muted">
              仅显示各会话最近 100 条消息中的文件;过期文件以侧栏寄存策略为准。
            </p>
          </div>
        )}
      </div>
    </section>
  )
}
