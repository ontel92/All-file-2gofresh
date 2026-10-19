import { Fragment, useEffect, useMemo, useState } from 'react'
import { collection, getDocs, limit, orderBy, query, where } from 'firebase/firestore'
import './Panels.css'
import { database } from './firebase'
import { httpsCallable } from 'firebase/functions'
import { functions } from './posFirebase'

type Sale = {
  id: string
  receiptNo: string
  channel: string
  total: number
  paymentMethod: string
  cashierUid: string
  cashierName: string
  memberName: string
  voided: boolean
  voidReason: string
  voidedByName: string
  createdAt: Date
  items: { name: string; unit: string; quantity: number; total: number }[]
}

type Props = { uid: string; canSeeAll: boolean; canVoid: boolean }

const currency = new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', maximumFractionDigits: 0 })
const qty = new Intl.NumberFormat('id-ID', { maximumFractionDigits: 3 })
const maxRows = 1000

const sourceLabel = (channel: string) =>
  channel === 'retail-offline'
    ? 'Kasir Retail'
    : channel === 'b2b-offline'
      ? 'Kasir B2B'
      : channel === 'web'
        ? 'Web Order'
        : channel
const sourceOrder = ['retail-offline', 'b2b-offline', 'web']
const paymentLabel: Record<string, string> = { cash: 'Tunai', qris: 'QRIS/EDC', transfer: 'Transfer', midtrans: 'Online' }

const dayInput = (date: Date) => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Jakarta' }).format(date)
const dayStart = (value: string) => new Date(`${value}T00:00:00+07:00`)

type Preset = 'today' | 'week' | 'month' | 'custom'

function SalesHistory({ uid, canSeeAll, canVoid }: Props) {
  const [preset, setPreset] = useState<Preset>('today')
  const [now] = useState(() => Date.now())
  const [from, setFrom] = useState(() => dayInput(new Date()))
  const [to, setTo] = useState(() => dayInput(new Date()))
  const [source, setSource] = useState('all')
  const [openId, setOpenId] = useState('')
  const [reloadKey, setReloadKey] = useState(0)
  const [voiding, setVoiding] = useState('')
  const [voidError, setVoidError] = useState('')
  const [result, setResult] = useState<{ key: string; sales: Sale[]; error: string } | null>(null)

  const range = useMemo(() => {
    const today = dayInput(new Date(now))
    if (preset === 'today') return { from: today, to: today }
    if (preset === 'week') return { from: dayInput(new Date(now - 6 * 86_400_000)), to: today }
    if (preset === 'month') return { from: `${today.slice(0, 8)}01`, to: today }
    return { from, to }
  }, [now, preset, from, to])
  const key = `${uid}|${canSeeAll}|${range.from}|${range.to}|${reloadKey}`

  useEffect(() => {
    let cancelled = false
    const start = dayStart(range.from)
    const end = new Date(dayStart(range.to).getTime() + 86_400_000)
    const constraints = [
      ...(canSeeAll ? [] : [where('cashierUid', '==', uid)]),
      where('createdAt', '>=', start),
      where('createdAt', '<', end),
      orderBy('createdAt', 'desc'),
      limit(maxRows),
    ]
    getDocs(query(collection(database, 'sales'), ...constraints))
      .then((snapshot) => {
        if (cancelled) return
        const sales = snapshot.docs.flatMap((document) => {
          const data = document.data()
          const createdAt = data.createdAt?.toDate?.() as Date | undefined
          if (!createdAt || typeof data.total !== 'number') return []
          return [
            {
              id: document.id,
              receiptNo: String(data.receiptNo ?? document.id),
              channel: String(data.channel ?? ''),
              total: data.total,
              paymentMethod: String(data.paymentMethod ?? ''),
              cashierUid: String(data.cashierUid ?? ''),
              cashierName: String(data.cashierName ?? '-'),
              memberName: typeof data.memberName === 'string' ? data.memberName : '',
              voided: data.voided === true,
              voidReason: typeof data.voidReason === 'string' ? data.voidReason : '',
              voidedByName: typeof data.voidedByName === 'string' ? data.voidedByName : '',
              createdAt,
              items: Array.isArray(data.items) ? data.items : [],
            },
          ]
        })
        setResult({ key, sales, error: '' })
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setResult({ key, sales: [], error: error instanceof Error ? error.message : 'Gagal memuat riwayat.' })
        }
      })
    return () => {
      cancelled = true
    }
  }, [key, range.from, range.to, canSeeAll, uid])

  async function voidSale(sale: Sale) {
    const reason = window.prompt(
      `Void ${sale.receiptNo} (${currency.format(sale.total)})?\nStok barang akan dikembalikan. Tulis alasan (mis. retur / batal beli):`,
    )
    if (reason === null) return
    if (reason.trim().length < 3) {
      setVoidError('Alasan void wajib diisi minimal 3 huruf.')
      return
    }
    setVoiding(sale.id)
    setVoidError('')
    try {
      await httpsCallable(functions, 'voidSale')({ saleId: sale.id, reason: reason.trim() })
      setReloadKey((current) => current + 1)
    } catch (error) {
      setVoidError(error instanceof Error ? error.message : 'Void gagal.')
    } finally {
      setVoiding('')
    }
  }

  const loading = result?.key !== key
  const everything = useMemo(() => (loading ? [] : (result?.sales ?? [])), [loading, result])
  const all = useMemo(() => everything.filter((sale) => !sale.voided), [everything])
  const listed = useMemo(
    () => everything.filter((sale) => source === 'all' || sale.channel === source),
    [everything, source],
  )
  const sales = useMemo(() => listed.filter((sale) => !sale.voided), [listed])

  const revenue = sales.reduce((sum, sale) => sum + sale.total, 0)
  const bySource = useMemo(() => {
    const map = new Map<string, { count: number; total: number }>()
    for (const sale of all) {
      const entry = map.get(sale.channel) ?? { count: 0, total: 0 }
      entry.count += 1
      entry.total += sale.total
      map.set(sale.channel, entry)
    }
    return [...map.entries()].sort(([a], [b]) => sourceOrder.indexOf(a) - sourceOrder.indexOf(b))
  }, [all])
  const byCashier = useMemo(() => {
    const map = new Map<string, { name: string; count: number; total: number }>()
    for (const sale of sales) {
      const entry = map.get(sale.cashierUid) ?? { name: sale.cashierName, count: 0, total: 0 }
      entry.count += 1
      entry.total += sale.total
      map.set(sale.cashierUid, entry)
    }
    return [...map.values()].sort((a, b) => b.total - a.total)
  }, [sales])
  const byPayment = useMemo(() => {
    const map = new Map<string, number>()
    for (const sale of sales) map.set(sale.paymentMethod, (map.get(sale.paymentMethod) ?? 0) + sale.total)
    return [...map.entries()]
  }, [sales])

  return (
    <div className="sh-page">
      <div className="pos-page-heading">
        <div>
          <p className="pos-eyebrow">LAPORAN</p>
          <h1>Riwayat penjualan</h1>
          <p>
            {canSeeAll
              ? 'Semua transaksi toko: kasir retail, kasir B2B, dan web order.'
              : 'Transaksi yang Anda proses sendiri.'}
          </p>
        </div>
      </div>

      <div className="sh-filters">
        <div className="po-tabs" role="tablist" aria-label="Periode">
          {(
            [
              ['today', 'Hari ini'],
              ['week', '7 hari'],
              ['month', 'Bulan ini'],
              ['custom', 'Pilih tanggal'],
            ] as const
          ).map(([id, label]) => (
            <button key={id} type="button" className={preset === id ? 'active' : ''} onClick={() => setPreset(id)}>
              {label}
            </button>
          ))}
        </div>
        {preset === 'custom' && (
          <div className="sh-dates">
            <input type="date" value={from} max={to} onChange={(event) => setFrom(event.target.value)} aria-label="Dari tanggal" />
            <span>s/d</span>
            <input type="date" value={to} min={from} onChange={(event) => setTo(event.target.value)} aria-label="Sampai tanggal" />
          </div>
        )}
      </div>

      {voidError && <p className="ct-error" role="alert">{voidError}</p>}
      {result?.error && <p className="ct-error" role="alert">{result.error}</p>}
      {loading && <p className="ct-note">Memuat...</p>}

      <div className="sh-summary">
        <div><span>Total pendapatan</span><strong>{currency.format(revenue)}</strong></div>
        <div><span>Jumlah transaksi</span><strong>{sales.length}</strong></div>
        <div>
          <span>Rata-rata per transaksi</span>
          <strong>{currency.format(sales.length ? Math.round(revenue / sales.length) : 0)}</strong>
        </div>
      </div>
      {all.length >= maxRows && (
        <p className="ct-note">Menampilkan {maxRows} transaksi terbaru. Persempit periode untuk hasil lengkap.</p>
      )}

      <div className="sh-grid">
        <section className="ct-card">
          <h2>Sumber pemasukan</h2>
          <div className="sh-chips">
            <button type="button" className={source === 'all' ? 'active' : ''} onClick={() => setSource('all')}>
              Semua
            </button>
            {bySource.map(([channel, entry]) => (
              <button
                key={channel}
                type="button"
                className={source === channel ? 'active' : ''}
                onClick={() => setSource(channel)}
              >
                {sourceLabel(channel)} · {entry.count}
              </button>
            ))}
          </div>
          <table className="sh-table">
            <thead><tr><th>Sumber</th><th>Transaksi</th><th>Pendapatan</th></tr></thead>
            <tbody>
              {bySource.length === 0 && <tr><td colSpan={3}>Belum ada transaksi.</td></tr>}
              {bySource.map(([channel, entry]) => (
                <tr key={channel}><td>{sourceLabel(channel)}</td><td>{entry.count}</td><td>{currency.format(entry.total)}</td></tr>
              ))}
            </tbody>
          </table>
        </section>

        <section className="ct-card">
          <h2>Kasir bertugas</h2>
          <table className="sh-table">
            <thead><tr><th>Kasir</th><th>Transaksi</th><th>Pendapatan</th></tr></thead>
            <tbody>
              {byCashier.length === 0 && <tr><td colSpan={3}>Belum ada transaksi.</td></tr>}
              {byCashier.map((entry) => (
                <tr key={entry.name}><td>{entry.name}</td><td>{entry.count}</td><td>{currency.format(entry.total)}</td></tr>
              ))}
            </tbody>
          </table>
          {byPayment.length > 0 && (
            <p className="ct-note">
              Metode bayar:{' '}
              {byPayment.map(([method, total]) => `${paymentLabel[method] ?? method} ${currency.format(total)}`).join(' · ')}
            </p>
          )}
        </section>
      </div>

      <section className="ct-card">
        <h2>Daftar transaksi</h2>
        <table className="sh-table sh-trx">
          <thead>
            <tr><th>Waktu</th><th>No. nota</th><th>Sumber</th><th>Kasir</th><th>Bayar</th><th>Total</th>{canVoid && <th></th>}</tr>
          </thead>
          <tbody>
            {listed.length === 0 && !loading && <tr><td colSpan={canVoid ? 7 : 6}>Belum ada transaksi pada periode ini.</td></tr>}
            {listed.map((sale) => (
              <Fragment key={sale.id}>
                <tr className={`sh-row${sale.voided ? ' voided' : ''}`} onClick={() => setOpenId(openId === sale.id ? '' : sale.id)}>
                  <td>{sale.createdAt.toLocaleString('id-ID', { dateStyle: 'short', timeStyle: 'short' })}</td>
                  <td>{sale.receiptNo}</td>
                  <td>{sourceLabel(sale.channel)}</td>
                  <td>{sale.cashierName}</td>
                  <td>{paymentLabel[sale.paymentMethod] ?? sale.paymentMethod}</td>
                  <td>
                    {sale.voided && <span className="sh-void-chip">VOID</span>} {currency.format(sale.total)}
                  </td>
                  {canVoid && (
                    <td>
                      {!sale.voided && sale.channel !== 'web' && (
                        <button
                          type="button"
                          className="sh-void"
                          disabled={voiding === sale.id}
                          onClick={(event) => {
                            event.stopPropagation()
                            void voidSale(sale)
                          }}
                        >
                          {voiding === sale.id ? '...' : 'Void'}
                        </button>
                      )}
                    </td>
                  )}
                </tr>
                {openId === sale.id && (
                  <tr key={`${sale.id}-detail`} className="sh-detail">
                    <td colSpan={canVoid ? 7 : 6}>
                      {sale.voided && (
                        <p className="ct-error">Dibatalkan oleh {sale.voidedByName || '-'}: {sale.voidReason}</p>
                      )}
                      {sale.memberName && <strong>Member: {sale.memberName}</strong>}
                      <ul>
                        {sale.items.map((item, index) => (
                          <li key={index}>
                            {item.name} - {qty.format(item.quantity)} {item.unit} = {currency.format(item.total)}
                          </li>
                        ))}
                      </ul>
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  )
}

export default SalesHistory
