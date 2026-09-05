// 文件类型 → 图标映射(Phosphor,regular 字重)
import {
  FileArchive,
  FileAudio,
  FileCode,
  FileDoc,
  FileImage,
  FilePdf,
  FileText,
  FileVideo,
  File,
} from '@phosphor-icons/react'
import type { Icon } from '@phosphor-icons/react'

export type FileKind =
  | 'image'
  | 'archive'
  | 'audio'
  | 'video'
  | 'pdf'
  | 'doc'
  | 'code'
  | 'text'
  | 'other'

const EXT_KIND: Record<string, FileKind> = {}
const table: Array<[FileKind, string[]]> = [
  ['image', ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'svg', 'bmp', 'heic']],
  ['archive', ['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'iso']],
  ['audio', ['mp3', 'flac', 'wav', 'aac', 'ogg', 'm4a']],
  ['video', ['mp4', 'mkv', 'mov', 'avi', 'webm', 'flv']],
  ['pdf', ['pdf']],
  ['doc', ['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods']],
  ['code', ['js', 'ts', 'tsx', 'jsx', 'py', 'rs', 'go', 'java', 'c', 'cpp', 'h', 'sh', 'json', 'toml', 'yaml', 'yml', 'html', 'css']],
  ['text', ['txt', 'md', 'log', 'csv']],
]
for (const [kind, exts] of table) {
  for (const ext of exts) EXT_KIND[ext] = kind
}

export function fileKind(name: string): FileKind {
  const dot = name.lastIndexOf('.')
  if (dot < 0) return 'other'
  return EXT_KIND[name.slice(dot + 1).toLowerCase()] ?? 'other'
}

export const KIND_ICON: Record<FileKind, Icon> = {
  image: FileImage,
  archive: FileArchive,
  audio: FileAudio,
  video: FileVideo,
  pdf: FilePdf,
  doc: FileDoc,
  code: FileCode,
  text: FileText,
  other: File,
}

export function isImage(name: string): boolean {
  return fileKind(name) === 'image'
}

// 设备名 → 图标(名字里带手机/iPhone/iPad/PAD 视为移动设备)
import { DeviceMobile, Desktop } from '@phosphor-icons/react'

export function isMobileDeviceName(name: string): boolean {
  return /手机|iphone|ipad|移动|pad|phone/i.test(name)
}

export const deviceIcon = (name: string): Icon =>
  isMobileDeviceName(name) ? DeviceMobile : Desktop
