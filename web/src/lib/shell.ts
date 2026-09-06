// 托盘壳桥接:web UI 在 Tauri 壳内运行时,获得通知、自动接收等原生能力。
// 全部能力以 inShell 为前提,浏览器入口零影响。
//
// 与壳的约定(见 shell/src-tauri/src/lib.rs):
// - invoke('hub_url' | 'set_hub_url' | 'auto_accept' | 'download_dir' | 'set_download_dir' |
//          'pick_download_dir' | 'download_to' | 'notify' | 'open_hub')
// - 壳窗口 disable_drag_drop_handler,系统文件拖拽以原生 HTML5 DnD 直达网页

import type { FileRef } from './types'

export const inShell: boolean =
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

interface TauriGlobals {
  core: {
    invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>
    Channel?: new <T>(opts: { onMessage: (msg: T) => void }) => unknown
  }
}

function tauri(): TauriGlobals | null {
  if (!inShell) return null
  return (window as unknown as { __TAURI__: TauriGlobals }).__TAURI__ ?? null
}

/** 系统通知(壳内)。权限被拒时静默失败——通知是增强,不是依赖。 */
export async function shellNotify(title: string, body: string): Promise<void> {
  const t = tauri()
  if (!t) return
  try {
    await t.core.invoke('notify', { title, body })
  } catch {
    /* 通知失败不惊扰用户 */
  }
}

export interface ShellDownloadProgress {
  received: number
  total: number
}

export interface ShellDownloadDirInfo {
  configured: string
  resolved: string
  is_custom: boolean
}

/** 查询壳的接收目录配置 */
export async function shellDownloadDir(): Promise<ShellDownloadDirInfo | null> {
  const t = tauri()
  if (!t) return null
  try {
    return (await t.core.invoke('download_dir')) as ShellDownloadDirInfo
  } catch {
    return null
  }
}

/** 弹出系统文件夹选择并持久化 */
export async function shellPickDownloadDir(): Promise<ShellDownloadDirInfo | null> {
  const t = tauri()
  if (!t) return null
  try {
    return (await t.core.invoke('pick_download_dir')) as ShellDownloadDirInfo
  } catch (err) {
    console.error('[shell] pick_download_dir failed', err)
    return null
  }
}

/** 清空自定义路径 → 恢复「下载/Noobty」 */
export async function shellResetDownloadDir(): Promise<ShellDownloadDirInfo | null> {
  const t = tauri()
  if (!t) return null
  try {
    return (await t.core.invoke('set_download_dir', { path: '' })) as ShellDownloadDirInfo
  } catch (err) {
    console.error('[shell] set_download_dir failed', err)
    return null
  }
}

/** 流式下载到壳配置的接收目录,返回落盘路径 */
export async function shellDownloadToDownloads(
  file: FileRef,
  onProgress?: (p: ShellDownloadProgress) => void,
): Promise<string | null> {
  const t = tauri()
  if (!t) return null
  const { invoke, Channel } = t.core
  const origin = typeof window !== 'undefined' ? window.location.origin : ''
  const args: Record<string, unknown> = {
    url: `${origin}/api/files/${encodeURIComponent(file.file_id)}`,
    name: file.name,
  }
  // Channel 可选;不传时 Rust 端静默落盘(自动接收路径)
  if (typeof Channel === 'function') {
    args.onProgress = new Channel<ShellDownloadProgress>({
      onMessage: onProgress ?? (() => undefined),
    })
  }
  try {
    const path = await invoke('download_to', args)
    return typeof path === 'string' ? path : null
  } catch (err) {
    console.error('[shell] download_to failed', err)
    return null
  }
}

/** 壳内是否开启自动接收(托盘菜单可切换) */
export async function shellAutoAcceptEnabled(): Promise<boolean> {
  const t = tauri()
  if (!t) return false
  try {
    return (await t.core.invoke('auto_accept')) === true
  } catch {
    return false
  }
}

/** 收到新消息时的壳内增强:系统通知 + (文件消息)自动接收。
 * `notify` 为 false 时仍可自动落盘(用户正看着该会话时不弹打扰通知)。 */
export async function onIncomingMessage(
  info: {
    senderName: string
    kind: 'text' | 'file' | 'file_group'
    text?: string
    file?: FileRef
    files?: FileRef[]
  },
  opts: { notify?: boolean } = {},
): Promise<void> {
  if (!inShell) return
  const notify = opts.notify !== false

  if (info.kind === 'text') {
    if (notify) void shellNotify(`来自 ${info.senderName}`, (info.text ?? '').slice(0, 120))
    return
  }

  const files = info.kind === 'file' ? (info.file ? [info.file] : []) : (info.files ?? [])
  if (files.length === 0) return
  const preview = files.length === 1 ? files[0]!.name : `${files.length} 个文件`
  if (notify) void shellNotify(`${info.senderName} 发来文件`, preview)

  if (await shellAutoAcceptEnabled()) {
    for (const f of files) {
      const path = await shellDownloadToDownloads(f)
      if (path) {
        if (notify) void shellNotify('已自动保存', `${f.name} → ${path}`)
      } else {
        void shellNotify('自动接收失败', `${f.name}:请打开 Noobty 手动取件`)
      }
    }
  }
}
