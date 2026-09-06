// 下载保存路径:托盘壳可配任意盘符目录;浏览器记住默认文件夹(File System Access)。
import { useEffect, useState } from 'react'
import { FolderOpen, ArrowCounterClockwise } from '@phosphor-icons/react'
import {
  inShell,
  shellDownloadDir,
  shellPickDownloadDir,
  shellResetDownloadDir,
  type ShellDownloadDirInfo,
} from '../lib/shell'
import {
  canPickSaveDir,
  clearSaveDir,
  pickSaveDir,
  saveDirLabel,
} from '../lib/saveDir'

function shortenPath(path: string, max = 36): string {
  if (path.length <= max) return path
  const keep = Math.floor((max - 1) / 2)
  return `${path.slice(0, keep)}…${path.slice(-keep)}`
}

export function SavePathSettings() {
  const [shellInfo, setShellInfo] = useState<ShellDownloadDirInfo | null>(null)
  const [browserLabel, setBrowserLabel] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (inShell) {
      void shellDownloadDir().then(setShellInfo)
    } else {
      setBrowserLabel(saveDirLabel())
    }
  }, [])

  if (inShell) {
    const label = shellInfo?.resolved ?? '加载中…'
    return (
      <div className="border-t border-line px-3 py-2">
        <div className="flex items-start gap-2">
          <FolderOpen size={14} className="mt-0.5 shrink-0 text-muted" aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="text-[11px] text-muted">接收目录</p>
            <p className="num mt-0.5 truncate text-[11.5px] text-ink" title={shellInfo?.resolved}>
              {shortenPath(label)}
            </p>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              <button
                type="button"
                disabled={busy}
                className="rounded-md border border-line bg-surface px-2 py-0.5 text-[11px] text-ink transition-colors hover:bg-surface-2 disabled:opacity-50"
                onClick={() => {
                  setBusy(true)
                  void shellPickDownloadDir()
                    .then((info) => {
                      if (info) setShellInfo(info)
                    })
                    .finally(() => setBusy(false))
                }}
              >
                选择…
              </button>
              {shellInfo?.is_custom && (
                <button
                  type="button"
                  disabled={busy}
                  className="inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] text-muted transition-colors hover:bg-surface-2 hover:text-ink disabled:opacity-50"
                  onClick={() => {
                    setBusy(true)
                    void shellResetDownloadDir()
                      .then((info) => {
                        if (info) setShellInfo(info)
                      })
                      .finally(() => setBusy(false))
                  }}
                >
                  <ArrowCounterClockwise size={11} />
                  默认
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    )
  }

  if (!canPickSaveDir()) return null

  return (
    <div className="border-t border-line px-3 py-2">
      <div className="flex items-start gap-2">
        <FolderOpen size={14} className="mt-0.5 shrink-0 text-muted" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="text-[11px] text-muted">默认保存文件夹</p>
          <p className="mt-0.5 truncate text-[11.5px] text-ink" title={browserLabel ?? undefined}>
            {browserLabel ? browserLabel : '未设置（每次下载时选择）'}
          </p>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            <button
              type="button"
              disabled={busy}
              className="rounded-md border border-line bg-surface px-2 py-0.5 text-[11px] text-ink transition-colors hover:bg-surface-2 disabled:opacity-50"
              onClick={() => {
                setBusy(true)
                void pickSaveDir()
                  .then((name) => {
                    if (name) setBrowserLabel(name)
                  })
                  .catch(() => undefined)
                  .finally(() => setBusy(false))
              }}
            >
              选择…
            </button>
            {browserLabel && (
              <button
                type="button"
                disabled={busy}
                className="inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] text-muted transition-colors hover:bg-surface-2 hover:text-ink disabled:opacity-50"
                onClick={() => {
                  setBusy(true)
                  void clearSaveDir()
                    .then(() => setBrowserLabel(null))
                    .finally(() => setBusy(false))
                }}
              >
                <ArrowCounterClockwise size={11} />
                清除
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
