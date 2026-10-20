import { useCallback, useEffect, useState } from 'react'
import { httpsCallable } from 'firebase/functions'
import { functions } from './posFirebase'
import { printShippingLabel, usePrinter } from './printer'
import { getOps, setOps, useOps } from './opsStore'
import './ShopeePanel.css'

type Item = { itemId: number; modelId: number; name: string; variant: string; sku: string; quantity: number; price: number; image: string }
type Pack = { packageNumber: string; logistics: string; carrier: string }
type Order = {
  orderSn: string
  status: string
  buyer: string
  total: number
  carrier: string
  payment: string
  createdAt: number
  shipBy: number
  note: string
  buyerMessage: string
  cancelReason: string
  recipient: string
  phone: string
  address: string
  packages: Pack[]
  items: Item[]
}
type ShipInfo = {
  methods: string[]
  addresses: { addressId: number; text: string; slots: { id: string; text: string; date: number }[] }[]
}
type Product = {
  itemId: number
  name: string
  sku: string
  image: string
  hasModel: boolean
  price: number
  stock: number
  models: { modelId: number; name: string; sku: string; price: number; stock: number }[]
}

const money = new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', maximumFractionDigits: 0 })
const dateText = (ms: number) => (ms ? new Date(ms).toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' }) : '-')

const orderTabs = [
  { id: 'ALL', label: 'Semua' },
  { id: 'UNPAID', label: 'Belum Bayar' },
  { id: 'READY_TO_SHIP', label: 'Perlu Dikirim' },
  { id: 'PROCESSED', label: 'Telah Diproses' },
  { id: 'SHIPPED', label: 'Dikirim' },
  { id: 'COMPLETED', label: 'Selesai' },
  { id: 'IN_CANCEL', label: 'Pembatalan' },
  { id: 'CANCELLED', label: 'Dibatalkan' },
]
const statusText: Record<string, string> = {
  UNPAID: 'Belum Bayar',
  READY_TO_SHIP: 'Perlu Dikirim',
  PROCESSED: 'Telah Diproses',
  SHIPPED: 'Dikirim',
  COMPLETED: 'Selesai',
  IN_CANCEL: 'Pembatalan Diminta',
  CANCELLED: 'Dibatalkan',
  TO_RETURN: 'Pengembalian',
}
const methodText: Record<string, string> = {
  pickup: 'Pickup (kurir jemput)',
  dropoff: 'Antar sendiri ke drop-off',
  non_integrated: 'Input nomor resi manual',
}

function countdown(ms: number) {
  if (ms <= 0) return 'Batas kirim terlewati'
  const minutes = Math.floor(ms / 60000)
  const hours = Math.floor(minutes / 60)
  return `Atur pickup dalam ${hours > 0 ? `${hours} jam ` : ''}${minutes % 60} menit`
}

function chatTime(ms: number) {
  if (!ms) return ''
  const date = new Date(ms)
  const today = new Date().setHours(0, 0, 0, 0)
  if (ms >= today) return date.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })
  if (ms >= today - 86400000) return 'Kemarin'
  return date.toLocaleDateString('id-ID', { dateStyle: 'short' })
}

function message(failure: unknown) {
  return failure instanceof Error ? failure.message : 'Terjadi kesalahan.'
}

async function call<T>(name: string, data?: unknown) {
  return (await httpsCallable<unknown, T>(functions, name)(data)).data
}

function ShipModal({ order, onClose, onDone }: { order: Order; onClose: () => void; onDone: () => void }) {
  const [info, setInfo] = useState<ShipInfo | null>(null)
  const [method, setMethod] = useState('')
  const [addressId, setAddressId] = useState(0)
  const [slot, setSlot] = useState('')
  const [tracking, setTracking] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    call<ShipInfo>('shopeeShipInfo', { orderSn: order.orderSn })
      .then((result) => {
        setInfo(result)
        setMethod(result.methods[0] ?? '')
        setAddressId(result.addresses[0]?.addressId ?? 0)
        setSlot(result.addresses[0]?.slots[0]?.id ?? '')
      })
      .catch((failure) => setError(message(failure)))
  }, [order.orderSn])

  const address = info?.addresses.find((entry) => entry.addressId === addressId)

  async function submit() {
    setBusy(true)
    setError('')
    try {
      await call('shopeeShip', { orderSn: order.orderSn, method, addressId, pickupTimeId: slot, trackingNumber: tracking })
      onDone()
    } catch (failure) {
      setError(message(failure))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="sp-modal" role="dialog" aria-modal="true">
      <div className="sp-modal-card">
        <h3>Atur Pengiriman</h3>
        <p className="sp-muted">{order.orderSn} · {order.carrier || 'Kurir Shopee'}</p>
        {!info && !error && <p>Memuat opsi pengiriman...</p>}
        {info && info.methods.length === 0 && <p className="sp-muted">Tidak ada opsi yang tersedia untuk pesanan ini.</p>}
        {info && info.methods.length > 0 && (
          <>
            <div className="sp-choice">
              {info.methods.map((entry) => (
                <label key={entry} className={method === entry ? 'on' : ''}>
                  <input type="radio" checked={method === entry} onChange={() => setMethod(entry)} />
                  {methodText[entry] ?? entry}
                </label>
              ))}
            </div>
            {method === 'pickup' && (
              <>
                <label className="sp-field">Alamat pickup
                  <select value={addressId} onChange={(event) => {
                    const next = Number(event.target.value)
                    setAddressId(next)
                    setSlot(info.addresses.find((entry) => entry.addressId === next)?.slots[0]?.id ?? '')
                  }}>
                    {info.addresses.map((entry) => <option key={entry.addressId} value={entry.addressId}>{entry.text}</option>)}
                  </select>
                </label>
                <label className="sp-field">Jadwal pickup
                  <select value={slot} onChange={(event) => setSlot(event.target.value)}>
                    {address?.slots.map((entry) => <option key={entry.id} value={entry.id}>{dateText(entry.date).split(',')[0]} · {entry.text}</option>)}
                  </select>
                </label>
              </>
            )}
            {method === 'dropoff' && <p className="sp-muted">Antar paket ke gerai/drop-off kurir yang ditunjuk Shopee. Cetak resi setelah ini.</p>}
            {method === 'non_integrated' && (
              <label className="sp-field">Nomor resi
                <input value={tracking} onChange={(event) => setTracking(event.target.value)} maxLength={60} />
              </label>
            )}
          </>
        )}
        {error && <p className="sp-error" role="alert">{error}</p>}
        <div className="sp-actions">
          <button type="button" className="sp-btn ghost" onClick={onClose}>Batal</button>
          <button type="button" className="sp-btn" disabled={busy || !method} onClick={() => void submit()}>{busy ? 'Memproses...' : 'Konfirmasi'}</button>
        </div>
      </div>
    </div>
  )
}

function OrdersTab() {
  const [tab, setTab] = useState('READY_TO_SHIP')
  const [orders, setOrders] = useState<Order[]>([])
  const [cursor, setCursor] = useState('')
  const [more, setMore] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [openSn, setOpenSn] = useState('')
  const [shipping, setShipping] = useState<Order | null>(null)
  const [printing, setPrinting] = useState('')
  const [search, setSearch] = useState('')
  const [sortBy, setSortBy] = useState<'newest' | 'oldest' | 'deadline'>('newest')
  const [now, setNow] = useState(() => Date.now())
  const [counts, setCounts] = useState<Record<string, number>>({})
  const printer = usePrinter()
  const { openOrderSn } = useOps()

  useEffect(() => {
    if (!openOrderSn) return
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setTab('READY_TO_SHIP')
    setSearch('')
    setOpenSn(openOrderSn)
  }, [openOrderSn])

  useEffect(() => {
    const target = getOps().openOrderSn
    if (!target || !orders.some((order) => order.orderSn === target)) return
    document.getElementById(`sp-order-${target}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    setOps({ openOrderSn: '' })
  }, [orders, openOrderSn])

  const load = useCallback(async (status: string, next = '') => {
    setLoading(true)
    setError('')
    try {
      const result = await call<{ orders: Order[]; more: boolean; cursor: string }>('shopeeOrders', { status, cursor: next })
      setOrders((current) => (next ? [...current, ...result.orders] : result.orders))
      setMore(result.more)
      setCursor(result.cursor)
    } catch (failure) {
      setError(message(failure))
      if (!next) setOrders([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load(tab)
    const timer = window.setInterval(() => void load(tab), 30000)
    return () => window.clearInterval(timer)
  }, [tab, load])

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 15000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    let stopped = false
    const refresh = () =>
      call<{ counts: Record<string, number> }>('shopeeOrderCounts')
        .then((result) => {
          if (!stopped) setCounts(result.counts)
        })
        .catch(() => undefined)
    void refresh()
    const timer = window.setInterval(() => void refresh(), 60000)
    return () => {
      stopped = true
      window.clearInterval(timer)
    }
  }, [])

  async function printLabel(order: Order) {
    setPrinting(order.orderSn)
    setError('')
    // Bluetooth printer connected: print a compact 80mm label with a scannable barcode.
    if (printer.status === 'connected') {
      try {
        const pack = order.packages[0]?.packageNumber ?? ''
        const { trackingNumber } = await call<{ trackingNumber: string }>('shopeeTracking', { orderSn: order.orderSn, packageNumber: pack })
        await printShippingLabel({
          orderSn: order.orderSn,
          trackingNumber,
          carrier: order.carrier,
          buyer: order.buyer,
          recipient: order.recipient,
          phone: order.phone,
          address: order.address,
          note: order.buyerMessage || order.note,
          items: order.items.map((item) => ({ name: item.name, variant: item.variant, quantity: item.quantity })),
        })
      } catch (failure) {
        setError(message(failure))
      } finally {
        setPrinting('')
      }
      return
    }
    const popup = window.open('', '_blank')
    try {
      const result = await call<{ pdfBase64: string }>('shopeeLabel', {
        orderSn: order.orderSn,
        packageNumber: order.packages[0]?.packageNumber ?? '',
      })
      const bytes = Uint8Array.from(atob(result.pdfBase64), (char) => char.charCodeAt(0))
      const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }))
      if (popup) popup.location.href = url
      else window.location.assign(url)
    } catch (failure) {
      popup?.close()
      setError(message(failure))
    } finally {
      setPrinting('')
    }
  }

  const shown = orders
    .filter((order) => {
      const needle = search.trim().toLowerCase()
      return !needle || order.orderSn.toLowerCase().includes(needle) || order.buyer.toLowerCase().includes(needle) || order.items.some((item) => item.name.toLowerCase().includes(needle))
    })
    .sort((a, b) => {
      if (sortBy === 'oldest') return a.createdAt - b.createdAt
      if (sortBy === 'deadline') return (a.shipBy || Infinity) - (b.shipBy || Infinity)
      return b.createdAt - a.createdAt
    })

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
        <input placeholder="Cari no. pesanan, pembeli, produk" value={search} onChange={(event) => setSearch(event.target.value)} />
        <select value={sortBy} onChange={(event) => setSortBy(event.target.value as 'newest' | 'oldest' | 'deadline')} aria-label="Urutkan pesanan">
          <option value="newest">Terbaru → Terlama</option>
          <option value="oldest">Terlama → Terbaru</option>
          <option value="deadline">Batas kirim terdekat</option>
        </select>
        <button type="button" className="sp-btn ghost" onClick={() => void load(tab)}>↻ Muat ulang</button>
      </div>
      <p className="sp-muted">
        <b>Total pesanan {orderTabs.find((entry) => entry.id === tab)?.label}: {counts[tab] ?? shown.length}</b> · pesanan 14 hari terakhir
        {printer.status === 'connected' ? ' · Cetak Label → printer Bluetooth' : ' · Printer belum terhubung: Cetak Label membuka PDF'}
      </p>
      {error && <p className="sp-error" role="alert">{error}</p>}
      {loading && orders.length === 0 && <p className="sp-muted">Memuat pesanan...</p>}
      {!loading && shown.length === 0 && !error && <div className="sp-empty">Belum ada pesanan</div>}
      {shown.map((order) => (
        <article key={order.orderSn} id={`sp-order-${order.orderSn}`} className={`sp-order${openSn === order.orderSn ? ' sp-focus' : ''}`}>
          <header>
            <span><b>{order.buyer || 'Pembeli'}</b> · {order.orderSn}</span>
            <span className={`sp-badge s-${order.status}`}>{statusText[order.status] ?? order.status}</span>
          </header>
          <div className="sp-row">
            <div className="sp-items">
              {order.items.map((item, index) => (
                <div key={index} className="sp-line">
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
              {order.status === 'READY_TO_SHIP' && order.shipBy > 0 && (
                <span className={order.shipBy - now <= 12 * 60 * 1000 ? 'sp-warn sp-blink' : 'sp-warn'}>{countdown(order.shipBy - now)}</span>
              )}
            </div>
            <div className="sp-col">
              <b>{order.carrier || '-'}</b>
            </div>
            <div className="sp-actions">
              {order.status === 'READY_TO_SHIP' && <button type="button" onClick={() => setShipping(order)}>Atur Pengiriman</button>}
              <button type="button" onClick={() => setOpenSn(openSn === order.orderSn ? '' : order.orderSn)}>{openSn === order.orderSn ? 'Tutup Rincian' : 'Lihat Rincian'}</button>
              {['READY_TO_SHIP', 'PROCESSED', 'SHIPPED'].includes(order.status) && (
                <button type="button" disabled={printing === order.orderSn} onClick={() => void printLabel(order)}>
                  {printing === order.orderSn ? 'Menyiapkan...' : 'Cetak Label'}
                </button>
              )}
            </div>
          </div>
          <div className="sp-meta">
            <span>Dipesan {dateText(order.createdAt)}</span>
            {order.status === 'READY_TO_SHIP' && order.shipBy > 0 && <span className="sp-warn">Kirim sebelum {dateText(order.shipBy)}</span>}
            {order.carrier && <span>Kurir: {order.carrier}</span>}
          </div>
          {openSn === order.orderSn && (
            <div className="sp-detail">
              <p><b>Penerima:</b> {order.recipient || '-'} {order.phone && `(${order.phone})`}</p>
              <p><b>Alamat:</b> {order.address || '-'}</p>
              {order.payment && <p><b>Pembayaran:</b> {order.payment}</p>}
              {order.buyerMessage && <p><b>Pesan pembeli:</b> {order.buyerMessage}</p>}
              {order.note && <p><b>Catatan:</b> {order.note}</p>}
              {order.cancelReason && <p><b>Alasan batal:</b> {order.cancelReason}</p>}
              {order.packages.map((pack) => <p key={pack.packageNumber}><b>Paket {pack.packageNumber}:</b> {pack.logistics}</p>)}
            </div>
          )}
        </article>
      ))}
      {more && <button type="button" className="sp-btn ghost wide" disabled={loading} onClick={() => void load(tab, cursor)}>{loading ? 'Memuat...' : 'Muat lebih banyak'}</button>}
      {shipping && (
        <ShipModal
          order={shipping}
          onClose={() => setShipping(null)}
          onDone={() => {
            setShipping(null)
            void load(tab)
          }}
        />
      )}
    </>
  )
}

function PriceStockRow({ itemId, modelId, label, price, stock, onSaved }: { itemId: number; modelId: number; label: string; price: number; stock: number; onSaved: () => void }) {
  const [priceInput, setPriceInput] = useState(String(price))
  const [stockInput, setStockInput] = useState(String(stock))
  const [busy, setBusy] = useState('')
  const [note, setNote] = useState('')

  async function save(kind: 'price' | 'stock') {
    setBusy(kind)
    setNote('')
    try {
      if (kind === 'price') await call('shopeeUpdatePrice', { itemId, modelId, price: Number(priceInput) })
      else await call('shopeeUpdateStock', { itemId, modelId, stock: Number(stockInput) })
      setNote(kind === 'price' ? 'Harga tersimpan ✓' : 'Stok tersimpan ✓')
      onSaved()
    } catch (failure) {
      setNote(message(failure))
    } finally {
      setBusy('')
    }
  }

  return (
    <div className="sp-edit">
      {label && <span className="sp-muted sp-var">{label}</span>}
      <label>Harga (Rp)
        <span><input inputMode="numeric" value={priceInput} onChange={(event) => setPriceInput(event.target.value.replace(/\D/g, ''))} />
          <button type="button" className="sp-btn small" disabled={busy !== '' || Number(priceInput) === price} onClick={() => void save('price')}>{busy === 'price' ? '...' : 'Simpan'}</button></span>
      </label>
      <label>Stok
        <span><input inputMode="numeric" value={stockInput} onChange={(event) => setStockInput(event.target.value.replace(/\D/g, ''))} />
          <button type="button" className="sp-btn small" disabled={busy !== '' || Number(stockInput) === stock} onClick={() => void save('stock')}>{busy === 'stock' ? '...' : 'Simpan'}</button></span>
      </label>
      {note && <small className={note.includes('✓') ? 'sp-ok' : 'sp-error'}>{note}</small>}
    </div>
  )
}

function ProductsTab() {
  const [items, setItems] = useState<Product[]>([])
  const [more, setMore] = useState(false)
  const [next, setNext] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [search, setSearch] = useState('')

  const load = useCallback(async (offset: number) => {
    setLoading(true)
    setError('')
    try {
      const result = await call<{ items: Product[]; more: boolean; next: number }>('shopeeProducts', { offset })
      setItems((current) => (offset ? [...current, ...result.items] : result.items))
      setMore(result.more)
      setNext(result.next)
    } catch (failure) {
      setError(message(failure))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load(0)
  }, [load])

  const shown = items.filter((item) => {
    const needle = search.trim().toLowerCase()
    return !needle || item.name.toLowerCase().includes(needle) || item.sku.toLowerCase().includes(needle)
  })

  return (
    <>
      <div className="sp-toolbar">
        <input placeholder="Cari nama atau SKU produk (yang sudah dimuat)" value={search} onChange={(event) => setSearch(event.target.value)} />
        <button type="button" className="sp-btn ghost" onClick={() => void load(0)}>↻ Muat ulang</button>
      </div>
      <p className="sp-muted">Ubah harga dan stok langsung ke Shopee. Hanya owner/supervisor yang bisa menyimpan perubahan.</p>
      {error && <p className="sp-error" role="alert">{error}</p>}
      {loading && items.length === 0 && <p className="sp-muted">Memuat produk...</p>}
      {shown.map((item) => (
        <article key={item.itemId} className="sp-order">
          <div className="sp-line">
            {item.image ? <img src={item.image} alt="" loading="lazy" /> : <div className="sp-noimg" />}
            <div>
              <p className="sp-name">{item.name}</p>
              {item.sku && <p className="sp-muted">SKU: {item.sku}</p>}
            </div>
          </div>
          {item.hasModel ? (
            item.models.map((model) => (
              <PriceStockRow key={model.modelId} itemId={item.itemId} modelId={model.modelId} label={model.name + (model.sku ? ` · ${model.sku}` : '')} price={model.price} stock={model.stock} onSaved={() => undefined} />
            ))
          ) : (
            <PriceStockRow itemId={item.itemId} modelId={0} label="" price={item.price} stock={item.stock} onSaved={() => undefined} />
          )}
        </article>
      ))}
      {more && <button type="button" className="sp-btn ghost wide" disabled={loading} onClick={() => void load(next)}>{loading ? 'Memuat...' : 'Muat lebih banyak'}</button>}
    </>
  )
}

type Conversation = { id: string; buyerId: number; buyer: string; last: string; unread: number; fromBuyer: boolean; lastAt: number; latestId: string }
type Msg = { id: string; mine: boolean; text: string; at: number; type: string }

export function ShopeeChat() {
  const [chatTab, setChatTab] = useState<'today' | 'all'>('today')
  const [openGroups, setOpenGroups] = useState({ unanswered: true, answered: false })
  const [chats, setChats] = useState<Conversation[]>([])
  const [active, setActive] = useState<Conversation | null>(null)
  const [messages, setMessages] = useState<Msg[]>([])
  const [text, setText] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const loadChats = useCallback(async () => {
    try {
      setChats((await call<{ conversations: Conversation[] }>('shopeeChats')).conversations)
      setError('')
    } catch (failure) {
      setError(message(failure))
    }
  }, [])

  const loadMessages = useCallback(async (id: string) => {
    try {
      setMessages((await call<{ messages: Msg[] }>('shopeeMessages', { conversationId: id })).messages)
    } catch (failure) {
      setError(message(failure))
    }
  }, [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadChats()
    const timer = window.setInterval(() => void loadChats(), 30000)
    return () => window.clearInterval(timer)
  }, [loadChats])

  useEffect(() => {
    if (!active) return
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadMessages(active.id)
    const timer = window.setInterval(() => void loadMessages(active.id), 15000)
    return () => window.clearInterval(timer)
  }, [active, loadMessages])

  async function send(event: React.FormEvent) {
    event.preventDefault()
    if (!active || !text.trim()) return
    setBusy(true)
    try {
      await call('shopeeSendMessage', { buyerId: active.buyerId, text: text.trim() })
      setText('')
      await loadMessages(active.id)
    } catch (failure) {
      setError(message(failure))
    } finally {
      setBusy(false)
    }
  }

  const dayStart = new Date().setHours(0, 0, 0, 0)
  const visibleChats = chatTab === 'today' ? chats.filter((chat) => chat.lastAt >= dayStart || ((chat.fromBuyer || chat.unread > 0) && chat.lastAt >= dayStart - 6 * 86400000)) : chats
  const unanswered = visibleChats.filter((chat) => chat.fromBuyer || chat.unread > 0)
  const answered = visibleChats.filter((chat) => !chat.fromBuyer && chat.unread === 0)
  const totalUnread = chats.filter((chat) => (chat.fromBuyer || chat.unread > 0) && chat.lastAt >= dayStart - 6 * 86400000).length

  return (
    <div className={`sp-chat${active ? ' open' : ''}`}>
      <div className="sp-chat-list">
        {error && <p className="sp-error" role="alert">{error}</p>}
        <div className="sp-chat-tabs">
          <button type="button" className={chatTab === 'today' ? 'on' : ''} onClick={() => setChatTab('today')}>Chat Hari Ini</button>
          <button type="button" className={chatTab === 'all' ? 'on' : ''} onClick={() => setChatTab('all')}>
            Semua Chat{totalUnread > 0 && <i className="sp-dot" />}
          </button>
        </div>
        {chats.length === 0 && !error && <div className="sp-empty">Belum ada percakapan</div>}
        {([['unanswered', 'Belum Dibalas', unanswered], ['answered', 'Sudah Dibalas', answered]] as const).map(([key, label, rows]) => (
          <div key={key} className="sp-chat-group">
            <button type="button" className="sp-chat-group-head" onClick={() => setOpenGroups((current) => ({ ...current, [key]: !current[key] }))}>
              <span>{openGroups[key] ? '▾' : '▸'} {label} ({rows.length})</span>
            </button>
            {openGroups[key] && rows.map((chat) => (
              <button key={chat.id} type="button" className={`sp-chat-row${active?.id === chat.id ? ' on' : ''}`} onClick={() => setActive(chat)}>
                <span className="sp-avatar">{(chat.buyer || '?').charAt(0).toUpperCase()}</span>
                <span className="sp-chat-main">
                  <b>{chat.buyer || `Pembeli ${chat.buyerId}`}</b>
                  <span>{chat.last}</span>
                </span>
                <span className="sp-chat-side">
                  <small>{chatTime(chat.lastAt)}</small>
                  {(chat.unread > 0 || chat.fromBuyer) && <i>{chat.unread || 1}</i>}
                </span>
              </button>
            ))}
          </div>
        ))}      </div>
      <div className="sp-chat-thread">
        {!active ? (
          <div className="sp-empty">Pilih percakapan</div>
        ) : (
          <>
            <header>
              <button type="button" className="sp-back" onClick={() => setActive(null)}>←</button>
              <b>{active.buyer || `Pembeli ${active.buyerId}`}</b>
            </header>
            <div className="sp-msgs">
              {messages.map((entry) => (
                <p key={entry.id} className={entry.mine ? 'mine' : ''}>{entry.text || `[${entry.type}]`}<small>{dateText(entry.at)}</small></p>
              ))}
            </div>
            <form onSubmit={(event) => void send(event)}>
              <input value={text} onChange={(event) => setText(event.target.value)} placeholder="Tulis balasan..." maxLength={500} />
              <button type="submit" className="sp-btn" disabled={busy}>Kirim</button>
            </form>
          </>
        )}
      </div>
    </div>
  )
}

type ReturnRow = { returnSn: string; orderSn: string; status: string; reason: string; amount: number; createdAt: number }

function ReturnsTab() {
  const [rows, setRows] = useState<ReturnRow[] | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    call<{ returns: ReturnRow[] }>('shopeeReturns')
      .then((result) => setRows(result.returns))
      .catch((failure) => {
        setError(message(failure))
        setRows([])
      })
  }, [])

  return (
    <>
      {error && <p className="sp-error" role="alert">{error}</p>}
      {rows === null && <p className="sp-muted">Memuat...</p>}
      {rows?.length === 0 && !error && <div className="sp-empty">Belum ada pengembalian</div>}
      {rows?.map((row) => (
        <article key={row.returnSn} className="sp-order">
          <header>
            <span><b>{row.returnSn}</b> · Pesanan {row.orderSn}</span>
            <span className="sp-badge">{row.status}</span>
          </header>
          <div className="sp-meta">
            <span>{row.reason}</span>
            <span>{dateText(row.createdAt)}</span>
            <b className="sp-total">Refund {money.format(row.amount)}</b>
          </div>
          <p className="sp-muted">Proses persetujuan/penolakan retur dilakukan di Seller Centre Shopee.</p>
        </article>
      ))}
    </>
  )
}

function MarketplaceShopee() {
  const [status, setStatus] = useState<{ connected: boolean; shopName?: string } | null>(null)
  const [main, setMain] = useState<'orders' | 'products' | 'returns'>('orders')
  const [error, setError] = useState('')

  useEffect(() => {
    call<{ connected: boolean; shopName?: string }>('shopeeStatus')
      .then(setStatus)
      .catch(() => setStatus({ connected: false }))
  }, [])

  async function connect() {
    setError('')
    try {
      window.location.assign((await call<{ url: string }>('shopeeConnectUrl')).url)
    } catch (failure) {
      setError(message(failure))
    }
  }

  return (
    <div className="sp">
      <div className="sp-head">
        <div>
          <strong>Shopee Seller</strong>
          <span>{status?.connected ? status.shopName || 'Terhubung' : 'Belum terhubung'}</span>
        </div>
        {status?.connected && <nav aria-label="Menu Shopee">
          {([['orders', 'Pesanan'], ['products', 'Produk'], ['returns', 'Pengembalian']] as const).map(([id, label]) => (
            <button key={id} type="button" className={main === id ? 'on' : ''} onClick={() => setMain(id)}>{label}</button>
          ))}
        </nav>}
      </div>
      {status === null && <p className="sp-muted">Memeriksa koneksi...</p>}
      {status && !status.connected && (
        <section className="sp-connect">
          <h2>Hubungkan toko Shopee</h2>
          <p>Login ke akun penjual Shopee lalu setujui akses. Kunci API tersimpan aman di server. Hanya owner/supervisor yang bisa menghubungkan.</p>
          <button type="button" className="sp-btn" onClick={() => void connect()}>Hubungkan Shopee</button>
          {error && <p className="sp-error" role="alert">{error}</p>}
        </section>
      )}
      {status?.connected && main === 'orders' && <OrdersTab />}
      {status?.connected && main === 'products' && <ProductsTab />}
      {status?.connected && main === 'returns' && <ReturnsTab />}
    </div>
  )
}

export default MarketplaceShopee
