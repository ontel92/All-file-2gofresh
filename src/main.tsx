import { Capacitor } from '@capacitor/core'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import PosEntry from './PosEntry.tsx'
import InfoPage from './InfoPage.tsx'
import { setupPosApp } from './posPwa'

setupPosApp()

// Pada aplikasi native Android (Capacitor), selalu arahkan langsung ke POS
const isNativeApp = Capacitor.isNativePlatform()

const isPosRoute =
  isNativeApp ||
  window.location.pathname.replace(/\/+$/, '') === '/kasir' ||
  /^(www\.)?kasir\./i.test(window.location.hostname)

const isInfoRoute =
  !isNativeApp &&
  (window.location.pathname.replace(/\/+$/, '') === '/info' ||
    /^(www\.)?(info\.)?2gofresh\.info$|^info\./i.test(window.location.hostname))

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {isInfoRoute ? (
      <InfoPage />
    ) : isPosRoute ? (
      <PosEntry />
    ) : (
      <App />
    )}
  </StrictMode>,
)

