import { lazy, Suspense } from 'react'
import OfflineBanner from './OfflineBanner'
import { usePosNotificationActions } from './PosPush'
import './OfflineBanner.css'

const PosApp = lazy(() => import('./PosApp'))

function PosEntry() {
  usePosNotificationActions()

  return (
    <>
      <OfflineBanner />
      <Suspense fallback={<main className="route-loading">Membuka ruang toko...</main>}>
        <PosApp />
      </Suspense>
    </>
  )
}

export default PosEntry
