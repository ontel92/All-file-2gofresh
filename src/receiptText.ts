import { storeInfo } from './storeInfo'

const idr = (value: number) => `Rp${new Intl.NumberFormat('id-ID').format(value)}`
const qty = (value: number) => new Intl.NumberFormat('id-ID', { maximumFractionDigits: 3 }).format(value)

type TextItem = { name: string; unit: string; quantity: number; total: number }
export type Channel = 'retail' | 'b2b'

const storeFooter = [
  '------------------',
  `*${storeInfo.name}*`,
  storeInfo.address,
  `WA: ${storeInfo.whatsapp}`,
  `Email: ${storeInfo.email}`,
  `IG: ${storeInfo.instagram}`,
  `Shopee: ${storeInfo.shopee}`,
  '',
  `${storeInfo.qrCaption}:`,
  storeInfo.websiteUrl,
]

function itemLines(items: TextItem[]) {
  return items.flatMap((item) => [
    `- ${item.name}`,
    `   ${qty(item.quantity)} ${item.unit} = ${idr(item.total)}`,
  ])
}

export function paidReceiptText(receipt: {
  channel: Channel
  receiptNo: string
  items: TextItem[]
  total: number
  paymentMethod: 'cash' | 'qris' | 'transfer'
  paymentReference?: string | null
  qrisReference?: string | null
  customerName?: string
  createdAtIso: string
}) {
  const method = { cash: 'Tunai', qris: 'QRIS/EDC', transfer: 'Transfer' }[receipt.paymentMethod]
  const reference = receipt.paymentReference ?? receipt.qrisReference
  const isB2b = receipt.channel === 'b2b'
  return [
    isB2b ? `*STRUK LUNAS B2B - ${storeInfo.name}*` : `*STRUK PEMBELIAN - ${storeInfo.name}*`,
    receipt.receiptNo,
    new Date(receipt.createdAtIso).toLocaleString('id-ID'),
    ...(receipt.customerName ? [`${isB2b ? 'Member B2B' : 'Pelanggan'}: ${receipt.customerName}`] : []),
    '',
    ...itemLines(receipt.items),
    '',
    `*TOTAL: ${idr(receipt.total)}*`,
    `Pembayaran: ${method}${reference ? ` (Ref ${reference})` : ''}`,
    'Status: LUNAS',
    '',
    'Terima kasih sudah berbelanja!',
    ...storeFooter,
  ].join('\n')
}

export function invoiceText(order: {
  channel: Channel
  customerName: string
  items: TextItem[]
  total: number
}) {
  const isB2b = order.channel === 'b2b'
  return [
    isB2b ? `*TAGIHAN B2B - ${storeInfo.name}*` : `*TAGIHAN PESANAN - ${storeInfo.name}*`,
    `Kepada: ${order.customerName || 'Pelanggan'}`,
    '',
    ...itemLines(order.items),
    '',
    `*TOTAL TAGIHAN: ${idr(order.total)}*`,
    'Status: MENUNGGU PEMBAYARAN',
    '',
    'Mohon kirim bukti pembayaran ke chat ini. Pesanan diproses setelah pembayaran kami terima.',
    ...storeFooter,
  ].join('\n')
}

export function whatsappLink(phone: string, text: string) {
  return `https://wa.me/${phone}?text=${encodeURIComponent(text)}`
}
