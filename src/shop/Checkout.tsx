import { useMemo, useState } from 'react'
import { signInAnonymously } from 'firebase/auth'
import { getStorage, ref, uploadBytes } from 'firebase/storage'
import { httpsCallable } from 'firebase/functions'
import { app } from '../firebase'
import { auth, functions } from '../posFirebase'
import { normalizePhone } from '../retailPricing'
import { maxDeliveryKm, quoteShipping, vipCardSku, vipFreeShippingKm, vipMinimumPurchase, distanceKm } from '../shipping'
import { storeInfo } from '../storeInfo'
import { currency, qtyFormat } from './customer'
import type { CartMap, CustomerProfile, Product } from './customer'
import MapPicker from './MapPicker'
import type { Point } from './MapPicker'

type Props = {
  products: Map<string, Product>
  cart: CartMap
  registered: boolean
  profile: CustomerProfile | null
  onClose: () => void
  onNeedLogin: () => void
  onDone: () => void
  onPaymentStarted: (payment: { orderId: string; orderNo: string; redirectUrl: string }) => void
}

type Done = { orderNo: string; total: number; payment: 'midtrans' | 'qris' }

function Checkout({ products, cart, registered, profile, onClose, onNeedLogin, onDone, onPaymentStarted }: Props) {
  const [name, setName] = useState(profile?.name ?? '')
  const [phone, setPhone] = useState(profile?.phone ?? '')
  const [email, setEmail] = useState(profile?.email ?? '')
  const [fulfillment, setFulfillment] = useState<'delivery' | 'pickup'>('delivery')
  const [point, setPoint] = useState<Point | null>(
    profile && profile.lat !== null && profile.lng !== null ? { lat: profile.lat, lng: profile.lng } : null,
  )
  const [address, setAddress] = useState(profile?.address ?? '')
  const [note, setNote] = useState('')
  const [payment, setPayment] = useState<'midtrans' | 'qris'>('midtrans')
  const [proof, setProof] = useState<File | null>(null)
  const [usePoints, setUsePoints] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState<Done | null>(null)
  const [requestId] = useState(() => crypto.randomUUID())
  const [guest, setGuest] = useState(false)

  const lines = useMemo(
    () =>
      Object.entries(cart)
        .map(([sku, quantity]) => ({ product: products.get(sku), quantity }))
        .filter((line): line is { product: Product; quantity: number } => !!line.product)
        .map((line) => ({ ...line, total: Math.round(line.product.retailPrice * line.quantity) })),
    [cart, products],
  )
  const subtotal = lines.reduce((sum, line) => sum + line.total, 0)
  const hasVipCard = lines.some((line) => line.product.sku.toLowerCase() === vipCardSku)
  const vip = profile?.vip === true
  const km = point ? distanceKm(point.lat, point.lng) : null
  const outOfRange = km !== null && km > maxDeliveryKm
  const shipping =
    fulfillment === 'pickup' ? { fee: 0, free: false } : km !== null ? quoteShipping(km, vip, subtotal) : null
  const pointsUsed = Math.min(Math.max(0, usePoints), profile?.points ?? 0, subtotal)
  const total = subtotal - pointsUsed + (shipping?.fee ?? 0)

  function whatsappOrder() {
    const text = [
      `Halo ${storeInfo.name}, saya mau pesan:`,
      ...lines.map((line) => `- ${line.product.name} ${qtyFormat.format(line.quantity)} ${line.product.unit} = ${currency.format(line.total)}`),
      `Subtotal: ${currency.format(subtotal)}`,
      name ? `Nama: ${name}` : '',
    ]
      .filter(Boolean)
      .join('\n')
    window.open(`https://wa.me/6285176768067?text=${encodeURIComponent(text)}`, '_blank', 'noopener')
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    setError('')
    const normalized = normalizePhone(phone)
    if (name.trim().length < 2) return setError('Nama penerima wajib diisi.')
    if (!normalized) return setError('Nomor WhatsApp tidak valid. Contoh: 081234567890')
    if (hasVipCard && !registered) {
      setError('Untuk membeli Kartu VIP, masuk atau daftar akun dulu.')
      return onNeedLogin()
    }
    if (fulfillment === 'delivery') {
      if (!point) return setError('Tandai titik lokasi pengantaran di peta.')
      if (outOfRange) return setError(`Lokasi di luar jangkauan (maks ${maxDeliveryKm} km dari toko).`)
      if (address.trim().length < 10) return setError('Tulis alamat lengkap (jalan, nomor, RT/RW, patokan).')
    }
    if (payment === 'qris' && !proof) return setError('Unggah bukti pembayaran QRIS terlebih dahulu.')

    setBusy(true)
    try {
      const user = auth.currentUser ?? (await signInAnonymously(auth)).user
      let proofPath = ''
      if (payment === 'qris' && proof) {
        const extension = proof.type === 'image/png' ? 'png' : 'jpg'
        proofPath = `proofs/${user.uid}/${requestId}.${extension}`
        await uploadBytes(ref(getStorage(app), proofPath), proof, { contentType: proof.type })
      }
      const created = await httpsCallable<unknown, { id: string; orderNo: string; total: number }>(
        functions,
        'createWebOrder',
      )({
        requestId,
        items: lines.map((line) => ({ sku: line.product.sku, quantity: line.quantity })),
        name: name.trim(),
        phone: normalized,
        email: email.trim(),
        fulfillment,
        address: fulfillment === 'delivery' ? address.trim() : '',
        lat: point?.lat,
        lng: point?.lng,
        note: note.trim(),
        payment,
        proofPath,
        usePoints: pointsUsed,
      })
      if (payment === 'midtrans') {
        const result = await httpsCallable<unknown, { redirectUrl: string }>(
          functions,
          'createMidtransPayment',
        )({ orderId: created.data.id })
        onPaymentStarted({ orderId: created.data.id, orderNo: created.data.orderNo, redirectUrl: result.data.redirectUrl })
        window.location.assign(result.data.redirectUrl)
        return
      }
      onDone()
      setDone({ orderNo: created.data.orderNo, total: created.data.total, payment })
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Pesanan gagal dibuat. Coba lagi.')
    } finally {
      setBusy(false)
    }
  }

  if (done) {
    return (
      <div className="modal" role="dialog" aria-modal="true">
        <div className="modal-card center">
          <div className="done-mark" aria-hidden="true">✓</div>
          <h2>Pesanan diterima</h2>
          <p><b>{done.orderNo}</b></p>
          <p className="muted">
            Pembayaran {currency.format(done.total)} sedang kami cek. Kami akan memproses pesanan setelah pembayaran terverifikasi dan menghubungi Anda lewat WhatsApp.
          </p>
          <button type="button" className="btn" onClick={onClose}>Selesai</button>
        </div>
      </div>
    )
  }

  if (!registered && !guest) {
    return (
      <div className="modal" role="dialog" aria-modal="true" aria-label="Pilih cara checkout">
        <div className="modal-card center">
          <button type="button" className="modal-close" aria-label="Tutup" onClick={onClose}>×</button>
          <h2>Lanjut ke checkout</h2>
          <p className="muted">Masuk untuk riwayat belanja, poin, dan Member VIP, atau lanjut tanpa akun.</p>
          <div className="choice-stack">
            <button type="button" className="btn" onClick={onNeedLogin}>Masuk / Daftar</button>
            <button type="button" className="btn ghost" onClick={() => setGuest(true)}>Lanjut sebagai tamu</button>
          </div>
          <p className="muted small">Kartu VIP hanya bisa dibeli dengan akun terdaftar.</p>
        </div>
      </div>
    )
  }

  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label="Checkout">
      <form className="modal-card wide" onSubmit={(event) => void submit(event)}>
        <button type="button" className="modal-close" aria-label="Tutup" onClick={onClose}>×</button>
        <h2>Checkout</h2>

        <section className="co-section">
          <h3>1. Data penerima</h3>
          <div className="grid2">
            <label>Nama<input value={name} onChange={(event) => setName(event.target.value)} autoComplete="name" /></label>
            <label>No. WhatsApp<input value={phone} onChange={(event) => setPhone(event.target.value)} inputMode="tel" autoComplete="tel" placeholder="08xxxxxxxxxx" /></label>
          </div>
          <label>Email (opsional)<input type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" /></label>
          {!registered && (
            <p className="muted small">
              Checkout sebagai tamu. <button type="button" className="link" onClick={onNeedLogin}>Masuk / daftar</button> untuk riwayat, poin, dan Member VIP.
            </p>
          )}
        </section>

        <section className="co-section">
          <h3>2. Pengiriman</h3>
          <div className="choice">
            <label className={fulfillment === 'delivery' ? 'on' : ''}>
              <input type="radio" name="ful" checked={fulfillment === 'delivery'} onChange={() => setFulfillment('delivery')} />
              Diantar kurir instan
            </label>
            <label className={fulfillment === 'pickup' ? 'on' : ''}>
              <input type="radio" name="ful" checked={fulfillment === 'pickup'} onChange={() => setFulfillment('pickup')} />
              Ambil di toko
            </label>
          </div>
          {fulfillment === 'delivery' ? (
            <>
              <MapPicker value={point} onChange={setPoint} />
              {point && (
                <p className="map-meta">
                  Jarak ± {km?.toFixed(1)} km dari toko ·{' '}
                  <a href={`https://www.google.com/maps?q=${point.lat},${point.lng}`} target="_blank" rel="noreferrer">Lihat di Google Maps</a>
                </p>
              )}
              {outOfRange && <p className="error">Di luar jangkauan pengantaran (maks {maxDeliveryKm} km).</p>}
              <label>Alamat lengkap
                <textarea rows={3} value={address} onChange={(event) => setAddress(event.target.value)} placeholder="Nama jalan, nomor rumah, RT/RW, kelurahan, patokan" maxLength={300} />
              </label>
              <label>Catatan untuk kurir (opsional)
                <input value={note} onChange={(event) => setNote(event.target.value)} maxLength={200} placeholder="Contoh: pagar hitam, titip satpam" />
              </label>
            </>
          ) : (
            <p className="muted">Ambil pesanan di {storeInfo.address}.</p>
          )}
        </section>

        {registered && (profile?.points ?? 0) > 0 && (
          <section className="co-section">
            <h3>Tukar poin</h3>
            <p className="muted small">Poin Anda: {profile?.points.toLocaleString('id-ID')} (1 poin = Rp1)</p>
            <div className="points-row">
              <input type="number" min={0} max={Math.min(profile?.points ?? 0, subtotal)} value={usePoints || ''} onChange={(event) => setUsePoints(Number(event.target.value) || 0)} placeholder="0" aria-label="Poin yang dipakai" />
              <button type="button" className="btn ghost" onClick={() => setUsePoints(Math.min(profile?.points ?? 0, subtotal))}>Pakai semua</button>
            </div>
          </section>
        )}

        <section className="co-section">
          <h3>3. Pembayaran</h3>
          <div className="choice">
            <label className={payment === 'midtrans' ? 'on' : ''}>
              <input type="radio" name="pay" checked={payment === 'midtrans'} onChange={() => setPayment('midtrans')} />
              Bayar online (Otomatis)
              <small>QRIS, e-wallet, transfer bank, kartu · langsung valid</small>
            </label>
            <label className={payment === 'qris' ? 'on' : ''}>
              <input type="radio" name="pay" checked={payment === 'qris'} onChange={() => setPayment('qris')} />
              QRIS toko (manual)
              <small>Unggah bukti bayar · dicek kasir</small>
            </label>
          </div>
          {payment === 'qris' && (
            <div className="qris-box">
              <img src="/brand/qris.jpeg" alt="QRIS 2goFresh" />
              <div>
                <p>Scan QRIS, bayar <b>{currency.format(total)}</b>, lalu unggah bukti pembayaran.</p>
                <label className="file">
                  <input type="file" accept="image/png,image/jpeg" onChange={(event) => setProof(event.target.files?.[0] ?? null)} />
                </label>
                {proof && <small className="muted">{proof.name}</small>}
              </div>
            </div>
          )}
        </section>

        <section className="co-summary">
          {lines.map((line) => (
            <div key={line.product.sku}>
              <span>{line.product.name} × {qtyFormat.format(line.quantity)} {line.product.unit}</span>
              <span>{currency.format(line.total)}</span>
            </div>
          ))}
          <div><span>Subtotal</span><span>{currency.format(subtotal)}</span></div>
          {pointsUsed > 0 && <div><span>Tukar poin</span><span>−{currency.format(pointsUsed)}</span></div>}
          <div>
            <span>Ongkos kirim</span>
            <span>
              {fulfillment === 'pickup'
                ? 'Gratis'
                : shipping === null
                  ? 'Pilih lokasi'
                  : shipping.free
                    ? 'GRATIS (VIP)'
                    : currency.format(shipping.fee)}
            </span>
          </div>
          {fulfillment === 'delivery' && !vip && (
            <small className="muted">Member VIP: gratis ongkir radius {vipFreeShippingKm} km, min. belanja {currency.format(vipMinimumPurchase)}.</small>
          )}
          <div className="grand"><span>Total</span><span>{currency.format(total)}</span></div>
        </section>

        {error && <p className="error" role="alert">{error}</p>}
        <button type="submit" className="btn big" disabled={busy || lines.length === 0}>
          {busy ? 'Memproses...' : payment === 'midtrans' ? 'Bayar sekarang' : 'Kirim pesanan'}
        </button>
        <button type="button" className="link center-link" onClick={whatsappOrder}>Atau pesan lewat WhatsApp</button>
      </form>
    </div>
  )
}

export default Checkout
