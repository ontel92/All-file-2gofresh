import { useEffect, useRef, useState } from 'react'
import { httpsCallable } from 'firebase/functions'
import { functions } from './posFirebase'
import { SHIP_ALARM_WINDOW_MS, playSound, pushToast, setOps, shopeeSounds, shopeeStoreNames, stopSound } from './opsStore'
import type { ShopeeStoreId } from './opsStore'
import { countUnreadChats, effectiveUnread } from './shopeeChatState'

type WatchOrder = { orderSn: string; buyer: string; shipBy: number }
type WatchChat = { id: string; buyer: string; last: string; unread: number; fromBuyer: boolean; latestId: string; lastAt: number }

const POLL_MS = 120000
const ALARM_REPEAT_MS = 2 * 60 * 1000
const CHAT_POLL_MS = 45000

// Kunci 2goFresh tetap seperti sebelumnya agar riwayat notifikasi lama tidak hilang.
const storageKeys = {
  '2gofresh': { seen: 'shopeeSeenOrders', chat: 'shopeeChatCursorV3' },
  freshstock: { seen: 'shopeeSeenOrders:freshstock', chat: 'shopeeChatCursorV3:freshstock' },
} as const

function loadSeen(key: string) {
  try {
    const raw = localStorage.getItem(key)
    return raw === null ? null : new Set<string>(JSON.parse(raw) as string[])
  } catch {
    return null
  }
}

function loadChatCursor(key: string): Record<string, string> | null {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as Record<string, string>) : null
  } catch {
    return null
  }
}

// Memantau pesanan yang perlu dikirim (suara pesanan baru dan alarm 10 menit sebelum batas kirim)
// serta chat yang belum dibaca menurut Shopee. Setiap toko memakai suara dan label sendiri.
export default function ShopeeWatcher({ store = '2gofresh' }: { store?: ShopeeStoreId }) {
  const [urgent, setUrgent] = useState<WatchOrder[]>([])
  const seenKey = storageKeys[store].seen
  const chatKey = storageKeys[store].chat
  const storeName = shopeeStoreNames[store]
  const sounds = shopeeSounds[store]
  const seen = useRef<Set<string> | null>(loadSeen(seenKey))
  const lastAlarm = useRef<Record<string, number>>({})
  // Pesanan yang bannernya sudah ditutup tidak membunyikan alarm lagi.
  const dismissedAlarm = useRef<Set<string>>(new Set())
  const urgentRef = useRef<WatchOrder[]>([])
  useEffect(() => {
    let stopped = false
    let polling = false
    const data = store === '2gofresh' ? {} : { store }

    async function poll() {
      if (stopped || document.visibilityState !== 'visible' || polling) return
      polling = true
      try {
        const result = await httpsCallable<unknown, { orders: WatchOrder[] }>(functions, 'shopeeOrders')({ ...data, status: 'READY_TO_SHIP', cursor: '' })
        if (stopped) return
        const orders = result.data.orders
        const known = seen.current
        const added = known ? orders.filter((order) => !known.has(order.orderSn)) : []
        const next = new Set(known ?? [])
        orders.forEach((order) => next.add(order.orderSn))
        seen.current = next
        localStorage.setItem(seenKey, JSON.stringify([...next].slice(-500)))
        setOps(store === '2gofresh' ? { shopeeToShip: orders.length } : { freshstockToShip: orders.length })
        for (const order of added) {
          pushToast({
            icon: '🛒',
            title: `Pesanan Shopee baru · ${storeName}`,
            body: order.buyer || 'Pembeli',
            sticky: true,
            sound: sounds.order,
            store,
            actions: [{ label: order.orderSn, panel: 'marketplace', orderSn: order.orderSn, store }],
          })
        }

        const now = Date.now()
        const active = new Set(orders.map((order) => order.orderSn))
        dismissedAlarm.current.forEach((orderSn) => {
          if (!active.has(orderSn)) dismissedAlarm.current.delete(orderSn)
        })
        const close = orders.filter((order) => order.shipBy > 0 && order.shipBy - now <= SHIP_ALARM_WINDOW_MS && !dismissedAlarm.current.has(order.orderSn))
        urgentRef.current = close
        setUrgent(close)
        if (close.length === 0) {
          stopSound(sounds.alarm)
        } else if (close.some((order) => now - (lastAlarm.current[order.orderSn] ?? 0) >= ALARM_REPEAT_MS)) {
          close.forEach((order) => {
            lastAlarm.current[order.orderSn] = now
          })
          playSound(sounds.alarm)
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
  }, [store, seenKey, storeName, sounds])

  useEffect(() => {
    let stopped = false
    let polling = false
    let cursor = loadChatCursor(chatKey)
    const data = store === '2gofresh' ? { unreadOnly: true } : { store, unreadOnly: true }

    async function pollChats() {
      if (stopped || document.visibilityState !== 'visible' || polling) return
      polling = true
      try {
        const result = await httpsCallable<unknown, { conversations: WatchChat[] }>(functions, 'shopeeChats')(data)
        if (stopped) return
        // Hanya yang belum dibaca menurut Shopee; chat yang sudah dibuka di Seller Center otomatis hilang dari daftar ini.
        const unreadChats = result.data.conversations.filter((chat) => effectiveUnread(store, chat) > 0)
        setOps(store === '2gofresh'
          ? { shopeeUnreadChats: countUnreadChats(store, result.data.conversations) }
          : { freshstockUnreadChats: countUnreadChats(store, result.data.conversations) })

        const incoming = cursor === null
          ? []
          : unreadChats.filter((chat) => chat.latestId && cursor?.[chat.id] !== chat.latestId)
        const nextCursor: Record<string, string> = { ...(cursor ?? {}) }
        for (const chat of result.data.conversations) {
          if (chat.id && chat.latestId) nextCursor[chat.id] = chat.latestId
        }
        cursor = Object.fromEntries(Object.entries(nextCursor).slice(-500))
        try {
          localStorage.setItem(chatKey, JSON.stringify(cursor))
        } catch {
          // Notifications still work for this tab if browser storage is unavailable.
        }

        incoming.slice(0, 4).forEach((chat, index) => {
          pushToast({
            icon: '💬',
            title: `Chat Shopee baru · ${storeName}`,
            body: `${chat.buyer || 'Pembeli'}: ${chat.last}`,
            sticky: false,
            sound: index === 0 ? sounds.chat : undefined,
            store,
            actions: [{ label: 'Buka chat', panel: 'chat' }],
          })
        })
        if (incoming.length > 4) {
          pushToast({ icon: '💬', title: `+${incoming.length - 4} chat Shopee lain belum dibaca · ${storeName}`, body: '', sticky: false, store, actions: [{ label: 'Buka chat', panel: 'chat' }] })
        }
      } catch {
        // Not connected or temporary failure.
      } finally {
        polling = false
      }
    }

    void pollChats()
    const timer = window.setInterval(() => void pollChats(), CHAT_POLL_MS)
    const onWake = () => {
      if (document.visibilityState === 'visible') void pollChats()
    }
    document.addEventListener('visibilitychange', onWake)
    window.addEventListener('focus', onWake)
    return () => {
      stopped = true
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onWake)
      window.removeEventListener('focus', onWake)
    }
  }, [store, chatKey, storeName, sounds])

  function closeBanner() {
    urgentRef.current.forEach((order) => dismissedAlarm.current.add(order.orderSn))
    stopSound(sounds.alarm)
    urgentRef.current = []
    setUrgent([])
  }

  if (urgent.length === 0) return null

  return (
    <div className="sp-watch" role="alert" style={store === 'freshstock' ? { top: '4.6rem' } : undefined}>
      <div className={`sp-watch-urgent${store === 'freshstock' ? ' freshstock' : ''}`}>
        <b>⏰ {urgent.length} pesanan Shopee {storeName} kurang dari 10 menit lagi batas kirim!</b>
        <span>{urgent.map((order) => order.orderSn).join(', ')}</span>
        <button type="button" onClick={closeBanner}>Tutup</button>
      </div>
    </div>
  )
}
