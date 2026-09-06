// 托盘壳桥接:web UI 在 Tauri 壳内运行时,获得通知、自动接收等原生能力。
// 全部能力以 inShell 为前提,浏览器入口零影响。
//
// 与壳的约定(见 shell/src-tauri/src/lib.rs):
// - invoke('hub_url' | 'set_hub_url' | 'auto_accept' | 'download_to')
// - 壳窗口 dragDropEnabled=false,系统文件拖拽以原生 HTML5 DnD 直达网页,无需桥接

import type { FileRef } from './types'

export const inShell: boolean =
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

interface TauriNotification {
  isPermissionGranted: () => Promise<boolean>
  requestPermission: () => Promise<unknown>
  sendNotification: (options: { title: string; body?: string }) => Promise<void>
}

interface TauriGlobals {
  core: {
    invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>
  }
  notification?: TauriNotification
}

function tauri(): TauriGlobals | null {
  if (!inShell) return null
  return (window as unknown as { __TAURI__: TauriGlobals }).__TAURI__ ?? null
}

/** 系统通知(壳内)。权限被拒时静默失败——通知是增强,不是依赖。 */
export async function shellNotify(title: string, body: string): Promise<void> {
  const t = tauri()
  const n = t?.notification
  if (!n) return
  try {
    let granted = await n.isPermissionGranted()
    if (!granted) {
      await n.requestPermission()
      granted = await n.isPermissionGranted()
    }
    if (granted) await n.sendNotification({ title, body })
  } catch {
    /* 通知失败不惊扰用户 */
  }
}

export interface ShellDownloadProgress {
  received: number
  total: number
}

/** 自动接收:由壳的 Rust 侧流式下载到 系统下载目录/Noobty,返回落盘路径 */
export async function shellDownloadToDownloads(
  file: FileRef,
  onProgress?: (p: ShellDownloadProgress) => void,
): Promise<string | null> {
  const t = tauri()
  if (!t) return null
  const { invoke, Channel } = t.core as unknown as {
    invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>
    Channel?: new <T>(opts: { onMessage: (msg: T) => void }) => unknown
  }
  const args: Record<string, unknown> = {
    url: `/api/files/${encodeURIComponent(file.file_id)}`,
    name: file.name,
  }
  // 进度通道可选:老壳或全局对象缺 Channel 时优雅降级
  if (typeof Channel === 'function' && onProgress) {
    args.onProgress = new Channel<ShellDownloadProgress>({ onMessage: onProgress })
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

/** 收到新消息时的壳内增强:系统通知 + (文件消息)自动接收 */
export async function onIncomingMessage(info: {
  senderName: string
  kind: 'text' | 'file' | 'file_group'
  text?: string
  file?: FileRef
  files?: FileRef[]
}): Promise<void> {
  if (!inShell) return

  if (info.kind === 'text') {
    void shellNotify(`来自 ${info.senderName}`, (info.text ?? '').slice(0, 120))
    return
  }

  const files = info.kind === 'file' ? (info.file ? [info.file] : []) : (info.files ?? [])
  if (files.length === 0) return
  const preview = files.length === 1 ? files[0]!.name : `${files.length} 个文件`
  void shellNotify(`${info.senderName} 发来文件`, preview)

  // 自动接收:逐个下载到 下载/Noobty,完成后补一条通知
  if (await shellAutoAcceptEnabled()) {
    for (const f of files) {
      const path = await shellDownloadToDownloads(f)
      if (path) {
        void shellNotify('已自动保存', `${f.name} → ${path}`)
      } else {
        void shellNotify('自动接收失败', `${f.name}:请打开 Noobty 手动取件`)
      }
    }
  }
}
