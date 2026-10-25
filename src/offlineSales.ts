import { useSyncExternalStore } from 'react'
import { httpsCallable } from 'firebase/functions'
import { functions } from './posFirebase'
import { pushToast } from './opsStore'

// Penjualan yang dibuat saat internet mati disimpan di perangkat lalu dikirim otomatis ke server saat tersambung.
// Server memakai requestId yang sama sebagai kunci anti-ganda, jadi pengiriman ulang aman.

export type SaleDraft = {
  items: { sku: string; name: string; unit: string; quantity: number; total: number }[]
  total: number
  change: number
  // Field tambahan struk sementara (mis. referensi pembayaran, data member).
  extra?: Record<string, unknown>
}

export type OfflineSale = {
  id: string
  kind: 'retail' | 'b2b'
  uid: string
  request: Record<string, unknown>
  draftReceiptNo: string
  total: number
  paymentMethod: string
  soldAtMs: number
  status: 'pending' | 'failed'
  error?: string
  attempts: number
}

const QUEUE_KEY = 'posOfflineSalesV1'
const COUNTER_KEY = 'posOfflineCounterV1'
const SESSION_KEY = 'posCachedSessionV1'
const MAX_NETWORK_ATTEMPTS = 8

const listeners = new Set<() => void>()

function readQueue(): OfflineSale[] {
  try {
    const raw = localStorage.getItem(QUEUE_KEY)
    return raw ? (JSON.parse(raw) as OfflineSale[]) : []
  } catch {
    return []
  }
}

let queue = readQueue()

function commit(next: OfflineSale[]) {
  queue = next
  try {
    localStorage.setItem(QUEUE_KEY, JSON.stringify(next))
  } catch {
    // Antrean tetap ada di memori selama aplikasi terbuka bila penyimpanan penuh.
  }
  listeners.forEach((listener) => listener())
}

window.addEventListener('storage', (event) => {
  if (event.key !== QUEUE_KEY) return
  queue = readQueue()
  listeners.forEach((listener) => listener())
})

export const getOfflineSales = () => queue

export function useOfflineSales() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => queue,
  )
}

export function useOnlineStatus() {
  return useSyncExternalStore(
    (listener) => {
      window.addEventListener('online', listener)
      window.addEventListener('offline', listener)
      return () => {
        window.removeEventListener('online', listener)
        window.removeEventListener('offline', listener)
      }
    },
    () => navigator.onLine,
  )
}

export function isNetworkError(error: unknown) {
  if (!navigator.onLine) return true
  const code = (error as { code?: string } | null)?.code ?? ''
  return (
    ['functions/internal', 'functions/unavailable', 'functions/deadline-exceeded', 'functions/cancelled'].includes(code) ||
    error instanceof TypeError
  )
}

function nextDraftReceiptNo(kind: 'retail' | 'b2b') {
  const day = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Jakarta' }).format(new Date()).replaceAll('-', '')
  let counter: Record<string, number | string> = {}
  try {
    counter = JSON.parse(localStorage.getItem(COUNTER_KEY) ?? '{}') as Record<string, number | string>
  } catch {
    counter = {}
  }
  if (counter.day !== day) counter = { day, retail: 0, b2b: 0 }
  const next = Number(counter[kind] ?? 0) + 1
  counter[kind] = next
  try {
    localStorage.setItem(COUNTER_KEY, JSON.stringify(counter))
  } catch {
    // Nomor sementara tetap unik karena memuat waktu penjualan saat penyimpanan tidak tersedia.
  }
  return `OFF-${kind === 'retail' ? 'R' : 'B'}-${day}-${String(next).padStart(3, '0')}`
}

type SellOptions = {
  kind: 'retail' | 'b2b'
  callable: 'createRetailSale' | 'createB2bSale'
  uid: string
  cashierName: string
  request: { requestId: string; paymentMethod: string; cashReceived?: number }
  draft: SaleDraft
}

// Menjual lewat server; bila tidak ada internet (atau koneksi putus di tengah jalan) transaksi disimpan
// di antrean dan struk sementara diberikan agar kasir tetap bisa melayani dan mencetak.
export async function sellOrQueue<R>(options: SellOptions): Promise<R> {
  const { request } = options
  if (navigator.onLine) {
    try {
      const sell = httpsCallable<typeof request, R>(functions, options.callable, { timeout: 15000 })
      return (await sell(request)).data
    } catch (error) {
      if (!isNetworkError(error)) throw error
    }
  }

  const existing = queue.find((sale) => sale.id === request.requestId)
  const soldAtMs = existing?.soldAtMs ?? Date.now()
  const draftReceiptNo = existing?.draftReceiptNo ?? nextDraftReceiptNo(options.kind)
  if (!existing) {
    commit([
      ...queue,
      {
        id: request.requestId,
        kind: options.kind,
        uid: options.uid,
        request: request as Record<string, unknown>,
        draftReceiptNo,
        total: options.draft.total,
        paymentMethod: request.paymentMethod,
        soldAtMs,
        status: 'pending',
        attempts: 0,
      },
    ])
  }
  return {
    receiptNo: draftReceiptNo,
    items: options.draft.items,
    total: options.draft.total,
    paymentMethod: request.paymentMethod,
    cashReceived: request.cashReceived ?? null,
    change: options.draft.change,
    cashierName: options.cashierName,
    createdAtIso: new Date(soldAtMs).toISOString(),
    offlinePending: true,
    ...options.draft.extra,
  } as unknown as R
}

export function updateOfflineSale(id: string, patch: Partial<OfflineSale>) {
  commit(queue.map((sale) => (sale.id === id ? { ...sale, ...patch } : sale)))
}

export function retryOfflineSale(id: string) {
  updateOfflineSale(id, { status: 'pending', error: undefined, attempts: 0 })
}

export function discardOfflineSale(id: string) {
  commit(queue.filter((sale) => sale.id !== id))
}

export function pendingSalesFor(uid: string) {
  return queue.filter((sale) => sale.uid === uid)
}

let syncing = false

type SyncedSale = { receiptNo?: string; stockFlags?: { sku: string }[] }

export async function syncOfflineSales(uid: string) {
  if (syncing || !navigator.onLine) return
  syncing = true
  const synced: { draft: string; receiptNo: string; flags: string[] }[] = []
  try {
    const waiting = queue.filter((sale) => sale.uid === uid && sale.status === 'pending').sort((a, b) => a.soldAtMs - b.soldAtMs)
    for (const sale of waiting) {
      try {
        const sell = httpsCallable<Record<string, unknown>, SyncedSale>(
          functions,
          sale.kind === 'retail' ? 'createRetailSale' : 'createB2bSale',
          { timeout: 30000 },
        )
        const result = await sell({ ...sale.request, offline: { soldAtMs: sale.soldAtMs, draftReceiptNo: sale.draftReceiptNo } })
        discardOfflineSale(sale.id)
        synced.push({
          draft: sale.draftReceiptNo,
          receiptNo: result.data.receiptNo ?? '-',
          flags: (result.data.stockFlags ?? []).map((flag) => flag.sku),
        })
      } catch (error) {
        const code = (error as { code?: string } | null)?.code ?? ''
        if (isNetworkError(error) || code === 'functions/unauthenticated') {
          const attempts = sale.attempts + 1
          if (navigator.onLine && attempts >= MAX_NETWORK_ATTEMPTS) {
            updateOfflineSale(sale.id, { status: 'failed', attempts, error: 'Server gagal memproses berulang kali. Hubungi admin, lalu coba lagi.' })
          } else if (navigator.onLine) {
            updateOfflineSale(sale.id, { attempts })
          }
          break
        }
        updateOfflineSale(sale.id, {
          status: 'failed',
          attempts: sale.attempts + 1,
          error: error instanceof Error ? error.message : 'Penjualan offline ditolak server.',
        })
      }
    }
  } finally {
    syncing = false
  }

  if (synced.length > 0) {
    pushToast({
      icon: '✅',
      title: `${synced.length} penjualan offline sudah tersinkron`,
      body: synced.map((entry) => `${entry.draft} → ${entry.receiptNo}`).join(' · '),
      sticky: false,
      actions: [],
    })
    const flagged = synced.flatMap((entry) => entry.flags)
    if (flagged.length > 0) {
      pushToast({
        icon: '⚠️',
        title: 'Stok minus dari penjualan offline',
        body: `Cek stok fisik: ${[...new Set(flagged)].join(', ')}`,
        sticky: true,
        actions: [{ label: 'Buka Stok Produk', panel: 'stock' }],
      })
    }
  }
}

export type CachedSession = { displayName: string; forcePasswordChange: false }

export function cacheSession(uid: string, displayName: string) {
  try {
    localStorage.setItem(`${SESSION_KEY}:${uid}`, JSON.stringify({ displayName, forcePasswordChange: false }))
  } catch {
    // Tanpa cache sesi, buka aplikasi saat offline menunggu internet.
  }
}

export function loadCachedSession(uid: string): CachedSession | null {
  try {
    const raw = localStorage.getItem(`${SESSION_KEY}:${uid}`)
    return raw ? (JSON.parse(raw) as CachedSession) : null
  } catch {
    return null
  }
}
