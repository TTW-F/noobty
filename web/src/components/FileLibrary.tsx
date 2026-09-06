// 文件库:中枢共享文件清单(GET /api/files),浏览 / 下载 / 删除 + 虚拟列表
import { useEffect, useMemo, useState, type FormEvent } from 'react'
import {
  ArrowCounterClockwise,
  ArrowLeft,
  DownloadSimple,
  File,
  HardDrives,
  MagnifyingGlass,
  TrashSimple,
} from '@phosphor-icons/react'
import { Virtuoso } from 'react-virtuoso'
import { useHub, type LibraryEntry } from '../store/hub'
import { ConfirmDialog, EmptyState, Skeleton } from './ui'
import { StorageMeter } from './StorageMeter'
import { KIND_ICON, KIND_LABEL, fileKind, isImage } from '../lib/files'
import { api } from '../lib/api'
import {
  formatBytes,
  formatClock,
  formatDayLabel,
  formatExpiresIn,
  formatSpeed,
} from '../lib/format'

type Filter = 'all' | 'mine' | 'received' | 'image' | 'archive'
type Sort = 'newest' | 'largest'

const FILTERS: Array<{ id: Filter; label: string }> = [
  { id: 'all', label: '全部' },
  { id: 'mine', label: '我发的' },
  { id: 'received', label: '我收到的' },
  { id: 'image', label: '图片' },
  { id: 'archive', label: '压缩包' },
]

type FlatRow =
  | { kind: 'day'; key: string; label: string }
  | { kind: 'file'; key: string; entry: LibraryEntry }

function matchesFilter(e: LibraryEntry, filter: Filter): boolean {
  if (filter === 'all') return true
  if (filter === 'mine') return e.mine
  if (filter === 'received') return !e.mine
  const kind = fileKind(e.file.name)
  if (filter === 'image') return kind === 'image'
  if (filter === 'archive') return kind === 'archive'
  return true
}

function buildFlatRows(filtered: LibraryEntry[], sort: Sort): FlatRow[] {
  if (sort === 'largest') {
    return filtered.map((e) => ({ kind: 'file' as const, key: e.file.file_id, entry: e }))
  }
  const rows: FlatRow[] = []
  let prevDay = ''
  for (const e of filtered) {
    const label = formatDayLabel(e.uploadedAt)
    if (label !== prevDay) {
      rows.push({ kind: 'day', key: `d-${label}-${e.file.file_id}`, label })
      prevDay = label
    }
    rows.push({ kind: 'file', key: e.file.file_id, entry: e })
  }
  return rows
}

function LibraryRow({ entry }: { entry: LibraryEntry }) {
  const download = useHub((s) => s.download)
  const state = useHub((s) => s.downloads[entry.file.file_id])
  const downloaded = useHub((s) => Boolean(s.downloaded[entry.file.file_id]))
  const dead = useHub((s) => Boolean(s.deadFiles[entry.file.file_id]))
  const deleteStoredFile = useHub((s) => s.deleteStoredFile)
  const [confirming, setConfirming] = useState(false)
  const [thumbFailed, setThumbFailed] = useState(false)
  const kind = fileKind(entry.file.name)
  const Icon = KIND_ICON[kind]
  const showThumb = isImage(entry.file.name) && !dead && !thumbFailed
  const expiringSoon =
    !dead && new Date(entry.expiresAt).getTime() - Date.now() < 86400_000 * 1.5
  const done = downloaded || state?.status === 'saved'

  const status = () => {
    if (dead) return <span className="text-[12px] text-warning">已过期或已删除</span>
    if (state?.status === 'downloading') {
      const ratio = state.totalBytes > 0 ? state.receivedBytes / state.totalBytes : 0
      return (
        <span className="flex min-w-0 flex-1 items-center gap-2">
          <span className="h-1 w-24 overflow-hidden rounded-full bg-surface-2">
            <span
              className="block h-full origin-left rounded-full bg-primary"
              style={{ transform: `scaleX(${Math.min(1, Math.max(0.02, ratio))})` }}
            />
          </span>
          <span className="num text-[11.5px] text-primary-ink">
            {Math.round(ratio * 100)}%
            {state.speed > 0 ? ` · ${formatSpeed(state.speed)}` : ''}
          </span>
        </span>
      )
    }
    if (done) return <span className="text-[12px] text-primary-ink">已下载</span>
    if (state?.status === 'error') return <span className="text-[12px] text-danger">{state.message}</span>
    return (
      <span className={`text-[12px] ${expiringSoon ? 'text-warning' : 'text-muted'}`}>
        {formatExpiresIn(entry.expiresAt)}
      </span>
    )
  }

  return (
    <div
      className="group mx-auto flex max-w-[860px] items-center gap-3 border-b border-line px-4 py-3 hover:bg-surface-2/60"
      data-lib-file={entry.file.file_id}
    >
      {showThumb ? (
        <img
          src={api.thumbUrl(entry.file.file_id)}
          alt=""
          className="h-10 w-10 shrink-0 rounded-[10px] object-cover bg-surface-2"
          loading="lazy"
          decoding="async"
          onError={() => setThumbFailed(true)}
        />
      ) : (
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px] bg-primary-soft text-primary-ink">
          <Icon size={20} />
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[14px] font-medium leading-snug" title={entry.file.name}>
          {entry.file.name}
        </span>
        <span className="num mt-0.5 block text-[12px] text-muted">
          {KIND_LABEL[kind]} · {formatBytes(entry.file.size)} · {entry.mine ? '我上传' : `来自 ${entry.fromName}`}
        </span>
        <span className="num mt-0.5 block truncate text-[12px] text-muted">
          {formatDayLabel(entry.uploadedAt)} {formatClock(entry.uploadedAt)}
        </span>
        <span className="mt-0.5 block">{status()}</span>
      </span>
      <span className="flex shrink-0 items-center gap-1">
        {!dead && !done && state?.status !== 'downloading' && (
          <button
            onClick={() => download(entry.file)}
            className="flex h-9 items-center gap-1.5 rounded-[10px] bg-surface-2 px-3 text-[13px] font-medium text-ink transition-[background-color,transform] hover:bg-line active:scale-[0.98]"
          >
            <DownloadSimple size={14} />
            下载
          </button>
        )}
        {!dead && done && (
          <button
            onClick={() => download(entry.file)}
            className="flex h-9 items-center gap-1.5 rounded-[10px] bg-surface-2 px-3 text-[13px] font-medium text-ink hover:bg-line"
          >
            <ArrowCounterClockwise size={14} /> 重新下载
          </button>
        )}
        {dead && (
          <button
            onClick={() => download(entry.file)}
            className="flex h-9 items-center gap-1.5 rounded-[10px] bg-surface-2 px-3 text-[13px] font-medium text-ink hover:bg-line"
          >
            <ArrowCounterClockwise size={14} /> 重试
          </button>
        )}
        <button
          aria-label={`删除 ${entry.file.name}`}
          title="从中枢删除"
          onClick={() => setConfirming(true)}
          className="flex h-9 w-9 items-center justify-center rounded-[10px] text-muted transition-colors hover:bg-danger-soft hover:text-danger"
        >
          <TrashSimple size={16} />
        </button>
      </span>
      <ConfirmDialog
        open={confirming}
        onClose={() => setConfirming(false)}
        title="从中枢删除这个文件?"
        body={`「${entry.file.name}」将从文件库删除,引用它的聊天卡片也会移除;所有设备都无法再下载。`}
        confirmLabel="删除"
        onConfirm={() => deleteStoredFile(entry.file)}
      />
    </div>
  )
}

export function FileLibrary({ mobile = false, onBack }: { mobile?: boolean; onBack?: () => void }) {
  const library = useHub((s) => s.library)
  const status = useHub((s) => s.libraryStatus)
  const hasMore = useHub((s) => s.libraryHasMore)
  const loadingMore = useHub((s) => s.libraryLoadingMore)
  const loadLibrary = useHub((s) => s.loadLibrary)
  const loadLibraryMore = useHub((s) => s.loadLibraryMore)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [sort, setSort] = useState<Sort>('newest')

  useEffect(
    function ensureLoaded() {
      if (status === 'idle') void loadLibrary()
    },
    [status, loadLibrary],
  )

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    let rows = library.filter((e) => matchesFilter(e, filter))
    if (q) rows = rows.filter((e) => e.file.name.toLowerCase().includes(q) || e.fromName.toLowerCase().includes(q))
    rows = [...rows].sort((a, b) => {
      if (sort === 'largest') return b.file.size - a.file.size
      return b.uploadedAt.localeCompare(a.uploadedAt)
    })
    return rows
  }, [library, filter, query, sort])

  const flatRows = useMemo(() => buildFlatRows(filtered, sort), [filtered, sort])

  const totalSize = filtered.reduce((sum, e) => sum + e.file.size, 0)
  const canPage = hasMore && filter === 'all' && !query && sort === 'newest'

  const onSearch = (e: FormEvent) => {
    e.preventDefault()
  }

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
            {library.length > 0
              ? filter === 'all' && !query
                ? `${library.length} 个文件 · ${formatBytes(library.reduce((s, e) => s + e.file.size, 0))}`
                : `显示 ${filtered.length} / ${library.length} · ${formatBytes(totalSize)}`
              : '中枢文件库全部文件'}
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

      <div className="shrink-0 space-y-3 border-b border-line px-4 py-3">
        <StorageMeter compact />
        <form onSubmit={onSearch} className="relative">
          <MagnifyingGlass size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索文件名或上传者"
            className="h-9 w-full rounded-[10px] border border-line bg-bg pl-9 pr-3 text-[13px] outline-none placeholder:text-muted/70 focus:border-primary"
          />
        </form>
        <div className="flex flex-wrap items-center gap-1.5">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              onClick={() => setFilter(f.id)}
              className={`h-7 rounded-[9px] px-2.5 text-[12px] transition-colors ${
                filter === f.id
                  ? 'bg-primary-soft font-medium text-primary-ink'
                  : 'text-muted hover:bg-surface-2 hover:text-ink'
              }`}
            >
              {f.label}
            </button>
          ))}
          <span className="mx-1 h-4 w-px bg-line" aria-hidden />
          <button
            type="button"
            onClick={() => setSort('newest')}
            className={`h-7 rounded-[9px] px-2.5 text-[12px] ${
              sort === 'newest' ? 'bg-surface-2 font-medium text-ink' : 'text-muted hover:text-ink'
            }`}
          >
            最新
          </button>
          <button
            type="button"
            onClick={() => setSort('largest')}
            className={`h-7 rounded-[9px] px-2.5 text-[12px] ${
              sort === 'largest' ? 'bg-surface-2 font-medium text-ink' : 'text-muted hover:text-ink'
            }`}
          >
            最大
          </button>
        </div>
      </div>

      <div className="relative min-h-0 flex-1" role="region" aria-label="文件仓库列表">
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
            hint="发到中枢的文件会集中出现在这里,可随时下载或清理存储空间。"
          />
        ) : filtered.length === 0 ? (
          <EmptyState
            icon={<MagnifyingGlass size={26} />}
            title="没有匹配的文件"
            hint="试试换个关键词或筛选条件。"
          />
        ) : (
          <Virtuoso
            data={flatRows}
            className="h-full"
            increaseViewportBy={{ top: 200, bottom: 400 }}
            endReached={() => {
              if (canPage && !loadingMore) void loadLibraryMore()
            }}
            components={{
              Footer: () => (
                <div className="px-4 py-4 text-center">
                  {canPage ? (
                    <button
                      type="button"
                      disabled={loadingMore}
                      onClick={() => void loadLibraryMore()}
                      className="mb-2 h-8 rounded-[10px] border border-line px-3 text-[12.5px] text-muted transition-colors hover:bg-surface-2 hover:text-ink disabled:opacity-50"
                    >
                      {loadingMore ? '加载中…' : '加载更早的文件'}
                    </button>
                  ) : null}
                  <p className="text-[11.5px] text-muted">
                    清单来自中枢文件库;到期或超配额时自动清理最旧文件。
                  </p>
                </div>
              ),
            }}
            itemContent={(_i, row) => {
              if (row.kind === 'day') {
                return (
                  <p className="sticky top-0 z-[1] mx-auto max-w-[860px] bg-bg/95 px-4 py-2 text-[11.5px] font-medium text-muted backdrop-blur-sm">
                    {row.label}
                  </p>
                )
              }
              return <LibraryRow entry={row.entry} />
            }}
          />
        )}
      </div>
    </section>
  )
}
