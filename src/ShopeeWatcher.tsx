import { useEffect, useRef, useState } from 'react'
import { httpsCallable } from 'firebase/functions'
import { functions } from './posFirebase'

type WatchOrder = { orderSn: string; buyer: string; shipBy: number }

const POLL_MS = 30000
const ALARM_WINDOW_MS = 12 * 60 * 1000
const ALARM_REPEAT_MS = 2 * 60 * 1000
const SEEN_KEY = 'shopeeSeenOrders'

function loadSeen() {
  try {
    const raw = localStorage.getItem(SEEN_KEY)
    return raw === null ? null : new Set<string>(JSON.parse(raw) as string[])
  } catch {
    return null
  }
}

// Polls Shopee for orders that still need shipping: plays order_masuk.mp3 for new orders
// and loud_alarm.mp3 when an order is within 12 minutes of its ship-by deadline.
export default function ShopeeWatcher() {
  const [urgent, setUrgent] = useState<WatchOrder[]>([])
  const [fresh, setFresh] = useState<WatchOrder[]>([])
  const seen = useRef<Set<string> | null>(loadSeen())
  const lastAlarm = useRef<Record<string, number>>({})
  const newSound = useRef<HTMLAudioElement | null>(null)
  const alarmSound = useRef<HTMLAudioElement | null>(null)

  useEffect(() => {
    newSound.current = new Audio('/order_masuk.mp3')
    alarmSound.current = new Audio('/loud_alarm.mp3')
    const unlock = () => {
      for (const audio of [newSound.current, alarmSound.current]) {
        if (!audio) continue
        audio.muted = true
        void audio.play().then(() => {
          audio.pause()
          audio.currentTime = 0
          audio.muted = false
        }).catch(() => {
          audio.muted = false
        })
      }
      window.removeEventListener('pointerdown', unlock)
    }
    window.addEventListener('pointerdown', unlock)
    return () => window.removeEventListener('pointerdown', unlock)
  }, [])

  useEffect(() => {
    let stopped = false

    async function poll() {
      try {
        const result = await httpsCallable<unknown, { orders: WatchOrder[] }>(functions, 'shopeeOrders')({ status: 'READY_TO_SHIP', cursor: '' })
        if (stopped) return
        const orders = result.data.orders
        const known = seen.current
        const added = known ? orders.filter((order) => !known.has(order.orderSn)) : []
        const next = new Set(known ?? [])
        orders.forEach((order) => next.add(order.orderSn))
        seen.current = next
        localStorage.setItem(SEEN_KEY, JSON.stringify([...next].slice(-500)))
        if (added.length > 0) {
          setFresh(added)
          void newSound.current?.play().catch(() => undefined)
        }

        const now = Date.now()
        const close = orders.filter((order) => order.shipBy > 0 && order.shipBy - now <= ALARM_WINDOW_MS)
        setUrgent(close)
        const due = close.some((order) => now - (lastAlarm.current[order.orderSn] ?? 0) >= ALARM_REPEAT_MS)
        if (due) {
          close.forEach((order) => {
            lastAlarm.current[order.orderSn] = now
          })
          void alarmSound.current?.play().catch(() => undefined)
        }
      } catch {
        // Shopee not connected or temporary failure: stay silent and retry on the next tick.
      }
    }

    void poll()
    const timer = window.setInterval(() => void poll(), POLL_MS)
    return () => {
      stopped = true
      window.clearInterval(timer)
    }
  }, [])

  if (urgent.length === 0 && fresh.length === 0) return null

  return (
    <div className="sp-watch" role="alert">
      {urgent.length > 0 && (
        <div className="sp-watch-urgent">
          <b>⏰ {urgent.length} pesanan Shopee hampir melewati batas kirim!</b>
          <span>{urgent.map((order) => order.orderSn).join(', ')}</span>
          <button type="button" onClick={() => setUrgent([])}>Tutup</button>
        </div>
      )}
      {fresh.length > 0 && (
        <div className="sp-watch-new">
          <b>🛒 Pesanan Shopee baru: {fresh.map((order) => order.buyer || order.orderSn).join(', ')}</b>
          <button type="button" onClick={() => setFresh([])}>OK</button>
        </div>
      )}
    </div>
  )
}
