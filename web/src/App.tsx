import { useEffect } from 'react'
import { useHub } from './store/hub'
import { useMediaQuery } from './hooks/ui'
import { Sidebar } from './components/Sidebar'
import { ChatPane } from './components/ChatPane'
import { RegisterScreen } from './components/RegisterScreen'
import { Lightbox } from './components/messages'
import { Toasts } from './components/ui'

export default function App() {
  const me = useHub((s) => s.me)
  const boot = useHub((s) => s.boot)
  const activeConv = useHub((s) => s.activeConv)
  const setActiveConv = useHub((s) => s.setActiveConv)
  const isDesktop = useMediaQuery('(min-width: 1024px)')

  useEffect(
    function initialBoot() {
      boot()
    },
    [boot],
  )

  // 桌面端始终有活动会话
  useEffect(
    function defaultToLobby() {
      if (me && isDesktop && !activeConv) setActiveConv('lobby')
    },
    [me, isDesktop, activeConv, setActiveConv],
  )

  if (!me) return <RegisterScreen />

  return (
    <>
      {isDesktop ? (
        <div className="grid h-full min-h-0 grid-cols-[280px_minmax(0,1fr)]">
          <aside className="min-h-0 border-r border-line">
            <Sidebar />
          </aside>
          <ChatPane />
        </div>
      ) : activeConv ? (
        <ChatPane mobile onBack={() => setActiveConv(null)} />
      ) : (
        <div className="h-full min-h-0">
          <Sidebar mobile />
        </div>
      )}
      <Toasts />
      <Lightbox />
    </>
  )
}
