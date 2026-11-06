import { BrowserRouter, Navigate, Outlet, Route, Routes } from 'react-router-dom'
import { AuthProvider, useAuth } from './context/AuthContext'
import { ToastProvider, useToast } from './context/Toast'
import { backendConfigured } from './lib/supabase'
import { usePresence } from './hooks/usePresence'
import { Splash } from './components/ui'
import { TabBar } from './components/Nav'
import { MiniRoomBar } from './components/MiniRoomBar'
import { ActiveRoomProvider } from './context/ActiveRoom'
import { QuickSendProvider } from './context/QuickSend'
import { useEnsureHomeBelow } from './lib/nav'
import { UpdateManager } from './lib/version'
import { OfflineBanner } from './components/OfflineBanner'
import { CallManager } from './components/CallManager'
import { ConfigMissing, Login, Onboarding } from './pages/Auth'
import { AddByLink, FriendsPage } from './pages/Friends'
import { HomePage } from './pages/Home'
import { RoomPage } from './pages/Room'
import { DevicesPage } from './pages/Devices'
import { SettingsPage } from './pages/Settings'
import { SendPage } from './pages/Send'
import { DisplayPage } from './pages/Display'
import { useCallback } from 'react'

function Gate() {
  const { user, profile, authReady, profileReady } = useAuth()
  if (!authReady || !profileReady) return null
  if (!user) return <Login />
  if (!profile) return <Onboarding />
  return <Presence />
}

function Presence() {
  const { user, profile } = useAuth()
  const toast = useToast()
  const onRemoved = useCallback(() => toast('This device was removed from your account'), [toast])
  usePresence(user?.id, profile?.username, onRemoved)
  return <><CallManager /><Outlet /></>
}

function Tabs() {
  return (
    <QuickSendProvider>
      <div className="h-full overflow-y-auto"><div className="mx-auto max-w-[430px] md:max-w-[760px] lg:max-w-[1120px]"><Outlet /></div></div>
      <MiniRoomBar />
      <TabBar />
    </QuickSendProvider>
  )
}

function Shell() {
  const { authReady, profileReady } = useAuth()
  useEnsureHomeBelow() // opened on a deep link? Home goes underneath so Back lands there, not outside the app
  return (
    <>
      <Routes>
        <Route element={<Gate />}>
          <Route element={<Tabs />}>
            <Route index element={<HomePage />} />
            <Route path="friends" element={<FriendsPage />} />
            <Route path="devices" element={<DevicesPage />} />
            <Route path="settings" element={<SettingsPage />} />
          </Route>
          <Route path="r/:code" element={<RoomPage />} />
          <Route path="send/:uid" element={<SendPage />} />
          <Route path="display" element={<DisplayPage />} />
          <Route path="j/:code" element={<AddByLink />} />
          <Route path="add/:code" element={<AddByLink />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
      <OfflineBanner />
      <UpdateManager />
      <Splash ready={authReady && profileReady} />
    </>
  )
}

export default function App() {
  if (!backendConfigured) return <ConfigMissing />
  return (
    <BrowserRouter>
      <ToastProvider>
        <AuthProvider>
          <ActiveRoomProvider>
            <Shell />
          </ActiveRoomProvider>
        </AuthProvider>
      </ToastProvider>
    </BrowserRouter>
  )
}
