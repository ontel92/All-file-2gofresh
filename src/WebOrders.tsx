import { useEffect, useState } from 'react'
import { collection, limit, onSnapshot, orderBy, query } from 'firebase/firestore'
import { httpsCallable } from 'firebase/functions'
import { getDownloadURL, getStorage, ref } from 'firebase/storage'
import { app, database } from './firebase'
import { functions } from './posFirebase'
import './Shifts.css'

type WebOrderItem = { name: string; quantity: number; unit: string; total: number }
export type WebOrder = {
  id: string
  orderNo: string
  customerName: string
  phone: string
  address: string
  note: string
  items: WebOrderItem[]
  total: number
  payment: string
  paymentStatus: string
  status: 'new' | 'processing' | 'ready' | 'done' | 'cancelled'
  createdAt: Date | null
  proofPath: string
  shippingFee: number
  freeShipping: boolean
  pointsUsed: number
  lat: number | null
  lng: number | null
  fulfillment: string
  distanceKm: number
  vipCard: boolean
}

const currency = new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', maximumFractionDigits: 0 })
const statusLabel: Record<WebOrder['status'], string> = {
  new: 'Baru',
  processing: 'Diproses',
  ready: 'Siap diambil/kirim',
  done: 'Selesai',
  cancelled: 'Dibatalkan',
}
const paymentLabel: Record<string, string> = { midtrans: 'Midtrans', qris: 'QRIS toko (manual)', whatsapp: 'Via WhatsApp' }
const payStatusLabel: Record<string, string> = {
  paid: 'LUNAS / VALID',
  pending: 'Menunggu bayar Midtrans',
  'needs-check': 'BUTUH DICEK',
  'paid-after-cancel': 'Dibayar setelah batal (refund)',
}

function ProofButton({ path }: { path: string }) {
  const [error, setError] = useState('')
  async function open() {
    try {
      window.open(await getDownloadURL(ref(getStorage(app), path)), '_blank', 'noopener')
    } catch {
      setError('Gagal membuka bukti.')
    }
  }
  return (
    <>
      <button type="button" className="po-resume" onClick={() => void open()}>Lihat bukti bayar</button>
      {error && <small>{error}</small>}
    </>
  )
}
const nextStep: Partial<Record<WebOrder['status'], { to: WebOrder['status']; label: string }>> = {
  new: { to: 'processing', label: 'Proses pesanan' },
  processing: { to: 'ready', label: 'Tandai siap' },
  ready: { to: 'done', label: 'Selesai' },
}

export function useWebOrders(enabled: boolean) {
  const [orders, setOrders] = useState<WebOrder[]>([])
  useEffect(() => {
    if (!enabled) return
    return onSnapshot(
      query(collection(database, 'webOrders'), orderBy('createdAt', 'desc'), limit(200)),
      (snapshot) =>
        setOrders(
          snapshot.docs.map((entry) => ({
            id: entry.id,
            orderNo: String(entry.get('orderNo') ?? entry.id),
            customerName: String(entry.get('customerName') ?? ''),
            phone: String(entry.get('phone') ?? ''),
            address: String(entry.get('address') ?? ''),
            note: String(entry.get('note') ?? ''),
            items: Array.isArray(entry.get('items')) ? (entry.get('items') as WebOrderItem[]) : [],
            total: Number(entry.get('total') ?? 0),
            payment: String(entry.get('payment') ?? ''),
            paymentStatus: String(entry.get('paymentStatus') ?? ''),
            status: (entry.get('status') as WebOrder['status']) ?? 'new',
            createdAt: (entry.get('createdAt') as { toDate?: () => Date } | null)?.toDate?.() ?? null,
            proofPath: String(entry.get('proofPath') ?? ''),
            shippingFee: Number(entry.get('shippingFee') ?? 0),
            freeShipping: entry.get('freeShipping') === true,
            pointsUsed: Number(entry.get('pointsUsed') ?? 0),
            lat: typeof entry.get('lat') === 'number' ? (entry.get('lat') as number) : null,
            lng: typeof entry.get('lng') === 'number' ? (entry.get('lng') as number) : null,
            fulfillment: String(entry.get('fulfillment') ?? ''),
            distanceKm: Number(entry.get('distanceKm') ?? 0),
            vipCard: entry.get('vipCard') === true,
          })),
        ),
      () => setOrders([]),
    )
  }, [enabled])
  const valid = orders.filter((order) => order.paymentStatus === 'paid' || order.paymentStatus === 'needs-check')
  return { orders: valid, newCount: valid.filter((order) => order.status === 'new').length }
}

function WebOrders({ orders }: { orders: WebOrder[] }) {
  const [filter, setFilter] = useState<'active' | 'all'>('active')
  const [busyId, setBusyId] = useState('')
  const [error, setError] = useState('')

  async function confirmPayment(order: WebOrder) {
    if (!window.confirm("Pembayaran QRIS ${order.orderNo} sebesar ${currency.format(order.total)} sudah masuk dan valid?")) return
    setBusyId(order.id)
    setError('')
    try {
      await httpsCallable(functions, 'confirmWebOrderPayment')({ orderId: order.id })
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Gagal mengonfirmasi pembayaran.')
    } finally {
      setBusyId('')
    }
  }

  async function change(order: WebOrder, status: WebOrder['status']) {
    if (status === 'cancelled' && !window.confirm(`Batalkan pesanan ${order.orderNo}?`)) return
    setBusyId(order.id)
    setError('')
    try {
      await httpsCallable(functions, 'updateWebOrderStatus')({ orderId: order.id, status })
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Status gagal diubah.')
    } finally {
      setBusyId('')
    }
  }

  const visible = orders.filter((order) =>
    filter === 'all' ? true : order.status !== 'done' && order.status !== 'cancelled',
  )

  return (
    <div className="sf-page">
      <div className="pos-page-heading">
        <div>
          <p className="pos-eyebrow">PESANAN ONLINE</p>
          <h1>Web Order</h1>
          <p>Pesanan dari www.2gofresh.com muncul di sini secara real-time.</p>
        </div>
      </div>
      <div className="calc-tabs">
        <button type="button" className={filter === 'active' ? 'active' : ''} onClick={() => setFilter('active')}>Perlu diproses</button>
        <button type="button" className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}>Semua</button>
      </div>
      {error && <p className="pos-data-error" role="alert">{error}</p>}
      {visible.length === 0 && (
        <div className="pos-no-products">
          {orders.length === 0 ? 'Belum ada pesanan dari website.' : 'Tidak ada pesanan yang perlu diproses.'}
        </div>
      )}
      <div className="po-grid">
        {visible.map((order) => {
          const step = nextStep[order.status]
          const open = order.status !== 'done' && order.status !== 'cancelled'
          return (
            <article key={order.id} className="po-card">
              <header>
                <div>
                  <h2>{order.orderNo}</h2>
                  <small>
                    {order.createdAt?.toLocaleString('id-ID', { dateStyle: 'short', timeStyle: 'short' })} · {order.customerName}
                  </small>
                </div>
                <strong>{statusLabel[order.status] ?? order.status}</strong>
              </header>
              <ul className="po-items">
                {order.items.map((item, index) => (
                  <li key={index}>{item.name} - {item.quantity} {item.unit}</li>
                ))}
              </ul>
              <p className="sf-note">
                <b>{currency.format(order.total)}</b> · {paymentLabel[order.payment] ?? order.payment} ·{' '}
                <b>{payStatusLabel[order.paymentStatus] ?? order.paymentStatus}</b>
              </p>
              <p className="sf-note">
                Ongkir: {order.fulfillment === 'pickup' ? 'Ambil di toko' : order.freeShipping ? 'GRATIS (VIP)' : currency.format(order.shippingFee)}
                {order.pointsUsed > 0 && ` · Poin dipakai: ${order.pointsUsed}`}
                {order.vipCard && ' · 🎫 Beli Kartu VIP'}
              </p>
              <p className="sf-note">WA: {order.phone}</p>
              {order.address && (
                <p className="sf-note">
                  Alamat: {order.address}
                  {order.lat !== null && order.lng !== null && (
                    <>
                      {' '}(±{order.distanceKm} km){' '}
                      <a href={`https://www.google.com/maps?q=${order.lat},${order.lng}`} target="_blank" rel="noreferrer">Buka Maps</a>
                    </>
                  )}
                </p>
              )}
              {order.note && <p className="sf-note">Catatan: {order.note}</p>}
              <footer>
                {order.proofPath && <ProofButton path={order.proofPath} />}
                {open && order.payment === 'qris' && order.paymentStatus === 'needs-check' && (
                  <button type="button" className="po-resume" disabled={busyId === order.id} onClick={() => void confirmPayment(order)}>
                    Pembayaran valid
                  </button>
                )}
                {order.phone && (
                  <a className="po-resume" href={`https://wa.me/${order.phone}`} target="_blank" rel="noreferrer">Chat WA</a>
                )}
                {open && step && order.paymentStatus === 'paid' && (
                  <button type="button" className="po-resume" disabled={busyId === order.id} onClick={() => void change(order, step.to)}>
                    {step.label}
                  </button>
                )}
                {open && (
                  <button type="button" className="po-delete" disabled={busyId === order.id} onClick={() => void change(order, 'cancelled')}>
                    Batalkan
                  </button>
                )}
              </footer>
            </article>
          )
        })}
      </div>
    </div>
  )
}

export default WebOrders
