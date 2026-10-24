import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { collection, onSnapshot } from 'firebase/firestore'
import { httpsCallable } from 'firebase/functions'
import { database } from './firebase'
import { functions } from './posFirebase'
import { storeInfo } from './storeInfo'
import { vipCardSku, vipFreeShippingKm, vipMinimumPurchase } from './shipping'
import Account from './shop/Account'
import Checkout from './shop/Checkout'
import { currency, qtyFormat, useCustomer } from './shop/customer'
import type { CartMap, Product } from './shop/customer'
import YubiChat from './YubiChat'
import './shop/shop.css'

const pageSize = 24
const bestSellerList = [
  { title: 'Paket Sayur Capjay', sku: 'vege-7444', category: 'VEGETABLE', label: 'Sayur segar', emoji: '🥗' },
  { title: 'Paket Sayur Sop', sku: 'vege-7445', category: 'VEGETABLE', label: 'Sayur segar', emoji: '🥕' },
  { title: 'Tempe & Tahu', sku: 'groc-3258', category: 'GROCERY', label: 'Lauk harian', emoji: '🍢' },
  { title: 'Udang', sku: 'fish-5465', category: 'FISH', label: 'Seafood', emoji: '🦐' },
  { title: 'Beef Shortplate', sku: 'meat-4263', category: 'MEAT', label: 'Daging sapi', emoji: '🥩' },
  { title: 'Kangkung, Sawi, Bayam', sku: 'vege-8116', category: 'VEGETABLE', label: 'Sayur segar', emoji: '🥬' },
]
const cartKey = 'gofresh-cart-v1'
const pendingKey = 'gofresh-pending-payment-v1'

type PendingPayment = { orderId: string; orderNo: string; redirectUrl: string; expiresAt: number }

function loadPending(): PendingPayment | null {
  try {
    const parsed = JSON.parse(localStorage.getItem(pendingKey) ?? 'null') as PendingPayment | null
    return parsed && typeof parsed.orderId === 'string' && parsed.expiresAt > Date.now() ? parsed : null
  } catch {
    return null
  }
}

function countdown(ms: number) {
  const total = Math.max(0, Math.floor(ms / 1000))
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
}

function loadCart(): CartMap {
  try {
    const parsed = JSON.parse(localStorage.getItem(cartKey) ?? '{}') as CartMap
    return Object.fromEntries(Object.entries(parsed).filter(([, value]) => typeof value === 'number' && value > 0))
  } catch {
    return {}
  }
}

function stepFor(product: Product) {
  return product.unit.toUpperCase() === 'KG' ? 0.25 : 1
}

function ProductCard({
  product,
  quantity,
  onChange,
}: {
  product: Product
  quantity: number
  onChange: (quantity: number) => void
}) {
  const [broken, setBroken] = useState(false)
  const step = stepFor(product)
  const minimum = product.minQty
  const decrease = () => {
    const next = Math.round((quantity - step) * 1000) / 1000
    onChange(next < minimum ? 0 : next)
  }
  return (
    <article className="card">
      <div className="card-photo">
        {product.imageUrl && !broken ? (
          <img src={product.imageUrl} alt={product.name} loading="lazy" decoding="async" onError={() => setBroken(true)} />
        ) : (
          <span aria-hidden="true">🧺</span>
        )}
      </div>
      <div className="card-body">
        <small>{product.category}</small>
        <h3>{product.name}</h3>
        <p className="price">
          {currency.format(product.retailPrice)} <span>/ {product.unit}</span>
        </p>
        {minimum !== 1 && <small className="muted">Min. {qtyFormat.format(minimum)} {product.unit}</small>}
        {quantity > 0 ? (
          <div className="stepper">
            <button type="button" aria-label="Kurangi" onClick={decrease}>−</button>
            <span>{qtyFormat.format(quantity)} {product.unit}</span>
            <button type="button" aria-label="Tambah" onClick={() => onChange(Math.round((quantity + step) * 1000) / 1000)}>+</button>
          </div>
        ) : (
          <button type="button" className="btn add" onClick={() => onChange(minimum)}>Tambah</button>
        )}
      </div>
    </article>
  )
}

function App() {
  const [products, setProducts] = useState<Product[]>([])
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [category, setCategory] = useState('Semua')
  const [search, setSearch] = useState('')
  const [visible, setVisible] = useState(pageSize)
  const [cart, setCart] = useState<CartMap>(loadCart)
  const [cartOpen, setCartOpen] = useState(false)
  const [checkout, setCheckout] = useState(false)
  const [account, setAccount] = useState<'login' | 'register' | null>(null)
  const [orderNotice, setOrderNotice] = useState('')
  const customer = useCustomer()
  const [pending, setPending] = useState<PendingPayment | null>(loadPending)
  const [now, setNow] = useState(() => Date.now())
  const expiring = useRef(false)

  useEffect(() => {
    if (pending) localStorage.setItem(pendingKey, JSON.stringify(pending))
    else localStorage.removeItem(pendingKey)
  }, [pending])

  const releasePending = useCallback(async () => {
    const current = pending
    setPending(null)
    if (!current) return
    try {
      await httpsCallable(functions, 'cancelPendingPayment')({ orderId: current.orderId })
    } catch {
      // The server also closes unpaid orders when the Midtrans window ends.
    }
  }, [pending])

  // Sync the unpaid order with Midtrans: paid or already closed means the cart is no longer needed.
  useEffect(() => {
    if (!pending || !customer.ready || !customer.user) return
    let cancelled = false
    void httpsCallable<unknown, { paymentStatus: string; status: string }>(functions, 'checkMidtransPayment')({ orderId: pending.orderId })
      .then((result) => {
        if (cancelled) return
        if (result.data.paymentStatus === 'paid') {
          setCart({})
          setPending(null)
          setOrderNotice('Pembayaran berhasil! Pesanan Anda sedang kami proses.')
        } else if (result.data.status === 'cancelled') {
          setCart({})
          setPending(null)
          setOrderNotice('Waktu pembayaran habis. Keranjang dikosongkan, silakan belanja lagi.')
        }
      })
      .catch(() => setPending(null))
    return () => {
      cancelled = true
    }
  }, [pending, customer.ready, customer.user])

  useEffect(() => {
    if (!pending) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [pending])

  useEffect(() => {
    if (!pending || now < pending.expiresAt || expiring.current) return
    expiring.current = true
    void releasePending().finally(() => {
      setCart({})
      setOrderNotice('Waktu pembayaran habis. Keranjang dikosongkan, silakan belanja lagi.')
      expiring.current = false
    })
  }, [now, pending, releasePending])
  useEffect(
    () =>
      onSnapshot(
        collection(database, 'catalogProducts'),
        (snapshot) => {
          setProducts(
            snapshot.docs.map((entry) => ({
              sku: String(entry.get('sku')),
              name: String(entry.get('name')),
              category: String(entry.get('category')),
              unit: String(entry.get('unit')),
              minQty: Number(entry.get('minQty')),
              retailPrice: Number(entry.get('retailPrice')),
              imageUrl: String(entry.get('imageUrl') ?? ''),
            })),
          )
          setStatus('ready')
        },
        () => setStatus('error'),
      ),
    [],
  )

  useEffect(() => {
    localStorage.setItem(cartKey, JSON.stringify(cart))
  }, [cart])

  const productMap = useMemo(() => new Map(products.map((product) => [product.sku.toLowerCase(), product])), [products])
  const cartForCheckout = useMemo(
    () => Object.fromEntries(Object.entries(cart).map(([sku, quantity]) => [sku.toLowerCase(), quantity])),
    [cart],
  )
  const categories = useMemo(() => ['Semua', ...[...new Set(products.map((product) => product.category))].sort()], [products])
  const filtered = useMemo(() => {
    const query = search.trim().toLocaleLowerCase('id-ID')
    return products
      .filter((product) => product.sku.toLowerCase() !== vipCardSku)
      .filter(
        (product) =>
          (category === 'Semua' || product.category === category) &&
          (!query || `${product.name} ${product.category}`.toLocaleLowerCase('id-ID').includes(query)),
      )
      .sort((a, b) => Number(!!b.imageUrl) - Number(!!a.imageUrl) || a.name.localeCompare(b.name, 'id'))
  }, [products, category, search])

  const bestSellers = useMemo(
    () => bestSellerList.map((item) => ({
      ...item,
      product: productMap.get(item.sku),
      categoryCount: products.filter((product) => product.category === item.category).length,
    })),
    [productMap, products],
  )
  const vipProduct = productMap.get(vipCardSku)
  const cartLines = Object.entries(cart)
    .map(([sku, quantity]) => ({ product: productMap.get(sku.toLowerCase()), quantity }))
    .filter((line): line is { product: Product; quantity: number } => !!line.product)
  const cartCount = cartLines.length
  const cartTotal = cartLines.reduce((sum, line) => sum + Math.round(line.product.retailPrice * line.quantity), 0)

  function setQuantity(product: Product, quantity: number) {
    if (pending) void releasePending()
    setCart((current) => {
      const next = { ...current }
      if (quantity > 0) next[product.sku] = quantity
      else delete next[product.sku]
      return next
    })
  }

  useEffect(() => {
    const orderId = new URLSearchParams(window.location.search).get('order')
    if (!orderId || !customer.ready || !customer.user) return
    let cancelled = false
    void httpsCallable<unknown, { paymentStatus: string }>(functions, 'checkMidtransPayment')({ orderId })
      .then((result) => {
        if (cancelled) return
        setOrderNotice(
          result.data.paymentStatus === 'paid'
            ? 'Pembayaran berhasil! Pesanan Anda sedang kami proses.'
            : 'Pembayaran belum terkonfirmasi. Jika sudah membayar, status akan diperbarui otomatis.',
        )
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [customer.ready, customer.user])

  const whatsappHref = `https://wa.me/6285176768067?text=${encodeURIComponent('Halo 2goFresh, saya mau tanya produk.')}`

  return (
    <div className="shop">
      <div className="promo">
        <span>
          Jadi <b>Member VIP</b>: gratis ongkir radius {vipFreeShippingKm} km + poin cashback 1%
        </span>
        <a href="#vip">Lihat</a>
      </div>

      <header className="top">
        <a className="brand" href="/" aria-label="2goFresh">
          <img src="/brand/logo.png" alt="" width="40" height="40" />
          <span className="wordmark"><b>2go</b><i>Fresh</i></span>
        </a>
        <nav aria-label="Menu utama">
          <a href="#produk">Produk</a>
          <a href="#vip">VIP</a>
          <a href="#tentang">Tentang</a>
        </nav>
        <div className="top-actions">
          <button type="button" className="icon-btn" onClick={() => setAccount('login')}>
            <span className="account-label-wide">
              {customer.registered ? (customer.profile?.name.split(' ')[0] ?? 'Akun') : 'Masuk / Registrasi'}
            </span>
            <span className="account-label-compact">
              {customer.registered ? (customer.profile?.name.split(' ')[0] ?? 'Akun') : 'Masuk'}
            </span>
          </button>
          <button type="button" className="icon-btn cart-btn" onClick={() => setCartOpen(true)} aria-label="Buka keranjang">
            <span>Keranjang</span> 🛒
            {cartCount > 0 && <b>{cartCount}</b>}
          </button>
        </div>
      </header>

      <section className="hero">
        <span className="veg v1" aria-hidden="true">🥬</span>
        <span className="veg v2" aria-hidden="true">🥕</span>
        <span className="veg v3" aria-hidden="true">🍅</span>
        <span className="veg v4" aria-hidden="true">🥦</span>
        <div className="hero-text">
          <p className="eyebrow">Mitra Terpercaya Kebutuhan Pangan & Sayur Segar Berkualitas · Kota Malang</p>
          <h1>Bahan segar pilihan,<br />sampai di depan pintu.</h1>
          <p>Platform belanja modern terpadu dari 2gofresh Malang yang dirancang khusus untuk memberikan pengalaman transaksi terbaik.</p>
          <ul className="hero-points">
            <li>🌱 Segar setiap hari</li>
            <li>🛵 Kirim instan</li>
            <li>💚 Layanan Offline Store & Online Delivery (Retail & B2B)</li>
          </ul>
          <div className="hero-actions">
            <a className="btn" href="#produk">Belanja sekarang</a>
            <a className="btn ghost light" href={whatsappHref} target="_blank" rel="noreferrer">Tanya via WhatsApp</a>
          </div>
        </div>
      </section>

      <section className="section best" aria-label="Pilihan segar 2goFresh">
        <div className="section-head">
          <h2>🌿 Pilihan Segar 2goFresh</h2>
          <span className="muted small">Pilih produk atau jelajahi kategorinya</span>
        </div>
        <div className="best-grid">
          {bestSellers.map((item) => (
            <button
              key={item.title}
              type="button"
              className="best-card"
              aria-label={`Lihat ${item.product?.name ?? item.title} di kategori ${item.category}`}
              onClick={() => {
                setCategory(item.category)
                setSearch(item.product?.name ?? '')
                setVisible(pageSize)
                document.getElementById('produk')?.scrollIntoView({ behavior: 'smooth' })
              }}
            >
              <span className="best-category">{item.label}</span>
              <span className="best-photo">
                {item.product?.imageUrl ? (
                  <img src={item.product.imageUrl} alt="" loading="lazy" decoding="async" />
                ) : (
                  <span className="best-emoji" aria-hidden="true">{item.emoji}</span>
                )}
              </span>
              <b>{item.title}</b>
              <span className="best-card-meta">
                {item.product ? `${currency.format(item.product.retailPrice)} / ${item.product.unit}` : `${item.categoryCount} produk`}
              </span>
              <small>{item.categoryCount} produk · Lihat pilihan →</small>
            </button>
          ))}
        </div>
      </section>

      {orderNotice && <p className="notice" role="status">{orderNotice}</p>}
      {pending && (
        <div className="pay-pending" role="status">
          <div>
            <b>Pembayaran belum selesai</b>
            <span>Pesanan {pending.orderNo} · sisa waktu <b>{countdown(pending.expiresAt - now)}</b>. Keranjang Anda tetap tersimpan.</span>
          </div>
          <div className="pay-pending-actions">
            <button type="button" className="btn" onClick={() => window.location.assign(pending.redirectUrl)}>Lanjutkan pembayaran</button>
            <button type="button" className="btn ghost" onClick={() => { void releasePending(); setCartOpen(false); document.getElementById('produk')?.scrollIntoView({ behavior: 'smooth' }) }}>Tambah belanjaan</button>
            <button type="button" className="btn ghost" onClick={() => { void releasePending(); setCart({}) }}>Batalkan</button>
          </div>
        </div>
      )}

      <main>
        <section id="produk" className="section">
          <div className="section-head">
            <h2>Produk kami</h2>
            <input
              type="search"
              value={search}
              onChange={(event) => {
                setSearch(event.target.value)
                setVisible(pageSize)
              }}
              placeholder="Cari produk…"
              aria-label="Cari produk"
            />
          </div>
          <div className="chips" role="tablist" aria-label="Kategori">
            {categories.map((name) => (
              <button
                key={name}
                type="button"
                className={name === category ? 'on' : ''}
                onClick={() => {
                  setCategory(name)
                  setVisible(pageSize)
                }}
              >
                {name}
              </button>
            ))}
          </div>
          {status === 'loading' && <p className="muted">Memuat produk…</p>}
          {status === 'error' && <p className="error">Produk belum bisa dimuat. Coba muat ulang halaman.</p>}
          {status === 'ready' && filtered.length === 0 && <p className="muted">Produk tidak ditemukan.</p>}
          <div className="grid">
            {filtered.slice(0, visible).map((product) => (
              <ProductCard key={product.sku} product={product} quantity={cart[product.sku] ?? 0} onChange={(quantity) => setQuantity(product, quantity)} />
            ))}
          </div>
          {visible < filtered.length && (
            <button type="button" className="btn ghost more" onClick={() => setVisible((value) => value + pageSize)}>
              Tampilkan lebih banyak ({filtered.length - visible})
            </button>
          )}
        </section>

        <section id="vip" className="section vip">
          <img src="/brand/vip-card.png" alt="Kartu VIP 2goFresh" loading="lazy" />
          <div>
            <p className="eyebrow">Member VIP</p>
            <h2>Belanja lebih hemat, setiap hari</h2>
            <ul>
              <li><b>Gratis ongkir</b> radius {vipFreeShippingKm} km dari toko (min. belanja {currency.format(vipMinimumPurchase)})</li>
              <li><b>Poin 1%</b> setiap belanja min. {currency.format(vipMinimumPurchase)} — belanja Rp70.000 dapat 700 poin</li>
              <li>Poin bisa ditukar untuk produk di website</li>
              <li>Riwayat belanja tersimpan di akunmu</li>
            </ul>
            <div className="hero-actions">
              {vipProduct ? (
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    if (!customer.registered) return setAccount('register')
                    setQuantity(vipProduct, 1)
                    setCartOpen(true)
                  }}
                >
                  {customer.profile?.vip ? 'Kamu sudah VIP ✓' : `Beli Kartu VIP · ${currency.format(vipProduct.retailPrice)}`}
                </button>
              ) : (
                <a className="btn" href={whatsappHref} target="_blank" rel="noreferrer">Tanya Kartu VIP</a>
              )}
              {!customer.registered && <button type="button" className="btn ghost" onClick={() => setAccount('register')}>Daftar akun</button>}
            </div>
          </div>
        </section>
      </main>

      <footer id="tentang" className="foot">
        <div>
          <strong>2goFresh</strong>
          <p>Tentang Toko Kami</p>
          <p>Grosir & eceran sayur segar, buah pilihan, serta sembako harian. Melayani pembelian Retail dan B2B dengan kualitas terbaik langsung dari tangan pertama. Belanja mudah secara offline maupun online via POS & Marketplace terpadu. Always Fresh, Always Trusted!</p>
          <br />© 2026 2gofresh. All rights reserved.
        </div>
        <div>
          <p>{storeInfo.address}</p>
          <p>WhatsApp <a href={whatsappHref}>{storeInfo.whatsapp}</a></p>
          <p><a href={`mailto:${storeInfo.email}`}>{storeInfo.email}</a></p>
        </div>
        <div>
          <p><a href="https://instagram.com/2gofreshmalang" target="_blank" rel="noreferrer">Instagram {storeInfo.instagram}</a></p>
          <p><a href="https://shopee.co.id/2gofresh" target="_blank" rel="noreferrer">Shopee {storeInfo.shopee}</a></p>
        </div>
      </footer>

      {cartOpen && (
        <div className="drawer-wrap" onClick={() => setCartOpen(false)}>
          <aside className="drawer" role="dialog" aria-label="Keranjang" onClick={(event) => event.stopPropagation()}>
            <header>
              <h2>Keranjang 🛒</h2>
              <button type="button" className="modal-close static" aria-label="Tutup" onClick={() => setCartOpen(false)}>×</button>
            </header>
            <div className="drawer-body">
              {cartLines.length === 0 && <p className="muted">Keranjang 🛒 masih kosong.</p>}
              {cartLines.map(({ product, quantity }) => (
                <div key={product.sku} className="cart-row">
                  <div className="cart-thumb">{product.imageUrl ? <img src={product.imageUrl} alt="" loading="lazy" /> : '🧺'}</div>
                  <div>
                    <strong>{product.name}</strong>
                    <small>{currency.format(product.retailPrice)} / {product.unit}</small>
                    <div className="stepper small">
                      <button type="button" aria-label="Kurangi" onClick={() => { const next = Math.round((quantity - stepFor(product)) * 1000) / 1000; setQuantity(product, next < product.minQty ? 0 : next) }}>−</button>
                      <span>{qtyFormat.format(quantity)} {product.unit}</span>
                      <button type="button" aria-label="Tambah" onClick={() => setQuantity(product, Math.round((quantity + stepFor(product)) * 1000) / 1000)}>+</button>
                    </div>
                  </div>
                  <b>{currency.format(Math.round(product.retailPrice * quantity))}</b>
                </div>
              ))}
            </div>
            <footer>
              <div className="sum"><span>Subtotal</span><b>{currency.format(cartTotal)}</b></div>
              <button type="button" className="btn big" disabled={cartLines.length === 0} onClick={() => { setCartOpen(false); if (pending) void releasePending(); setCheckout(true) }}>Checkout</button>
            </footer>
          </aside>
        </div>
      )}

      {checkout && (
        <Checkout
          key={customer.profile?.phone ?? 'guest'}
          products={productMap}
          cart={cartForCheckout}
          registered={customer.registered}
          profile={customer.profile}
          onClose={() => setCheckout(false)}
          onNeedLogin={() => setAccount('register')}
          onDone={() => setCart({})}
          onPaymentStarted={(started) => {
            const next = { ...started, expiresAt: Date.now() + 58 * 60 * 1000 }
            localStorage.setItem(pendingKey, JSON.stringify(next))
            setPending(next)
          }}
        />
      )}
      {account && (
        <Account
          profile={customer.profile}
          profileLoading={customer.profileLoading}
          displayName={customer.user?.displayName ?? ''}
          uid={customer.user?.uid ?? ''}
          registered={customer.registered}
          startTab={account}
          onClose={() => setAccount(null)}
        />
      )}
      <YubiChat />
    </div>
  )
}

export default App
