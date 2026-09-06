// 图片灯箱状态(独立于 hub,便于 park 时释放而无循环依赖)
import { create } from 'zustand'
import type { FileRef } from './types'

interface LightboxState {
  file: FileRef | null
  /** Direct URL or blob: object URL */
  src: string | null
  open: (file: FileRef, src: string) => void
  close: () => void
}

export const useLightbox = create<LightboxState>((set, get) => ({
  file: null,
  src: null,
  open: (file, src) => {
    const prev = get().src
    if (prev?.startsWith('blob:')) URL.revokeObjectURL(prev)
    set({ file, src })
  },
  close: () => {
    const prev = get().src
    if (prev?.startsWith('blob:')) URL.revokeObjectURL(prev)
    set({ file: null, src: null })
  },
}))

/** 关窗 park 时释放灯箱解码缓冲 / blob URL */
export function closeLightbox(): void {
  useLightbox.getState().close()
}
