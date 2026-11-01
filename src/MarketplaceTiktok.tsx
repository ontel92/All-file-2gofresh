import { useCallback, useEffect, useRef, useState } from 'react'
import { httpsCallable } from 'firebase/functions'
import { functions } from './posFirebase'
import MarketplaceSync from './MarketplaceSync'
import './ShopeePanel.css'

type TiktokItem = { productId: string; skuId: string; name: string; variant: string; sku: string; quantity: number; price: number; image: string }
type TiktokOrder = {
  orderId: string
  status: string
  buyer: string
  total: number
  carrier: string
  trackingNumber: string
  payment: string
  createdAt: number
  shipBy: number
  buyerMessage: string
  cancelReason: string
  recipient: string
  phone: string
  address: string
  packages: string[]
  items: TiktokItem[]
}
type TiktokSkuRow = { skuId: string; sellerSku: string; price: number; currency: string; stock: number; warehouseId: string }
type TiktokProduct = { productId: string; name: string; status: string; skus: TiktokSkuRow[] }
type Status = { connected: boolean; shopName?: string; region?: string; tokenSaved?: boolean; reason?: string }

const money = new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', maximumFractionDigits: 0 })
const dateText = (ms: number) => (ms ? new Date(ms).toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' }) : '-')
const REFRESH_MS = 120000

const orderTabs = [
  { id: 'AWAITING_SHIPMENT', label: 'Perlu Dikirim' },
  { id: 'AWAITING_COLLECTION', label: 'Menunggu Dijemput' },
  { id: 'IN_TRANSIT', label: 'Dikirim' },
  { id: 'DELIVERED', label: 'Tiba' },
  { id: 'COMPLETED', label: 'Selesai' },
  { id: 'UNPAID', label: 'Belum Bayar' },
  { id: 'CANCELLED', label: 'Dibatalkan' },
  { id: 'ALL', label: 'Semua' },
]
const statusText: Record<string, string> = {
  UNPAID: 'Belum Bayar',
  ON_HOLD: 'Ditahan',
  AWAITING_SHIPMENT: 'Perlu Dikirim',
  PARTIALLY_SHIPPING: 'Sebagian Dikirim',
  AWAITING_COLLECTION: 'Menunggu Dijemput',
  IN_TRANSIT: 'Dikirim',
  DELIVERED: 'Tiba',
  COMPLETED: 'Selesai',
  CANCELLED: 'Dibatalkan',
}

function message(failure: unknown) {
  return failure instanceof Error ? failure.message : 'Terjadi kesalahan.'
}

async function call<T>(name: string, data?: unknown) {
  return (await httpsCallable<unknown, T>(functions, name)(data)).data
}

function OrdersTab({ canManage }: { canManage: boolean }) {
  const [tab, setTab] = useState('AWAITING_SHIPMENT')
  const [orders, setOrders] = useState<TiktokOrder[]>([])
  const [pageToken, setPageToken] = useState('')
  const [more, setMore] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [openId, setOpenId] = useState('')
  const [search, setSearch] = useState('')
  const [counts, setCounts] = useState<Record<string, number>>({})
  const [busy, setBusy] = useState('')
  const inFlight = useRef(false)

  const load = useCallback(async (status: string, token = '') => {
    if (inFlight.current) return
    inFlight.current = true
    setLoading(true)
    setError('')
    try {
      const result = await call<{ orders: TiktokOrder[]; more: boolean; pageToken: string }>('tiktokOrders', { status, pageToken: token })
      setOrders((current) => (token ? [...current, ...result.orders] : result.orders))
      setMore(result.more)
      setPageToken(result.pageToken)
    } catch (failure) {
      setError(message(failure))
      if (!token) setOrders([])
    } finally {
      inFlight.current = false
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === 'visible') void load(tab)
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect
    refresh()
    const timer = window.setInterval(refresh, REFRESH_MS)
    document.addEventListener('visibilitychange', refresh)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', refresh)
    }
  }, [tab, load])

  useEffect(() => {
    call<{ counts: Record<string, number> }>('tiktokOrderCounts').then((result) => setCounts(result.counts)).catch(() => undefined)
  }, [])

  async function ship(order: TiktokOrder, handoverMethod: 'PICKUP' | 'DROP_OFF') {
    const packageId = order.packages[0]
    if (!packageId) return
    if (!window.confirm(`Atur pengiriman pesanan ${order.orderId} dengan ${handoverMethod === 'PICKUP' ? 'pickup (kurir jemput)' : 'antar sendiri ke drop-off'}?`)) return
    setBusy(order.orderId)
    setError('')
    try {
      await call('tiktokShip', { packageId, handoverMethod })
      await load(tab)
    } catch (failure) {
      setError(message(failure))
    } finally {
      setBusy('')
    }
  }

  async function printLabel(order: TiktokOrder) {
    const packageId = order.packages[0]
    if (!packageId) return
    setBusy(order.orderId)
    setError('')
    const popup = window.open('', '_blank')
    try {
      const { url } = await call<{ url: string }>('tiktokLabel', { packageId })
      if (popup) popup.location.href = url
      else window.location.assign(url)
    } catch (failure) {
      popup?.close()
      setError(message(failure))
    } finally {
      setBusy('')
    }
  }

  const needle = search.trim().toLowerCase()
  const shown = orders.filter((order) => !needle
    || order.orderId.toLowerCase().includes(needle)
    || order.buyer.toLowerCase().includes(needle)
    || order.items.some((item) => item.name.toLowerCase().includes(needle) || item.sku.toLowerCase().includes(needle)))

  return (
    <>
      <div className="sp-tabs">
        {orderTabs.map((entry) => (
          <button key={entry.id} type="button" className={tab === entry.id ? 'on' : ''} onClick={() => setTab(entry.id)}>
            {entry.label}
            {counts[entry.id] !== undefined && <span className="sp-count">{counts[entry.id]}</span>}
          </button>
        ))}
      </div>
      <div className="sp-toolbar">
        <input placeholder="Cari no. pesanan, pembeli, produk, SKU" value={search} onChange={(event) => setSearch(event.target.value)} />
        <button type="button" className="sp-btn ghost" onClick={() => void load(tab)}>↻ Muat ulang</button>
      </div>
      <p className="sp-hint">14 hari terakhir · Cetak Label membuka PDF label resmi TikTok.</p>
      {error && <p className="sp-error" role="alert">{error}</p>}
      {loading && orders.length === 0 && <p className="sp-muted">Memuat pesanan...</p>}
      {!loading && shown.length === 0 && !error && <div className="sp-empty">Belum ada pesanan</div>}
      {shown.map((order) => (
        <article key={order.orderId} className="sp-order">
          <header>
            <span><b>{order.buyer || 'Pembeli'}</b> · {order.orderId}</span>
            <span className="sp-badge">{statusText[order.status] ?? order.status}</span>
          </header>
          <div className="sp-row">
            <div className="sp-items">
              {order.items.map((item) => (
                <div key={item.skuId} className="sp-line">
                  {item.image ? <img src={item.image} alt="" loading="lazy" /> : <div className="sp-noimg" />}
                  <div>
                    <p className="sp-name">{item.name}</p>
                    {item.variant && <p className="sp-muted">Variasi: {item.variant}</p>}
                    {item.sku && <p className="sp-muted">[{item.sku}]</p>}
                  </div>
                  <span className="sp-x">x{item.quantity}</span>
                </div>
              ))}
            </div>
            <div className="sp-col">
              <b>{money.format(order.total)}</b>
              {order.payment && <span className="sp-muted">{order.payment}</span>}
            </div>
            <div className="sp-col">
              <b>{statusText[order.status] ?? order.status}</b>
              {order.status === 'AWAITING_SHIPMENT' && order.shipBy > 0 && <span className="sp-warn">Kirim sebelum {dateText(order.shipBy)}</span>}
            </div>
            <div className="sp-col">
              <b>{order.carrier || '-'}</b>
              {order.trackingNumber && <span className="sp-muted">{order.trackingNumber}</span>}
            </div>
            <div className="sp-actions">
              {canManage && order.status === 'AWAITING_SHIPMENT' && order.packages.length > 0 && (
                <>
                  <button type="button" className="primary" disabled={busy === order.orderId} onClick={() => void ship(order, 'PICKUP')}>Atur Pickup</button>
                  <button type="button" disabled={busy === order.orderId} onClick={() => void ship(order, 'DROP_OFF')}>Antar Sendiri</button>
                </>
              )}
              <button type="button" onClick={() => setOpenId(openId === order.orderId ? '' : order.orderId)}>{openId === order.orderId ? 'Tutup Rincian' : 'Lihat Rincian'}</button>
              {['AWAITING_SHIPMENT', 'AWAITING_COLLECTION', 'IN_TRANSIT'].includes(order.status) && order.packages.length > 0 && (
                <button type="button" disabled={busy === order.orderId} onClick={() => void printLabel(order)}>
                  {busy === order.orderId ? 'Menyiapkan...' : 'Cetak Label'}
                </button>
              )}
            </div>
          </div>
          <div className="sp-meta">
            <span>Dipesan {dateText(order.createdAt)}</span>
            {order.carrier && <span>Kurir: {order.carrier}</span>}
          </div>
          {openId === order.orderId && (
            <div className="sp-detail">
              <p><b>Penerima:</b> {order.recipient || '-'} {order.phone && `(${order.phone})`}</p>
              <p><b>Alamat:</b> {order.address || '-'}</p>
              {order.buyerMessage && <p><b>Pesan pembeli:</b> {order.buyerMessage}</p>}
              {order.cancelReason && <p><b>Alasan batal:</b> {order.cancelReason}</p>}
              {order.packages.map((id) => <p key={id}><b>Paket:</b> {id}</p>)}
            </div>
          )}
        </article>
      ))}
      {more && <button type="button" className="sp-btn ghost wide" disabled={loading} onClick={() => void load(tab, pageToken)}>{loading ? 'Memuat...' : 'Muat lebih banyak'}</button>}
    </>
  )
}

function SkuRow({ product, sku, canManage }: { product: TiktokProduct; sku: TiktokSkuRow; canManage: boolean }) {
  const [priceInput, setPriceInput] = useState(String(sku.price))
  const [stockInput, setStockInput] = useState(String(sku.stock))
  const [saved, setSaved] = useState({ price: sku.price, stock: sku.stock })
  const [busy, setBusy] = useState('')
  const [note, setNote] = useState('')

  async function save(kind: 'price' | 'stock') {
    setBusy(kind)
    setNote('')
    try {
      if (kind === 'price') {
        await call('tiktokUpdatePrice', { productId: product.productId, skuId: sku.skuId, price: Number(priceInput) })
        setSaved((current) => ({ ...current, price: Number(priceInput) }))
      } else {
        await call('tiktokUpdateStock', { productId: product.productId, skuId: sku.skuId, stock: Number(stockInput) })
        setSaved((current) => ({ ...current, stock: Number(stockInput) }))
      }
      setNote('Tersimpan ✓')
    } catch (failure) {
      setNote(message(failure))
    } finally {
      setBusy('')
    }
  }

  return (
    <div className="sp-edit">
      <span className="sp-muted sp-var">{sku.sellerSku || '(tanpa SKU penjual)'}</span>
      <label>Harga (Rp)
        <span>
          <input inputMode="numeric" value={priceInput} disabled={!canManage} onChange={(event) => setPriceInput(event.target.value.replace(/\D/g, ''))} />
          <button type="button" className="sp-btn small" disabled={!canManage || busy !== '' || !priceInput || Number(priceInput) === saved.price} onClick={() => void save('price')}>{busy === 'price' ? '...' : 'Simpan'}</button>
        </span>
      </label>
      <label>Stok
        <span>
          <input inputMode="numeric" value={stockInput} disabled={!canManage} onChange={(event) => setStockInput(event.target.value.replace(/\D/g, ''))} />
          <button type="button" className="sp-btn small" disabled={!canManage || busy !== '' || stockInput === '' || Number(stockInput) === saved.stock} onClick={() => void save('stock')}>{busy === 'stock' ? '...' : 'Simpan'}</button>
        </span>
      </label>
      {note && <small className={note.includes('✓') ? 'sp-ok' : 'sp-error'}>{note}</small>}
    </div>
  )
}

function ProductsTab({ canManage }: { canManage: boolean }) {
  const [items, setItems] = useState<TiktokProduct[]>([])
  const [more, setMore] = useState(false)
  const [pageToken, setPageToken] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [search, setSearch] = useState('')

  const load = useCallback(async (token: string) => {
    setLoading(true)
    setError('')
    try {
      const result = await call<{ items: TiktokProduct[]; more: boolean; pageToken: string }>('tiktokProducts', { pageToken: token })
      setItems((current) => (token ? [...current, ...result.items] : result.items))
      setMore(result.more)
      setPageToken(result.pageToken)
    } catch (failure) {
      setError(message(failure))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load('')
  }, [load])

  const needle = search.trim().toLowerCase()
  const shown = items.filter((item) => !needle || item.name.toLowerCase().includes(needle) || item.skus.some((sku) => sku.sellerSku.toLowerCase().includes(needle)))

  return (
    <>
      <div className="sp-toolbar">
        <input placeholder="Cari nama atau SKU produk (yang sudah dimuat)" value={search} onChange={(event) => setSearch(event.target.value)} />
        <button type="button" className="sp-btn ghost" onClick={() => void load('')}>↻ Muat ulang</button>
      </div>
      <p className="sp-hint">Ubah harga dan stok langsung ke TikTok. Hanya owner/supervisor yang bisa menyimpan perubahan; harga tidak boleh di bawah harga minimum master.</p>
      {error && <p className="sp-error" role="alert">{error}</p>}
      {loading && items.length === 0 && <p className="sp-muted">Memuat produk...</p>}
      {shown.map((item) => (
        <article key={item.productId} className="sp-order">
          <div className="sp-line">
            <div className="sp-noimg" />
            <div>
              <p className="sp-name">{item.name}</p>
              <p className="sp-muted">ID {item.productId} · {item.status}</p>
            </div>
          </div>
          {item.skus.map((sku) => <SkuRow key={sku.skuId} product={item} sku={sku} canManage={canManage} />)}
        </article>
      ))}
      {more && <button type="button" className="sp-btn ghost wide" disabled={loading} onClick={() => void load(pageToken)}>{loading ? 'Memuat...' : 'Muat lebih banyak'}</button>}
    </>
  )
}

type UploadResult = {
  itemId: number
  name: string
  status: 'created' | 'skipped' | 'failed'
  variants: number
  tiktokProductId?: string
  error?: string
}

type UploadRow = {
  itemId: number
  name: string
  suggestedTitle: string
  status: 'uploaded' | 'failed' | 'pending'
  error: string
  tiktokProductId: string
}

const titleOk = (title: string) => title.trim().length >= 25 && title.trim().length <= 255

function UploadTab() {
  const [rows, setRows] = useState<UploadRow[]>([])
  const [titles, setTitles] = useState<Record<number, string>>({})
  const [picked, setPicked] = useState<Set<number>>(new Set())
  const [view, setView] = useState<'todo' | 'done'>('todo')
  const [loading, setLoading] = useState(false)
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState('')
  const [error, setError] = useState('')
  const stopRef = useRef(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const result = await call<{ items: UploadRow[] }>('tiktokUploadStatus')
      setRows(result.items)
    } catch (failure) {
      setError(message(failure))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const todo = rows.filter((row) => row.status !== 'uploaded')
  const done = rows.filter((row) => row.status === 'uploaded')
  const titleOf = (row: UploadRow) => titles[row.itemId] ?? row.suggestedTitle

  async function upload(targets: UploadRow[]) {
    const invalid = targets.filter((row) => !titleOk(titleOf(row)))
    if (invalid.length > 0) {
      setError(`Judul harus 25-255 karakter: ${invalid.slice(0, 3).map((row) => row.name).join(', ')}${invalid.length > 3 ? ', ...' : ''}`)
      return
    }
    if (targets.length === 0) return
    stopRef.current = false
    setRunning(true)
    setError('')
    let finished = 0
    try {
      for (let start = 0; start < targets.length && !stopRef.current; start += 3) {
        const chunk = targets.slice(start, start + 3)
        setProgress(`Mengupload ${finished}/${targets.length}...`)
        const result = await call<{ results: UploadResult[] }>('tiktokUploadFromShopee', {
          itemIds: chunk.map((row) => row.itemId),
          titles: Object.fromEntries(chunk.map((row) => [row.itemId, titleOf(row).trim()])),
        })
        const byId = new Map(result.results.map((entry) => [entry.itemId, entry]))
        setRows((current) => current.map((row) => {
          const entry = byId.get(row.itemId)
          if (!entry) return row
          return entry.status === 'failed'
            ? { ...row, status: 'failed', error: entry.error ?? 'Gagal.' }
            : { ...row, status: 'uploaded', error: '', tiktokProductId: entry.tiktokProductId ?? '' }
        }))
        setPicked((current) => {
          const next = new Set(current)
          for (const entry of result.results) if (entry.status !== 'failed') next.delete(entry.itemId)
          return next
        })
        finished += chunk.length
      }
    } catch (failure) {
      setError(message(failure))
    } finally {
      setRunning(false)
      setProgress('')
    }
  }

  const shown = view === 'todo' ? todo : done
  const pickedRows = todo.filter((row) => picked.has(row.itemId))
  const failedCount = todo.filter((row) => row.status === 'failed').length

  return (
    <>
      <p className="sp-hint">
        Produk Shopee yang belum ada di TikTok muncul otomatis di sini (produk baru Shopee ikut masuk). Upload membuat <b>draf</b> beserta semua varian pecahan dan SKU-nya, stok 0.
        Yang gagal tetap di daftar dengan alasannya; edit judul lalu upload ulang. Lengkapi atribut/sertifikasi di TikTok Seller Center sebelum menerbitkan.
      </p>
      <div className="sp-toolbar">
        <button type="button" className="sp-btn" disabled={running || loading || todo.length === 0} onClick={() => void upload(todo)}>
          {running ? progress || 'Mengupload...' : `Upload semua yang belum (${todo.length})`}
        </button>
        <button type="button" className="sp-btn ghost" disabled={running || pickedRows.length === 0} onClick={() => void upload(pickedRows)}>
          Upload terpilih ({pickedRows.length})
        </button>
        <button type="button" className="sp-btn ghost" disabled={running || loading || failedCount === 0} onClick={() => void upload(todo.filter((row) => row.status === 'failed'))}>
          Ulangi yang gagal ({failedCount})
        </button>
        <button type="button" className="sp-btn ghost" disabled={running || loading} onClick={() => void load()}>
          {loading ? 'Memuat...' : 'Muat ulang'}
        </button>
        {running && <button type="button" className="sp-btn ghost" onClick={() => { stopRef.current = true }}>Berhenti</button>}
      </div>
      <nav className="sp-main-tabs" aria-label="Status upload">
        <button type="button" className={view === 'todo' ? 'on' : ''} onClick={() => setView('todo')}>Belum terupload ({todo.length})</button>
        <button type="button" className={view === 'done' ? 'on' : ''} onClick={() => setView('done')}>Sudah terupload ({done.length})</button>
      </nav>
      {error && <p className="sp-error" role="alert">{error}</p>}
      {loading && rows.length === 0 && <p className="sp-muted">Memuat daftar produk Shopee...</p>}
      {!loading && shown.length === 0 && <p className="sp-muted">{view === 'todo' ? 'Semua produk Shopee sudah ada di TikTok.' : 'Belum ada produk yang terupload.'}</p>}
      {shown.map((row) => (
        <article key={row.itemId} className="sp-order">
          <header>
            <span>
              {view === 'todo' && (
                <input
                  type="checkbox"
                  checked={picked.has(row.itemId)}
                  disabled={running}
                  onChange={(event) => setPicked((current) => {
                    const next = new Set(current)
                    if (event.target.checked) next.add(row.itemId)
                    else next.delete(row.itemId)
                    return next
                  })}
                />
              )}{' '}
              <b>{row.name || 'Produk'}</b> · Shopee ID {row.itemId}
            </span>
            <span className="sp-badge">{row.status === 'uploaded' ? 'Draf dibuat' : row.status === 'failed' ? 'Gagal' : 'Belum terupload'}</span>
          </header>
          {row.status === 'uploaded' && <p className="sp-muted">ID produk TikTok: {row.tiktokProductId}</p>}
          {row.status !== 'uploaded' && (
            <>
              <label className="sp-muted" style={{ display: 'block', padding: '0.4rem 0.8rem 0' }}>
                Judul TikTok ({titleOf(row).trim().length}/255, min 25)
                <input
                  style={{ width: '100%', padding: '0.45rem 0.6rem', border: `1px solid ${titleOk(titleOf(row)) ? '#d9d9d9' : '#d93025'}`, borderRadius: 8 }}
                  value={titleOf(row)}
                  disabled={running}
                  maxLength={255}
                  onChange={(event) => setTitles((current) => ({ ...current, [row.itemId]: event.target.value }))}
                />
              </label>
              {row.error && <p className="sp-error">{row.error}</p>}
            </>
          )}
        </article>
      ))}
    </>
  )
}

export default function MarketplaceTiktok({ canManage, isOwner }: { canManage: boolean; isOwner: boolean }) {
  const [status, setStatus] = useState<Status | null>(null)
  const [main, setMain] = useState<'orders' | 'products' | 'sync' | 'upload'>('orders')
  const [error, setError] = useState('')

  useEffect(() => {
    call<Status>('tiktokStatus').then(setStatus).catch(() => setStatus({ connected: false }))
  }, [])

  async function connect() {
    setError('')
    try {
      window.location.assign((await call<{ url: string }>('tiktokConnectUrl')).url)
    } catch (failure) {
      setError(message(failure))
    }
  }

  const menu: { id: typeof main; label: string; icon: string }[] = [
    { id: 'orders', label: 'Pesanan', icon: '📦' },
    { id: 'products', label: 'Produk & Harga', icon: '🏷️' },
    ...(canManage ? [{ id: 'sync' as const, label: 'Sinkron Master', icon: '🔄' }, { id: 'upload' as const, label: 'Upload dari Shopee', icon: '⬆️' }] : []),
  ]

  return (
    <div className="sp tt">
      <header className="sp-top">
        <div className="sp-store-switch" style={{ gridTemplateColumns: '1fr' }}>
          <div className="sp-store-text" style={{ padding: '0.4rem 0.6rem' }}>
            <b>Tokopedia / TikTok Shop</b>
            <small>{status === null ? 'Memeriksa...' : status.connected ? `${status.shopName || 'Terhubung'}${status.region ? ` · ${status.region}` : ''}` : 'Belum terhubung'}</small>
          </div>
        </div>
        {status?.connected && (
          <nav className="sp-main-tabs" aria-label="Menu TikTok">
            {menu.map((entry) => (
              <button key={entry.id} type="button" className={main === entry.id ? 'on' : ''} onClick={() => setMain(entry.id)}>
                <span aria-hidden="true">{entry.icon}</span> {entry.label}
              </button>
            ))}
          </nav>
        )}
      </header>

      {status === null && <p className="sp-muted">Memeriksa koneksi...</p>}
      {status && !status.connected && (
        <section className="sp-connect">
          <h2>Hubungkan toko TikTok / Tokopedia</h2>
          <p>Login ke akun penjual TikTok Shop lalu setujui akses. Kunci API tersimpan aman di server. Hanya owner/supervisor yang bisa menghubungkan.</p>
          {canManage
            ? <button type="button" className="sp-btn" onClick={() => void connect()}>Hubungkan TikTok</button>
            : <p className="sp-muted">Minta owner atau supervisor menghubungkan toko.</p>}
          {status.tokenSaved && (
            <p className="sp-error" role="alert">
              Otorisasi diterima tetapi data toko belum bisa dibaca: {status.reason}. Pastikan aplikasi TikTok memiliki scope Authorization/Shop (Partner Center &gt; aplikasi &gt; API scope), lalu hubungkan ulang.
            </p>
          )}
          {error && <p className="sp-error" role="alert">{error}</p>}
        </section>
      )}
      {status?.connected && main === 'orders' && <OrdersTab canManage={canManage} />}
      {status?.connected && main === 'products' && <ProductsTab canManage={canManage} />}
      {status?.connected && main === 'sync' && canManage && <MarketplaceSync platform="tiktok" isOwner={isOwner} />}
      {status?.connected && main === 'upload' && canManage && <UploadTab />}
    </div>
  )
}
