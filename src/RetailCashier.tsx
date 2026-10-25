import { useMemo, useRef, useState } from 'react'
import './RetailCashier.css'
import CashInput from './CashInput'
import PrinterGate from './PrinterGate'
import { printReceipt, printReceiptViaBrowser, reconnectKnownPrinter, usePrinter } from './printer'
import { StoreContact, StoreQr } from './StoreQr'
import { paidReceiptText, whatsappLink } from './receiptText'
import { normalizePhone, parseDecimal, parseNumber, priceLine, retailPerKg } from './retailPricing'
import type { CartLine, RetailProduct } from './retailPricing'
import { useOnlineStatus } from './offlineSales'
import type { SaleDraft } from './offlineSales'

export type SaleReceipt = {
  receiptNo: string
  items: { sku: string; name: string; unit: string; quantity: number; total: number }[]
  total: number
  paymentMethod: 'cash' | 'qris'
  cashReceived: number | null
  qrisReference?: string | null
  change: number
  cashierName: string
  createdAtIso: string
  channel?: 'retail'
  memberName?: string
  memberPhone?: string
  // Struk sementara: penjualan dicatat saat offline dan belum dikirim ke server.
  offlinePending?: boolean
}

export type SaleRequest = {
  items: { sku: string; mode: 'quantity' | 'nominal'; quantity?: number; amount?: number }[]
  paymentMethod: 'cash' | 'qris'
  cashReceived?: number
  qrisReference?: string
  requestId: string
}

type Props = {
  products: RetailProduct[]
  stockBySku: Record<string, number | undefined>
  cart: CartLine[]
  setCart: React.Dispatch<React.SetStateAction<CartLine[]>>
  resumedLabel: string | null
  waPhone: string
  setWaPhone: (value: string) => void
  onSale: (request: SaleRequest, draft: SaleDraft) => Promise<SaleReceipt>
  onPend: (label: string, waPhone: string) => Promise<void>
}

const currency = new Intl.NumberFormat('id-ID', {
  style: 'currency',
  currency: 'IDR',
  maximumFractionDigits: 0,
})
const quantityFormat = new Intl.NumberFormat('id-ID', { maximumFractionDigits: 3 })

function RetailCashier({
  products,
  stockBySku,
  cart,
  setCart,
  resumedLabel,
  waPhone,
  setWaPhone,
  onSale,
  onPend,
}: Props) {
  const [search, setSearch] = useState('')
  const [pendingLabel, setPendingLabel] = useState('')
  const [method, setMethod] = useState<'cash' | 'qris'>('cash')
  const [cashInput, setCashInput] = useState('')
  const [qrisReference, setQrisReference] = useState('')
  const [paying, setPaying] = useState(false)
  const [error, setError] = useState('')
  const [receipt, setReceipt] = useState<SaleReceipt | null>(null)
  const [orderSource, setOrderSource] = useState<'offline' | 'wa'>(waPhone ? 'wa' : 'offline')
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

  const priced = cart.map((line) => {
    const product = productBySku.get(line.sku)
    return { line, product, result: product ? priceLine(product, line) : null }
  })
  const total = priced.reduce((sum, row) => sum + (row.result?.total ?? 0), 0)
  // Saat offline, stok di tablet hanya salinan terakhir: penjualan tetap boleh dan stok minus ditandai setelah sinkron.
  const stockProblem = online ? priced.find((row) => {
    if (!row.product || !row.result) return false
    const stock = stockBySku[row.product.sku.toLowerCase()]
    return stock === undefined || stock < row.result.quantity
  }) : undefined
  const normalizedWa = waPhone.trim() === '' ? null : normalizePhone(waPhone)
  const waInvalid = orderSource === 'wa' && !normalizedWa
  const cashValue = parseNumber(cashInput)
  const canPay =
    cart.length > 0 &&
    !waInvalid &&
    priced.every((row) => row.result !== null) &&
    !stockProblem &&
    !paying &&
    (method === 'qris'
      ? !online || /^[A-Za-z0-9][A-Za-z0-9._/-]{5,39}$/.test(qrisReference.trim())
      : Number.isFinite(cashValue) && cashValue >= total)

  function chooseSource(next: 'offline' | 'wa') {
    setOrderSource(next)
    if (next === 'offline') setWaPhone('')
  }

  function addProduct(product: RetailProduct) {
    setReceipt(null)
    setCart((current) =>
      current.some((line) => line.sku === product.sku)
        ? current.map((line) => {
            if (line.sku !== product.sku || line.mode === 'nominal') return line
            const next = parseDecimal(line.input)
            return Number.isFinite(next) ? { ...line, input: String(Math.round((next + 1) * 1000) / 1000) } : line
          })
        : [...current, { sku: product.sku, mode: 'quantity', input: '1' }],
    )
  }

  function updateLine(sku: string, patch: Partial<CartLine>) {
    setCart((current) => current.map((line) => (line.sku === sku ? { ...line, ...patch } : line)))
  }

  async function pend() {
    if (cart.length === 0 || paying) return
    setPaying(true)
    setError('')
    try {
      await onPend(pendingLabel.trim(), normalizedWa ?? '')
      setPendingLabel('')
      setCashInput('')
      requestIdRef.current = null
    } catch (pendError) {
      setError(pendError instanceof Error ? pendError.message : 'Pending order gagal disimpan.')
    } finally {
      setPaying(false)
    }
  }

  async function printSale(sale: SaleReceipt) {
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
      setPaying(true)
      const restored = await reconnectKnownPrinter()
      setPaying(false)
      if (!restored) {
        setPrinterPrompt(true)
        return
      }
    }
    await submitSale()
  }

  async function submitSale() {
    setPrinterPrompt(false)
    setPaying(true)
    setError('')
    requestIdRef.current ??= crypto.randomUUID()
    try {
      // Konfirmasi QRIS manual saat offline: nomor referensi dibuat otomatis jika kasir tidak mengisinya.
      const enteredReference = qrisReference.trim().toUpperCase()
      const reference = method === 'qris'
        ? (enteredReference || `MANUAL-${requestIdRef.current.slice(0, 8).toUpperCase()}`)
        : undefined
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
        extra: reference ? { qrisReference: reference } : undefined,
      }
      const sale = await onSale({
        items: priced.map(({ line, result }) =>
          line.mode === 'nominal'
            ? { sku: line.sku, mode: 'nominal', amount: result!.total }
            : { sku: line.sku, mode: 'quantity', quantity: result!.quantity },
        ),
        paymentMethod: method,
        cashReceived: method === 'cash' ? cashValue : undefined,
        qrisReference: reference,
        requestId: requestIdRef.current,
      }, draft)
      requestIdRef.current = null
      const fullSale: SaleReceipt = { ...sale, channel: 'retail', memberPhone: normalizedWa ?? undefined }
      setReceipt(fullSale)
      setPrintMessage('')
      void printSale(fullSale)
      setCart([])
      setWaPhone('')
      setOrderSource('offline')
      setCashInput('')
      setQrisReference('')
    } catch (saleError) {
      setError(saleError instanceof Error ? saleError.message : 'Transaksi gagal disimpan.')
    } finally {
      setPaying(false)
    }
  }

  return (
    <div className="rc-layout">
      <section className="rc-card rc-products">
        <div className="rc-card-head">
          <div>
            <h2>Kasir Retail</h2>
            <p>Klik produk untuk memasukkan ke keranjang</p>
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
                <th>Harga Retail</th>
                <th>Stok</th>
                <th>Aksi</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((product) => {
                const stock = stockBySku[product.sku.toLowerCase()]
                const isKg = product.unit.toUpperCase() === 'KG'
                return (
                  <tr key={product.sku}>
                    <td className="rc-sku">{product.sku}</td>
                    <td>{product.name}</td>
                    <td className="rc-price">
                      {currency.format(product.retailPrice)}
                      <small>
                        /{product.unit}
                        {isKg && ` · ecer ${currency.format(retailPerKg(product.retailPrice))}`}
                      </small>
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
                  <td colSpan={5} className="rc-empty">Produk tidak ditemukan.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="rc-card rc-cart">
        <div className="rc-card-head">
          <h2>Keranjang Retail{resumedLabel !== null && <small className="rc-resumed"> · dari pending{resumedLabel ? `: ${resumedLabel}` : ''}</small>}</h2>
          {cart.length > 0 && (
            <button type="button" className="rc-link" onClick={() => setCart([])}>Kosongkan</button>
          )}
        </div>

        <ol className="rc-steps" aria-label="Langkah kasir">
          <li>Pilih produk</li>
          <li>Pilih cara bayar</li>
          <li>Selesai &amp; Cetak</li>
        </ol>

        <div className="rc-cart-lines">
          {cart.length === 0 && <p className="rc-empty">Keranjang RETAIL kosong</p>}
          {priced.map(({ line, product, result }) => {
            if (!product) return null
            const isKg = product.unit.toUpperCase() === 'KG'
            return (
              <article key={line.sku} className="rc-line">
                <header>
                  <strong className="rc-line-name">{product.name}</strong>
                  <strong className="rc-line-total">{result ? currency.format(result.total) : '–'}</strong>
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
                  {isKg && (
                    <div className="rc-mode" role="group" aria-label="Cara beli">
                      <button
                        type="button"
                        className={line.mode === 'quantity' ? 'active' : ''}
                        onClick={() => updateLine(line.sku, { mode: 'quantity', input: '1' })}
                      >
                        Berat
                      </button>
                      <button
                        type="button"
                        className={line.mode === 'nominal' ? 'active' : ''}
                        onClick={() => updateLine(line.sku, { mode: 'nominal', input: '' })}
                      >
                        Nominal
                      </button>
                    </div>
                  )}
                  <label>
                    <input
                      inputMode="decimal"
                      value={line.input}
                      onChange={(event) => updateLine(line.sku, { input: event.target.value })}
                      aria-label={line.mode === 'nominal' ? 'Nominal rupiah' : `Jumlah ${product.unit}`}
                    />
                    <span>{line.mode === 'nominal' ? 'Rp' : product.unit}</span>
                  </label>
                  {isKg && line.mode === 'quantity' && (
                    <div className="rc-quick" role="group" aria-label="Berat cepat">
                      {['0.25', '0.5', '1', '2'].map((value) => (
                        <button key={value} type="button" onClick={() => updateLine(line.sku, { input: value })}>
                          {value.replace('.', ',')}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                {result && line.mode === 'nominal' && (
                  <p className="rc-hint">≈ {quantityFormat.format(result.quantity)} {product.unit}</p>
                )}
                {result && isKg && line.mode === 'quantity' && (
                  <p className="rc-hint">
                    {result.quantity >= 1 ? 'Harga grosir' : 'Harga ecer'} (
                    {currency.format(result.quantity >= 1 ? product.retailPrice : retailPerKg(product.retailPrice))}/KG)
                  </p>
                )}
                {!result && <p className="rc-warning">Jumlah belum valid.</p>}
                {result && online && (stockBySku[product.sku.toLowerCase()] ?? 0) < result.quantity && (
                  <p className="rc-warning">
                    Stok hanya {quantityFormat.format(stockBySku[product.sku.toLowerCase()] ?? 0)} {product.unit}.
                  </p>
                )}
                {result && !online && (stockBySku[product.sku.toLowerCase()] ?? 0) < result.quantity && (
                  <p className="rc-hint">Offline: stok di tablet tinggal {quantityFormat.format(stockBySku[product.sku.toLowerCase()] ?? 0)} {product.unit}; penjualan tetap dicatat dan ditandai untuk dicek.</p>
                )}
              </article>
            )
          })}
        </div>

        <div className="rc-total"><span>TOTAL TAGIHAN:</span><strong>{currency.format(total)}</strong></div>

        <div className="rc-source" role="group" aria-label="Jenis pesanan">
          <button type="button" className={orderSource === 'offline' ? 'active' : ''} onClick={() => chooseSource('offline')}>
            Offline
            <small>Beli langsung di toko</small>
          </button>
          <button type="button" className={orderSource === 'wa' ? 'active' : ''} onClick={() => chooseSource('wa')}>
            WhatsApp Order
            <small>Nota dikirim via WA</small>
          </button>
        </div>
        {orderSource === 'wa' && (
          <label className="rc-cash">
            <span>No. WhatsApp pembeli</span>
            <input
              inputMode="tel"
              value={waPhone}
              onChange={(event) => setWaPhone(event.target.value)}
              placeholder="08xxxxxxxxxx"
              autoComplete="off"
              autoFocus
            />
            {waPhone.trim() === '' || waInvalid ? (
              <small className="rc-warning">Isi nomor WhatsApp yang valid untuk mengirim nota.</small>
            ) : (
              <small className="rc-hint">Nota akan dikirim ke +{normalizedWa} setelah selesai.</small>
            )}
          </label>
        )}

        <div className="rc-payment">
          <span>Metode Pembayaran</span>
          <div className="rc-methods">
            <button type="button" className={method === 'cash' ? 'active' : ''} onClick={() => setMethod('cash')}>
              CASH / TUNAI
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
          {method === 'qris' && (
            <label className="rc-cash">
              <span>{online ? 'No. Transaksi QRIS/EDC (wajib)' : 'No. Transaksi QRIS/EDC (boleh kosong saat offline)'}</span>
              <input
                value={qrisReference}
                onChange={(event) => setQrisReference(event.target.value)}
                placeholder="Nomor referensi di struk EDC / notifikasi QRIS"
                maxLength={40}
                autoComplete="off"
              />
              <small className="rc-hint">
                {online
                  ? 'Isi setelah pembeli selesai membayar. Tombol cetak aktif setelah nomor diisi.'
                  : 'Offline: pastikan pembayaran sudah masuk (cek notifikasi QRIS/mutasi), lalu konfirmasi manual. Nomor dibuat otomatis jika dikosongkan.'}
              </small>
            </label>
          )}
          {method === 'cash' && <CashInput value={cashInput} onChange={setCashInput} total={total} />}
        </div>

        {error && <p className="rc-warning" role="alert">{error}</p>}
        {cart.length > 0 && (
          <input
            className="rc-pending-label"
            value={pendingLabel}
            maxLength={60}
            onChange={(event) => setPendingLabel(event.target.value)}
            placeholder="Label pending, mis. Ibu baju merah (opsional)"
            aria-label="Label pending order"
          />
        )}
        <div className="rc-actions">
          <button type="button" className="rc-pending" disabled={cart.length === 0 || paying} onClick={pend}>
            Pending Order
          </button>
          <button type="button" className="rc-pay" disabled={!canPay} onClick={pay}>
            {paying ? 'Menyimpan...' : 'Selesai & Cetak'}
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
            <p><strong>STRUK PEMBELIAN</strong></p>
            <p>{receipt.receiptNo}</p>
            {receipt.offlinePending && (
              <p className="rc-hint"><strong>Struk sementara (offline).</strong> Nomor final dibuat setelah data terkirim ke server.</p>
            )}
            <p>{new Date(receipt.createdAtIso).toLocaleString('id-ID')} · Kasir {receipt.cashierName}</p>
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
              <span>{receipt.paymentMethod === 'cash' ? 'Tunai' : 'QRIS / EDC'}</span>
              <span>{currency.format(receipt.cashReceived ?? receipt.total)}</span>
            </div>
            {receipt.qrisReference && (
              <div className="rc-receipt-row"><span>No. Trx QRIS</span><span>{receipt.qrisReference}</span></div>
            )}
            <div className="rc-receipt-row"><span>Kembali</span><span>{currency.format(receipt.change)}</span></div>
            <p className="rc-thanks">Terima kasih sudah berbelanja!</p>
            <StoreQr />
            {printMessage && <p className="rc-hint no-print" role="status">{printMessage}</p>}
            <div className="rc-receipt-actions">
              <button type="button" onClick={() => void printSale(receipt)}>Cetak ulang</button>
              <button
                type="button"
                disabled={!receipt.memberPhone}
                title={receipt.memberPhone ? undefined : 'Isi No. WhatsApp pembeli sebelum bayar'}
                onClick={() =>
                  window.open(
                    whatsappLink(receipt.memberPhone ?? '', paidReceiptText({ ...receipt, channel: 'retail' })),
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

export default RetailCashier
