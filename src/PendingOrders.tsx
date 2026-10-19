import { useMemo, useState } from 'react'
import { invoiceText, whatsappLink } from './receiptText'
import { parseDecimal, priceB2bLine, priceLine } from './retailPricing'
import type { CartLine, RetailProduct } from './retailPricing'

export type PendingOrder = {
  id: string
  channel: 'retail' | 'b2b'
  label: string
  items: CartLine[]
  memberPhone: string
  memberName: string
  createdByName: string
  updatedAt: Date | null
}

type Props = {
  orders: PendingOrder[]
  retailProducts: RetailProduct[]
  b2bProducts: RetailProduct[]
  retailCartInUse: boolean
  b2bCartInUse: boolean
  busyId: string
  onResume: (order: PendingOrder) => void
  onDelete: (order: PendingOrder) => Promise<void>
}

type Tab = 'all' | 'retail' | 'b2b'

const currency = new Intl.NumberFormat('id-ID', {
  style: 'currency',
  currency: 'IDR',
  maximumFractionDigits: 0,
})
const quantityFormat = new Intl.NumberFormat('id-ID', { maximumFractionDigits: 3 })

function PendingOrders({
  orders,
  retailProducts,
  b2bProducts,
  retailCartInUse,
  b2bCartInUse,
  busyId,
  onResume,
  onDelete,
}: Props) {
  const [tab, setTab] = useState<Tab>('all')
  const retailBySku = useMemo(
    () => new Map(retailProducts.map((product) => [product.sku, product])),
    [retailProducts],
  )
  const b2bBySku = useMemo(
    () => new Map(b2bProducts.map((product) => [product.sku, product])),
    [b2bProducts],
  )
  const counts = {
    all: orders.length,
    retail: orders.filter((order) => order.channel === 'retail').length,
    b2b: orders.filter((order) => order.channel === 'b2b').length,
  }
  const shown = orders.filter((order) => tab === 'all' || order.channel === tab)

  return (
    <>
      <div className="pos-page-heading">
        <div>
          <p className="pos-eyebrow">KASIR</p>
          <h1>Pending order</h1>
          <p>
            Stok baru dipotong saat pesanan dibayar, dan harga selalu mengikuti harga terbaru di sheet.
          </p>
        </div>
      </div>

      <div className="po-tabs" role="tablist" aria-label="Jenis pending order">
        {(
          [
            ['all', 'Semua'],
            ['retail', 'Pending Retail'],
            ['b2b', 'Pending B2B'],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            className={tab === id ? 'active' : ''}
            onClick={() => setTab(id)}
          >
            {label} <span>{counts[id]}</span>
          </button>
        ))}
      </div>

      <div className="po-grid">
        {shown.length === 0 && <div className="pos-no-products">Belum ada pending order.</div>}
        {shown.map((order) => {
          const isB2b = order.channel === 'b2b'
          const productBySku = isB2b ? b2bBySku : retailBySku
          const lines = order.items.map((line) => {
            const product = productBySku.get(line.sku)
            const result = product
              ? isB2b
                ? priceB2bLine(product, line)
                : priceLine(product, line)
              : null
            return { line, product, result }
          })
          const total = lines.reduce((sum, row) => sum + (row.result?.total ?? 0), 0)
          const cartInUse = isB2b ? b2bCartInUse : retailCartInUse
          return (
            <article key={order.id} className={`po-card${isB2b ? ' po-card-b2b' : ''}`}>
              <header>
                <div>
                  <h2>
                    <span className={`po-chip${isB2b ? ' b2b' : ''}`}>{isB2b ? 'B2B' : 'RETAIL'}</span>{' '}
                    {isB2b ? order.memberName || order.label : order.label || 'Tanpa label'}
                  </h2>
                  <small>
                    {isB2b && `+${order.memberPhone} · `}
                    {order.createdByName}
                    {order.updatedAt && ` · ${order.updatedAt.toLocaleString('id-ID')}`}
                  </small>
                </div>
                <strong>{currency.format(total)}</strong>
              </header>
              <ul>
                {lines.map(({ line, product, result }) => (
                  <li key={line.sku}>
                    <span>{product?.name ?? line.sku}</span>
                    <span>
                      {line.mode === 'nominal'
                        ? `${currency.format(parseDecimal(line.input.replace(/\./g, '')) || 0)}${
                            result && product ? ` ≈ ${quantityFormat.format(result.quantity)} ${product.unit}` : ''
                          }`
                        : `${line.input} ${product?.unit ?? ''}`}
                    </span>
                  </li>
                ))}
              </ul>
              {isB2b && <p className="po-status">Menunggu pembayaran</p>}
              <footer>
                {order.memberPhone !== '' && (
                  <button
                    type="button"
                    className="po-wa"
                    disabled={lines.some((row) => !row.result)}
                    onClick={() =>
                      window.open(
                        whatsappLink(
                          order.memberPhone,
                          invoiceText({
                            channel: order.channel,
                            customerName: order.memberName || order.label,
                            total,
                            items: lines.flatMap(({ product, result }) =>
                              product && result
                                ? [{ name: product.name, unit: product.unit, quantity: result.quantity, total: result.total }]
                                : [],
                            ),
                          }),
                        ),
                        '_blank',
                        'noopener',
                      )
                    }
                  >
                    Kirim tagihan WA
                  </button>
                )}
                <button
                  type="button"
                  className="po-resume"
                  disabled={cartInUse || busyId === order.id}
                  onClick={() => onResume(order)}
                >
                  {isB2b ? 'Selesaikan' : 'Buka kembali'}
                </button>
                <button
                  type="button"
                  className="po-delete"
                  disabled={busyId === order.id}
                  onClick={() => {
                    if (window.confirm('Hapus pending order ini?')) void onDelete(order)
                  }}
                >
                  Hapus
                </button>
              </footer>
            </article>
          )
        })}
      </div>
      {(retailCartInUse || b2bCartInUse) && orders.length > 0 && (
        <p className="pos-saving-status" role="status">
          Tombol buka/selesaikan nonaktif untuk kanal yang keranjangnya masih terisi. Pending-kan atau bayar dulu.
        </p>
      )}
    </>
  )
}

export default PendingOrders
