import { lazy, Suspense } from 'react'

const PosApp = lazy(() => import('./PosApp'))

function PosEntry() {
  return (
    <Suspense fallback={<main className="route-loading">Membuka ruang toko...</main>}>
      <PosApp />
    </Suspense>
  )
}

export default PosEntry
