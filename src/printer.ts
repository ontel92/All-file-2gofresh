import { useSyncExternalStore } from 'react'
import { storeInfo } from './storeInfo'

export type PrinterState = {
  status: 'disconnected' | 'connecting' | 'connected'
  name: string
  error: string
}

export type ReceiptData = {
  channel?: 'retail' | 'b2b'
  receiptNo: string
  items: { name: string; unit: string; quantity: number; total: number }[]
  total: number
  paymentMethod: 'cash' | 'qris' | 'transfer'
  cashReceived: number | null
  qrisReference?: string | null
  paymentReference?: string | null
  memberName?: string
  memberPhone?: string
  change: number
  cashierName: string
  createdAtIso: string
}

type Transport = {
  name: string
  write: (data: Uint8Array) => Promise<void>
  close: () => Promise<void> | void
}

// Layanan BLE yang umum dipakai printer thermal (termasuk seri Kassen/BTP).
const printerServices = [
  '000018f0-0000-1000-8000-00805f9b34fb',
  '0000ffe0-0000-1000-8000-00805f9b34fb',
  '0000ff00-0000-1000-8000-00805f9b34fb',
  '0000fee7-0000-1000-8000-00805f9b34fb',
  'e7810a71-73ae-499d-8c15-faa9aef0c3f2',
  '49535343-fe7d-4ae5-8fa9-9fafd205e455',
]
const bleChunkSize = 20
const paperKey = 'pos.printer.paperChars'

let state: PrinterState = { status: 'disconnected', name: '', error: '' }
let transport: Transport | null = null
const listeners = new Set<() => void>()

function setState(next: Partial<PrinterState>) {
  state = { ...state, ...next }
  listeners.forEach((listener) => listener())
}

export function usePrinter(): PrinterState {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => state,
  )
}

export const bluetoothSupported = typeof navigator !== 'undefined' && 'bluetooth' in navigator
export const serialSupported = typeof navigator !== 'undefined' && 'serial' in navigator

export function paperChars(): 32 | 48 {
  return localStorage.getItem(paperKey) === '32' ? 32 : 48
}

export function setPaperChars(chars: 32 | 48) {
  localStorage.setItem(paperKey, String(chars))
  listeners.forEach((listener) => listener())
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function connected(next: Transport) {
  transport = next
  setState({ status: 'connected', name: next.name, error: '' })
}

function lost() {
  transport = null
  setState({ status: 'disconnected', name: '' })
}

function connectionError(error: unknown): string {
  if (error instanceof DOMException && error.name === 'NotFoundError') {
    return 'Tidak ada printer yang dipilih.'
  }
  return error instanceof Error ? error.message : 'Printer gagal terhubung.'
}

const lastKindKey = 'pos.printer.kind'

async function openBluetooth(device: BluetoothDevice) {
  const server = await device.gatt!.connect()
  let characteristic: BluetoothRemoteGATTCharacteristic | undefined
  for (const service of await server.getPrimaryServices()) {
    const found = (await service.getCharacteristics()).find(
      (item) => item.properties.writeWithoutResponse || item.properties.write,
    )
    if (found) {
      characteristic = found
      break
    }
  }
  if (!characteristic) {
    server.disconnect()
    throw new Error(
      'Perangkat ini tidak punya jalur cetak Bluetooth LE. Coba tombol "Hubungkan via Serial/COM".',
    )
  }
  const target = characteristic
  device.addEventListener('gattserverdisconnected', lost, { once: true })
  connected({
    name: device.name || 'Printer Bluetooth',
    write: async (data) => {
      for (let offset = 0; offset < data.length; offset += bleChunkSize) {
        const chunk = data.slice(offset, offset + bleChunkSize)
        if (target.properties.writeWithoutResponse) {
          await target.writeValueWithoutResponse(chunk)
        } else {
          await target.writeValueWithResponse(chunk)
        }
        await delay(8)
      }
    },
    close: () => device.gatt?.disconnect(),
  })
  localStorage.setItem(lastKindKey, 'bluetooth')
}

async function openSerial(port: SerialPort) {
  await port.open({ baudRate: 9600 })
  const writer = port.writable!.getWriter()
  port.addEventListener('disconnect', lost, { once: true })
  connected({
    name: 'Printer Serial/COM',
    write: (data) => writer.write(data),
    close: async () => {
      writer.releaseLock()
      await port.close()
    },
  })
  localStorage.setItem(lastKindKey, 'serial')
}

export async function connectBluetoothPrinter() {
  if (!bluetoothSupported) {
    setState({ error: 'Browser ini tidak mendukung Bluetooth. Gunakan Chrome atau Edge.' })
    return
  }
  setState({ status: 'connecting', error: '' })
  try {
    const device = await navigator.bluetooth.requestDevice({
      acceptAllDevices: true,
      optionalServices: printerServices,
    })
    await openBluetooth(device)
  } catch (error) {
    setState({ status: 'disconnected', error: connectionError(error) })
  }
}

// Untuk printer Bluetooth klasik (SPP) yang sudah dipasangkan di Windows sebagai port COM.
export async function connectSerialPrinter() {
  if (!serialSupported) {
    setState({ error: 'Browser ini tidak mendukung Serial. Gunakan Chrome atau Edge di komputer.' })
    return
  }
  setState({ status: 'connecting', error: '' })
  try {
    await openSerial(await navigator.serial.requestPort())
  } catch (error) {
    setState({ status: 'disconnected', error: connectionError(error) })
  }
}

// Menyambung ulang printer yang pernah diizinkan, tanpa dialog pairing.
let reconnecting: Promise<boolean> | null = null

export function reconnectKnownPrinter(): Promise<boolean> {
  if (state.status === 'connected') return Promise.resolve(true)
  reconnecting ??= (async () => {
    setState({ status: 'connecting', error: '' })
    try {
      const kind = localStorage.getItem(lastKindKey)
      if (kind !== 'bluetooth' && serialSupported) {
        const ports = await navigator.serial.getPorts()
        if (ports[0]) {
          await openSerial(ports[0])
          return true
        }
      }
      if (kind !== 'serial' && bluetoothSupported && 'getDevices' in navigator.bluetooth) {
        const devices = await navigator.bluetooth.getDevices()
        if (devices[0]) {
          await openBluetooth(devices[0])
          return true
        }
      }
    } catch {
      // Gagal sambung otomatis; kasir akan diminta menghubungkan manual.
    }
    setState({ status: 'disconnected' })
    return false
  })().finally(() => {
    reconnecting = null
  })
  return reconnecting
}
export async function disconnectPrinter() {
  const current = transport
  lost()
  try {
    await current?.close()
  } catch {
    // Koneksi sudah terputus.
  }
}

function ascii(value: string) {
  return value.normalize('NFD').replace(/[^\x20-\x7E]/g, '')
}

const idr = (value: number) => `Rp${new Intl.NumberFormat('id-ID').format(value)}`
const qty = (value: number) => new Intl.NumberFormat('id-ID', { maximumFractionDigits: 3 }).format(value)

function twoColumns(left: string, right: string, width: number) {
  const space = Math.max(width - right.length - 1, 1)
  const label = left.length > space ? left.slice(0, space) : left
  return `${label}${' '.repeat(Math.max(width - label.length - right.length, 1))}${right}`
}

export function buildReceipt(receipt: ReceiptData, width: number): Uint8Array {
  const bytes: number[] = []
  const raw = (...values: number[]) => bytes.push(...values)
  const text = (value: string) => {
    for (const char of ascii(value)) bytes.push(char.charCodeAt(0))
    bytes.push(0x0a)
  }
  const line = '-'.repeat(width)

  const isB2b = receipt.channel === 'b2b' || Boolean(receipt.memberName && !receipt.channel)

  raw(0x1b, 0x40)
  raw(0x1b, 0x61, 1, 0x1b, 0x45, 1)
  text(storeInfo.name)
  raw(0x1b, 0x45, 0)
  text(storeInfo.address)
  text(`WA ${storeInfo.whatsapp}`)
  text(storeInfo.email)
  text(`IG ${storeInfo.instagram} | Shopee ${storeInfo.shopee}`)
  raw(0x1b, 0x61, 0)
  text(line)
  raw(0x1b, 0x61, 1, 0x1b, 0x45, 1)
  text(isB2b ? 'STRUK LUNAS B2B' : 'STRUK PEMBELIAN')
  raw(0x1b, 0x45, 0, 0x1b, 0x61, 0)
  text(receipt.receiptNo)
  text(new Date(receipt.createdAtIso).toLocaleString('id-ID'))
  text(`Kasir: ${receipt.cashierName}`)
  if (receipt.memberName) {
    text(`${isB2b ? 'Member B2B' : 'Pelanggan'}: ${receipt.memberName}`)
    if (receipt.memberPhone) text(`HP: ${receipt.memberPhone}`)
  }
  text(line)
  for (const item of receipt.items) {
    text(item.name)
    text(twoColumns(`  ${qty(item.quantity)} ${item.unit}`, idr(item.total), width))
  }
  text(line)
  raw(0x1b, 0x45, 1)
  text(twoColumns('TOTAL', idr(receipt.total), width))
  raw(0x1b, 0x45, 0)
  if (receipt.paymentMethod === 'cash') {
    text(twoColumns('Tunai', idr(receipt.cashReceived ?? receipt.total), width))
    text(twoColumns('Kembali', idr(receipt.change), width))
  } else {
    text(twoColumns(receipt.paymentMethod === 'transfer' ? 'Transfer' : 'QRIS / EDC', idr(receipt.total), width))
    const reference = receipt.paymentReference ?? receipt.qrisReference
    if (reference) text(twoColumns('No. Ref', reference, width))
  }
  text('STATUS: LUNAS')
  text(line)
  raw(0x1b, 0x61, 1)
  text('Terima kasih sudah berbelanja!')
  text(storeInfo.qrCaption)
  // QR model 2, modul 6, koreksi error L, lalu simpan data dan cetak.
  const qrData = [...storeInfo.websiteUrl].map((char) => char.charCodeAt(0))
  const qrLength = qrData.length + 3
  raw(0x1d, 0x28, 0x6b, 0x04, 0x00, 0x31, 0x41, 0x32, 0x00)
  raw(0x1d, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x43, 0x06)
  raw(0x1d, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x45, 0x30)
  raw(0x1d, 0x28, 0x6b, qrLength & 0xff, qrLength >> 8, 0x31, 0x50, 0x30, ...qrData)
  raw(0x1d, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x51, 0x30)
  bytes.push(0x0a)
  text(storeInfo.websiteLabel)
  raw(0x1b, 0x61, 0)
  raw(0x0a, 0x0a, 0x0a)
  raw(0x1d, 0x56, 0x42, 0x00)
  return Uint8Array.from(bytes)
}

export type ShippingLabel = {
  orderSn: string
  trackingNumber: string
  carrier: string
  buyer: string
  recipient: string
  phone: string
  address: string
  note: string
  items: { name: string; variant: string; quantity: number }[]
}

export function buildShippingLabel(label: ShippingLabel, width: number): Uint8Array {
  const bytes: number[] = []
  const raw = (...values: number[]) => bytes.push(...values)
  const text = (value: string) => {
    for (const char of ascii(value)) bytes.push(char.charCodeAt(0))
    bytes.push(0x0a)
  }
  const wrap = (value: string) => {
    const words = ascii(value).split(/\s+/).filter(Boolean)
    const rows: string[] = []
    let current = ''
    for (const word of words) {
      if ((current + ' ' + word).trim().length > width) {
        if (current) rows.push(current)
        current = word
      } else {
        current = (current + ' ' + word).trim()
      }
    }
    if (current) rows.push(current)
    return rows
  }
  const line = '-'.repeat(width)
  const code = label.trackingNumber || label.orderSn

  raw(0x1b, 0x40)
  raw(0x1b, 0x61, 1, 0x1b, 0x45, 1)
  text('SHOPEE - 2GOFRESH')
  raw(0x1b, 0x45, 0)
  text(label.carrier || 'Kurir Shopee')
  text(line)
  // CODE128 (set B) barcode with the human readable text below, centered.
  const barcode = [...ascii(`{B${code}`)].map((char) => char.charCodeAt(0))
  raw(0x1d, 0x68, 80, 0x1d, 0x77, 2, 0x1d, 0x48, 2, 0x1d, 0x66, 0)
  raw(0x1d, 0x6b, 73, barcode.length, ...barcode)
  bytes.push(0x0a)
  text(label.trackingNumber ? 'No. Resi' : '(Resi belum terbit - kode = No. Pesanan)')
  raw(0x1b, 0x61, 0)
  text(line)
  text(`No. Pesanan: ${label.orderSn}`)
  text(`Pembeli: ${label.buyer}`)
  text(line)
  raw(0x1b, 0x45, 1)
  text('PENERIMA')
  raw(0x1b, 0x45, 0)
  text(label.recipient)
  if (label.phone) text(label.phone)
  wrap(label.address).forEach(text)
  text(line)
  raw(0x1b, 0x45, 1)
  text('ISI PAKET')
  raw(0x1b, 0x45, 0)
  for (const item of label.items) {
    wrap(`${item.quantity}x ${item.name}${item.variant ? ` (${item.variant})` : ''}`).forEach(text)
  }
  if (label.note) {
    text(line)
    wrap(`Catatan: ${label.note}`).forEach(text)
  }
  text(line)
  // QR of the same code as a backup for 2D scanners.
  const qrData = [...ascii(code)].map((char) => char.charCodeAt(0))
  const qrLength = qrData.length + 3
  raw(0x1b, 0x61, 1)
  raw(0x1d, 0x28, 0x6b, 0x04, 0x00, 0x31, 0x41, 0x32, 0x00)
  raw(0x1d, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x43, 0x06)
  raw(0x1d, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x45, 0x30)
  raw(0x1d, 0x28, 0x6b, qrLength & 0xff, qrLength >> 8, 0x31, 0x50, 0x30, ...qrData)
  raw(0x1d, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x51, 0x30)
  bytes.push(0x0a)
  raw(0x1b, 0x61, 0)
  raw(0x0a, 0x0a, 0x0a)
  raw(0x1d, 0x56, 0x42, 0x00)
  return Uint8Array.from(bytes)
}

export async function printShippingLabel(label: ShippingLabel) {
  if (!transport) throw new Error('Printer belum terhubung.')
  try {
    await transport.write(buildShippingLabel(label, paperChars()))
  } catch (error) {
    lost()
    throw new Error(`Printer terputus saat mencetak: ${error instanceof Error ? error.message : 'tidak diketahui'}`)
  }
}

export async function printReceipt(receipt: ReceiptData) {
  if (!transport) throw new Error('Printer belum terhubung.')
  try {
    await transport.write(buildReceipt(receipt, paperChars()))
  } catch (error) {
    lost()
    throw new Error(
      `Printer terputus saat mencetak: ${error instanceof Error ? error.message : 'tidak diketahui'}`,
    )
  }
}

export function printReceiptViaBrowser(receipt: ReceiptData) {
  const width = paperChars()
  const line = '-'.repeat(width)
  const isB2b = receipt.channel === 'b2b' || Boolean(receipt.memberName && !receipt.channel)
  const rows: string[] = [
    storeInfo.name,
    storeInfo.address,
    `WA ${storeInfo.whatsapp}`,
    storeInfo.email,
    storeInfo.websiteLabel,
    line,
    isB2b ? 'STRUK LUNAS B2B' : 'STRUK PEMBELIAN',
    receipt.receiptNo,
    new Date(receipt.createdAtIso).toLocaleString('id-ID'),
    `Kasir: ${receipt.cashierName}`,
  ]
  if (receipt.memberName) rows.push(`${isB2b ? 'Member B2B' : 'Pelanggan'}: ${receipt.memberName}`)
  rows.push(line)
  for (const item of receipt.items) {
    rows.push(item.name, twoColumns(`  ${qty(item.quantity)} ${item.unit}`, idr(item.total), width))
  }
  rows.push(line, twoColumns('TOTAL', idr(receipt.total), width))
  if (receipt.paymentMethod === 'cash') {
    rows.push(twoColumns('Tunai', idr(receipt.cashReceived ?? receipt.total), width))
    rows.push(twoColumns('Kembali', idr(receipt.change), width))
  } else {
    rows.push(twoColumns(receipt.paymentMethod === 'transfer' ? 'Transfer' : 'QRIS / EDC', idr(receipt.total), width))
  }
  rows.push('STATUS: LUNAS', line, 'Terima kasih sudah berbelanja!', storeInfo.qrCaption, storeInfo.websiteUrl)
  const escaped = rows.join('\n').replace(/&/g, '&amp;').replace(/</g, '&lt;')

  const frame = document.createElement('iframe')
  frame.style.cssText = 'position:fixed;width:0;height:0;border:0;right:0;bottom:0'
  document.body.appendChild(frame)
  const doc = frame.contentDocument
  if (!doc || !frame.contentWindow) {
    frame.remove()
    throw new Error('Browser tidak dapat membuka dialog cetak.')
  }
  doc.open()
  doc.write(
    `<html><head><title>${receipt.receiptNo}</title><style>@page{margin:0}body{margin:2mm}pre{font:12px/1.25 monospace;margin:0;white-space:pre-wrap}</style></head><body><pre>${escaped}</pre></body></html>`,
  )
  doc.close()
  frame.contentWindow.focus()
  frame.contentWindow.print()
  setTimeout(() => frame.remove(), 60000)
}

export async function printTestPage() {
  await printReceipt({
    receiptNo: 'TES-PRINTER',
    items: [{ name: 'Tes cetak 2GoFresh', unit: 'PCS', quantity: 1, total: 1000 }],
    total: 1000,
    paymentMethod: 'cash',
    cashReceived: 1000,
    change: 0,
    cashierName: 'Tes',
    createdAtIso: new Date().toISOString(),
  })
}
