import { useEffect, useState } from 'react'
import { collection, limit, onSnapshot, orderBy, query, where } from 'firebase/firestore'
import { database } from '../firebase'
import { currency } from './customer'

type OrderRow = {
  id: string
  orderNo: string
  total: number
  status: string
  paymentStatus: string
  createdAt: Date | null
  items: { name: string; quantity: number; unit: string }[]
  pointsEarned: number
}

const statusText: Record<string, string> = {
  new: 'Baru masuk',
  processing: 'Diproses',
  ready: 'Siap diantar/diambil',
  done: 'Selesai',
  cancelled: 'Dibatalkan',
}
const paymentText: Record<string, string> = {
  pending: 'Menunggu pembayaran',
  'needs-check': 'Pembayaran sedang dicek',
  paid: 'Lunas',
}

export function OrderHistory({ uid }: { uid: string }) {
  const [orders, setOrders] = useState<OrderRow[]>([])
  useEffect(
    () =>
      onSnapshot(
        query(collection(database, 'webOrders'), where('customerUid', '==', uid), orderBy('createdAt', 'desc'), limit(30)),
        (snapshot) =>
          setOrders(
            snapshot.docs.map((entry) => ({
              id: entry.id,
              orderNo: String(entry.get('orderNo')),
              total: Number(entry.get('total')),
              status: String(entry.get('status')),
              paymentStatus: String(entry.get('paymentStatus')),
              createdAt: (entry.get('createdAt') as { toDate?: () => Date } | null)?.toDate?.() ?? null,
              items: (entry.get('items') as OrderRow['items']) ?? [],
              pointsEarned: Number(entry.get('pointsEarned') ?? 0),
            })),
          ),
        () => setOrders([]),
      ),
    [uid],
  )
  if (orders.length === 0) return <p className="muted">Belum ada riwayat belanja.</p>
  return (
    <ul className="order-list">
      {orders.map((order) => (
        <li key={order.id}>
          <div>
            <strong>{order.orderNo}</strong>
            <span>{order.createdAt?.toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' })}</span>
          </div>
          <p>{order.items.map((item) => `${item.name} (${item.quantity} ${item.unit})`).join(', ')}</p>
          <div>
            <b>{currency.format(order.total)}</b>
            <span className={`tag ${order.status === 'cancelled' ? 'bad' : order.paymentStatus === 'paid' ? 'good' : ''}`}>
              {order.status === 'cancelled' ? 'Dibatalkan' : `${paymentText[order.paymentStatus] ?? order.paymentStatus} · ${statusText[order.status] ?? order.status}`}
            </span>
          </div>
          {order.pointsEarned > 0 && <small>+{order.pointsEarned} poin</small>}
        </li>
      ))}
    </ul>
  )
}

