// 侧栏:身份块、会话列表(大厅 + 设备)、存储面板、中枢信息
// 性能约定:每行自行订阅所需切片,父级不订阅整个 messages/lastMessages/unread 记录,
// 避免任意会话的消息变动触发整个侧栏重渲染。
import { useMemo, useState } from 'react'
import {
  Broadcast,
  CaretDown,
  Check,
  Copy,
  HardDrives,
  Moon,
  PencilSimple,
  Sun,
  Warning,
} from '@phosphor-icons/react'
import { useHub } from '../store/hub'
import { Dialog, IconButton, PresenceDot } from './ui'
import { deviceIcon } from '../lib/files'
import { formatBytes, formatRelative } from '../lib/format'
import { useTheme } from '../hooks/ui'
import type { ConversationId, Message } from '../lib/types'

// ---------- 存储面板 ----------

const WARN_RATIO = 0.8

function StorageMeter() {
  const storage = useHub((s) => s.storage)
  const [expanded, setExpanded] = useState(false)
  if (!storage || storage.max_total_bytes <= 0) return null

  const ratio = storage.used_bytes / storage.max_total_bytes
  const warn = ratio >= WARN_RATIO
  const percent = Math.round(ratio * 100)

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
              <dt className="shrink-0 text-muted">容量告警</dt>
              <dd className="text-right">达到上限后,从最早上传的文件开始清理</dd>
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

// ---------- 会话行 ----------

interface ConvSummary {
  kind: 'text' | 'file' | 'file_group' | undefined
  text?: string
  files: number
  at?: string
}

function summarize(list: Message[] | undefined, fallback: Message | undefined): ConvSummary {
  const m = list && list.length > 0 ? list[list.length - 1] : fallback
  if (!m) return { kind: undefined, files: 0 }
  return {
    kind: m.kind,
    text: m.text,
    files: m.kind === 'file_group' ? (m.files?.length ?? 0) : m.kind === 'file' ? 1 : 0,
    at: m.created_at,
  }
}

function summaryText(s: ConvSummary): string {
  if (s.kind === 'file') return '[文件]'
  if (s.kind === 'file_group') return `[${s.files} 个文件]`
  return s.text ?? ''
}

function ConversationRow({
  conv,
  name,
  active,
  online,
  isLobby,
  onSelect,
}: {
  conv: ConversationId
  name: string
  active: boolean
  online?: boolean
  isLobby?: boolean
  onSelect: () => void
}) {
  const local = useHub((s) => s.messages[conv])
  const summaryMsg = useHub((s) => s.lastMessages[conv])
  const unread = useHub((s) => s.unread[conv] ?? 0)
  const summary = useMemo(() => summarize(local, summaryMsg), [local, summaryMsg])
  const Icon = isLobby ? Broadcast : deviceIcon(name)

  return (
    <button
      onClick={onSelect}
      data-conv={conv}
      className={`flex w-full items-center gap-3 rounded-[10px] px-2.5 py-2 text-left transition-colors duration-150 ${
        active ? 'bg-primary-soft' : 'hover:bg-surface-2'
      }`}
    >
      <span
        className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] text-[16px] ${
          active ? 'bg-primary text-on-primary' : 'bg-surface-2 text-muted'
        }`}
      >
        <Icon size={isLobby ? 18 : 17} weight={isLobby ? 'fill' : 'regular'} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          {online !== undefined && <PresenceDot online={online} />}
          <span className="truncate text-[13.5px] font-medium">{name}</span>
          <span className="num ml-auto shrink-0 pl-1 text-[11px] text-muted">
            {summary.at ? formatRelative(summary.at) : ''}
          </span>
        </span>
        <span className="block truncate text-[12px] text-muted">{summaryText(summary)}</span>
      </span>
      {unread > 0 && (
        <span className="num flex h-[18px] min-w-[18px] shrink-0 items-center justify-center rounded-full bg-primary px-1 text-[10.5px] font-semibold text-on-primary">
          {unread > 99 ? '99+' : unread}
        </span>
      )}
    </button>
  )
}

// ---------- 侧栏 ----------

export function Sidebar({ mobile = false }: { mobile?: boolean }) {
  const me = useHub((s) => s.me)
  const devices = useHub((s) => s.devices)
  const activeConv = useHub((s) => s.activeConv)
  const setActiveConv = useHub((s) => s.setActiveConv)
  const renameDevice = useHub((s) => s.renameDevice)
  const hubVersion = useHub((s) => s.hubVersion)
  const [theme, toggleTheme] = useTheme()
  const [copied, setCopied] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [draftName, setDraftName] = useState('')

  const others = devices.filter((d) => d.device_id !== me?.device_id)
  // 在线优先,其余按名字
  const sorted = [...others].sort(
    (a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name, 'zh'),
  )

  const copyHubAddress = async () => {
    try {
      await navigator.clipboard.writeText(location.host)
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    } catch {
      /* 剪贴板不可用 */
    }
  }

  const submitRename = async () => {
    const name = draftName.trim()
    if (!name) return
    try {
      await renameDevice(name)
      setRenaming(false)
    } catch {
      /* 失败时保留输入 */
    }
  }

  return (
    <div className={`flex h-full min-h-0 flex-col ${mobile ? 'bg-bg' : 'bg-surface'}`}>
      {/* 身份块 */}
      <div className="flex items-center gap-2.5 border-b border-line px-3.5 py-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] bg-primary text-on-primary">
          <span className="text-[15px] font-semibold">{me?.name?.slice(0, 1) ?? '?'}</span>
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[14px] font-semibold">{me?.name}</span>
          <span className="block text-[11.5px] text-muted">这台设备</span>
        </span>
        <IconButton
          label="重命名这台设备"
          className="h-8 w-8"
          onClick={() => {
            setDraftName(me?.name ?? '')
            setRenaming(true)
          }}
        >
          <PencilSimple size={15} />
        </IconButton>
      </div>

      {/* 会话列表 */}
      <nav aria-label="会话" className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        <ConversationRow
          conv="lobby"
          name="大厅"
          isLobby
          active={activeConv === 'lobby'}
          onSelect={() => setActiveConv('lobby')}
        />
        {sorted.length > 0 && <div className="mx-2.5 my-2 border-t border-line" />}
        {sorted.map((d) => {
          const conv = `private:${d.device_id}`
          return (
            <ConversationRow
              key={d.device_id}
              conv={conv}
              name={d.name}
              online={d.online}
              active={activeConv === conv}
              onSelect={() => setActiveConv(conv)}
            />
          )
        })}
        {sorted.length === 0 && (
          <p className="px-3 py-4 text-[12.5px] leading-relaxed text-muted">
            还没有其他设备。在局域网内的手机或电脑打开这个地址,就能出现在这里。
          </p>
        )}
      </nav>

      {/* 存储面板 */}
      <StorageMeter />

      {/* 底部:中枢信息 */}
      <div className="flex items-center gap-1 border-t border-line px-3 py-2.5">
        <span className="num min-w-0 flex-1 truncate text-[11.5px] text-muted" title={`http://${location.host}`}>
          {location.host}
        </span>
        <IconButton label="复制中枢地址" className="h-7 w-7" onClick={() => void copyHubAddress()}>
          {copied ? <Check size={14} className="text-primary" weight="bold" /> : <Copy size={14} />}
        </IconButton>
        <IconButton
          label={theme === 'dark' ? '切换到亮色' : '切换到暗色'}
          className="h-7 w-7"
          onClick={toggleTheme}
        >
          {theme === 'dark' ? <Sun size={14} /> : <Moon size={14} />}
        </IconButton>
      </div>
      {hubVersion && !mobile && (
        <div className="px-3.5 pb-2 text-right">
          <span className="num text-[10.5px] text-muted/70">hub v{hubVersion}</span>
        </div>
      )}

      {/* 重命名对话框 */}
      <Dialog open={renaming} onClose={() => setRenaming(false)} title="重命名这台设备">
        <input
          autoFocus
          value={draftName}
          onChange={(e) => setDraftName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void submitRename()
          }}
          maxLength={32}
          className="h-10 w-full rounded-[10px] border border-line bg-bg px-3 text-[14px] outline-none focus:border-primary"
        />
        <div className="mt-4 flex justify-end gap-2">
          <button
            onClick={() => setRenaming(false)}
            className="h-9 rounded-[10px] px-3.5 text-[13px] font-medium text-ink hover:bg-surface-2"
          >
            取消
          </button>
          <button
            onClick={() => void submitRename()}
            disabled={!draftName.trim()}
            className="h-9 rounded-[10px] bg-primary px-3.5 text-[13px] font-medium text-on-primary hover:opacity-90 disabled:opacity-50"
          >
            保存
          </button>
        </div>
      </Dialog>
    </div>
  )
}
