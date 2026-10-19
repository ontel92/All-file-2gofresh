import { createHash } from 'node:crypto'
import { FieldValue, getFirestore } from 'firebase-admin/firestore'
import type { DocumentReference, Transaction } from 'firebase-admin/firestore'
import { getStorage } from 'firebase-admin/storage'
import { logger } from 'firebase-functions'
import { defineSecret } from 'firebase-functions/params'
import { HttpsError, onCall, onRequest } from 'firebase-functions/v2/https'
import { onSchedule } from 'firebase-functions/v2/scheduler'

const webOptions = {
  region: 'asia-southeast2',
  memory: '256MiB',
  maxInstances: 5,
  serviceAccount: 'catalog-sync-runtime@gofresh-3f2f3.iam.gserviceaccount.com',
  timeoutSeconds: 60,
} as const

const midtransServerKey = defineSecret('MIDTRANS_SERVER_KEY')

const storeLocation = { lat: -7.974164, lng: 112.656634 }
const vipCardSku = 'vip-card-01'
const vipFreeShippingKm = 1
const vipMinimumPurchase = 50_000
const maxDeliveryKm = 15
const siteUrl = 'https://www.2gofresh.com'

// Estimasi tarif kurir instan (Gojek/Grab/Maxim/Shopee Instant): dasar 3 km pertama + per km berikutnya.
const shippingBase = 10_000
const shippingBaseKm = 3
const shippingPerKm = 2_500
const roadFactor = 1.3

type StaffRole = 'owner' | 'supervisor' | 'cashier'

function callableData(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new HttpsError('invalid-argument', 'Data permintaan tidak valid.')
  }
  return value as Record<string, unknown>
}

async function requireStaff(uid: string, roles: StaffRole[] = ['owner', 'supervisor', 'cashier']) {
  const snapshot = await getFirestore().collection('staff').doc(uid).get()
  const data = snapshot.data() as { active?: boolean; role?: StaffRole; displayName?: string } | undefined
  if (data?.active !== true || !data.role || !roles.includes(data.role)) {
    throw new HttpsError('permission-denied', 'Akses ini tidak tersedia untuk akun Anda.')
  }
  return data
}

function isRegistered(auth: { token: { firebase?: { sign_in_provider?: string } } }) {
  return auth.token.firebase?.sign_in_provider !== 'anonymous'
}

function normalizePhone(value: unknown): string {
  const digits = typeof value === 'string' ? value.replace(/\D/g, '') : ''
  const normalized = digits.startsWith('0')
    ? `62${digits.slice(1)}`
    : digits.startsWith('8')
      ? `62${digits}`
      : digits
  if (!/^628[0-9]{7,12}$/.test(normalized)) {
    throw new HttpsError('invalid-argument', 'Nomor WhatsApp/HP tidak valid.')
  }
  return normalized
}

function cleanText(value: unknown, label: string, min: number, max: number): string {
  const text = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : ''
  if (text.length < min || text.length > max) {
    throw new HttpsError('invalid-argument', `${label} wajib diisi (${min}–${max} karakter).`)
  }
  return text
}

function distanceKm(lat: number, lng: number): number {
  const rad = (degrees: number) => (degrees * Math.PI) / 180
  const dLat = rad(lat - storeLocation.lat)
  const dLng = rad(lng - storeLocation.lng)
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(storeLocation.lat)) * Math.cos(rad(lat)) * Math.sin(dLng / 2) ** 2
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

function shippingFeeFor(km: number): number {
  const roadKm = km * roadFactor
  const raw = shippingBase + Math.max(0, Math.ceil(roadKm - shippingBaseKm)) * shippingPerKm
  return Math.ceil(raw / 500) * 500
}

function dayKeyNow(): string {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Jakarta' })
    .format(new Date())
    .replaceAll('-', '')
}

type OrderItem = {
  sku: string
  name: string
  unit: string
  quantity: number
  unitPrice: number
  total: number
}

type Deduction = { sku: string; unit: string; quantity: number }

export const saveCustomerProfile = onCall(webOptions, async (request) => {
  if (!request.auth || !isRegistered(request.auth)) {
    throw new HttpsError('unauthenticated', 'Silakan daftar atau masuk terlebih dahulu.')
  }
  const uid = request.auth.uid
  const input = callableData(request.data)
  const name = cleanText(input.name, 'Nama', 2, 60)
  const phone = normalizePhone(input.phone)
  const email = request.auth.token.email ?? ''

  const database = getFirestore()
  const customerRef = database.collection('customers').doc(uid)
  const claimRef = database.collection('customerPhones').doc(phone)
  const memberRef = database.collection('retailMembers').doc(phone)

  await database.runTransaction(async (transaction) => {
    const [customer, claim, member] = await Promise.all([
      transaction.get(customerRef),
      transaction.get(claimRef),
      transaction.get(memberRef),
    ])
    if (claim.exists && claim.get('uid') !== uid) {
      throw new HttpsError('already-exists', 'Nomor ini sudah dipakai akun lain.')
    }
    const oldPhone = customer.get('phone')
    if (typeof oldPhone === 'string' && oldPhone !== phone) {
      transaction.delete(database.collection('customerPhones').doc(oldPhone))
    }
    transaction.set(claimRef, { uid })
    transaction.set(
      customerRef,
      {
        name,
        phone,
        email,
        vip: member.exists && member.get('active') === true,
        points: customer.exists ? (customer.get('points') ?? 0) : 0,
        ...(customer.exists ? {} : { createdAt: FieldValue.serverTimestamp() }),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    )
  })
  return { ok: true }
})

export const saveCustomerAddress = onCall(webOptions, async (request) => {
  if (!request.auth || !isRegistered(request.auth)) {
    throw new HttpsError('unauthenticated', 'Silakan masuk terlebih dahulu.')
  }
  const input = callableData(request.data)
  const address = cleanText(input.address, 'Alamat', 10, 300)
  const lat = Number(input.lat)
  const lng = Number(input.lng)
  const hasPoint = Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180
  const reference = getFirestore().collection('customers').doc(request.auth.uid)
  if (!(await reference.get()).exists) {
    throw new HttpsError('failed-precondition', 'Lengkapi nama dan nomor WhatsApp dulu.')
  }
  await reference.update({
    address,
    lat: hasPoint ? lat : FieldValue.delete(),
    lng: hasPoint ? lng : FieldValue.delete(),
    updatedAt: FieldValue.serverTimestamp(),
  })
  return { ok: true }
})

export const createWebOrder = onCall(webOptions, async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Sesi tidak ditemukan. Muat ulang halaman.')
  }
  const uid = request.auth.uid
  const registered = isRegistered(request.auth)
  const input = callableData(request.data)

  const requestId = input.requestId
  if (typeof requestId !== 'string' || !/^[A-Fa-f0-9-]{36}$/.test(requestId)) {
    throw new HttpsError('invalid-argument', 'Permintaan tidak valid.')
  }
  const rawItems = input.items
  if (!Array.isArray(rawItems) || rawItems.length === 0 || rawItems.length > 60) {
    throw new HttpsError('invalid-argument', 'Keranjang kosong atau terlalu besar.')
  }
  const payment = input.payment
  if (payment !== 'midtrans' && payment !== 'qris') {
    throw new HttpsError('invalid-argument', 'Metode pembayaran tidak valid.')
  }
  const fulfillment = input.fulfillment
  if (fulfillment !== 'delivery' && fulfillment !== 'pickup') {
    throw new HttpsError('invalid-argument', 'Pilih diantar atau ambil di toko.')
  }

  const customerName = cleanText(input.name, 'Nama', 2, 60)
  const phone = normalizePhone(input.phone)
  const email = typeof input.email === 'string' ? input.email.trim().slice(0, 100) : ''
  const note = typeof input.note === 'string' ? input.note.trim().slice(0, 200) : ''

  let address = ''
  let lat = 0
  let lng = 0
  let km = 0
  if (fulfillment === 'delivery') {
    address = cleanText(input.address, 'Alamat lengkap', 10, 300)
    lat = Number(input.lat)
    lng = Number(input.lng)
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
      throw new HttpsError('invalid-argument', 'Titik lokasi pengantaran wajib dipilih di peta.')
    }
    km = distanceKm(lat, lng)
    if (km > maxDeliveryKm) {
      throw new HttpsError(
        'failed-precondition',
        `Lokasi di luar jangkauan pengantaran (maks ${maxDeliveryKm} km dari toko).`,
      )
    }
  }

  let proofPath = ''
  if (payment === 'qris') {
    proofPath = typeof input.proofPath === 'string' ? input.proofPath : ''
    if (!proofPath.startsWith(`proofs/${uid}/`) || proofPath.includes('..')) {
      throw new HttpsError('invalid-argument', 'Bukti pembayaran wajib diunggah.')
    }
    const [exists] = await getStorage().bucket().file(proofPath).exists()
    if (!exists) {
      throw new HttpsError('failed-precondition', 'File bukti pembayaran belum terunggah.')
    }
  }

  const seen = new Set<string>()
  const lines = rawItems.map((raw) => {
    const item = callableData(raw)
    const sku = item.sku
    const quantity = item.quantity
    if (typeof sku !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(sku)) {
      throw new HttpsError('invalid-argument', 'SKU tidak valid.')
    }
    if (typeof quantity !== 'number' || !Number.isFinite(quantity) || quantity <= 0 || quantity > 500) {
      throw new HttpsError('invalid-argument', 'Jumlah produk tidak valid.')
    }
    const id = sku.toLowerCase()
    if (seen.has(id)) throw new HttpsError('invalid-argument', 'Produk dobel di keranjang.')
    seen.add(id)
    return { id, quantity: Math.round(quantity * 1000) / 1000 }
  })
  const requestedPoints = Number.isSafeInteger(input.usePoints) ? Math.max(0, input.usePoints as number) : 0

  const database = getFirestore()
  const orderRef = database.collection('webOrders').doc(`${uid}_${requestId}`)
  const counterRef = database.collection('salesCounters').doc(`web-${dayKeyNow()}`)
  const customerRef = database.collection('customers').doc(uid)
  const entries = lines.map((line) => ({
    ...line,
    productRef: database.collection('catalogProducts').doc(line.id),
    inventoryRef: database.collection('inventory').doc(line.id),
    movementRef: database.collection('stockMovements').doc(),
  }))

  const result = await database.runTransaction(async (transaction) => {
    const [prior, counter, customer, ...rest] = await Promise.all([
      transaction.get(orderRef),
      transaction.get(counterRef),
      transaction.get(customerRef),
      ...entries.flatMap((entry) => [transaction.get(entry.productRef), transaction.get(entry.inventoryRef)]),
    ])
    if (prior.exists) {
      return { id: orderRef.id, orderNo: prior.get('orderNo') as string, total: prior.get('total') as number }
    }

    let hasVipCard = false
    const items: OrderItem[] = []
    const deductions: Deduction[] = []
    const stockWrites: { entry: (typeof entries)[number]; onHand: number; unit: string; quantity: number }[] = []
    entries.forEach((entry, index) => {
      const product = rest[index * 2]
      const stock = rest[index * 2 + 1]
      if (!product.exists) throw new HttpsError('not-found', 'Ada produk yang sudah tidak tersedia.')
      const name = String(product.get('name'))
      const unit = String(product.get('unit')).trim().toUpperCase()
      const price = Number(product.get('retailPrice'))
      const minQty = Number(product.get('minQty'))
      if (entry.quantity < minQty) {
        throw new HttpsError('invalid-argument', `Minimal beli ${name} adalah ${minQty} ${unit}.`)
      }
      if (unit !== 'KG' && !Number.isInteger(entry.quantity)) {
        throw new HttpsError('invalid-argument', `Jumlah ${name} harus bilangan bulat.`)
      }
      if (entry.id === vipCardSku) hasVipCard = true
      if (stock.exists) {
        const onHand = Number(stock.get('onHand'))
        if (!Number.isFinite(onHand) || onHand < entry.quantity) {
          throw new HttpsError(
            'failed-precondition',
            `Stok ${name} tidak cukup (tersisa ${Number.isFinite(onHand) ? onHand : 0} ${unit}).`,
          )
        }
        stockWrites.push({ entry, onHand, unit, quantity: entry.quantity })
        deductions.push({ sku: String(product.get('sku')), unit, quantity: entry.quantity })
      }
      items.push({
        sku: String(product.get('sku')),
        name,
        unit,
        quantity: entry.quantity,
        unitPrice: price,
        total: Math.round(price * entry.quantity),
      })
    })
    if (hasVipCard && !registered) {
      throw new HttpsError('failed-precondition', 'Daftar/masuk akun dulu untuk membeli Kartu VIP.')
    }

    const subtotal = items.reduce((sum, item) => sum + item.total, 0)
    const points = registered && customer.exists ? Number(customer.get('points') ?? 0) : 0
    const pointsUsed = Math.min(requestedPoints, points, subtotal)
    const isVip = registered && customer.exists && customer.get('vip') === true
    const freeShipping =
      isVip && fulfillment === 'delivery' && km <= vipFreeShippingKm && subtotal >= vipMinimumPurchase
    const shippingFee = fulfillment === 'delivery' && !freeShipping ? shippingFeeFor(km) : 0
    const total = subtotal - pointsUsed + shippingFee
    if (total < 1000) {
      throw new HttpsError('invalid-argument', 'Total pesanan terlalu kecil untuk diproses.')
    }

    const sequence = (counter.exists ? (counter.get('last') as number) : 0) + 1
    const orderNo = `WEB-${dayKeyNow()}-${String(sequence).padStart(4, '0')}`

    stockWrites.forEach(({ entry, onHand, unit, quantity }, index) => {
      const sku = deductions[index].sku
      const newOnHand = Math.round((onHand - quantity) * 1000) / 1000
      transaction.set(entry.inventoryRef, {
        sku,
        onHand: newOnHand,
        unit,
        updatedAt: FieldValue.serverTimestamp(),
        updatedBy: 'web',
      })
      transaction.create(entry.movementRef, {
        sku,
        unit,
        movementType: 'sale',
        previousOnHand: onHand,
        newOnHand,
        quantityDelta: -quantity,
        reason: `Pesanan website ${orderNo}`,
        actorUid: 'web',
        createdAt: FieldValue.serverTimestamp(),
      })
    })
    transaction.set(counterRef, { last: sequence })

    if (pointsUsed > 0) {
      transaction.update(customerRef, { points: FieldValue.increment(-pointsUsed) })
      transaction.create(customerRef.collection('pointLedger').doc(), {
        delta: -pointsUsed,
        reason: `Tukar poin untuk ${orderNo}`,
        orderNo,
        createdAt: FieldValue.serverTimestamp(),
      })
    }
    if (hasVipCard) {
      transaction.create(database.collection('memberRegistrations').doc(orderRef.id), {
        orderId: orderRef.id,
        receiptNo: orderNo,
        source: 'web',
        status: 'pending',
        prefillName: customerName,
        prefillPhone: phone,
        createdAt: FieldValue.serverTimestamp(),
      })
    }

    transaction.create(orderRef, {
      orderNo,
      customerUid: uid,
      registered,
      customerName,
      phone,
      email,
      items,
      subtotal,
      pointsUsed,
      pointsEarned: 0,
      shippingFee,
      freeShipping,
      distanceKm: Math.round(km * 10) / 10,
      total,
      fulfillment,
      address,
      note,
      lat: fulfillment === 'delivery' ? lat : null,
      lng: fulfillment === 'delivery' ? lng : null,
      payment,
      paymentStatus: payment === 'midtrans' ? 'pending' : 'needs-check',
      proofPath,
      status: 'new',
      deductions,
      vipCard: hasVipCard,
      isVip,
      createdAt: FieldValue.serverTimestamp(),
    })
    return { id: orderRef.id, orderNo, total }
  })

  return result
})

type OrderData = FirebaseFirestore.DocumentData

// Pembayaran valid: catat sebagai penjualan web, beri poin VIP, dan aktifkan member jika membeli kartu VIP.
async function settleOrderPaid(orderRef: DocumentReference, method: string, byName: string) {
  const database = getFirestore()
  await database.runTransaction(async (transaction) => {
    const order = await transaction.get(orderRef)
    if (!order.exists) throw new HttpsError('not-found', 'Pesanan tidak ditemukan.')
    const data = order.data() as OrderData
    if (data.paymentStatus === 'paid') return
    if (data.status === 'cancelled') {
      transaction.update(orderRef, { paymentStatus: 'paid-after-cancel', paidVia: method })
      return
    }
    const phone = String(data.phone)
    const customerRef = database.collection('customers').doc(String(data.customerUid))
    const memberRef = database.collection('retailMembers').doc(phone)
    const claimRef = database.collection('customerPhones').doc(phone)
    const registrationRef = database.collection('memberRegistrations').doc(orderRef.id)
    const saleRef = database.collection('sales').doc(`web_${orderRef.id}`)
    const [customer, member, claim] = await Promise.all([
      transaction.get(customerRef),
      transaction.get(memberRef),
      transaction.get(claimRef),
    ])

    const items = data.items as OrderItem[]
    const base =
      items.filter((item) => item.sku.toLowerCase() !== vipCardSku).reduce((sum, item) => sum + item.total, 0) -
      Number(data.pointsUsed ?? 0)
    const earnsPoints = data.isVip === true && customer.exists && base >= vipMinimumPurchase
    const pointsEarned = earnsPoints ? Math.floor(base / 100) : 0

    if (pointsEarned > 0) {
      transaction.update(customerRef, { points: FieldValue.increment(pointsEarned) })
      transaction.create(customerRef.collection('pointLedger').doc(), {
        delta: pointsEarned,
        reason: `Poin belanja ${data.orderNo}`,
        orderNo: data.orderNo,
        createdAt: FieldValue.serverTimestamp(),
      })
    }
    if (data.vipCard === true) {
      if (!(member.exists && member.get('active') === true)) {
        transaction.set(memberRef, {
          name: data.customerName,
          phone,
          active: true,
          source: 'web',
          receiptNo: data.orderNo,
          registrationId: orderRef.id,
          registeredByName: byName,
          createdAt: FieldValue.serverTimestamp(),
        })
      }
      transaction.update(registrationRef, {
        status: 'done',
        memberPhone: phone,
        memberName: data.customerName,
        completedByName: byName,
        completedAt: FieldValue.serverTimestamp(),
      })
      if (claim.exists) {
        transaction.set(
          database.collection('customers').doc(String(claim.get('uid'))),
          { vip: true },
          { merge: true },
        )
      }
    }
    transaction.create(saleRef, {
      receiptNo: data.orderNo,
      channel: 'web',
      items: items.map((item) => ({
        sku: item.sku,
        name: item.name,
        unit: item.unit,
        quantity: item.quantity,
        total: item.total,
      })),
      total: data.total,
      shippingFee: data.shippingFee ?? 0,
      paymentMethod: method === 'midtrans' ? 'midtrans' : 'qris',
      cashierUid: null,
      cashierName: 'Website',
      customerName: data.customerName,
      createdAtIso: new Date().toISOString(),
      createdAt: FieldValue.serverTimestamp(),
    })
    transaction.update(orderRef, {
      paymentStatus: 'paid',
      paidVia: method,
      paidAt: FieldValue.serverTimestamp(),
      paymentCheckedBy: byName,
      pointsEarned,
    })
  })
}

// Membatalkan pesanan: kembalikan stok, poin yang dipakai, dan koreksi penjualan/poin jika sudah lunas.
async function cancelOrder(orderRef: DocumentReference, byName: string, reason: string) {
  const database = getFirestore()
  await database.runTransaction(async (transaction: Transaction) => {
    const order = await transaction.get(orderRef)
    if (!order.exists) throw new HttpsError('not-found', 'Pesanan tidak ditemukan.')
    const data = order.data() as OrderData
    if (data.status === 'cancelled' || data.status === 'done') return
    const deductions = (data.deductions ?? []) as Deduction[]
    const customerRef = database.collection('customers').doc(String(data.customerUid))
    const saleRef = database.collection('sales').doc(`web_${orderRef.id}`)
    const registrationRef = database.collection('memberRegistrations').doc(orderRef.id)
    const stocks = await Promise.all(
      deductions.map((entry) => transaction.get(database.collection('inventory').doc(entry.sku.toLowerCase()))),
    )
    const [customer, registration] = await Promise.all([
      transaction.get(customerRef),
      transaction.get(registrationRef),
    ])
    const paid = data.paymentStatus === 'paid'

    deductions.forEach((entry, index) => {
      const previous = stocks[index].exists ? Number(stocks[index].get('onHand')) : 0
      const newOnHand = Math.round((previous + entry.quantity) * 1000) / 1000
      transaction.set(database.collection('inventory').doc(entry.sku.toLowerCase()), {
        sku: entry.sku,
        onHand: newOnHand,
        unit: entry.unit,
        updatedAt: FieldValue.serverTimestamp(),
        updatedBy: 'web',
      })
      transaction.create(database.collection('stockMovements').doc(), {
        sku: entry.sku,
        unit: entry.unit,
        movementType: 'void',
        previousOnHand: previous,
        newOnHand,
        quantityDelta: entry.quantity,
        reason: `Batal ${data.orderNo}: ${reason}`,
        actorUid: 'web',
        createdAt: FieldValue.serverTimestamp(),
      })
    })

    const pointDelta = Number(data.pointsUsed ?? 0) - (paid ? Number(data.pointsEarned ?? 0) : 0)
    if (customer.exists && pointDelta !== 0) {
      transaction.update(customerRef, { points: FieldValue.increment(pointDelta) })
      transaction.create(customerRef.collection('pointLedger').doc(), {
        delta: pointDelta,
        reason: `Koreksi pembatalan ${data.orderNo}`,
        orderNo: data.orderNo,
        createdAt: FieldValue.serverTimestamp(),
      })
    }
    if (paid) {
      transaction.update(saleRef, {
        voided: true,
        voidReason: reason,
        voidedByName: byName,
        voidedAt: FieldValue.serverTimestamp(),
      })
    }
    if (registration.exists && registration.get('status') === 'pending') {
      transaction.update(registrationRef, { status: 'cancelled' })
    }
    transaction.update(orderRef, {
      status: 'cancelled',
      cancelReason: reason,
      updatedAt: FieldValue.serverTimestamp(),
      updatedByName: byName,
    })
  })
}

export const updateWebOrderStatus = onCall(webOptions, async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Silakan login ke POS terlebih dahulu.')
  }
  const staff = await requireStaff(request.auth.uid)
  const input = callableData(request.data)
  const orderId = input.orderId
  const status = input.status
  if (typeof orderId !== 'string' || !/^[A-Za-z0-9_-]{6,80}$/.test(orderId)) {
    throw new HttpsError('invalid-argument', 'Pesanan tidak valid.')
  }
  if (!['new', 'processing', 'ready', 'done', 'cancelled'].includes(status as string)) {
    throw new HttpsError('invalid-argument', 'Status tidak valid.')
  }
  const orderRef = getFirestore().collection('webOrders').doc(orderId)
  const name = staff.displayName ?? 'Staf'
  if (status === 'cancelled') {
    await cancelOrder(orderRef, name, 'Dibatalkan oleh toko')
    return { ok: true }
  }
  await getFirestore().runTransaction(async (transaction) => {
    const order = await transaction.get(orderRef)
    if (!order.exists) throw new HttpsError('not-found', 'Pesanan tidak ditemukan.')
    if (order.get('status') === 'done' || order.get('status') === 'cancelled') {
      throw new HttpsError('failed-precondition', 'Pesanan ini sudah selesai/dibatalkan.')
    }
    if (order.get('paymentStatus') !== 'paid') {
      throw new HttpsError('failed-precondition', 'Pembayaran belum valid. Cek pembayaran dulu.')
    }
    transaction.update(orderRef, {
      status,
      updatedAt: FieldValue.serverTimestamp(),
      updatedByName: name,
    })
  })
  return { ok: true }
})

export const confirmWebOrderPayment = onCall(webOptions, async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Silakan login ke POS terlebih dahulu.')
  }
  const staff = await requireStaff(request.auth.uid)
  const orderId = callableData(request.data).orderId
  if (typeof orderId !== 'string' || !/^[A-Za-z0-9_-]{6,80}$/.test(orderId)) {
    throw new HttpsError('invalid-argument', 'Pesanan tidak valid.')
  }
  const orderRef = getFirestore().collection('webOrders').doc(orderId)
  const order = await orderRef.get()
  if (order.get('payment') !== 'qris') {
    throw new HttpsError('failed-precondition', 'Hanya pembayaran QRIS manual yang dicek manual.')
  }
  await settleOrderPaid(orderRef, 'qris-manual', staff.displayName ?? 'Staf')
  return { ok: true }
})

function midtransBases() {
  const sandbox = midtransServerKey.value().startsWith('SB-')
  return {
    snap: sandbox
      ? 'https://app.sandbox.midtrans.com/snap/v1/transactions'
      : 'https://app.midtrans.com/snap/v1/transactions',
    api: sandbox ? 'https://api.sandbox.midtrans.com' : 'https://api.midtrans.com',
    auth: `Basic ${Buffer.from(`${midtransServerKey.value()}:`).toString('base64')}`,
  }
}

export const createMidtransPayment = onCall(
  { ...webOptions, secrets: [midtransServerKey] },
  async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Sesi tidak ditemukan.')
    const orderId = callableData(request.data).orderId
    if (typeof orderId !== 'string' || !/^[A-Za-z0-9_-]{6,80}$/.test(orderId)) {
      throw new HttpsError('invalid-argument', 'Pesanan tidak valid.')
    }
    const orderRef = getFirestore().collection('webOrders').doc(orderId)
    const order = await orderRef.get()
    if (!order.exists || order.get('customerUid') !== request.auth.uid) {
      throw new HttpsError('not-found', 'Pesanan tidak ditemukan.')
    }
    if (order.get('payment') !== 'midtrans' || order.get('paymentStatus') !== 'pending' || order.get('status') === 'cancelled') {
      throw new HttpsError('failed-precondition', 'Pesanan ini tidak menunggu pembayaran Midtrans.')
    }
    if (typeof order.get('redirectUrl') === 'string') {
      return { redirectUrl: order.get('redirectUrl') as string }
    }

    const data = order.data() as OrderData
    const items = (data.items as OrderItem[]).map((item) => ({
      id: item.sku.slice(0, 50),
      price: item.total,
      quantity: 1,
      name: `${item.name} (${item.quantity} ${item.unit})`.slice(0, 50),
    }))
    if (Number(data.shippingFee) > 0) {
      items.push({ id: 'ongkir', price: Number(data.shippingFee), quantity: 1, name: 'Ongkos kirim' })
    }
    if (Number(data.pointsUsed) > 0) {
      items.push({ id: 'poin', price: -Number(data.pointsUsed), quantity: 1, name: 'Tukar poin VIP' })
    }
    const bases = midtransBases()
    const response = await fetch(bases.snap, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: bases.auth },
      body: JSON.stringify({
        transaction_details: { order_id: data.orderNo, gross_amount: data.total },
        item_details: items,
        customer_details: {
          first_name: String(data.customerName).slice(0, 50),
          phone: `+${data.phone}`,
          ...(data.email ? { email: data.email } : {}),
        },
        callbacks: { finish: `${siteUrl}/?order=${orderRef.id}` },
        expiry: { unit: 'minutes', duration: 60 },
      }),
    })
    const body = (await response.json()) as { redirect_url?: string; token?: string; error_messages?: string[] }
    if (!response.ok || !body.redirect_url) {
      logger.error('Midtrans Snap gagal', { status: response.status, errors: body.error_messages })
      throw new HttpsError('internal', 'Gagal membuat pembayaran Midtrans. Coba lagi atau pilih QRIS.')
    }
    await orderRef.update({ redirectUrl: body.redirect_url, snapToken: body.token ?? '' })
    return { redirectUrl: body.redirect_url }
  },
)

async function applyMidtransStatus(
  orderRef: DocumentReference,
  status: { transaction_status?: string; fraud_status?: string; gross_amount?: string },
) {
  const order = await orderRef.get()
  if (!order.exists || order.get('payment') !== 'midtrans') return
  const paid =
    status.transaction_status === 'settlement' ||
    (status.transaction_status === 'capture' && status.fraud_status !== 'challenge')
  if (paid) {
    if (Math.round(Number(status.gross_amount)) !== Number(order.get('total'))) {
      logger.error('Nominal Midtrans tidak cocok', { orderId: orderRef.id })
      return
    }
    await settleOrderPaid(orderRef, 'midtrans', 'Midtrans')
  } else if (['expire', 'cancel', 'deny', 'failure'].includes(status.transaction_status ?? '')) {
    if (order.get('paymentStatus') === 'pending') {
      await cancelOrder(orderRef, 'Midtrans', `Pembayaran ${status.transaction_status}`)
    }
  }
}

export const midtransNotification = onRequest(
  { ...webOptions, invoker: 'public', secrets: [midtransServerKey] },
  async (request, response) => {
    const body = (request.body ?? {}) as Record<string, string>
    const expected = createHash('sha512')
      .update(`${body.order_id}${body.status_code}${body.gross_amount}${midtransServerKey.value()}`)
      .digest('hex')
    if (request.method !== 'POST' || body.signature_key !== expected) {
      response.status(403).send('invalid signature')
      return
    }
    const found = await getFirestore()
      .collection('webOrders')
      .where('orderNo', '==', body.order_id)
      .limit(1)
      .get()
    if (!found.empty) {
      await applyMidtransStatus(found.docs[0].ref, body)
    }
    response.status(200).send('ok')
  },
)

export const checkMidtransPayment = onCall(
  { ...webOptions, secrets: [midtransServerKey] },
  async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Sesi tidak ditemukan.')
    const orderId = callableData(request.data).orderId
    if (typeof orderId !== 'string' || !/^[A-Za-z0-9_-]{6,80}$/.test(orderId)) {
      throw new HttpsError('invalid-argument', 'Pesanan tidak valid.')
    }
    const orderRef = getFirestore().collection('webOrders').doc(orderId)
    const order = await orderRef.get()
    if (!order.exists || order.get('customerUid') !== request.auth.uid || order.get('payment') !== 'midtrans') {
      throw new HttpsError('not-found', 'Pesanan tidak ditemukan.')
    }
    if (order.get('paymentStatus') === 'pending') {
      const bases = midtransBases()
      const response = await fetch(`${bases.api}/v2/${encodeURIComponent(String(order.get('orderNo')))}/status`, {
        headers: { Accept: 'application/json', Authorization: bases.auth },
      })
      if (response.ok) {
        await applyMidtransStatus(orderRef, await response.json())
      }
    }
    return {
      paymentStatus: (await orderRef.get()).get('paymentStatus') as string,
      status: (await orderRef.get()).get('status') as string,
    }
  },
)

// Customer chose to change the cart instead of paying: release the unpaid order (stock, points) and close it at Midtrans.
export const cancelPendingPayment = onCall(
  { ...webOptions, secrets: [midtransServerKey] },
  async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Sesi tidak ditemukan.')
    const orderId = callableData(request.data).orderId
    if (typeof orderId !== 'string' || !/^[A-Za-z0-9_-]{6,80}$/.test(orderId)) {
      throw new HttpsError('invalid-argument', 'Pesanan tidak valid.')
    }
    const orderRef = getFirestore().collection('webOrders').doc(orderId)
    const order = await orderRef.get()
    if (!order.exists || order.get('customerUid') !== request.auth.uid) {
      throw new HttpsError('not-found', 'Pesanan tidak ditemukan.')
    }
    if (order.get('payment') !== 'midtrans' || order.get('paymentStatus') !== 'pending') {
      return { cancelled: false }
    }
    try {
      const bases = midtransBases()
      await fetch(`${bases.api}/v2/${encodeURIComponent(String(order.get('orderNo')))}/cancel`, {
        method: 'POST',
        headers: { Accept: 'application/json', Authorization: bases.auth },
      })
    } catch (error) {
      logger.warn('Midtrans cancel gagal', { orderId, message: error instanceof Error ? error.message : String(error) })
    }
    await cancelOrder(orderRef, 'Pelanggan', 'Keranjang diubah sebelum bayar')
    return { cancelled: true }
  },
)

// Safety net when Midtrans' expire notification is missed: unpaid Midtrans orders older than the 60 minute window are closed.
export const expireStaleMidtransOrders = onSchedule(
  { region: 'asia-southeast2', schedule: 'every 15 minutes', secrets: [midtransServerKey], serviceAccount: webOptions.serviceAccount },
  async () => {
    const cutoff = new Date(Date.now() - 65 * 60 * 1000)
    const stale = await getFirestore().collection('webOrders').where('paymentStatus', '==', 'pending').limit(100).get()
    const bases = midtransBases()
    for (const entry of stale.docs) {
      const created = (entry.get('createdAt') as { toDate?: () => Date } | null)?.toDate?.()
      if (!created || created > cutoff) continue
      if (entry.get('payment') !== 'midtrans' || entry.get('status') === 'cancelled') continue
      try {
        const response = await fetch(`${bases.api}/v2/${encodeURIComponent(String(entry.get('orderNo')))}/status`, {
          headers: { Accept: 'application/json', Authorization: bases.auth },
        })
        const status = response.ok ? ((await response.json()) as { transaction_status?: string }) : {}
        const state = status.transaction_status ?? ''
        if (state === 'settlement' || state === 'capture') {
          await applyMidtransStatus(entry.ref, status)
        } else {
          await cancelOrder(entry.ref, 'Sistem', 'Waktu pembayaran habis')
        }
      } catch (error) {
        logger.error('Sweep order gagal', { id: entry.id, message: error instanceof Error ? error.message : String(error) })
      }
    }
  },
)
