import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { httpsCallable } from 'firebase/functions'
import { functions } from './posFirebase'
import './MarketplaceMargin.css'

type MarginLine = {
  name: string
  variant: string
  sku: string
  quantity: number | null
  unitCost: number | null
  cost: number | null
  mappingSource: string
}
type MarginOrder = {
  orderSn: string
  status: string
  releasedAt: number
  payout: number | null
  costOfGoods: number | null
  netProfit: number | null
  hasUnmappedItems: boolean
  lines: MarginLine[]
  feeBreakdown: { name: string; amount: number }[]
  feeDetailError: string
  payoutSource: string
}
type PendingMarginOrder = {
  orderSn: string
  status: string
  createdAt: number
  orderAmount: number | null
  costOfGoods: number | null
  hasUnmappedItems: boolean
  lines: MarginLine[]
}
type Report = {
  source: string
  rangeStart: number
  rangeEnd: number
  generatedAt: number
  syncedAt: number | null
  syncError: string
  backfillComplete: boolean
  orders: MarginOrder[]
  pendingOrders: PendingMarginOrder[]
}

const money = new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', maximumFractionDigits: 0 })
const labels: Record<string, string> = {
  commission_fee: 'Komisi',
  service_fee: 'Biaya layanan',
  transaction_fee: 'Biaya transaksi',
  seller_transaction_fee: 'Biaya transaksi penjual',
  actual_shipping_fee: 'Ongkir aktual',
  reverse_shipping_fee: 'Ongkir retur',
  seller_withholding_tax: 'Pajak dipotong',
  vat: 'PPN',
  voucher_from_seller: 'Voucher penjual',
  coins: 'Koin',
  shipping_fee_rebate_from_shopee: 'Rebate ongkir Shopee',
  seller_discount: 'Diskon penjual',
}
const pendingStatusLabels: Record<string, string> = {
  READY_TO_SHIP: 'Menunggu dikirim',
  PROCESSED: 'Sedang disiapkan',
  SHIPPED: 'Dalam pengiriman',
  COMPLETED: 'Pesanan selesai · menunggu pelepasan',
}

function errorText(error: unknown) {
  if (typeof error === 'object' && error !== null && 'code' in error && String(error.code).includes('deadline-exceeded')) {
    return 'Pengambilan data Shopee memerlukan waktu lebih lama dari batas pemanggilan. Tekan Muat ulang untuk mencoba lagi.'
  }
  return error instanceof Error ? error.message : 'Gagal mengambil data settlement Shopee.'
}

async function fetchMarginReport(period: 'day' | 'week' | 'month') {
  const result = await httpsCallable<{ period: 'day' | 'week' | 'month' }, Report>(
    functions,
    'shopeeRealizedMargins',
  )({ period })
  return result.data
}

export default function MarketplaceMargin() {
  const [report, setReport] = useState<Report | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [expanded, setExpanded] = useState('')
  const [search, setSearch] = useState('')
  const [period, setPeriod] = useState<'day' | 'week' | 'month'>('week')
  const requestInFlight = useRef(false)
  const load = useCallback(async () => {
    if (requestInFlight.current) return
    requestInFlight.current = true
    try {
      setReport(await fetchMarginReport(period))
      setError('')
    } catch (failure) {
      setError(errorText(failure))
    } finally {
      setLoading(false)
      requestInFlight.current = false
    }
  }, [period])

  const refresh = useCallback(() => {
    if (requestInFlight.current) return
    setLoading(true)
    setError('')
    void load()
  }, [load])

  useEffect(() => {
    const initialLoad = window.setTimeout(() => void load(), 0)
    const timer = window.setInterval(refresh, 10 * 60 * 1000)
    return () => {
      window.clearTimeout(initialLoad)
      window.clearInterval(timer)
    }
  }, [load, refresh])

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase()
    return (report?.orders ?? [])
      .filter((order) => !needle || order.orderSn.toLowerCase().includes(needle) || order.lines.some((line) => `${line.sku} ${line.name}`.toLowerCase().includes(needle)))
      .sort((a, b) => b.releasedAt - a.releasedAt)
  }, [report, search])
  const pendingFiltered = useMemo(() => {
    const needle = search.trim().toLowerCase()
    return (report?.pendingOrders ?? [])
      .filter((order) => !needle || order.orderSn.toLowerCase().includes(needle) || order.lines.some((line) => `${line.sku} ${line.name}`.toLowerCase().includes(needle)))
      .sort((a, b) => b.createdAt - a.createdAt)
  }, [report, search])
  const totals = filtered.reduce(
    (sum, order) => ({
      count: sum.count + 1,
      payout: sum.payout + (order.payout ?? 0),
      cogs: sum.cogs + (order.costOfGoods ?? 0),
      profit: sum.profit + (order.netProfit ?? 0),
      missing: sum.missing + (order.netProfit === null ? 1 : 0),
    }),
    { count: 0, payout: 0, cogs: 0, profit: 0, missing: 0 },
  )
  const pendingTotals = pendingFiltered.reduce(
    (sum, order) => ({
      count: sum.count + 1,
      amount: sum.amount + (order.orderAmount ?? 0),
      missing: sum.missing + (order.hasUnmappedItems ? 1 : 0),
    }),
    { count: 0, amount: 0, missing: 0 },
  )
  const monthGroups = useMemo(() => {
    const groups = new Map<string, MarginOrder[]>()
    for (const order of filtered) {
      const date = new Date(order.releasedAt)
      const monthKey = new Intl.DateTimeFormat('sv-SE', {
        timeZone: 'Asia/Jakarta',
        year: 'numeric',
        month: '2-digit',
      }).format(date)
      groups.set(monthKey, [...(groups.get(monthKey) ?? []), order])
    }
    return [...groups.entries()]
      .sort(([first], [second]) => second.localeCompare(first))
      .map(([monthKey, orders]) => ({
        monthKey,
        orders,
        monthLabel: new Date(`${monthKey}-01T12:00:00+07:00`).toLocaleDateString('id-ID', {
          month: 'long',
          year: 'numeric',
          timeZone: 'Asia/Jakarta',
        }),
      }))
  }, [filtered])

  return (
    <section className="mm">
      <header className="pos-page-heading">
        <div>
          <p className="pos-eyebrow">LAPORAN MARKETPLACE</p>
          <h1>Margin Marketplace</h1>
          <p>Data dari cache Firebase; sinkronisasi Shopee berjalan terjadwal setiap 10 menit.</p>
        </div>
        <button type="button" className="sp-btn ghost" disabled={loading} onClick={refresh}>{loading ? 'Memuat...' : '↻ Muat ulang'}</button>
      </header>

      <div className="mm-notice">
        <b>Mulai 1 Oktober 2026.</b> Dana dilepas memakai payout aktual. Dana yang masih diproses memakai nilai pesanan bruto, bukan payout bersih final.
      </div>

      <div className="mm-toolbar">
        <label className="mm-period">
          Periode
          <select value={period} onChange={(event) => {
            const value = event.target.value
            if (value !== 'day' && value !== 'week' && value !== 'month') return
            setLoading(true)
            setReport(null)
            setPeriod(value)
          }}>
            <option value="day">Hari ini</option>
            <option value="week">7 hari terakhir</option>
            <option value="month">Bulan ini</option>
          </select>
        </label>
        <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Cari no. order, SKU, produk..." aria-label="Cari order margin" />
        <span>{filtered.length} order dana dilepas · {pendingFiltered.length} order masih diproses</span>
        <span className="mm-channel-state">Shopee: terhubung · Tokopedia/TikTok: belum terhubung</span>
      </div>

      {error && <p className="mm-error" role="alert">{error}</p>}
      {loading && !report && <p className="mm-muted">Memuat cache laporan dari Firebase...</p>}
      {report && (
        <>
          {!report.syncedAt && <p className="mm-warning">Belum ada data cache. Sinkronisasi terjadwal akan mengisi data dari Shopee; tidak ada permintaan historis langsung dari browser.</p>}
          {report.syncError && <p className="mm-warning">Sinkronisasi terakhir gagal: {report.syncError}. Data cache yang sudah ada tetap ditampilkan dan sistem akan mencoba kembali pada jadwal berikutnya.</p>}
          {report.syncedAt && <p className="mm-muted">Data Shopee terakhir disinkronkan: {new Date(report.syncedAt).toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Jakarta' })}.{report.backfillComplete ? ' Riwayat sejak 1 Oktober sudah selesai dimuat.' : ' Riwayat lama masih diisi bertahap.'}</p>}
          <section className="mm-fund-section mm-fund-pending">
            <header className="mm-fund-heading">
              <div><p className="pos-eyebrow">BELUM MASUK PAYOUT</p><h2>Dana masih diproses</h2><p>Order yang belum ditemukan pada catatan pelepasan dana Shopee. Termasuk yang menunggu dikirim, sedang dikirim, atau selesai tetapi payout belum tercatat.</p></div>
              <div className="mm-fund-total"><small>Estimasi nilai pesanan bruto</small><b>{money.format(pendingTotals.amount)}</b><span>{pendingTotals.count} order</span></div>
            </header>
            {pendingTotals.missing > 0 && <p className="mm-warning">{pendingTotals.missing} order pending memiliki item yang HPP-nya belum termapping. Nilai pesanan tetap ditampilkan sebagai bruto.</p>}
            {pendingFiltered.length === 0 ? <div className="mm-empty">Tidak ada order yang sedang menunggu pelepasan dana.</div> : (
              <div className="mm-orders">
                {pendingFiltered.map((order) => (
                  <article key={order.orderSn} className={`mm-order${expanded === order.orderSn ? ' open' : ''}`}>
                    <button type="button" className="mm-order-head mm-pending-head" onClick={() => setExpanded(expanded === order.orderSn ? '' : order.orderSn)}>
                      <span className="mm-order-id"><b>{order.orderSn}</b><small>{order.createdAt ? new Date(order.createdAt).toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Jakarta' }) : 'Tanggal order tidak tersedia'}</small></span>
                      <span><small>Status Shopee</small><b>{pendingStatusLabels[order.status] ?? order.status}</b></span>
                      <span><small>Nilai pesanan bruto · bukan payout final</small><b>{order.orderAmount === null ? 'Tidak tersedia' : money.format(order.orderAmount)}</b></span>
                      <span aria-hidden="true">{expanded === order.orderSn ? '▴' : '▾'}</span>
                    </button>
                    {expanded === order.orderSn && (
                      <div className="mm-detail">
                        <div className="mm-detail-head"><b>Rincian item dan HPP</b><span>Nilai pesanan mengikuti total_amount dari Shopee; payout bersih baru ditampilkan setelah dilepas.</span></div>
                        {order.lines.map((line, index) => (
                          <div key={`${line.sku}-${index}`} className="mm-line">
                            <span><b>{line.name || line.sku}</b><small>{line.variant} · SKU {line.sku || 'tidak terpetakan'} · {line.mappingSource}</small></span>
                            <span>{line.quantity ?? '-'} × {line.unitCost === null ? '-' : money.format(line.unitCost)}</span>
                            <b>{line.cost === null ? 'HPP tidak diketahui' : money.format(line.cost)}</b>
                          </div>
                        ))}
                        {order.hasUnmappedItems && <p className="mm-warning">HPP order belum lengkap karena setidaknya satu item belum termapping.</p>}
                      </div>
                    )}
                  </article>
                ))}
              </div>
            )}
          </section>

          <section className="mm-fund-section mm-fund-released">
            <header className="mm-fund-heading">
              <div><p className="pos-eyebrow">SETTLEMENT SHOPEE</p><h2>Dana sudah dilepas</h2><p>Payout aktual yang sudah dicatat Shopee, dikurangi HPP untuk menghitung margin.</p></div>
            </header>
          <div className="mm-summary">
            <article><span>Jumlah order settled</span><b>{totals.count}</b></article>
            <article><span>Payout aktual Shopee</span><b>{money.format(totals.payout)}</b></article>
            <article><span>HPP produk termapping</span><b>{money.format(totals.cogs)}</b></article>
            <article className={totals.profit < 0 ? 'loss' : 'profit'}><span>Margin terhitung setelah HPP</span><b>{money.format(totals.profit)}</b></article>
          </div>
          {totals.missing > 0 && <p className="mm-warning">{totals.missing} order belum dapat dihitung marginnya penuh karena ada SKU yang belum termapping. Order tersebut tetap ditampilkan dengan status perhitungan belum lengkap.</p>}
          {filtered.length === 0 && <div className="mm-empty">Belum ada payout settlement sejak 1 Oktober 2026.</div>}
          <div className="mm-orders">
            {monthGroups.map(({ monthKey, orders, monthLabel }) => {
              const monthPayout = orders.reduce((sum, order) => sum + (order.payout ?? 0), 0)
              const monthProfit = orders.reduce((sum, order) => sum + (order.netProfit ?? 0), 0)
              return (
                <section className="mm-month" key={monthKey}>
                  <header className="mm-month-heading">
                    <b>{monthLabel}</b>
                    <span>{orders.length} order · Payout {money.format(monthPayout)} · Margin terhitung {money.format(monthProfit)}</span>
                  </header>
                  {orders.map((order) => (
                    <article key={order.orderSn} className={`mm-order${expanded === order.orderSn ? ' open' : ''}`}>
                      <button type="button" className="mm-order-head" onClick={() => setExpanded(expanded === order.orderSn ? '' : order.orderSn)}>
                        <span className="mm-order-id"><b>{order.orderSn}</b><small>{order.releasedAt ? new Date(order.releasedAt).toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Jakarta' }) : 'Tanggal payout tidak tersedia'}</small></span>
                        <span><small>Payout aktual</small><b>{order.payout === null ? 'Tidak tersedia' : money.format(order.payout)}</b></span>
                        <span><small>HPP</small><b>{order.costOfGoods === null ? 'Mapping belum lengkap' : money.format(order.costOfGoods)}</b></span>
                        <span className={order.netProfit === null ? '' : order.netProfit < 0 ? 'loss' : 'profit'}><small>Untung / rugi</small><b>{order.netProfit === null ? 'Belum lengkap' : money.format(order.netProfit)}</b></span>
                        <span aria-hidden="true">{expanded === order.orderSn ? '▴' : '▾'}</span>
                      </button>
                      {expanded === order.orderSn && (
                        <div className="mm-detail">
                          <div className="mm-detail-head"><b>Rincian item dan HPP</b><span>Sumber payout: {order.payoutSource}</span></div>
                          {order.lines.map((line, index) => (
                            <div key={`${line.sku}-${index}`} className="mm-line">
                              <span><b>{line.name || line.sku}</b><small>{line.variant} · SKU {line.sku || 'tidak terpetakan'} · {line.mappingSource}</small></span>
                              <span>{line.quantity ?? '-'} × {line.unitCost === null ? '-' : money.format(line.unitCost)}</span>
                              <b>{line.cost === null ? 'HPP tidak diketahui' : money.format(line.cost)}</b>
                            </div>
                          ))}
                          <div className="mm-fees">
                            <b>Semua nilai nominal yang dikembalikan API escrow Shopee</b>
                            {order.feeBreakdown.length === 0 && !order.feeDetailError && <span>API tidak mengembalikan item biaya terpisah untuk order ini; payout di atas tetap memakai nilai aktual.</span>}
                            {order.feeBreakdown.map((fee) => <span key={fee.name}>{labels[fee.name] ?? fee.name}: {money.format(fee.amount)}</span>)}
                            {order.feeDetailError && <span className="mm-fee-error">Rincian fee detail gagal diambil: {order.feeDetailError}</span>}
                          </div>
                          {order.hasUnmappedItems && <p className="mm-warning">Margin order belum lengkap: setidaknya satu item belum memiliki pemetaan HPP. Angka untung/rugi sengaja tidak ditebak.</p>}
                        </div>
                      )}
                    </article>
                  ))}
                </section>
              )
            })}
          </div>
          </section>
          <p className="mm-muted">Terakhir diperbarui: {new Date(report.generatedAt).toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' })}. Data settlement mengikuti akses dan retensi API Shopee.</p>
        </>
      )}
    </section>
  )
}
