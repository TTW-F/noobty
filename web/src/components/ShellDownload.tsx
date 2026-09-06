// 浏览器端：从中枢拉取已签名的 Windows 托盘安装包下载入口。
import { useEffect, useState } from 'react'
import { DownloadSimple } from '@phosphor-icons/react'
import { api, type ShellRelease } from '../lib/api'
import { inShell } from '../lib/shell'

export function ShellDownload({ className = '' }: { className?: string }) {
  const [release, setRelease] = useState<ShellRelease | null | undefined>(undefined)

  useEffect(() => {
    if (inShell) return
    let cancelled = false
    void api
      .shellLatest()
      .then((r) => {
        if (!cancelled) setRelease(r)
      })
      .catch(() => {
        if (!cancelled) setRelease(null)
      })
    return () => {
      cancelled = true
    }
  }, [])

  if (inShell || !release) return null

  return (
    <div className={`border-t border-line px-3 py-2 ${className}`}>
      <a
        href={release.url}
        download
        className="flex items-start gap-2 rounded-[9px] px-0.5 py-0.5 transition-colors hover:bg-surface-2"
      >
        <DownloadSimple size={14} className="mt-0.5 shrink-0 text-primary" aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="block text-[11px] text-muted">Windows 托盘客户端</span>
          <span className="mt-0.5 flex items-baseline gap-1.5 text-[11.5px] text-ink">
            <span className="font-medium">下载安装包</span>
            <span className="num text-muted">v{release.version}</span>
          </span>
          {release.notes ? (
            <span className="mt-0.5 block truncate text-[10.5px] text-muted/80" title={release.notes}>
              {release.notes}
            </span>
          ) : null}
        </span>
      </a>
    </div>
  )
}
