// 轻量 UI hooks:媒体查询、主题切换
import { useCallback, useSyncExternalStore } from 'react'

export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    function subscribe(onChange) {
      const mq = matchMedia(query)
      mq.addEventListener('change', onChange)
      return () => mq.removeEventListener('change', onChange)
    },
    () => matchMedia(query).matches,
    () => false,
  )
}

export type Theme = 'light' | 'dark'

function currentTheme(): Theme {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'
}

const themeListeners = new Set<() => void>()

export function useTheme(): [Theme, () => void] {
  const theme = useSyncExternalStore<Theme>(
    function subscribe(onChange) {
      themeListeners.add(onChange)
      return () => themeListeners.delete(onChange)
    },
    currentTheme,
    () => 'light' as Theme,
  )

  const toggle = useCallback(() => {
    const next = currentTheme() === 'dark' ? 'light' : 'dark'
    document.documentElement.dataset.theme = next
    try {
      localStorage.setItem('noobty.theme', next)
    } catch {
      /* 隐私模式 */
    }
    for (const fn of themeListeners) fn()
  }, [])

  return [theme, toggle]
}
