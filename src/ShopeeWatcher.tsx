import { useEffect, useRef, useState } from 'react'
import { httpsCallable } from 'firebase/functions'
import { functions } from './posFirebase'
import { playSound, pushToast, setOps } from './opsStore'

type WatchOrder = { orderSn: string; buyer: string; shipBy: number }
type WatchChat = { id: string; buyer: string; last: string; unread: number; fromBuyer: boolean; latestId: string; lastAt: number }
const CHAT_CURSOR_KEY = 'shopeeChatCursorV2'
const UNANSWERED_DAYS = 7

const POLL_MS = 120000
const ALARM_WINDOW_MS = 12 * 60 * 1000
const ALARM_REPEAT_MS = 2 * 60 * 1000
const SEEN_KEY = 'shopeeSeenOrders'
const CHAT_POLL_MS = 60000

function loadSeen() {
  try {
    const raw = localStorage.getItem(SEEN_KEY)
    return raw === null ? null : new Set<string>(JSON.parse(raw) as string[])
  } catch {
    return null
  }
}

function loadChatCursor(): Record<string, string> | null {
  try {
    const raw = localStorage.getItem(CHAT_CURSOR_KEY)
    return raw ? (JSON.parse(raw) as Record<string, string>) : null
  } catch {
    return null
  }
}

// Polls Shopee for orders that still need shipping: plays order_masuk.mp3 for new orders
// and loud_alarm.mp3 when an order is within 12 minutes of its ship-by deadline.
export default function ShopeeWatcher() {
  const [urgent, setUrgent] = useState<WatchOrder[]>([])
  const seen = useRef<Set<string> | null>(loadSeen())
  const lastAlarm = useRef<Record<string, number>>({})
  useEffect(() => {
    let stopped = false
    let polling = false

    async function poll() {
      if (stopped || document.visibilityState !== 'visible' || polling) return
      polling = true
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
        setOps({ shopeeToShip: orders.length })
        if (added.length > 0) {
          playSound('/order_masuk.mp3')
          for (const order of added) {
            pushToast({ icon: '🛒', title: 'Pesanan Shopee baru', body: order.buyer || 'Pembeli', sticky: true, actions: [{ label: order.orderSn, panel: 'marketplace', orderSn: order.orderSn }] })
          }
        }

        const now = Date.now()
        const close = orders.filter((order) => order.shipBy > 0 && order.shipBy - now <= ALARM_WINDOW_MS)
        setUrgent(close)
        const due = close.some((order) => now - (lastAlarm.current[order.orderSn] ?? 0) >= ALARM_REPEAT_MS)
        if (due) {
          close.forEach((order) => {
            lastAlarm.current[order.orderSn] = now
          })
          playSound('/loud_alarm.mp3')
        }
      } catch {
        // Shopee not connected or temporary failure: stay silent and retry on the next tick.
      } finally {
        polling = false
      }
    }

    void poll()
    const timer = window.setInterval(() => void poll(), POLL_MS)
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') void poll()
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      stopped = true
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [])

  useEffect(() => {
    let stopped = false
    let polling = false
    let cursor = loadChatCursor()

    async function pollChats() {
      if (stopped || document.visibilityState !== 'visible' || polling) return
      polling = true
      try {
        const result = await httpsCallable<unknown, { conversations: WatchChat[] }>(functions, 'shopeeChats')()
        if (stopped) return
        const chats = result.data.conversations
        const since = Date.now() - UNANSWERED_DAYS * 86400000
        const waiting = chats.filter((chat) => (chat.fromBuyer || chat.unread > 0) && chat.lastAt >= since)
        setOps({ shopeeUnreadChats: waiting.length })

        const isFirstSnapshot = cursor === null
        const incoming = isFirstSnapshot
          ? []
          : chats.filter(
              (chat) =>
                chat.fromBuyer &&
                chat.latestId &&
                chat.lastAt >= since &&
                cursor?.[chat.id] !== chat.latestId,
            )
        const nextCursor = { ...(cursor ?? {}) }
        for (const chat of chats) {
          if (chat.id && chat.latestId) nextCursor[chat.id] = chat.latestId
        }
        cursor = Object.fromEntries(Object.entries(nextCursor).slice(-500))
        try {
          localStorage.setItem(CHAT_CURSOR_KEY, JSON.stringify(cursor))
        } catch {
          // Notifications still work for this tab if browser storage is unavailable.
        }

        if (incoming.length > 0) {
          playSound('/chatmasuk.mp3')
          for (const chat of incoming.slice(0, 4)) {
            pushToast({ icon: '💬', title: `Chat Shopee: ${chat.buyer || 'Pembeli'}`, body: chat.last, sticky: false, actions: [{ label: 'Buka chat', panel: 'chat' }] })
          }
          if (incoming.length > 4) pushToast({ icon: '💬', title: `+${incoming.length - 4} chat Shopee lain belum dibalas`, body: '', sticky: false, actions: [{ label: 'Buka chat', panel: 'chat' }] })
        }
      } catch {
        // Not connected or temporary failure.
      } finally {
        polling = false
      }
    }

    void pollChats()
    const timer = window.setInterval(() => void pollChats(), CHAT_POLL_MS)
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') void pollChats()
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      stopped = true
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [])

  if (urgent.length === 0) return null

  return (
    <div className="sp-watch" role="alert">
      {urgent.length > 0 && (
        <div className="sp-watch-urgent">
          <b>⏰ {urgent.length} pesanan Shopee hampir melewati batas kirim!</b>
          <span>{urgent.map((order) => order.orderSn).join(', ')}</span>
          <button type="button" onClick={() => setUrgent([])}>Tutup</button>
        </div>
      )}

    </div>
  )
}
