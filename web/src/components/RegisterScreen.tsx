// 首次使用的引导屏:给这台设备起个名字
import { useEffect, useState, type FormEvent } from 'react'
import { CircleNotch, DownloadSimple } from '@phosphor-icons/react'
import { api, type ShellRelease } from '../lib/api'
import { inShell } from '../lib/shell'
import { useHub } from '../store/hub'

export function RegisterScreen() {
  const register = useHub((s) => s.register)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [shell, setShell] = useState<ShellRelease | null>(null)

  useEffect(() => {
    if (inShell) return
    void api.shellLatest().then(setShell).catch(() => setShell(null))
  }, [])

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const value = name.trim()
    if (!value || busy) return
    setBusy(true)
    setError(null)
    try {
      await register(value)
    } catch (err) {
      setError(err instanceof Error ? err.message : '注册失败,请检查中枢是否可达')
      setBusy(false)
    }
  }

  return (
    <main className="flex h-full items-center justify-center bg-bg px-4">
      <div className="anim-rise w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center text-center">
          <svg viewBox="0 0 48 48" className="mb-3 h-14 w-14" aria-hidden>
            <rect width="48" height="48" rx="11" fill="var(--primary)" />
            <g stroke="var(--on-primary)" strokeWidth="2.6" fill="none" strokeLinecap="round">
              <path d="M13 24h8M27 24h8" />
            </g>
            <circle cx="10.5" cy="24" r="3.4" fill="var(--on-primary)" />
            <circle cx="37.5" cy="24" r="3.4" fill="var(--on-primary)" />
            <rect x="21.5" y="19.5" width="9" height="9" rx="2.4" fill="var(--on-primary)" />
          </svg>
          <h1 className="text-[20px] font-semibold">欢迎使用 Noobty</h1>
          <p className="mt-1.5 text-[13.5px] leading-relaxed text-muted">
            局域网内的传输中枢,设备之间以聊天的方式互发文字与文件。
          </p>
        </div>

        <form onSubmit={submit} noValidate>
          <label htmlFor="device-name" className="mb-1.5 block text-[13px] font-medium">
            给这台设备起个名字
          </label>
          <input
            id="device-name"
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={32}
            placeholder="例如：客厅笔记本"
            className={`h-11 w-full rounded-[10px] border bg-bg px-3 text-[14.5px] outline-none transition-colors placeholder:text-muted/70 focus:border-primary ${
              error ? 'border-danger' : 'border-line'
            }`}
          />
          {error ? (
            <p className="mt-1.5 text-[12px] text-danger">{error}</p>
          ) : (
            <p className="mt-1.5 text-[12px] text-muted">它会出现在其他设备的联系人列表里。</p>
          )}
          <button
            type="submit"
            disabled={!name.trim() || busy}
            className="mt-4 flex h-11 w-full items-center justify-center gap-2 rounded-[10px] bg-primary text-[14px] font-medium text-on-primary transition-[opacity,transform] hover:opacity-90 active:scale-[0.99] disabled:opacity-40"
          >
            {busy && (
              <span className="inline-flex animate-spin">
                <CircleNotch size={16} weight="bold" />
              </span>
            )}
            进入
          </button>
        </form>

        {shell && (
          <a
            href={shell.url}
            download
            className="mt-5 flex items-center justify-center gap-2 rounded-[10px] border border-line bg-surface px-3 py-2.5 text-[12.5px] text-ink transition-colors hover:bg-surface-2"
          >
            <DownloadSimple size={15} className="text-primary" aria-hidden />
            <span>
              下载 Windows 托盘客户端
              <span className="num ml-1.5 text-muted">v{shell.version}</span>
            </span>
          </a>
        )}

        <p className="num mt-6 text-center text-[11.5px] text-muted/80">中枢 {location.host}</p>
      </div>
    </main>
  )
}
