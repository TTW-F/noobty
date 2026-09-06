import { useEffect } from 'react'
import { useHub } from './store/hub'
import { useMediaQuery } from './hooks/ui'
import { Sidebar } from './components/Sidebar'
import { ChatPane } from './components/ChatPane'
import { FileLibrary } from './components/FileLibrary'
import { RegisterScreen } from './components/RegisterScreen'
import { Lightbox } from './components/messages'
import { Toasts } from './components/ui'

export default function App() {
  const me = useHub((s) => s.me)
  const boot = useHub((s) => s.boot)
  const activeConv = useHub((s) => s.activeConv)
  const activeConvIsAuto = useHub((s) => s.activeConvIsAuto)
  const autoSelectConv = useHub((s) => s.autoSelectConv)
  const setActiveConv = useHub((s) => s.setActiveConv)
  const setView = useHub((s) => s.setView)
  const view = useHub((s) => s.view)
  const devices = useHub((s) => s.devices)
  const lobbySupported = useHub((s) => s.lobbySupported)
  const isDesktop = useMediaQuery('(min-width: 1024px)')

  useEffect(
    function initialBoot() {
      boot()
    },
    [boot],
  )

  // 桌面端代选默认会话:优先一台在线设备;没有在线设备时停在大厅。
  // 仅在"当前会话是代选的"时纠正——用户手动选择后绝不抢夺。
  useEffect(
    function defaultConversation() {
      if (!me || !isDesktop) return
      if (!activeConvIsAuto && activeConv) return
      const others = devices.filter((d) => d.device_id !== me.device_id)
      const online = others.find((d) => d.online)
      const target = online
        ? `private:${online.device_id}`
        : activeConv && lobbySupported !== true
          ? activeConv // 没有在线设备:维持现状(大厅或 M2 解释页),等设备上线再切
          : (activeConv ?? 'lobby')
      autoSelectConv(target)
    },
    [me, isDesktop, activeConv, activeConvIsAuto, devices, lobbySupported, autoSelectConv],
  )

  if (!me) return <RegisterScreen />

  return (
    <>
      {isDesktop ? (
        <div className="grid h-full min-h-0 grid-cols-[280px_minmax(0,1fr)]">
          <aside className="min-h-0 border-r border-line">
            <Sidebar />
          </aside>
          {view === 'files' ? <FileLibrary /> : <ChatPane />}
        </div>
      ) : view === 'files' ? (
        <FileLibrary mobile onBack={() => setView('chats')} />
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
