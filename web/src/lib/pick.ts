// 从 <input> / 拖放收集文件列表;支持文件夹(webkitdirectory / webkitGetAsEntry)。
// 目录内相对路径写入 File 的可展示名:folder/sub/a.txt(通过包装 name)。

export interface NamedFile {
  file: File
  /** 发送时用的名字(可含相对路径) */
  name: string
}

/** 给 File 一个可覆盖的显示名(浏览器 File.name 只读) */
export function withDisplayName(file: File, name: string): File {
  if (file.name === name) return file
  return new File([file], name, { type: file.type, lastModified: file.lastModified })
}

export async function filesFromDataTransfer(dt: DataTransfer): Promise<File[]> {
  const items = Array.from(dt.items ?? [])
  const entries = items
    .map((it) => (typeof it.webkitGetAsEntry === 'function' ? it.webkitGetAsEntry() : null))
    .filter((e): e is FileSystemEntry => Boolean(e))

  if (entries.length === 0) {
    return Array.from(dt.files ?? [])
  }

  const out: NamedFile[] = []
  for (const entry of entries) {
    await walkEntry(entry, '', out)
  }
  return out.map((n) => withDisplayName(n.file, n.name))
}

async function walkEntry(entry: FileSystemEntry, prefix: string, out: NamedFile[]): Promise<void> {
  if (entry.isFile) {
    const file = await new Promise<File>((resolve, reject) => {
      ;(entry as FileSystemFileEntry).file(resolve, reject)
    })
    const name = prefix ? `${prefix}/${file.name}` : file.name
    out.push({ file, name })
    return
  }
  if (entry.isDirectory) {
    const reader = (entry as FileSystemDirectoryEntry).createReader()
    const children = await readAllEntries(reader)
    const nextPrefix = prefix ? `${prefix}/${entry.name}` : entry.name
    for (const child of children) {
      await walkEntry(child, nextPrefix, out)
    }
  }
}

function readAllEntries(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  return new Promise((resolve, reject) => {
    const all: FileSystemEntry[] = []
    const pump = () => {
      reader.readEntries((batch) => {
        if (batch.length === 0) {
          resolve(all)
          return
        }
        all.push(...batch)
        pump()
      }, reject)
    }
    pump()
  })
}
