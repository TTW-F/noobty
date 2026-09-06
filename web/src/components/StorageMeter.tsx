// 寄存空间表:侧栏(可展开详情)与文件仓库(紧凑)共用
import { useState } from 'react'
import { CaretDown, HardDrives, Warning } from '@phosphor-icons/react'
import { useHub } from '../store/hub'
import { formatBytes } from '../lib/format'

const WARN_RATIO = 0.8

export function StorageMeter({ compact = false }: { compact?: boolean }) {
  const storage = useHub((s) => s.storage)
  const [expanded, setExpanded] = useState(false)
  if (!storage || storage.max_total_bytes <= 0) return null

  const ratio = storage.used_bytes / storage.max_total_bytes
  const warn = ratio >= WARN_RATIO
  const percent = Math.round(ratio * 100)

  if (compact) {
    return (
      <div>
        <div className="mb-1.5 flex items-baseline justify-between gap-2">
          <span className="flex items-center gap-1.5 text-[12px] font-medium text-muted">
            <HardDrives size={13} />
            寄存空间
          </span>
          <span className={`num text-[11px] ${warn ? 'text-warning' : 'text-muted'}`}>
            {formatBytes(storage.used_bytes)} / {formatBytes(storage.max_total_bytes)}
          </span>
        </div>
        <div className="relative">
          <div className="h-1 overflow-hidden rounded-full bg-surface-2">
            <div
              className={`h-full rounded-full transition-[width] duration-300 ${warn ? 'bg-warning' : 'bg-primary'}`}
              style={{ width: `${Math.min(100, Math.max(1.5, ratio * 100))}%` }}
            />
          </div>
          <span aria-hidden className="absolute -bottom-0.5 -top-0.5 w-px bg-ink/25" style={{ left: '80%' }} />
        </div>
        <p className="mt-1.5 flex items-center gap-1 text-[11px] text-muted">
          {warn && <Warning size={11} className="shrink-0 text-warning" weight="fill" />}
          寄存文件保留 {storage.retention_days} 天,到期自动清理
        </p>
      </div>
    )
  }

  return (
    <div className="border-t border-line px-3.5 py-2.5">
      <button
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="flex w-full items-center gap-1.5 rounded text-left"
      >
        <HardDrives size={13} className="shrink-0 text-muted" />
        <span className="flex-1 text-[12px] font-medium text-muted">寄存空间</span>
        <span className={`num text-[11px] ${warn ? 'text-warning' : 'text-muted'}`}>{percent}%</span>
        <CaretDown
          size={11}
          className={`shrink-0 text-muted transition-transform duration-200 ${expanded ? 'rotate-180' : ''}`}
        />
      </button>

      <div className="relative mt-2">
        <div className="h-1 overflow-hidden rounded-full bg-surface-2">
          <div
            className={`h-full rounded-full transition-[width] duration-300 ${warn ? 'bg-warning' : 'bg-primary'}`}
            style={{ width: `${Math.min(100, Math.max(1.5, ratio * 100))}%` }}
          />
        </div>
        {/* 80% 告警阈值刻度 */}
        <span aria-hidden className="absolute -bottom-0.5 -top-0.5 w-px bg-ink/25" style={{ left: '80%' }} />
      </div>

      {/* 展开详情:grid-rows 过渡,收起时不占布局 */}
      <div
        className={`grid transition-[grid-template-rows] duration-200 ease-out ${
          expanded ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'
        }`}
      >
        <div className="overflow-hidden">
          <dl className="flex flex-col gap-1.5 pb-1 pt-3 text-[11.5px] leading-snug">
            <div className="flex items-baseline justify-between gap-3">
              <dt className="shrink-0 text-muted">已用 / 上限</dt>
              <dd className="num text-right">
                {formatBytes(storage.used_bytes)} / {formatBytes(storage.max_total_bytes)}
              </dd>
            </div>
            <div className="flex items-baseline justify-between gap-3">
              <dt className="shrink-0 text-muted">保留期限</dt>
              <dd className="text-right">寄存文件保留 {storage.retention_days} 天</dd>
            </div>
            <div className="flex items-baseline justify-between gap-3">
              <dt className="shrink-0 text-muted">超出上限</dt>
              <dd className="text-right">从最早上传的文件开始清理</dd>
            </div>
          </dl>
        </div>
      </div>

      {!expanded && (
        <p className="mt-1.5 flex items-center gap-1 text-[11px] text-muted">
          {warn && <Warning size={11} className="shrink-0 text-warning" weight="fill" />}
          保留 {storage.retention_days} 天,到期自动清理
        </p>
      )}
    </div>
  )
}
