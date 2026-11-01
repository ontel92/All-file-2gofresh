import { useCallback, useEffect, useRef } from 'react'
import { SHIP_ALARM_REPEAT_MS, SHIP_ALARM_WINDOW_MS, getOps, playSound, setOps, shopeeSounds, stopSound } from './opsStore'
import type { AlertStoreId, UrgentOrder } from './opsStore'

function setAlerts(store: AlertStoreId, orders: UrgentOrder[]) {
  setOps({ shipAlerts: { ...getOps().shipAlerts, [store]: orders } })
}

// Menutup pop-up hanya mematikan suara saat ini; alarm kembali berbunyi dan pop-up muncul lagi
// tiap 2 menit selama pesanan masih belum dikirim.
export function dismissShipAlert(store: AlertStoreId) {
  stopSound(shopeeSounds[store].alarm)
  setAlerts(store, [])
}

export function useShipAlarm(store: AlertStoreId) {
  const orders = useRef<UrgentOrder[]>([])
  const lastAlarm = useRef(0)

  const evaluate = useCallback(() => {
    const now = Date.now()
    const urgent = orders.current.filter((order) => order.shipBy > 0 && order.shipBy - now <= SHIP_ALARM_WINDOW_MS)
    if (urgent.length === 0) {
      if (lastAlarm.current !== 0 || (getOps().shipAlerts[store]?.length ?? 0) > 0) {
        lastAlarm.current = 0
        dismissShipAlert(store)
      }
      return
    }
    if (now - lastAlarm.current >= SHIP_ALARM_REPEAT_MS) {
      lastAlarm.current = now
      playSound(shopeeSounds[store].alarm)
      setAlerts(store, urgent)
    } else if ((getOps().shipAlerts[store]?.length ?? 0) > 0) {
      setAlerts(store, urgent)
    }
  }, [store])

  useEffect(() => {
    const timer = window.setInterval(evaluate, 15000)
    return () => {
      window.clearInterval(timer)
      dismissShipAlert(store)
    }
  }, [evaluate, store])

  return useCallback((next: UrgentOrder[]) => {
    orders.current = next
    evaluate()
  }, [evaluate])
}
