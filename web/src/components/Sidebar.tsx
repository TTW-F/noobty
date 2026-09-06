// 侧栏:身份块、视图切换(聊天/文件)、会话列表、存储表、中枢信息
// 性能约定:每行自行订阅所需切片,父级不订阅整个 messages/lastMessages/unread 记录,
// 避免任意会话的消息变动触发整个侧栏重渲染。
import { useMemo, useState } from 'react'
import {
  Broadcast,
  Chats,
  Check,
  Copy,
  HardDrives,
  Moon,
  PencilSimple,
  Sun,
} from '@phosphor-icons/react'
import { useHub } from '../store/hub'
import { Dialog, IconButton, PresenceDot } from './ui'
import { StorageMeter } from './StorageMeter'
import { deviceIcon } from '../lib/files'
import { formatRelative } from '../lib/format'
import { useTheme } from '../hooks/ui'
import type { ConversationId, Message } from '../lib/types'

function ViewTabs() {
  const view = useHub((s) => s.view)
  const setView = useHub((s) => s.setView)
  const tabs = [
    { id: 'chats' as const, label: '聊天', icon: Chats },
    { id: 'files' as const, label: '文件', icon: HardDrives },
  ]
  return (
    <div className="flex gap-1 px-3 pb-1.5 pt-2.5" role="tablist" aria-label="视图切换">
      {tabs.map((t) => {
        const active = view === t.id
        return (
          <button
            key={t.id}
            role="tab"
            aria-selected={active}
            onClick={() => setView(t.id)}
            className={`flex h-8 flex-1 items-center justify-center gap-1.5 rounded-[9px] text-[12.5px] transition-colors duration-150 ${
              active ? 'bg-primary-soft font-medium text-primary-ink' : 'text-muted hover:bg-surface-2'
            }`}
          >
            <t.icon size={14} weight={active ? 'fill' : 'regular'} />
            {t.label}
          </button>
        )
      })}
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
  m2 = false,
  onSelect,
}: {
  conv: ConversationId
  name: string
  active: boolean
  online?: boolean
  isLobby?: boolean
  m2?: boolean
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
        <span className="block truncate text-[12px] text-muted">
          {m2 ? '当前中枢未开放 · 全员广播' : summaryText(summary)}
        </span>
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
  const setView = useHub((s) => s.setView)
  const view = useHub((s) => s.view)
  const renameDevice = useHub((s) => s.renameDevice)
  const hubVersion = useHub((s) => s.hubVersion)
  const lobbySupported = useHub((s) => s.lobbySupported)
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

      {/* 视图切换:聊天 / 文件仓库 */}
      <ViewTabs />

      {/* 会话列表(聊天视图) */}
      <nav aria-label="会话" className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        <ConversationRow
          conv="lobby"
          name="大厅"
          isLobby
          m2={lobbySupported === false}
          active={view === 'chats' && activeConv === 'lobby'}
          onSelect={() => {
            setView('chats')
            setActiveConv('lobby')
          }}
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
              active={view === 'chats' && activeConv === conv}
              onSelect={() => {
                setView('chats')
                setActiveConv(conv)
              }}
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
