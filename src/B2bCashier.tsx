import { useMemo, useRef, useState } from 'react'
import './RetailCashier.css'
import PrinterGate from './PrinterGate'
import { printReceipt, printReceiptViaBrowser, reconnectKnownPrinter, usePrinter } from './printer'
import { paidReceiptText, whatsappLink } from './receiptText'
import CashInput from './CashInput'
import { StoreContact, StoreQr } from './StoreQr'
import { normalizePhone, parseDecimal, parseNumber, priceB2bLine } from './retailPricing'
import type { CartLine, RetailProduct } from './retailPricing'
import { useOnlineStatus } from './offlineSales'
import type { SaleDraft } from './offlineSales'

export type B2bMember = { phone: string; name: string; active: boolean }

export type B2bSaleRequest = {
  items: { sku: string; quantity: number }[]
  memberPhone: string
  paymentMethod: 'cash' | 'transfer' | 'qris'
  cashReceived?: number
  paymentReference?: string
  requestId: string
}

export type B2bReceipt = {
  receiptNo: string
  items: { sku: string; name: string; unit: string; quantity: number; total: number }[]
  total: number
  paymentMethod: 'cash' | 'transfer' | 'qris'
  cashReceived: number | null
  paymentReference: string | null
  change: number
  memberPhone: string
  memberName: string
  cashierName: string
  createdAtIso: string
  // Struk sementara: penjualan dicatat saat offline dan belum dikirim ke server.
  offlinePending?: boolean
}

type Props = {
  products: RetailProduct[]
  stockBySku: Record<string, number | undefined>
  members: B2bMember[]
  cart: CartLine[]
  setCart: React.Dispatch<React.SetStateAction<CartLine[]>>
  phone: string
  setPhone: (value: string) => void
  resumedLabel: string | null
  onSale: (request: B2bSaleRequest, draft: SaleDraft) => Promise<B2bReceipt>
  onPend: (memberPhone: string, memberName: string) => Promise<void>
}

const currency = new Intl.NumberFormat('id-ID', {
  style: 'currency',
  currency: 'IDR',
  maximumFractionDigits: 0,
})
const quantityFormat = new Intl.NumberFormat('id-ID', { maximumFractionDigits: 3 })
const referencePattern = /^[A-Za-z0-9][A-Za-z0-9._/-]{5,39}$/

function B2bCashier({
  products,
  stockBySku,
  members,
  cart,
  setCart,
  phone,
  setPhone,
  resumedLabel,
  onSale,
  onPend,
}: Props) {
  const [search, setSearch] = useState('')
  const [method, setMethod] = useState<'cash' | 'transfer' | 'qris'>('transfer')
  const [cashInput, setCashInput] = useState('')
  const [reference, setReference] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [receipt, setReceipt] = useState<B2bReceipt | null>(null)
  const [printMessage, setPrintMessage] = useState('')
  const [printerPrompt, setPrinterPrompt] = useState(false)
  const printer = usePrinter()
  const online = useOnlineStatus()
  const requestIdRef = useRef<string | null>(null)

  const productBySku = useMemo(
    () => new Map(products.map((product) => [product.sku, product])),
    [products],
  )
  const visible = useMemo(() => {
    const term = search.trim().toLowerCase()
    const matches = term
      ? products.filter(
          (product) =>
            product.name.toLowerCase().includes(term) || product.sku.toLowerCase().includes(term),
        )
      : products
    return matches.slice(0, 80)
  }, [products, search])

  const normalizedPhone = normalizePhone(phone)
  const member = normalizedPhone
    ? members.find((item) => item.phone === normalizedPhone)
    : undefined
  const memberValid = member?.active === true

  const priced = cart.map((line) => {
    const product = productBySku.get(line.sku)
    return { line, product, result: product ? priceB2bLine(product, line) : null }
  })
  const total = priced.reduce((sum, row) => sum + (row.result?.total ?? 0), 0)
  // Saat offline, stok di tablet hanya salinan terakhir: penjualan tetap boleh dan stok minus ditandai setelah sinkron.
  const stockProblem = online && priced.some((row) => {
    if (!row.product || !row.result) return false
    const stock = stockBySku[row.product.sku.toLowerCase()]
    return stock === undefined || stock < row.result.quantity
  })
  const cashValue = parseNumber(cashInput)
  const cartReady = cart.length > 0 && priced.every((row) => row.result !== null) && !stockProblem
  const paymentReady =
    method === 'cash'
      ? Number.isFinite(cashValue) && cashValue >= total
      : !online || referencePattern.test(reference.trim())
  const canPay = cartReady && memberValid && paymentReady && !busy
  const canPend = cart.length > 0 && memberValid && priced.every((row) => row.result !== null) && !busy

  function addProduct(product: RetailProduct) {
    setReceipt(null)
    setCart((current) =>
      current.some((line) => line.sku === product.sku)
        ? current.map((line) => {
            if (line.sku !== product.sku) return line
            const next = parseDecimal(line.input)
            return Number.isFinite(next)
              ? { ...line, input: String(Math.round((next + 1) * 1000) / 1000) }
              : line
          })
        : [...current, { sku: product.sku, mode: 'quantity', input: '1' }],
    )
  }

  async function pend() {
    if (!canPend || !member) return
    setBusy(true)
    setError('')
    try {
      await onPend(member.phone, member.name)
      setReference('')
      setCashInput('')
      requestIdRef.current = null
    } catch (pendError) {
      setError(pendError instanceof Error ? pendError.message : 'Pending order gagal disimpan.')
    } finally {
      setBusy(false)
    }
  }

  async function printSale(sale: B2bReceipt) {
    if (printer.status !== 'connected') {
      try {
        printReceiptViaBrowser(sale)
        setPrintMessage('Printer Bluetooth belum terhubung, struk dibuka lewat dialog cetak browser.')
      } catch (printError) {
        setPrintMessage(printError instanceof Error ? printError.message : 'Cetak gagal.')
      }
      return
    }
    try {
      await printReceipt(sale)
      setPrintMessage('Struk dikirim ke printer.')
    } catch (printError) {
      setPrintMessage(printError instanceof Error ? printError.message : 'Cetak gagal.')
    }
  }

  async function pay() {
    if (!canPay) return
    if (printer.status !== 'connected') {
      setBusy(true)
      const restored = await reconnectKnownPrinter()
      setBusy(false)
      if (!restored) {
        setPrinterPrompt(true)
        return
      }
    }
    await submitSale()
  }

  async function submitSale() {
    if (!canPay || !member) return
    setPrinterPrompt(false)
    setBusy(true)
    setError('')
    requestIdRef.current ??= crypto.randomUUID()
    try {
      // Konfirmasi manual saat offline: nomor referensi dibuat otomatis jika kasir tidak mengisinya.
      const enteredReference = reference.trim().toUpperCase()
      const paymentReference = method === 'cash'
        ? undefined
        : (enteredReference || `MANUAL-${requestIdRef.current.slice(0, 8).toUpperCase()}`)
      const draft: SaleDraft = {
        items: priced.map(({ product, result }) => ({
          sku: product!.sku,
          name: product!.name,
          unit: product!.unit,
          quantity: result!.quantity,
          total: result!.total,
        })),
        total,
        change: method === 'cash' ? Math.max(0, cashValue - total) : 0,
        extra: {
          memberPhone: member.phone,
          memberName: member.name,
          paymentReference: paymentReference ?? null,
        },
      }
      const sale = await onSale({
        items: priced.map(({ line, result }) => ({ sku: line.sku, quantity: result!.quantity })),
        memberPhone: member.phone,
        paymentMethod: method,
        cashReceived: method === 'cash' ? cashValue : undefined,
        paymentReference,
        requestId: requestIdRef.current,
      }, draft)
      requestIdRef.current = null
      setReceipt(sale)
      setPrintMessage('')
      void printSale(sale)
      setCart([])
      setPhone('')
      setCashInput('')
      setReference('')
    } catch (saleError) {
      setError(saleError instanceof Error ? saleError.message : 'Transaksi gagal disimpan.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="rc-layout">
      <section className="rc-card rc-products">
        <div className="rc-card-head">
          <div>
            <h2>Kasir B2B</h2>
            <p>Harga grosir member B2B. Klik produk untuk memasukkan ke keranjang</p>
          </div>
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Cari SKU atau Nama Produk..."
            aria-label="Cari SKU atau nama produk"
          />
        </div>
        <div className="rc-table-wrap">
          <table>
            <thead>
              <tr>
                <th>SKU</th>
                <th>Nama Produk</th>
                <th>Harga B2B</th>
                <th>Stok</th>
                <th>Aksi</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((product) => {
                const stock = stockBySku[product.sku.toLowerCase()]
                return (
                  <tr key={product.sku}>
                    <td className="rc-sku">{product.sku}</td>
                    <td>{product.name}</td>
                    <td className="rc-price">
                      {currency.format(product.retailPrice)}
                      <small>/{product.unit}</small>
                    </td>
                    <td>{stock === undefined ? '–' : `${quantityFormat.format(stock)} ${product.unit}`}</td>
                    <td>
                      <button
                        type="button"
                        className="rc-add"
                        disabled={online && !stock}
                        onClick={() => addProduct(product)}
                      >
                        + Tambah
                      </button>
                    </td>
                  </tr>
                )
              })}
              {visible.length === 0 && (
                <tr>
                  <td colSpan={5} className="rc-empty">
                    {products.length === 0
                      ? 'Harga B2B belum tersedia. Pastikan kolom L di sheet terisi.'
                      : 'Produk tidak ditemukan.'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="rc-card rc-cart">
        <div className="rc-card-head">
          <h2>
            Keranjang B2B
            {resumedLabel !== null && (
              <small className="rc-resumed"> · dari pending{resumedLabel ? `: ${resumedLabel}` : ''}</small>
            )}
          </h2>
          {cart.length > 0 && (
            <button type="button" className="rc-link" onClick={() => setCart([])}>Kosongkan</button>
          )}
        </div>

        <ol className="rc-steps" aria-label="Langkah kasir">
          <li>Isi HP member</li>
          <li>Pilih produk</li>
          <li>Selesai &amp; Cetak</li>
        </ol>

        <label className="rc-cash b2b-member">
          <span>No. HP Member B2B (wajib)</span>
          <input
            inputMode="tel"
            value={phone}
            onChange={(event) => setPhone(event.target.value)}
            placeholder="08xxxxxxxxxx"
            autoComplete="off"
          />
          {phone.trim() !== '' && (
            <small className={memberValid ? 'b2b-ok' : 'rc-warning'}>
              {!normalizedPhone
                ? 'Format nomor HP tidak valid.'
                : !member
                  ? 'Nomor ini belum terdaftar sebagai member B2B.'
                  : !member.active
                    ? `${member.name} dinonaktifkan.`
                    : `✓ Member: ${member.name}`}
            </small>
          )}
        </label>

        <div className="rc-cart-lines">
          {cart.length === 0 && <p className="rc-empty">Keranjang B2B kosong</p>}
          {priced.map(({ line, product, result }) => {
            if (!product) return null
            const stock = stockBySku[product.sku.toLowerCase()] ?? 0
            return (
              <article key={line.sku} className="rc-line">
                <header>
                  <strong>{product.name}</strong>
                  <button
                    type="button"
                    className="rc-remove"
                    aria-label={`Hapus ${product.name}`}
                    onClick={() => setCart((current) => current.filter((item) => item.sku !== line.sku))}
                  >
                    ×
                  </button>
                </header>
                <div className="rc-line-controls">
                  <label>
                    <input
                      inputMode="decimal"
                      value={line.input}
                      onChange={(event) =>
                        setCart((current) =>
                          current.map((item) =>
                            item.sku === line.sku ? { ...item, input: event.target.value } : item,
                          ),
                        )
                      }
                      aria-label={`Jumlah ${product.unit}`}
                    />
                    <span>{product.unit}</span>
                  </label>
                  <strong className="rc-line-total">{result ? currency.format(result.total) : '–'}</strong>
                </div>
                <p className="rc-hint">{currency.format(product.retailPrice)}/{product.unit}</p>
                {!result && <p className="rc-warning">Jumlah belum valid.</p>}
                {result && online && stock < result.quantity && (
                  <p className="rc-warning">Stok hanya {quantityFormat.format(stock)} {product.unit}.</p>
                )}
                {result && !online && stock < result.quantity && (
                  <p className="rc-hint">Offline: stok di tablet tinggal {quantityFormat.format(stock)} {product.unit}; penjualan tetap dicatat dan ditandai untuk dicek.</p>
                )}
              </article>
            )
          })}
        </div>

        <div className="rc-total"><span>TOTAL TAGIHAN:</span><strong>{currency.format(total)}</strong></div>

        <div className="rc-payment">
          <span>Metode Pembayaran</span>
          <div className="b2b-methods">
            <button type="button" className={method === 'transfer' ? 'active' : ''} onClick={() => setMethod('transfer')}>
              TRANSFER
            </button>
            <button type="button" className={method === 'cash' ? 'active' : ''} onClick={() => setMethod('cash')}>
              TUNAI
            </button>
            <button type="button" className={method === 'qris' ? 'active' : ''} onClick={() => setMethod('qris')}>
              QRIS / EDC
            </button>
          </div>
          {method === 'qris' && (
            <details className="rc-qris-show" open>
              <summary>QRIS toko (tunjukkan ke pembeli)</summary>
              <img src="/brand/qris.jpeg" alt="QRIS 2GOFRESH" />
            </details>
          )}
          {method === 'cash' ? (
            <CashInput value={cashInput} onChange={setCashInput} total={total} />
          ) : (
            <label className="rc-cash">
              <span>{method === 'transfer' ? 'No. Referensi Bukti Transfer' : 'No. Transaksi QRIS/EDC'}{online ? ' (wajib)' : ' (boleh kosong saat offline)'}</span>
              <input
                value={reference}
                onChange={(event) => setReference(event.target.value)}
                placeholder="Nomor referensi pada bukti pembayaran"
                maxLength={40}
                autoComplete="off"
              />
              <small className="rc-hint">
                {online
                  ? 'Belum ada bukti pembayaran valid? Klik Pending Order, lalu kirim tagihan via WhatsApp dari panel Pending Order.'
                  : 'Offline: pastikan pembayaran sudah masuk (cek mutasi/notifikasi), lalu konfirmasi manual. Nomor dibuat otomatis jika dikosongkan.'}
              </small>
            </label>
          )}
        </div>

        {error && <p className="rc-warning" role="alert">{error}</p>}
        <div className="rc-actions">
          <button type="button" className="rc-pending" disabled={!canPend} onClick={pend}>
            Pending Order
          </button>
          <button type="button" className="rc-pay" disabled={!canPay} onClick={pay}>
            {busy ? 'Memproses...' : 'Selesai & Cetak'}
          </button>
        </div>
      </section>

      {printerPrompt && (
        <div className="rc-modal" role="dialog" aria-modal="true" aria-label="Hubungkan printer">
          <PrinterGate
            displayName="kasir"
            eyebrow="SEBELUM CETAK STRUK · SEKALI SAJA"
            continueLabel="Lanjut bayar & cetak struk"
            onContinue={() => void submitSale()}
            skipLabel="Bayar tanpa cetak struk"
            onSkip={() => void submitSale()}
          />
          <button type="button" className="rc-prompt-cancel" onClick={() => setPrinterPrompt(false)}>
            Batal
          </button>
        </div>
      )}

      {receipt && (
        <div className="rc-modal" role="dialog" aria-modal="true" aria-label="Struk">
          <div className="rc-receipt">
            <h3>2GoFresh</h3>
            <StoreContact />
            <p><strong>STRUK LUNAS B2B</strong></p>
            <p>{receipt.receiptNo}</p>
            {receipt.offlinePending && (
              <p className="rc-hint"><strong>Struk sementara (offline).</strong> Nomor final dibuat setelah data terkirim ke server.</p>
            )}
            <p>{new Date(receipt.createdAtIso).toLocaleString('id-ID')} · Kasir {receipt.cashierName}</p>
            <p>Member B2B: {receipt.memberName}</p>
            <hr />
            {receipt.items.map((item) => (
              <div key={item.sku} className="rc-receipt-row">
                <span>{item.name}<small>{quantityFormat.format(item.quantity)} {item.unit}</small></span>
                <span>{currency.format(item.total)}</span>
              </div>
            ))}
            <hr />
            <div className="rc-receipt-row"><strong>Total</strong><strong>{currency.format(receipt.total)}</strong></div>
            <div className="rc-receipt-row">
              <span>{{ cash: 'Tunai', transfer: 'Transfer', qris: 'QRIS / EDC' }[receipt.paymentMethod]}</span>
              <span>{currency.format(receipt.cashReceived ?? receipt.total)}</span>
            </div>
            {receipt.paymentReference && (
              <div className="rc-receipt-row"><span>No. Ref</span><span>{receipt.paymentReference}</span></div>
            )}
            {receipt.paymentMethod === 'cash' && (
              <div className="rc-receipt-row"><span>Kembali</span><span>{currency.format(receipt.change)}</span></div>
            )}
            <p className="rc-thanks"><strong>STATUS: LUNAS</strong></p>
            <StoreQr />
            {printMessage && <p className="rc-hint" role="status">{printMessage}</p>}
            <div className="rc-receipt-actions">
              <button type="button" onClick={() => void printSale(receipt)}>Cetak ulang</button>
              <button
                type="button"
                onClick={() =>
                  window.open(
                    whatsappLink(
                      receipt.memberPhone,
                      paidReceiptText({ ...receipt, channel: 'b2b', customerName: receipt.memberName }),
                    ),
                    '_blank',
                    'noopener',
                  )
                }
              >
                Kirim WA
              </button>
              <button type="button" onClick={() => setReceipt(null)}>Transaksi baru</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default B2bCashier
