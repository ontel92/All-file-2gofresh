import { useMemo, useState } from 'react'
import './Panels.css'
import {
  catalogWhatsAppText,
  downloadCatalogExcel,
  downloadCatalogPdf,
  rowsForKind,
} from './catalogExport'
import type { CatalogKind, CatalogRow } from './catalogExport'
import { normalizePhone } from './retailPricing'
import { whatsappLink } from './receiptText'
import { storeInfo } from './storeInfo'

type Props = {
  products: { sku: string; name: string; category: string; unit: string; minQty: number; retailPrice: number }[]
  b2bPrices: Record<string, number>
}

const currency = new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', maximumFractionDigits: 0 })
const maxWhatsAppChars = 3000

const kinds: { id: CatalogKind; label: string; hint: string }[] = [
  { id: 'retail', label: 'Retail', hint: 'Harga retail + minimal beli' },
  { id: 'b2b', label: 'B2B', hint: 'Harga B2B, tanpa minimal beli' },
  { id: 'both', label: 'Retail + B2B', hint: 'Dua harga dalam satu katalog' },
]

function CatalogPanel({ products, b2bPrices }: Props) {
  const [kind, setKind] = useState<CatalogKind>('retail')
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [phone, setPhone] = useState('')
  const [busy, setBusy] = useState('')
  const [message, setMessage] = useState('')

  const rows = useMemo<CatalogRow[]>(
    () =>
      products.map((product) => ({
        ...product,
        b2bPrice: b2bPrices[product.sku.toLowerCase()] ?? null,
      })),
    [products, b2bPrices],
  )
  const available = useMemo(() => rowsForKind(rows, kind), [rows, kind])
  const categories = useMemo(
    () => [...new Set(available.map((row) => row.category))].sort((a, b) => a.localeCompare(b, 'id')),
    [available],
  )
  const visible = useMemo(() => {
    const term = search.trim().toLowerCase()
    return term
      ? available.filter((row) => row.name.toLowerCase().includes(term) || row.sku.toLowerCase().includes(term))
      : available
  }, [available, search])

  const chosen = useMemo(() => available.filter((row) => selected.has(row.sku)), [available, selected])
  const normalizedPhone = phone.trim() === '' ? null : normalizePhone(phone)
  const phoneInvalid = phone.trim() !== '' && !normalizedPhone
  const allVisibleSelected = visible.length > 0 && visible.every((row) => selected.has(row.sku))

  function toggleMany(skus: string[], on: boolean) {
    setSelected((current) => {
      const next = new Set(current)
      for (const sku of skus) {
        if (on) next.add(sku)
        else next.delete(sku)
      }
      return next
    })
  }

  function toggleCategory(category: string) {
    const skus = available.filter((row) => row.category === category).map((row) => row.sku)
    toggleMany(skus, !skus.every((sku) => selected.has(sku)))
  }

  async function run(label: string, task: () => Promise<void>) {
    setBusy(label)
    setMessage('')
    try {
      await task()
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Gagal membuat katalog.')
    } finally {
      setBusy('')
    }
  }

  async function sendWhatsApp() {
    const text = catalogWhatsAppText(chosen, kind)
    const target = normalizedPhone ?? ''
    if (text.length <= maxWhatsAppChars) {
      window.open(whatsappLink(target, text), '_blank', 'noopener')
      return
    }
    // Daftar terlalu panjang untuk teks WA: unduh PDF, lalu buka chat dengan pesan singkat + info toko.
    await downloadCatalogPdf(chosen, kind)
    const short = [
      `Halo, berikut katalog harga ${storeInfo.name} (file PDF terlampir).`,
      '',
      `*${storeInfo.name}*`,
      storeInfo.address,
      `WA: ${storeInfo.whatsapp}`,
      `Email: ${storeInfo.email}`,
      `IG: ${storeInfo.instagram} | Shopee: ${storeInfo.shopee}`,
      `${storeInfo.qrCaption}: ${storeInfo.websiteUrl}`,
    ].join('\n')
    window.open(whatsappLink(target, short), '_blank', 'noopener')
    setMessage('Daftar terlalu panjang untuk teks WA. PDF sudah diunduh: lampirkan file PDF itu di chat WhatsApp yang terbuka.')
  }

  const disabled = chosen.length === 0 || busy !== ''

  return (
    <div className="ct-page">
      <div className="pos-page-heading">
        <div>
          <p className="pos-eyebrow">KATALOG</p>
          <h1>Katalog produk</h1>
          <p>1) Pilih jenis katalog. 2) Centang produk. 3) Unduh atau kirim ke WhatsApp.</p>
        </div>
      </div>

      <section className="ct-card">
        <h2>1. Jenis katalog</h2>
        <div className="ct-kinds" role="group" aria-label="Jenis katalog">
          {kinds.map((item) => (
            <button
              key={item.id}
              type="button"
              className={kind === item.id ? 'active' : ''}
              onClick={() => setKind(item.id)}
            >
              <strong>{item.label}</strong>
              <small>{item.hint}</small>
            </button>
          ))}
        </div>
      </section>

      <section className="ct-card">
        <div className="ct-head">
          <h2>2. Pilih produk <span className="ct-count">{chosen.length} dipilih dari {available.length}</span></h2>
          <div className="ct-head-actions">
            <button type="button" onClick={() => toggleMany(visible.map((row) => row.sku), !allVisibleSelected)}>
              {allVisibleSelected ? 'Batal pilih semua' : search.trim() ? 'Pilih hasil pencarian' : 'Pilih semua produk'}
            </button>
            {selected.size > 0 && (
              <button type="button" onClick={() => setSelected(new Set())}>Kosongkan</button>
            )}
          </div>
        </div>

        <div className="ct-chips" aria-label="Pilih per kategori">
          {categories.map((category) => {
            const skus = available.filter((row) => row.category === category)
            const all = skus.every((row) => selected.has(row.sku))
            const some = skus.some((row) => selected.has(row.sku))
            return (
              <button
                key={category}
                type="button"
                className={all ? 'active' : some ? 'partial' : ''}
                onClick={() => toggleCategory(category)}
              >
                {category} <span>{skus.length}</span>
              </button>
            )
          })}
        </div>

        <input
          className="ct-search"
          type="search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Cari nama produk..."
          aria-label="Cari nama produk"
        />

        <div className="ct-list">
          {visible.length === 0 && <p className="ct-empty">Tidak ada produk.</p>}
          {visible.map((row) => (
            <label key={row.sku} className={selected.has(row.sku) ? 'on' : ''}>
              <input
                type="checkbox"
                checked={selected.has(row.sku)}
                onChange={(event) => toggleMany([row.sku], event.target.checked)}
              />
              <span className="ct-name">
                {row.name}
                <small>{row.category} · {row.unit}</small>
              </span>
              <span className="ct-prices">
                {kind !== 'b2b' && (
                  <span>
                    {currency.format(row.retailPrice)}
                    <small>min {new Intl.NumberFormat('id-ID', { maximumFractionDigits: 3 }).format(row.minQty)} {row.unit}</small>
                  </span>
                )}
                {kind !== 'retail' && (
                  <span>{row.b2bPrice === null ? '-' : currency.format(row.b2bPrice)}<small>B2B</small></span>
                )}
              </span>
            </label>
          ))}
        </div>
      </section>

      <section className="ct-card">
        <h2>3. Unduh atau kirim</h2>
        <p className="ct-note">Semua hasil otomatis memuat info toko: alamat, WhatsApp, email, Instagram, dan barcode {storeInfo.websiteLabel}.</p>
        <div className="ct-actions">
          <button
            type="button"
            disabled={disabled}
            onClick={() => void run('xlsx', () => downloadCatalogExcel(chosen, kind))}
          >
            {busy === 'xlsx' ? 'Membuat...' : 'Unduh Excel'}
          </button>
          <button
            type="button"
            disabled={disabled}
            onClick={() => void run('pdf', () => downloadCatalogPdf(chosen, kind))}
          >
            {busy === 'pdf' ? 'Membuat...' : 'Unduh PDF'}
          </button>
        </div>
        <label className="ct-phone">
          <span>No. WhatsApp calon pembeli</span>
          <input
            inputMode="tel"
            value={phone}
            onChange={(event) => setPhone(event.target.value)}
            placeholder="08xxxxxxxxxx (kosongkan untuk pilih kontak di WhatsApp)"
          />
          {phoneInvalid && <small className="ct-error">Nomor tidak valid.</small>}
        </label>
        <button
          type="button"
          className="ct-wa"
          disabled={disabled || phoneInvalid}
          onClick={() => void run('wa', sendWhatsApp)}
        >
          {busy === 'wa' ? 'Menyiapkan...' : 'Kirim ke WhatsApp'}
        </button>
        {chosen.length === 0 && <p className="ct-note">Centang minimal satu produk dulu.</p>}
        {message && <p className="ct-note" role="status">{message}</p>}
      </section>
    </div>
  )
}

export default CatalogPanel
