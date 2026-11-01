import { useEffect, useRef } from 'react'
import { httpsCallable } from 'firebase/functions'
import { functions } from './posFirebase'
import { pushToast, shopeeSounds } from './opsStore'
import { useShipAlarm } from './ShipAlarm'

type WatchOrder = { orderId: string; buyer: string; shipBy: number }

const POLL_MS = 60000
const SEEN_KEY = 'tiktokSeenOrders'

function loadSeen() {
  try {
    const raw = localStorage.getItem(SEEN_KEY)
    return raw === null ? null : new Set<string>(JSON.parse(raw) as string[])
  } catch {
    return null
  }
}

// Memantau pesanan TikTok yang perlu dikirim: suara pesanan baru dan alarm 12 menit sebelum batas kirim.
export default function TiktokWatcher() {
  const seen = useRef<Set<string> | null>(loadSeen())
  const updateAlarm = useShipAlarm('tiktok')

  useEffect(() => {
    let stopped = false
    let polling = false

    async function poll() {
      if (stopped || document.visibilityState !== 'visible' || polling) return
      polling = true
      try {
        const result = await httpsCallable<unknown, { orders: WatchOrder[] }>(functions, 'tiktokOrders')({ status: 'AWAITING_SHIPMENT' })
        if (stopped) return
        const orders = result.data.orders
        const known = seen.current
        const added = known ? orders.filter((order) => !known.has(order.orderId)) : []
        const next = new Set(known ?? [])
        orders.forEach((order) => next.add(order.orderId))
        seen.current = next
        localStorage.setItem(SEEN_KEY, JSON.stringify([...next].slice(-500)))
        added.forEach((order, index) => {
          pushToast({
            icon: '🛒',
            title: 'Pesanan TikTok baru · 2goFresh',
            body: order.buyer || 'Pembeli',
            sticky: true,
            sound: index === 0 ? shopeeSounds.tiktok.order : undefined,
            store: 'tiktok',
            actions: [{ label: order.orderId, panel: 'tiktok' }],
          })
        })
        updateAlarm(orders.map((order) => ({ id: order.orderId, buyer: order.buyer, shipBy: order.shipBy })))
      } catch {
        // TikTok belum terhubung atau gangguan sementara: coba lagi pada putaran berikutnya.
      } finally {
        polling = false
      }
    }

    void poll()
    const timer = window.setInterval(() => void poll(), POLL_MS)
    const onVisible = () => {
      if (document.visibilityState === 'visible') void poll()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      stopped = true
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [updateAlarm])

  return null
}
