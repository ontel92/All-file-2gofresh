import { storeInfo } from '../storeInfo'
import { currency, qtyFormat } from './customer'

export type Receipt = {
  orderNo: string
  total: number
  subtotal: number
  shippingFee: number
  pointsUsed: number
  fulfillment: string
  customerName: string
  address: string
  items: { name: string; quantity: number; unit: string; total: number }[]
}

export type ReceiptState = { kind: 'paid' | 'pending' | 'closed'; receipt: Receipt }

const adminWhatsapp = '6285176768067'

export function receiptWhatsappUrl(receipt: Receipt, paid: boolean) {
  const lines = [
    `Halo ${storeInfo.name}, ini struk pesanan saya${paid ? ' (sudah dibayar via Midtrans)' : ''}:`,
    `No. pesanan: ${receipt.orderNo}`,
    receipt.customerName ? `Nama: ${receipt.customerName}` : '',
    '',
    ...receipt.items.map((item) => `- ${item.name} ${qtyFormat.format(item.quantity)} ${item.unit} = ${currency.format(item.total)}`),
    '',
    `Subtotal: ${currency.format(receipt.subtotal)}`,
    receipt.pointsUsed > 0 ? `Poin: -${currency.format(receipt.pointsUsed)}` : '',
    receipt.fulfillment === 'delivery' ? `Ongkir: ${currency.format(receipt.shippingFee)}` : 'Ambil di toko',
    `Total: ${currency.format(receipt.total)}`,
    receipt.fulfillment === 'delivery' && receipt.address ? `Alamat: ${receipt.address}` : '',
  ]
  return `https://wa.me/${adminWhatsapp}?text=${encodeURIComponent(lines.filter((line, index) => line || index === 2 || index === 3).join('\n'))}`
}

const titles = {
  paid: 'Terima kasih! Pesanan Anda diterima',
  pending: 'Menunggu konfirmasi pembayaran',
  closed: 'Pembayaran tidak selesai',
} as const

const messages = {
  paid: 'Pembayaran berhasil. Kami segera memproses pesanan Anda. Simpan nomor pesanan ini dan tunjukkan struk ke admin kami lewat WhatsApp.',
  pending: 'Pembayaran belum terkonfirmasi. Jika Anda sudah membayar, status diperbarui otomatis. Anda juga bisa menunjukkan struk ke admin kami.',
  closed: 'Waktu pembayaran habis atau pembayaran dibatalkan. Silakan belanja lagi untuk membuat pesanan baru.',
} as const

export default function OrderThanks({ state, onClose }: { state: ReceiptState; onClose: () => void }) {
  const { kind, receipt } = state
  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label="Konfirmasi pesanan">
      <div className="modal-card center">
        <div className="done-mark" aria-hidden="true">{kind === 'paid' ? '✓' : kind === 'pending' ? '…' : '!'}</div>
        <h2>{titles[kind]}</h2>
        <p><b>{receipt.orderNo}</b></p>
        <p className="muted">{messages[kind]}</p>
        <div className="thanks-receipt">
          {receipt.items.map((item, index) => (
            <div key={index}><span>{item.name} · {qtyFormat.format(item.quantity)} {item.unit}</span><b>{currency.format(item.total)}</b></div>
          ))}
          {receipt.pointsUsed > 0 && <div><span>Tukar poin</span><b>-{currency.format(receipt.pointsUsed)}</b></div>}
          <div><span>{receipt.fulfillment === 'delivery' ? 'Ongkos kirim' : 'Ambil di toko'}</span><b>{receipt.fulfillment === 'delivery' ? currency.format(receipt.shippingFee) : 'Gratis'}</b></div>
          <div className="thanks-total"><span>Total</span><b>{currency.format(receipt.total)}</b></div>
        </div>
        <div className="choice-stack">
          {kind !== 'closed' && (
            <a className="btn" href={receiptWhatsappUrl(receipt, kind === 'paid')} target="_blank" rel="noreferrer">Tunjukkan struk ini ke admin kami</a>
          )}
          <button type="button" className="btn ghost" onClick={onClose}>Belanja lagi</button>
        </div>
      </div>
    </div>
  )
}
