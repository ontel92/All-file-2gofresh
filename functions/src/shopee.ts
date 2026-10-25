import { AsyncLocalStorage } from 'node:async_hooks'
import { createHmac } from 'node:crypto'
import { getStorage } from 'firebase-admin/storage'
import { FieldValue, getFirestore } from 'firebase-admin/firestore'
import { logger } from 'firebase-functions'
import { defineSecret } from 'firebase-functions/params'
import { onSchedule } from 'firebase-functions/v2/scheduler'
import { HttpsError, onCall, onRequest, type CallableRequest } from 'firebase-functions/v2/https'
import { google } from 'googleapis'
import { shopeeMarginMappings } from './shopeeMarginMappings'

const shopeeOptions = {
  region: 'asia-southeast2',
  memory: '512MiB',
  maxInstances: 3,
  serviceAccount: 'catalog-sync-runtime@gofresh-3f2f3.iam.gserviceaccount.com',
  timeoutSeconds: 120,
} as const

const partnerIdSecret = defineSecret('SHOPEE_PARTNER_ID')
const partnerKeySecret = defineSecret('SHOPEE_PARTNER_KEY')
const options = {
  ...shopeeOptions,
  secrets: [partnerIdSecret, partnerKeySecret],
  cors: [
    'http://127.0.0.1:5173',
    'http://localhost:5173',
    'https://localhost',
    'capacitor://localhost',
    'https://kasir.2gofresh.com',
    'https://www.kasir.2gofresh.com',
  ],
}
const shopeeHost = { value: () => process.env.SHOPEE_HOST ?? 'https://partner.shopeemobile.com' }

// Freshstock memakai aplikasi Open Platform, token, dan callback sendiri agar tidak tercampur dengan 2goFresh.
type ShopeeStore = '2gofresh' | 'freshstock'
const freshstockPartnerIdSecret = defineSecret('SHOPEE_FRESHSTOCK_PARTNER_ID')
const freshstockPartnerKeySecret = defineSecret('SHOPEE_FRESHSTOCK_PARTNER_KEY')
const storeOptions = {
  ...options,
  secrets: [partnerIdSecret, partnerKeySecret, freshstockPartnerIdSecret, freshstockPartnerKeySecret],
}
const storeLongOptions = { ...storeOptions, timeoutSeconds: 300 }
const storeContext = new AsyncLocalStorage<ShopeeStore>()
const currentStore = (): ShopeeStore => storeContext.getStore() ?? '2gofresh'
const activePartnerId = () => (currentStore() === 'freshstock' ? freshstockPartnerIdSecret : partnerIdSecret).value().trim()
const activePartnerKey = () => (currentStore() === 'freshstock' ? freshstockPartnerKeySecret : partnerKeySecret).value().trim()
const callbackUrls: Record<ShopeeStore, string> = {
  '2gofresh': 'https://kasir.2gofresh.com/shopee/callback',
  freshstock: 'https://kasir.2gofresh.com/shopee/callback-freshstock',
}
const authDoc = () => getFirestore().collection('shopeeAuth').doc(currentStore() === 'freshstock' ? 'freshstock' : 'current')

type ShopeeAuth = { shopId: number; accessToken: string; refreshToken: string; expiresAt: number }
type Json = Record<string, unknown>
type Role = 'owner' | 'supervisor' | 'cashier'

function sign(base: string) {
  return createHmac('sha256', activePartnerKey()).update(base).digest('hex')
}

function storeFromRequest(request: { data: unknown }): ShopeeStore {
  const store = typeof request.data === 'object' && request.data !== null ? (request.data as Json).store : undefined
  if (store === undefined || store === '2gofresh') return '2gofresh'
  if (store === 'freshstock') return 'freshstock'
  throw new HttpsError('invalid-argument', 'Toko Shopee tidak valid.')
}

// Tanpa field `store`, pemanggil lama tetap memakai toko 2goFresh.
function storeCall<T>(callOptions: typeof storeOptions | typeof storeLongOptions, handler: (request: CallableRequest) => Promise<T>) {
  return onCall(callOptions, (request) => storeContext.run(storeFromRequest(request), () => handler(request)))
}

async function requireStaff(request: { auth?: { uid: string } }, roles: Role[] = ['owner', 'supervisor', 'cashier']) {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Login diperlukan.')
  const data = (await getFirestore().collection('staff').doc(request.auth.uid).get()).data() as
    | { active?: boolean; role?: Role }
    | undefined
  if (data?.active !== true || !data.role || !roles.includes(data.role)) {
    throw new HttpsError('permission-denied', 'Akses ini tidak tersedia untuk akun Anda.')
  }
}

const managers: Role[] = ['owner', 'supervisor']

function input(request: { data: unknown }): Json {
  return typeof request.data === 'object' && request.data !== null ? (request.data as Json) : {}
}

function str(value: unknown, label: string, max = 100) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text || text.length > max) throw new HttpsError('invalid-argument', `${label} tidak valid.`)
  return text
}

function whole(value: unknown, label: string) {
  const number = Number(value)
  if (!Number.isFinite(number) || number < 0 || !Number.isInteger(number)) {
    throw new HttpsError('invalid-argument', `${label} harus bilangan bulat ≥ 0.`)
  }
  return number
}

async function publicCall(path: string, body: Json) {
  const partnerId = activePartnerId()
  const timestamp = Math.floor(Date.now() / 1000)
  const response = await fetch(
    `${shopeeHost.value()}${path}?partner_id=${partnerId}&timestamp=${timestamp}&sign=${sign(`${partnerId}${path}${timestamp}`)}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, partner_id: Number(partnerId) }) },
  )
  return (await response.json()) as Json
}

async function saveTokens(shopId: number, payload: Json) {
  const accessToken = String(payload.access_token ?? '')
  const refreshToken = String(payload.refresh_token ?? '')
  if (!accessToken || !refreshToken) {
    logger.error('Shopee token error', { error: payload.error, message: payload.message })
    throw new HttpsError('failed-precondition', `Shopee menolak: ${String(payload.message ?? payload.error ?? 'tidak diketahui')}`)
  }
  const auth: ShopeeAuth = {
    shopId,
    accessToken,
    refreshToken,
    expiresAt: Date.now() + (Number(payload.expire_in ?? 14400) - 300) * 1000,
  }
  await authDoc().set({ ...auth, updatedAt: FieldValue.serverTimestamp() })
  return auth
}

async function getAuth(): Promise<ShopeeAuth> {
  const data = (await authDoc().get()).data() as ShopeeAuth | undefined
  if (!data) throw new HttpsError('failed-precondition', 'Shopee belum terhubung. Klik "Hubungkan Shopee" dulu.')
  if (data.expiresAt > Date.now()) return data
  const refreshed = await publicCall('/api/v2/auth/access_token/get', { refresh_token: data.refreshToken, shop_id: data.shopId })
  return saveTokens(data.shopId, refreshed)
}

async function shopFetch(path: string, params: Record<string, string | number> = {}, body?: Json) {
  const auth = await getAuth()
  const partnerId = activePartnerId()
  const timestamp = Math.floor(Date.now() / 1000)
  const query = new URLSearchParams({
    partner_id: partnerId,
    timestamp: String(timestamp),
    access_token: auth.accessToken,
    shop_id: String(auth.shopId),
    sign: sign(`${partnerId}${path}${timestamp}${auth.accessToken}${auth.shopId}`),
    ...Object.fromEntries(Object.entries(params).map(([key, value]) => [key, String(value)])),
  })
  return fetch(`${shopeeHost.value()}${path}?${query}`, {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
}

function checkJson(path: string, json: Json) {
  if (json.error) {
    logger.error('Shopee API error', { path, error: json.error, message: json.message })
    throw new HttpsError('failed-precondition', `Shopee: ${String(json.message || json.error)}`)
  }
  return json
}

async function shopCall(path: string, params: Record<string, string | number> = {}, body?: Json) {
  const response = await shopFetch(path, params, body)
  return checkJson(path, (await response.json()) as Json)
}

async function shopImageUpload(fileName: string, contentType: string, bytes: Buffer) {
  const auth = await getAuth()
  const partnerId = activePartnerId()
  const path = '/api/v2/media_space/upload_image'
  const timestamp = Math.floor(Date.now() / 1000)
  const query = new URLSearchParams({
    partner_id: partnerId,
    timestamp: String(timestamp),
    access_token: auth.accessToken,
    shop_id: String(auth.shopId),
    sign: sign(`${partnerId}${path}${timestamp}${auth.accessToken}${auth.shopId}`),
  })
  const form = new FormData()
  form.append('scene', 'normal')
  form.append('ratio', '1:1')
  form.append('image', new Blob([new Uint8Array(bytes)], { type: contentType }), fileName)
  const response = await fetch(`${shopeeHost.value()}${path}?${query}`, { method: 'POST', body: form })
  return checkJson(path, (await response.json()) as Json)
}

const list = (value: unknown): Json[] => (Array.isArray(value) ? (value as Json[]) : [])
const obj = (value: unknown): Json => (typeof value === 'object' && value !== null ? (value as Json) : {})

function productResponse(payload: Json): Json {
  return obj(payload.response)
}

export const shopeeConnectUrl = storeCall(storeOptions, async (request) => {
  await requireStaff(request, managers)
  const partnerId = activePartnerId()
  const path = '/api/v2/shop/auth_partner'
  const timestamp = Math.floor(Date.now() / 1000)
  return {
    url: `${shopeeHost.value()}${path}?partner_id=${partnerId}&timestamp=${timestamp}&sign=${sign(`${partnerId}${path}${timestamp}`)}&redirect=${encodeURIComponent(callbackUrls[currentStore()])}`,
  }
})

async function completeShopeeAuthorization(
  store: ShopeeStore,
  request: { query: Record<string, unknown> },
  response: { status: (code: number) => { send: (body: string) => void }; redirect: (url: string) => void },
) {
  const code = String(request.query.code ?? '')
  const shopId = Number(request.query.shop_id ?? 0)
  if (!code || !shopId) {
    response.status(400).send('Parameter tidak lengkap.')
    return
  }
  try {
    await storeContext.run(store, async () => {
      await saveTokens(shopId, await publicCall('/api/v2/auth/token/get', { code, shop_id: shopId }))
    })
    response.redirect(
      store === 'freshstock'
        ? 'https://kasir.2gofresh.com/?panel=marketplace&shopee=connected&store=freshstock'
        : 'https://kasir.2gofresh.com/?shopee=connected',
    )
  } catch (error) {
    logger.error('Shopee callback gagal', { store, error })
    response.status(500).send('Gagal menghubungkan Shopee. Coba lagi dari POS.')
  }
}

export const shopeeCallback = onRequest(options, (request, response) =>
  completeShopeeAuthorization('2gofresh', request, response))

export const shopeeCallbackFreshstock = onRequest(storeOptions, (request, response) =>
  completeShopeeAuthorization('freshstock', request, response))

export const shopeeStatus = storeCall(storeOptions, async (request) => {
  await requireStaff(request)
  const data = (await authDoc().get()).data() as ShopeeAuth | undefined
  if (!data) return { connected: false }
  try {
    const info = await shopCall('/api/v2/shop/get_shop_info')
    return { connected: true, shopId: data.shopId, shopName: String(info.shop_name ?? '') }
  } catch {
    return { connected: true, shopId: data.shopId, shopName: '' }
  }
})

const orderStatuses = ['ALL', 'UNPAID', 'READY_TO_SHIP', 'PROCESSED', 'SHIPPED', 'COMPLETED', 'IN_CANCEL', 'CANCELLED', 'TO_RETURN']

export const shopeeOrders = storeCall(storeOptions, async (request) => {
  await requireStaff(request)
  const data = input(request)
  const status = typeof data.status === 'string' ? data.status : 'READY_TO_SHIP'
  if (!orderStatuses.includes(status)) throw new HttpsError('invalid-argument', 'Status tidak valid.')
  const now = Math.floor(Date.now() / 1000)
  const params: Record<string, string | number> = {
    time_range_field: 'create_time',
    time_from: now - 14 * 24 * 3600,
    time_to: now,
    page_size: 30,
  }
  if (status !== 'ALL') params.order_status = status
  if (typeof data.cursor === 'string' && data.cursor) params.cursor = data.cursor
  const result = obj((await shopCall('/api/v2/order/get_order_list', params)).response)
  const sns = list(result.order_list).map((order) => String(order.order_sn))
  if (sns.length === 0) return { orders: [], more: false, cursor: '' }
  const detail = await shopCall('/api/v2/order/get_order_detail', {
    order_sn_list: sns.join(','),
    response_optional_fields:
      'buyer_user_id,buyer_username,recipient_address,item_list,pay_time,shipping_carrier,payment_method,total_amount,package_list,note,message_to_seller,ship_by_date,cancel_reason,order_status',
  })
  const orders = list(obj(detail.response).order_list).map((order) => {
    const address = obj(order.recipient_address)
    return {
      orderSn: String(order.order_sn),
      status: String(order.order_status),
      buyer: String(order.buyer_username ?? ''),
      total: Number(order.total_amount ?? 0),
      carrier: String(order.shipping_carrier ?? ''),
      payment: String(order.payment_method ?? ''),
      createdAt: Number(order.create_time ?? 0) * 1000,
      shipBy: Number(order.ship_by_date ?? 0) * 1000,
      note: String(order.note ?? ''),
      buyerMessage: String(order.message_to_seller ?? ''),
      cancelReason: String(order.cancel_reason ?? ''),
      recipient: String(address.name ?? ''),
      phone: String(address.phone ?? ''),
      address: String(address.full_address ?? ''),
      packages: list(order.package_list).map((pack) => ({
        packageNumber: String(pack.package_number ?? ''),
        logistics: String(pack.logistics_status ?? ''),
        carrier: String(pack.shipping_carrier ?? ''),
      })),
      items: list(order.item_list).map((item) => ({
        itemId: Number(item.item_id ?? 0),
        modelId: Number(item.model_id ?? 0),
        name: String(item.item_name ?? ''),
        variant: String(item.model_name ?? ''),
        sku: String(item.model_sku || item.item_sku || ''),
        quantity: Number(item.model_quantity_purchased ?? 0),
        price: Number(item.model_discounted_price ?? 0),
        image: String(obj(item.image_info).image_url ?? ''),
      })),
    }
  })
  return { orders, more: result.more === true, cursor: String(result.next_cursor ?? '') }
})

type MarginLine = {
  name: string
  variant: string
  sku: string
  quantity: number | null
  unitCost: number | null
  cost: number | null
  mappingSource: string
}

type PendingMarginOrder = {
  orderSn: string
  status: string
  createdAt: number
  orderAmount: number | null
  costOfGoods: number | null
  hasUnmappedItems: boolean
  lines: MarginLine[]
}

function amountValue(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'string') return null
  const digits = value.trim().replace(/[^\d.-]/g, '')
  const valueNumber = Number(digits)
  return digits && Number.isFinite(valueNumber) ? valueNumber : null
}

type MarginSkuMapping = {
  masterSku: string
  factor: number
  source: 'item-variant' | 'seller-sku' | 'single-item-sku' | 'variant-sku'
}

const marginFactorOverrides: Record<string, number> = {
  '24164512075:255356953423': 0.25,
}

function mappedMarginFactor(itemId: number, modelId: number, fallback: number) {
  return marginFactorOverrides[`${itemId}:${modelId}`] ?? fallback
}

function marginMapping(itemId: number, modelId: number, itemSku: string, modelSku: string): MarginSkuMapping | null {
  const exact = shopeeMarginMappings.find((entry) => entry.itemId === itemId && entry.modelId === modelId && entry.ready)
  if (exact) return { masterSku: exact.sku, factor: mappedMarginFactor(itemId, modelId, exact.factor), source: 'item-variant' }
  const sku = (modelSku || itemSku).trim().toUpperCase()
  const parsedVariant = variantSkuMapping(sku)
  if (parsedVariant) return parsedVariant
  const bySku = shopeeMarginMappings.filter((entry) => entry.ready && entry.sku.toUpperCase() === sku)
  const skuMappings = new Map(bySku.map((entry) => [`${entry.sku.toUpperCase()}:${entry.factor}`, entry]))
  if (skuMappings.size === 1) {
    const [entry] = skuMappings.values()
    return { masterSku: entry.sku, factor: entry.factor, source: 'seller-sku' }
  }

  const byItem = shopeeMarginMappings.filter((entry) => entry.itemId === itemId && entry.ready)
  const itemMappings = new Map(byItem.map((entry) => [`${entry.sku.toUpperCase()}:${entry.factor}`, entry]))
  if (itemMappings.size === 1) {
    const [entry] = itemMappings.values()
    return { masterSku: entry.sku, factor: entry.factor, source: 'single-item-sku' }
  }
  return null
}

function variantSkuMapping(sku: string): MarginSkuMapping | null {
  const match = /^(.+)-([0-9]+)G$/.exec(sku.trim().toUpperCase())
  if (!match) return null
  const masterSku = match[1]
  const grams = Number(match[2])
  const hasMasterMapping = shopeeMarginMappings.some((entry) => entry.ready && entry.sku.toUpperCase() === masterSku)
  return hasMasterMapping && Number.isFinite(grams) && grams > 0 && grams <= 1000
    ? { masterSku, factor: grams / 1000, source: 'variant-sku' }
    : null
}

function marginLines(items: Json[], masterCostBySku: Map<string, number>): MarginLine[] {
  return items.map((item) => {
    const itemId = Number(item.item_id ?? 0)
    const modelId = Number(item.model_id ?? 0)
    const itemSku = String(item.item_sku ?? '')
    const modelSku = String(item.model_sku ?? '')
    const parsedQuantity = Number(item.model_quantity_purchased ?? item.quantity_purchased)
    const quantity = Number.isFinite(parsedQuantity) && parsedQuantity > 0 ? parsedQuantity : null
    const mapping = marginMapping(itemId, modelId, itemSku, modelSku)
    const directSku = (modelSku || itemSku).trim().toUpperCase()
    const directCost = mapping
      ? masterCostBySku.get(mapping.masterSku)
      : masterCostBySku.get(directSku)
    const unitCost = directCost === undefined
      ? null
      : Math.round(directCost * (mapping?.factor ?? 1))
    return {
      name: String(item.item_name ?? ''),
      variant: String(item.model_name ?? ''),
      sku: mapping?.masterSku ?? directSku,
      quantity,
      unitCost,
      cost: unitCost === null || quantity === null ? null : Math.round(unitCost * quantity),
      mappingSource: mapping
        ? directCost !== undefined
          ? mapping.source === 'single-item-sku'
            ? 'Master Google Sheets · SKU item Shopee tunggal × faktor mapping Excel'
            : mapping.source === 'variant-sku'
              ? 'Master Google Sheets · SKU varian berat × faktor isi'
            : 'Master Google Sheets · HPP efektif × faktor mapping Excel'
          : 'SKU mapping tidak ditemukan di master Google Sheets'
        : directCost !== undefined ? 'Master Google Sheets · SKU langsung' : 'Mapping HPP belum tersedia',
    }
  })
}

const marginStart = Math.floor(new Date('2026-10-01T00:00:00+07:00').getTime() / 1000)
const marginPendingStatuses = new Set(['READY_TO_SHIP', 'PROCESSED', 'SHIPPED', 'COMPLETED'])
const marginCacheOptions = {
  ...shopeeOptions,
  secrets: [partnerIdSecret, partnerKeySecret],
  maxInstances: 1,
  concurrency: 1,
}

function marginDocId(orderSn: string) {
  return Buffer.from(orderSn).toString('base64url')
}

function jakartaDayStart(timestamp: number) {
  const date = new Date(timestamp * 1000)
  const day = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Jakarta' }).format(date)
  return Math.floor(new Date(`${day}T00:00:00+07:00`).getTime() / 1000)
}

async function marginMasterCosts() {
  const masterCostBySku = new Map<string, number>()
  try {
    const auth = new google.auth.GoogleAuth({
      scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
    })
    const sheets = google.sheets({ version: 'v4', auth })
    const master = await sheets.spreadsheets.values.get({
      spreadsheetId: '1Z3GxcqyB2DxGmfJcMuWvjDFKRRv7jceAlHPvfQ_zHR8',
      range: 'B:H',
      valueRenderOption: 'UNFORMATTED_VALUE',
    })
    for (const row of master.data.values ?? []) {
      const sku = String(row[0] ?? '').trim().toUpperCase()
      const cost = amountValue(row[6])
      if (sku && cost !== null) masterCostBySku.set(sku, cost)
    }
  } catch (error) {
    logger.error('Unable to load master HPP for Shopee margin report.', error)
    throw new HttpsError('failed-precondition', 'Master HPP tidak dapat dibaca. Periksa akses service account ke Google Sheets.')
  }
  return masterCostBySku
}

async function fetchShopeeMarginWindow(from: number, to: number, orderTimeField: 'create_time' | 'update_time') {
  const escrowByOrder = new Map<string, Json>()
  for (let pageNo = 1; pageNo <= 5; pageNo += 1) {
    const response = obj((await shopCall('/api/v2/payment/get_escrow_list', {
      release_time_from: from,
      release_time_to: to,
      page_size: 40,
      page_no: pageNo,
    })).response)
    for (const entry of list(response.escrow_list)) {
      const orderSn = String(entry.order_sn ?? '')
      if (orderSn) escrowByOrder.set(orderSn, entry)
    }
    if (response.more !== true) break
    if (pageNo === 5) throw new HttpsError('resource-exhausted', 'Data escrow pada periode ini melebihi batas aman sinkronisasi. Periode akan dicoba lagi pada siklus berikutnya.')
  }

  const ordersBySn = new Map<string, Json>()
  let cursor = ''
  for (let page = 0; page < 5; page += 1) {
    const params: Record<string, string | number> = {
      time_range_field: orderTimeField,
      time_from: from,
      time_to: to,
      page_size: 100,
    }
    if (cursor) params.cursor = cursor
    const response = obj((await shopCall('/api/v2/order/get_order_list', params)).response)
    for (const order of list(response.order_list)) {
      const orderSn = String(order.order_sn ?? '')
      if (orderSn) ordersBySn.set(orderSn, order)
    }
    if (response.more !== true) break
    const nextCursor = String(response.next_cursor ?? '')
    if (!nextCursor || nextCursor === cursor) {
      throw new HttpsError('failed-precondition', 'Shopee tidak memberikan cursor valid untuk membaca daftar pesanan.')
    }
    cursor = nextCursor
    if (page === 4) throw new HttpsError('resource-exhausted', 'Jumlah pesanan pada periode ini melebihi batas aman sinkronisasi. Periode akan dicoba lagi pada siklus berikutnya.')
  }

  const orderSns = [...new Set([...escrowByOrder.keys(), ...ordersBySn.keys()])]
  const detailsByOrder = new Map<string, Json>()
  for (let offset = 0; offset < orderSns.length; offset += 50) {
    const batch = orderSns.slice(offset, offset + 50)
    const response = obj((await shopCall('/api/v2/order/get_order_detail', {
      order_sn_list: batch.join(','),
      response_optional_fields: 'item_list,create_time,order_status,total_amount',
    })).response)
    for (const detail of list(response.order_list)) {
      const orderSn = String(detail.order_sn ?? '')
      if (orderSn) detailsByOrder.set(orderSn, detail)
    }
  }

  const incomeByOrder = new Map<string, Json>()
  const escrowSns = [...escrowByOrder.keys()]
  for (let offset = 0; offset < escrowSns.length; offset += 20) {
    const batch = escrowSns.slice(offset, offset + 20)
    const response = obj((await shopCall('/api/v2/payment/get_escrow_detail_batch', {}, {
      order_sn_list: batch,
    })).response)
    for (const entry of list(response.order_income_list)) {
      const orderSn = String(entry.order_sn ?? '')
      if (orderSn) incomeByOrder.set(orderSn, obj(entry.order_income))
    }
  }

  const database = getFirestore()
  const releasedCollection = database.collection('shopeeMarginReleased')
  const pendingCollection = database.collection('shopeeMarginPending')
  const writes: Array<Promise<unknown>> = []
  for (const [orderSn, escrow] of escrowByOrder) {
    const detail = detailsByOrder.get(orderSn)
    const releasedAt = Number(escrow.escrow_release_time ?? 0) * 1000
    if (!Number.isFinite(releasedAt) || releasedAt <= 0) continue
    writes.push(releasedCollection.doc(marginDocId(orderSn)).set({
      orderSn,
      escrow,
      detail: detail ?? null,
      income: incomeByOrder.get(orderSn) ?? null,
      releasedAt,
      syncedAt: FieldValue.serverTimestamp(),
    }, { merge: true }))
    writes.push(pendingCollection.doc(marginDocId(orderSn)).delete())
  }
  for (const [orderSn, order] of ordersBySn) {
    if (escrowByOrder.has(orderSn)) continue
    const detail = detailsByOrder.get(orderSn)
    const status = String(detail?.order_status ?? order.order_status ?? '')
    if (!marginPendingStatuses.has(status)) {
      writes.push(pendingCollection.doc(marginDocId(orderSn)).delete())
      continue
    }
    const createdAt = Number(detail?.create_time ?? order.create_time ?? 0) * 1000
    writes.push(pendingCollection.doc(marginDocId(orderSn)).set({
      orderSn,
      detail: detail ?? order,
      status,
      createdAt,
      syncedAt: FieldValue.serverTimestamp(),
    }, { merge: true }))
  }
  for (let offset = 0; offset < writes.length; offset += 40) {
    await Promise.all(writes.slice(offset, offset + 40))
  }
  return { escrowCount: escrowByOrder.size, orderCount: ordersBySn.size }
}

async function withMarginSyncLock(task: () => Promise<void>) {
  const database = getFirestore()
  const lock = database.collection('shopeeMarginSync').doc('lock')
  const state = database.collection('shopeeMarginSync').doc('state')
  const acquired = await database.runTransaction(async (transaction) => {
    const lockSnapshot = await transaction.get(lock)
    const stateSnapshot = await transaction.get(state)
    const now = Date.now()
    if (Number(lockSnapshot.get('lockUntil') ?? 0) > now || Number(stateSnapshot.get('retryAfter') ?? 0) > now) return false
    transaction.set(lock, { lockUntil: now + 8 * 60 * 1000 })
    return true
  })
  if (!acquired) {
    logger.info('Shopee margin sync skipped because a sync lock or API cooldown is active.')
    return
  }
  try {
    await task()
    await lock.set({ lockUntil: 0, lastSuccessAt: FieldValue.serverTimestamp(), lastError: '' }, { merge: true })
    await state.set({ lastError: '', retryAfter: 0 }, { merge: true })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await lock.set({
      lockUntil: 0,
      lastError: message,
      lastErrorAt: FieldValue.serverTimestamp(),
    }, { merge: true })
    await state.set({
      lastError: message,
      lastErrorAt: FieldValue.serverTimestamp(),
      retryAfter: Date.now() + 30 * 60 * 1000,
    }, { merge: true })
    logger.error('Shopee margin cache sync failed.', error)
  }
}

export const syncShopeeMarginCache = onSchedule(
  { ...marginCacheOptions, schedule: 'every 10 minutes', timeZone: 'Asia/Jakarta' },
  async () => withMarginSyncLock(async () => {
    const now = Math.floor(Date.now() / 1000)
    const from = Math.max(marginStart, now - 30 * 60)
    const result = await fetchShopeeMarginWindow(from, now, 'update_time')
    const state = getFirestore().collection('shopeeMarginSync').doc('state')
    await state.set({ lastSyncAt: FieldValue.serverTimestamp(), ...result }, { merge: true })
    logger.info('Shopee margin cache incrementally synchronized.', result)
  }),
)

export const backfillShopeeMarginCache = onSchedule(
  { ...marginCacheOptions, schedule: 'every 1 hours', timeZone: 'Asia/Jakarta' },
  async () => withMarginSyncLock(async () => {
    const database = getFirestore()
    const state = database.collection('shopeeMarginSync').doc('state')
    const snapshot = await state.get()
    if (snapshot.get('backfillComplete') === true) return
    const now = Math.floor(Date.now() / 1000)
    const to = Math.min(now, Number(snapshot.get('backfillNextEnd') ?? now))
    const from = Math.max(marginStart, to - 24 * 60 * 60)
    const result = await fetchShopeeMarginWindow(from, to, 'create_time')
    await state.set({
      backfillNextEnd: from,
      backfillComplete: from <= marginStart,
      lastBackfillAt: FieldValue.serverTimestamp(),
      ...result,
    }, { merge: true })
    logger.info('Shopee margin historical cache synchronized.', { from, to, ...result })
  }),
)

export const shopeeRealizedMargins = onCall(
  shopeeOptions,
  async (request) => {
    await requireStaff(request)
    const data = input(request)
    const period = typeof data.period === 'string' ? data.period : 'week'
    if (!['day', 'week', 'month'].includes(period)) throw new HttpsError('invalid-argument', 'Periode laporan tidak valid.')
    const now = Math.floor(Date.now() / 1000)
    const todayStart = jakartaDayStart(now)
    const rangeStart = period === 'day'
      ? todayStart
      : period === 'week'
        ? todayStart - 6 * 24 * 60 * 60
        : Math.floor(new Date(`${new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit' }).format(new Date(now * 1000))}-01T00:00:00+07:00`).getTime() / 1000)
    const database = getFirestore()
    const [releasedSnapshot, pendingSnapshot, stateSnapshot, masterCostBySku] = await Promise.all([
      database.collection('shopeeMarginReleased')
        .where('releasedAt', '>=', rangeStart * 1000)
        .where('releasedAt', '<=', now * 1000)
        .limit(2000)
        .get(),
      database.collection('shopeeMarginPending')
        .where('createdAt', '>=', rangeStart * 1000)
        .where('createdAt', '<=', now * 1000)
        .limit(2000)
        .get(),
      database.collection('shopeeMarginSync').doc('state').get(),
      marginMasterCosts(),
    ])
    const releasedRows = releasedSnapshot.docs.map((document) => document.data())
    const pendingRows = pendingSnapshot.docs.map((document) => document.data())
    const incomplete = releasedRows.length === 2000 || pendingRows.length === 2000
    if (incomplete) throw new HttpsError('resource-exhausted', 'Data periode ini melebihi 2.000 order. Pilih periode yang lebih pendek.')
    return {
      source: 'Cache Firebase · sinkronisasi Shopee terjadwal',
      rangeStart: rangeStart * 1000,
      rangeEnd: now * 1000,
      generatedAt: Date.now(),
      syncedAt: (stateSnapshot.get('lastSyncAt') as { toMillis?: () => number } | undefined)?.toMillis?.() ?? null,
      syncError: String(stateSnapshot.get('lastError') ?? ''),
      backfillComplete: stateSnapshot.get('backfillComplete') === true,
      pendingOrders: pendingRows.map((row): PendingMarginOrder => {
        const detail = obj(row.detail)
        const orderSn = String(row.orderSn ?? '')
        const lines = marginLines(list(detail?.item_list), masterCostBySku)
        const totalCost = lines.length > 0 && lines.every((line) => line.cost !== null)
          ? lines.reduce((sum, line) => sum + (line.cost ?? 0), 0)
          : null
        return {
          orderSn,
          status: String(detail?.order_status ?? row.status ?? ''),
          createdAt: Number(detail?.create_time ?? 0) * 1000 || Number(row.createdAt ?? 0),
          orderAmount: amountValue(detail?.total_amount),
          costOfGoods: totalCost,
          hasUnmappedItems: lines.length === 0 || lines.some((line) => line.cost === null),
          lines,
        }
      }),
      orders: releasedRows.map((row) => {
        const orderSn = String(row.orderSn ?? '')
        const escrow = obj(row.escrow)
        const detail = obj(row.detail)
        const lines = marginLines(list(detail?.item_list), masterCostBySku)
        const payout = amountValue(escrow.payout_amount)
        const income = obj(row.income)
        const feeBreakdown = Object.entries(income ?? {})
          .filter(([, value]) => amountValue(value) !== null)
          .map(([name, value]) => ({ name, amount: amountValue(value)! }))
        const detailError = income ? '' : 'Shopee tidak mengembalikan rincian escrow untuk order ini.'
        const totalCost = lines.length > 0 && lines.every((line) => line.cost !== null)
          ? lines.reduce((sum, line) => sum + (line.cost ?? 0), 0)
          : null
        const payoutAt = Number(row.releasedAt ?? 0)
        return {
          orderSn,
          status: String(detail?.order_status ?? 'SETTLED'),
          releasedAt: payoutAt,
          payout,
          costOfGoods: totalCost,
          netProfit: payout !== null && totalCost !== null ? payout - totalCost : null,
          hasUnmappedItems: lines.length === 0 || lines.some((line) => line.cost === null),
          lines,
          feeBreakdown,
          feeDetailError: detailError,
          payoutSource: 'payout_amount · Shopee get_escrow_list',
        }
      }),
    }
  },
)

export const shopeeTracking = storeCall(storeOptions, async (request) => {
  await requireStaff(request)
  const data = input(request)
  const orderSn = str(data.orderSn, 'Nomor pesanan')
  const packageNumber = typeof data.packageNumber === 'string' ? data.packageNumber : ''
  const tracking = await shopCall('/api/v2/logistics/get_tracking_number', {
    order_sn: orderSn,
    ...(packageNumber ? { package_number: packageNumber } : {}),
  })
  return { trackingNumber: String(obj(tracking.response).tracking_number ?? '') }
})

// Counts orders per status over the same 14-day window as the order list.
export const shopeeOrderCounts = storeCall(storeOptions, async (request) => {
  await requireStaff(request)
  const now = Math.floor(Date.now() / 1000)
  const statuses = orderStatuses.filter((status) => status !== 'ALL' && status !== 'TO_RETURN')
  const entries = await Promise.all(
    statuses.map(async (status) => {
      let count = 0
      let cursor = ''
      for (let page = 0; page < 5; page += 1) {
        const params: Record<string, string | number> = {
          time_range_field: 'create_time',
          time_from: now - 14 * 24 * 3600,
          time_to: now,
          page_size: 100,
          order_status: status,
        }
        if (cursor) params.cursor = cursor
        const result = obj((await shopCall('/api/v2/order/get_order_list', params)).response)
        count += list(result.order_list).length
        if (result.more !== true) break
        cursor = String(result.next_cursor ?? '')
      }
      return [status, count] as const
    }),
  )
  const counts = Object.fromEntries(entries) as Record<string, number>
  return { counts: { ...counts, ALL: Object.values(counts).reduce((sum, value) => sum + value, 0) } }
})

export const shopeeShipInfo = storeCall(storeOptions, async (request) => {
  await requireStaff(request)
  const orderSn = str(input(request).orderSn, 'Nomor pesanan')
  const response = obj((await shopCall('/api/v2/logistics/get_shipping_parameter', { order_sn: orderSn })).response)
  const needed = obj(response.info_needed)
  const pickup = obj(response.pickup)
  return {
    methods: ['pickup', 'dropoff', 'non_integrated'].filter((method) => Array.isArray(needed[method])),
    addresses: list(pickup.address_list).map((address) => ({
      addressId: Number(address.address_id ?? 0),
      text: [address.address, address.district, address.city, address.state, address.zipcode].filter(Boolean).join(', '),
      slots: list(address.time_slot_list).map((slot) => ({
        id: String(slot.pickup_time_id ?? ''),
        text: String(slot.time_text ?? ''),
        date: Number(slot.date ?? 0) * 1000,
      })),
    })),
  }
})

export const shopeeShip = storeCall(storeOptions, async (request) => {
  await requireStaff(request)
  const data = input(request)
  const orderSn = str(data.orderSn, 'Nomor pesanan')
  const method = str(data.method, 'Metode', 20)
  const body: Json = { order_sn: orderSn }
  if (method === 'pickup') {
    body.pickup = { address_id: whole(data.addressId, 'Alamat pickup'), pickup_time_id: str(data.pickupTimeId, 'Jadwal pickup') }
  } else if (method === 'dropoff') {
    body.dropoff = {}
  } else if (method === 'non_integrated') {
    body.non_integrated = { tracking_number: str(data.trackingNumber, 'Nomor resi', 60) }
  } else {
    throw new HttpsError('invalid-argument', 'Metode pengiriman tidak valid.')
  }
  await shopCall('/api/v2/logistics/ship_order', {}, body)
  return { ok: true }
})

export const shopeeLabel = storeCall(storeOptions, async (request) => {
  await requireStaff(request)
  const data = input(request)
  const orderSn = str(data.orderSn, 'Nomor pesanan')
  const packageNumber = typeof data.packageNumber === 'string' ? data.packageNumber : ''
  const entry: Json = { order_sn: orderSn, ...(packageNumber ? { package_number: packageNumber } : {}) }

  const tracking = await shopCall('/api/v2/logistics/get_tracking_number', {
    order_sn: orderSn,
    ...(packageNumber ? { package_number: packageNumber } : {}),
  })
  const trackingNumber = String(obj(tracking.response).tracking_number ?? '')
  if (trackingNumber) entry.tracking_number = trackingNumber

  const parameter = await shopCall('/api/v2/logistics/get_shipping_document_parameter', {}, { order_list: [entry] })
  const first = list(obj(parameter.response).result_list)[0] ?? {}
  const documentType = String(first.suggest_shipping_document_type ?? 'THERMAL_AIR_WAYBILL')
  entry.shipping_document_type = documentType

  await shopCall('/api/v2/logistics/create_shipping_document', {}, { order_list: [entry] })
  let ready = false
  for (let attempt = 0; attempt < 12 && !ready; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1500))
    const result = await shopCall('/api/v2/logistics/get_shipping_document_result', {}, { order_list: [entry] })
    const status = String(list(obj(result.response).result_list)[0]?.status ?? '')
    if (status === 'FAILED') throw new HttpsError('failed-precondition', 'Shopee gagal membuat resi. Coba lagi sebentar.')
    ready = status === 'READY'
  }
  if (!ready) throw new HttpsError('deadline-exceeded', 'Resi belum siap. Coba cetak ulang beberapa detik lagi.')

  const download = await shopFetch('/api/v2/logistics/download_shipping_document', {}, {
    shipping_document_type: documentType,
    order_list: [entry],
  })
  if ((download.headers.get('content-type') ?? '').includes('json')) {
    checkJson('download_shipping_document', (await download.json()) as Json)
    throw new HttpsError('internal', 'Resi tidak dapat diunduh.')
  }
  return { pdfBase64: Buffer.from(await download.arrayBuffer()).toString('base64'), trackingNumber }
})

export const shopeeProducts = storeCall(storeOptions, async (request) => {
  await requireStaff(request)
  const offset = whole(input(request).offset ?? 0, 'Offset')
  const listing = obj((await shopCall('/api/v2/product/get_item_list', { offset, page_size: 20, item_status: 'NORMAL' })).response)
  const ids = list(listing.item).map((item) => Number(item.item_id))
  if (ids.length === 0) return { items: [], more: false, next: offset }
  const base = await shopCall('/api/v2/product/get_item_base_info', { item_id_list: ids.join(',') })
  const items = await Promise.all(
    list(obj(base.response).item_list).map(async (item) => {
      const itemId = Number(item.item_id)
      const price = obj(item.price_info)
      const stock = obj(obj(item.stock_info_v2).summary_info)
      const hasModel = item.has_model === true
      let models: { modelId: number; name: string; sku: string; price: number; stock: number }[] = []
      if (hasModel) {
        const modelResult = obj((await shopCall('/api/v2/product/get_model_list', { item_id: itemId })).response)
        models = list(modelResult.model).map((model) => ({
          modelId: Number(model.model_id),
          name: String(model.model_name ?? ''),
          sku: String(model.model_sku ?? ''),
          price: Number(obj(obj(model.price_info)).original_price ?? obj(list(model.price_info)[0]).original_price ?? 0),
          stock: Number(obj(obj(model.stock_info_v2).summary_info).total_available_stock ?? 0),
        }))
      }
      return {
        itemId,
        name: String(item.item_name ?? ''),
        sku: String(item.item_sku ?? ''),
        image: String(list(obj(item.image).image_url_list)[0] ?? ''),
        hasModel,
        price: Number(price.original_price ?? obj(list(item.price_info)[0]).original_price ?? 0),
        stock: Number(stock.total_available_stock ?? 0),
        models,
      }
    }),
  )
  return { items, more: listing.has_next_page === true, next: Number(listing.next_offset ?? offset + 20) }
})

type MarketplaceVariantTier = {
  grams: number
  name: string
  price: number
  priceIndex: number
}

type ShopeeVariantModel = {
  modelId: number
  name: string
  sku: string
  price: number
  stock: number
  grams: number | null
}

function masterNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (!text) return null
  const normalized = text.includes(',') && !text.includes('.')
    ? text.replace(',', '.')
    : text.replace(/,/g, '')
  const number = Number(normalized.replace(/[^\d.-]/g, ''))
  return Number.isFinite(number) ? number : null
}

function gramsFromText(value: string): number | null {
  const match = /(\d+(?:[.,]\d+)?)\s*(kg|kilogram|gram|gr|g)\b/i.exec(value)
  if (!match) return null
  const amount = Number(match[1].replace(',', '.'))
  if (!Number.isFinite(amount) || amount <= 0) return null
  return Math.round(amount * (/^(kg|kilogram)$/i.test(match[2]) ? 1000 : 1))
}

function factorForModel(model: Json, itemId: number): number | null {
  const modelId = Number(model.model_id ?? 0)
  const sku = String(model.model_sku ?? '').trim().toUpperCase()
  const exact = shopeeMarginMappings.find((entry) => entry.itemId === itemId && entry.modelId === modelId && entry.ready)
  if (exact) return mappedMarginFactor(itemId, modelId, exact.factor)
  const skuMatch = /^(.+)-([0-9]+)G$/.exec(sku)
  if (skuMatch) return Number(skuMatch[2]) / 1000
  const grams = gramsFromText(String(model.model_name ?? ''))
  return grams === null ? null : grams / 1000
}

const marketplaceVariantTiers = [
  { grams: 1000, name: '1 kg', priceIndex: 0 },
  { grams: 500, name: '500 gr', priceIndex: 1 },
  { grams: 250, name: '250 gr', priceIndex: 2 },
  { grams: 100, name: '100 gr', priceIndex: 3 },
  { grams: 50, name: '50 gr', priceIndex: 4 },
  { grams: 10, name: '10 gr', priceIndex: 5 },
  { grams: 5, name: '5 gr', priceIndex: 6 },
] as const

async function shopeeVariantMasterRows() {
  const auth = new google.auth.GoogleAuth({ scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'] })
  const sheets = google.sheets({ version: 'v4', auth })
  const result = await sheets.spreadsheets.values.get({
    spreadsheetId: '1Z3GxcqyB2DxGmfJcMuWvjDFKRRv7jceAlHPvfQ_zHR8',
    range: "'Master Data 2gofresh'!A:W",
    valueRenderOption: 'UNFORMATTED_VALUE',
  })
  return result.data.values ?? []
}

async function shopeeVariantPlan(itemId: number, masterRows: unknown[][]) {
  const itemMappings = shopeeMarginMappings.filter((entry) => entry.itemId === itemId && entry.ready)
  const masterSkus = [...new Set(itemMappings.map((entry) => entry.sku.trim().toUpperCase()))]
  if (masterSkus.length !== 1) {
    return { itemId, name: '', sku: '', eligible: false, message: 'SKU produk Shopee belum memiliki satu mapping master yang pasti.' }
  }
  const sku = masterSkus[0]
  const masterMatches = masterRows.filter((row, index) => index > 0 && String(row[1] ?? '').trim().toUpperCase() === sku)
  if (masterMatches.length !== 1) {
    return { itemId, name: '', sku, eligible: false, message: `SKU ${sku} tidak ditemukan tepat satu kali di master.` }
  }
  const master = masterMatches[0]
  const unit = String(master[4] ?? '').trim().toUpperCase()
  const minQty = masterNumber(master[0])
  if (unit !== 'KG' || minQty === null || minQty <= 0) {
    return { itemId, name: String(master[3] ?? ''), sku, eligible: false, message: 'Hanya produk KG dengan MIN_QTY yang valid yang bisa direncanakan otomatis.' }
  }
  const eligibleTiers: MarketplaceVariantTier[] = marketplaceVariantTiers
    .map((tier) => ({ ...tier, price: masterNumber(master[15 + tier.priceIndex]) ?? 0 }))
    .filter((tier) => tier.grams >= minQty * 1000 && tier.price >= 100)
    .sort((a, b) => a.grams - b.grams)
  if (!eligibleTiers.length) {
    return { itemId, name: String(master[3] ?? ''), sku, eligible: false, message: 'Tidak ada tier harga master yang memenuhi MIN_QTY.' }
  }
  const allowedTiers: MarketplaceVariantTier[] = []
  for (const tier of eligibleTiers) {
    const candidate = [...allowedTiers, tier]
    const prices = candidate.map((entry) => entry.price)
    if (Math.max(...prices) / Math.min(...prices) <= 7) allowedTiers.push(tier)
  }
  const [baseResponse, modelResponse] = await Promise.all([
    shopCall('/api/v2/product/get_item_base_info', { item_id_list: String(itemId) }),
    shopCall('/api/v2/product/get_model_list', { item_id: itemId }),
  ])
  const item = list(obj(baseResponse.response).item_list).find((entry) => Number(entry.item_id ?? 0) === itemId)
  const modelData = obj(modelResponse.response)
  const rawModels = list(modelData.model)
  const models: ShopeeVariantModel[] = rawModels.map((model) => ({
    modelId: Number(model.model_id ?? 0),
    name: String(model.model_name ?? ''),
    sku: String(model.model_sku ?? ''),
    price: Number(obj(obj(model.price_info)).original_price ?? obj(list(model.price_info)[0]).original_price ?? 0),
    stock: Number(obj(obj(model.stock_info_v2).summary_info).total_available_stock ?? 0),
    grams: factorForModel(model, itemId) === null ? gramsFromText(String(model.model_name ?? '')) : Math.round(factorForModel(model, itemId)! * 1000),
  }))
  const tierVariation = list(modelData.tier_variation)
  const unsupported = tierVariation.length !== 1
  const existingGrams = new Set(models.map((model) => model.grams).filter((grams): grams is number => grams !== null))
  const additions = allowedTiers
    .filter((tier) => !existingGrams.has(tier.grams))
    .map((tier) => ({ ...tier, modelSku: `${sku}-${tier.grams}G` }))
  const disabledBelowMinimum = models.filter((model) => model.grams !== null && model.grams < minQty * 1000)
  const options = list(obj(tierVariation[0]).option_list).map((entry) => String(obj(entry).option ?? ''))
  return {
    itemId,
    name: String(item?.item_name ?? master[3] ?? ''),
    sku,
    eligible: Boolean(item) && !unsupported,
    message: !item
      ? 'Produk tidak ditemukan di toko Shopee.'
      : unsupported
        ? 'Produk memakai variasi bertingkat yang belum didukung batch otomatis; perlu ditinjau manual.'
        : '',
    unit,
    minQty,
    minGrams: minQty * 1000,
    currentModels: models,
    disabledBelowMinimum,
    additions,
    tierName: String(obj(tierVariation[0]).name ?? 'Berat'),
    currentOptions: options,
  }
}

export const shopeeVariantPreview = onCall(options, async (request) => {
  await requireStaff(request, managers)
  const itemIds = list(input(request).itemIds).map((itemId) => whole(itemId, 'ID produk Shopee'))
  const uniqueIds = [...new Set(itemIds)]
  if (uniqueIds.length < 1 || uniqueIds.length > 25) {
    throw new HttpsError('invalid-argument', 'Pilih 1 sampai 25 ID produk untuk setiap batch preview.')
  }
  const masterRows = await shopeeVariantMasterRows()
  const plans = []
  for (const itemId of uniqueIds) plans.push(await shopeeVariantPlan(itemId, masterRows))
  return { plans }
})

export const shopeeVariantCandidates = onCall(options, async (request) => {
  await requireStaff(request, managers)
  const offset = whole(input(request).offset ?? 0, 'Offset')
  const masterRows = await shopeeVariantMasterRows()
  const masterBySku = new Map<string, { name: string; minQty: number }[]>()
  for (const [index, row] of masterRows.entries()) {
    if (index === 0) continue
    const sku = String(row[1] ?? '').trim().toUpperCase()
    const unit = String(row[4] ?? '').trim().toUpperCase()
    const minQty = masterNumber(row[0])
    if (!sku || unit !== 'KG' || minQty === null || minQty <= 0) continue
    const records = masterBySku.get(sku) ?? []
    records.push({ name: String(row[3] ?? '').trim(), minQty })
    masterBySku.set(sku, records)
  }

  const mappedByItem = new Map<number, Set<string>>()
  for (const mapping of shopeeMarginMappings) {
    if (!mapping.ready) continue
    const skus = mappedByItem.get(mapping.itemId) ?? new Set<string>()
    skus.add(mapping.sku.trim().toUpperCase())
    mappedByItem.set(mapping.itemId, skus)
  }
  const candidates = [...mappedByItem.entries()]
    .flatMap(([itemId, skus]) => {
      if (skus.size !== 1) return []
      const [sku] = skus
      const master = masterBySku.get(sku)
      if (master?.length !== 1) return []
      return [{ itemId, sku, name: master[0].name, minQty: master[0].minQty }]
    })
    .sort((a, b) => a.name.localeCompare(b.name, 'id') || a.itemId - b.itemId)

  const page = candidates.slice(offset, offset + 25)
  const baseResponse = page.length > 0
    ? await shopCall('/api/v2/product/get_item_base_info', { item_id_list: page.map((entry) => entry.itemId).join(',') })
    : null
  const itemById = new Map(
    list(obj(baseResponse?.response).item_list)
      .filter((item) => !item.item_status || String(item.item_status).toUpperCase() === 'NORMAL')
      .map((item) => [Number(item.item_id), item]),
  )
  const products = page.flatMap((candidate) => {
    const item = itemById.get(candidate.itemId)
    return item
      ? [{ ...candidate, name: String(item.item_name ?? candidate.name) }]
      : []
  })
  return { products, nextOffset: offset + page.length, hasMore: offset + page.length < candidates.length }
})

type CatalogGap = { sku: string; name: string; category: string; unit: string; minQty: number | null; price: number | null }
type UnmatchedListing = { itemId: number; sku: string; name: string; status: string }

const normalizeSku = (value: unknown) => String(value ?? '').trim().toUpperCase()
const skuBase = (sku: string) => sku.replace(/-\d+G$/, '')

async function listShopeeItems() {
  const items: { itemId: number; status: string }[] = []
  // Produk yang sedang diturunkan/ditinjau tetap dihitung sudah ada agar tidak dianggap belum diupload.
  for (const status of ['NORMAL', 'UNLIST', 'BANNED', 'REVIEWING']) {
    let offset = 0
    for (let page = 0; page < 30; page += 1) {
      const result = obj((await shopCall('/api/v2/product/get_item_list', { offset, page_size: 100, item_status: status })).response)
      list(result.item).forEach((item) => items.push({ itemId: Number(item.item_id), status }))
      if (result.has_next_page !== true) break
      offset = Number(result.next_offset ?? offset + 100)
    }
  }
  return items
}

async function compareMasterWithShopee() {
  const masterRows = await shopeeVariantMasterRows()
  const master = new Map<string, CatalogGap>()
  for (const [index, row] of masterRows.entries()) {
    if (index === 0) continue
    const sku = normalizeSku(row[1])
    if (!sku || master.has(sku)) continue
    const price = marketplaceVariantTiers
      .map((tier) => masterNumber(row[15 + tier.priceIndex]))
      .find((value) => value !== null && value >= 100) ?? null
    master.set(sku, {
      sku,
      name: String(row[3] ?? '').trim(),
      category: String(row[2] ?? '').trim(),
      unit: String(row[4] ?? '').trim().toUpperCase(),
      minQty: masterNumber(row[0]),
      price,
    })
  }

  const listed = await listShopeeItems()
  const matched = new Set<string>()
  const unmatched: UnmatchedListing[] = []
  const markMatched = (sku: string) => {
    if (!sku) return false
    const hit = master.has(sku) ? sku : master.has(skuBase(sku)) ? skuBase(sku) : ''
    if (hit) matched.add(hit)
    return Boolean(hit)
  }
  const mappedByItem = new Map<number, Set<string>>()
  if (currentStore() === '2gofresh') {
    for (const mapping of shopeeMarginMappings) {
      if (!mapping.ready) continue
      const skus = mappedByItem.get(mapping.itemId) ?? new Set<string>()
      skus.add(normalizeSku(mapping.sku))
      mappedByItem.set(mapping.itemId, skus)
    }
  }

  const statusById = new Map(listed.map((entry) => [entry.itemId, entry.status]))
  const needModels: { itemId: number; name: string; status: string }[] = []
  for (let start = 0; start < listed.length; start += 50) {
    const ids = listed.slice(start, start + 50).map((entry) => entry.itemId)
    const base = obj((await shopCall('/api/v2/product/get_item_base_info', { item_id_list: ids.join(',') })).response)
    for (const item of list(base.item_list)) {
      const itemId = Number(item.item_id)
      const status = statusById.get(itemId) ?? 'NORMAL'
      const name = String(item.item_name ?? '')
      let found = markMatched(normalizeSku(item.item_sku))
      for (const sku of mappedByItem.get(itemId) ?? []) found = markMatched(sku) || found
      if (found) continue
      if (item.has_model === true) needModels.push({ itemId, name, status })
      else unmatched.push({ itemId, sku: String(item.item_sku ?? ''), name, status })
    }
  }

  // SKU induk kosong/berbeda: cek kode variasi, dengan 6 permintaan paralel agar kuota API aman.
  let cursor = 0
  await Promise.all(Array.from({ length: 6 }, async () => {
    while (cursor < needModels.length) {
      const entry = needModels[cursor]
      cursor += 1
      const models = list(obj((await shopCall('/api/v2/product/get_model_list', { item_id: entry.itemId })).response).model)
      const skus = models.map((model) => normalizeSku(model.model_sku)).filter(Boolean)
      let found = false
      for (const sku of skus) found = markMatched(sku) || found
      if (!found) unmatched.push({ itemId: entry.itemId, sku: skus[0] ?? '', name: entry.name, status: entry.status })
    }
  }))

  const missing = [...master.values()].filter((entry) => !matched.has(entry.sku))
  return {
    totals: { master: master.size, uploaded: master.size - missing.length, missing: missing.length, extra: unmatched.length, listings: listed.length },
    missing,
    extra: unmatched.slice(0, 400),
  }
}

// Daftar produk master yang belum punya listing Shopee; hasil sync disimpan agar panel cepat dibuka.
export const shopeeMissingProducts = storeCall(storeLongOptions, async (request) => {
  const data = input(request)
  const syncRef = getFirestore().collection('shopeeCatalogSync').doc(currentStore())
  if (data.refresh !== true) {
    await requireStaff(request)
    const saved = await syncRef.get()
    if (!saved.exists) return { synced: false }
    const { syncedAt, syncedBy: _syncedBy, ...cached } = saved.data() ?? {}
    return { ...cached, synced: true, syncedAt: (syncedAt as { toMillis?: () => number } | undefined)?.toMillis?.() ?? 0 }
  }
  await requireStaff(request, managers)
  const result = await compareMasterWithShopee()
  await syncRef.set({ ...result, syncedAt: FieldValue.serverTimestamp(), syncedBy: request.auth?.uid ?? '' })
  return { synced: true, syncedAt: Date.now(), ...result }
})

export const shopeeVariantApply = onCall({ ...options, timeoutSeconds: 540 }, async (request) => {
  await requireStaff(request, managers)
  const data = input(request)
  if (data.confirmPromoDisabled !== true) {
    throw new HttpsError('failed-precondition', 'Pastikan promo pada setiap produk batch sudah dihentikan sebelum mengubah variasi.')
  }
  const items = list(data.items)
  if (items.length < 1 || items.length > 25) {
    throw new HttpsError('invalid-argument', 'Terapkan 1 sampai 25 produk dalam satu batch.')
  }
  const masterRows = await shopeeVariantMasterRows()
  const results: Array<{
    itemId: number
    sku: string
    added: string[]
    disabled: string[]
    modelIds: Record<string, number>
    status: 'applied' | 'failed'
    error?: string
    mayBePartial?: boolean
  }> = []
  for (const raw of items) {
    const entry = obj(raw)
    const itemId = Number(entry.itemId)
    let sku = ''
    let writeStarted = false
    try {
      const validItemId = whole(entry.itemId, 'ID produk Shopee')
      const plan = await shopeeVariantPlan(validItemId, masterRows)
      sku = String(plan.sku ?? '')
      if (!plan.eligible) throw new HttpsError('failed-precondition', `Produk ${validItemId}: ${plan.message}`)
      const stocks = obj(entry.stockByGrams)
      const additions = plan.additions as Array<MarketplaceVariantTier & { modelSku: string }>
      if (additions.some((tier) => whole(stocks[String(tier.grams)], `Stok ${tier.name}`) < 1)) {
        throw new HttpsError('invalid-argument', `Masukkan stok aktual minimal 1 untuk setiap varian baru SKU ${plan.sku}.`)
      }
      const rawTierVariations = list(obj((await shopCall('/api/v2/product/get_model_list', { item_id: validItemId })).response).tier_variation)
      if (rawTierVariations.length !== 1) throw new HttpsError('failed-precondition', `Produk ${validItemId} memerlukan variasi bertingkat; tidak diproses.`)
      const tier = obj(rawTierVariations[0])
      const existingOptions = list(tier.option_list)
      const optionNames = existingOptions.map((option) => String(obj(option).option ?? ''))
      const nextOptions = [...existingOptions]
      for (const addition of additions) {
        if (!optionNames.includes(addition.name)) nextOptions.push({ option: addition.name })
      }
      if (additions.length > 0) {
        writeStarted = true
        await shopCall('/api/v2/product/update_tier_variation', {}, {
          item_id: validItemId,
          tier_variation: [{
            name: String(tier.name ?? 'Berat'),
            option_list: nextOptions,
          }],
        })
        const modelList = additions.map((addition) => ({
          tier_index: [nextOptions.findIndex((option) => String(obj(option).option ?? '') === addition.name)],
          normal_stock: whole(stocks[String(addition.grams)], `Stok ${addition.name}`),
          original_price: addition.price,
          model_sku: addition.modelSku,
        }))
        await shopCall('/api/v2/product/add_model', {}, { item_id: validItemId, model_list: modelList })
      }
      const disableBelowMinimum = entry.disableBelowMinimum === true
      const disabledModels = disableBelowMinimum
        ? (plan.disabledBelowMinimum as ShopeeVariantModel[]).filter((model) => model.modelId > 0)
        : []
      if (disabledModels.length > 0) {
        writeStarted = true
        await shopCall('/api/v2/product/update_stock', {}, {
          item_id: validItemId,
          stock_list: disabledModels.map((model) => ({
            model_id: model.modelId,
            seller_stock: [{ location_id: 'IDZ', stock: 0 }],
          })),
        })
      }
      const verified = obj((await shopCall('/api/v2/product/get_model_list', { item_id: validItemId })).response)
      const verifiedModels = list(verified.model)
      const modelIds: Record<string, number> = {}
      for (const addition of additions) {
        const model = verifiedModels.find((candidate) => String(candidate.model_sku ?? '').toUpperCase() === addition.modelSku.toUpperCase())
        const modelId = Number(model?.model_id ?? 0)
        if (!modelId) throw new HttpsError('failed-precondition', `Shopee belum mengonfirmasi ID model baru ${addition.modelSku}. Periksa listing sebelum mencoba lagi.`)
        modelIds[String(addition.grams)] = modelId
      }
      results.push({
        itemId: validItemId,
        sku,
        added: additions.map((tier) => tier.name),
        disabled: disabledModels.map((model) => model.name),
        modelIds,
        status: 'applied',
      })
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'Kesalahan Shopee yang tidak diketahui.'
      logger.error('Shopee variant batch item failed.', { itemId, sku, mayBePartial: writeStarted, error })
      results.push({
        itemId: Number.isSafeInteger(itemId) && itemId > 0 ? itemId : 0,
        sku,
        added: [],
        disabled: [],
        modelIds: {},
        status: 'failed',
        error: writeStarted ? `${detail} Perubahan mungkin sebagian sudah tersimpan; jalankan preview lagi sebelum mencoba ulang.` : detail,
        mayBePartial: writeStarted,
      })
    }
  }
  return { results }
})

export const shopeeProductSetup = onCall(options, async (request) => {
  await requireStaff(request, managers)
  const setupCache = getFirestore().collection('shopeeOpenPlatformCache').doc('product-setup')
  const cachedSetup = await setupCache.get()
  const cacheAge = Date.now() - Number(cachedSetup.get('cachedAt') ?? 0)
  const cachedCategories = cachedSetup.get('categories')
  const cachedLogistics = cachedSetup.get('logistics')
  if (cacheAge >= 0 && cacheAge < 6 * 60 * 60 * 1000 && Array.isArray(cachedCategories) && Array.isArray(cachedLogistics) && cachedCategories.length && cachedLogistics.length) {
    return { categories: cachedCategories, logistics: cachedLogistics }
  }
  const categoryResponse = productResponse(await shopCall('/api/v2/product/get_category'))
  const rawCategories = list(categoryResponse.category_list ?? categoryResponse.category_tree)
  const categories: { categoryId: number; parentCategoryId: number; name: string; hasChildren: boolean }[] = []
  const collectCategories = (entries: Json[], parentId = 0) => {
    for (const entry of entries) {
      const categoryId = Number(entry.category_id ?? 0)
      const children = list(entry.children ?? entry.category_list)
      const hasChildren = entry.has_children === true || children.length > 0
      const name = String(entry.category_name ?? entry.display_category_name ?? entry.original_category_name ?? '')
      const declaredParentId = Number(entry.parent_category_id ?? 0)
      if (categoryId > 0 && name && entry.is_active !== false && entry.is_active !== 0) {
        categories.push({
          categoryId,
          parentCategoryId: declaredParentId > 0 ? declaredParentId : parentId,
          name,
          hasChildren,
        })
      }
      if (children.length) collectCategories(children, categoryId)
    }
  }
  collectCategories(rawCategories)
  if (!categories.length) {
    logger.warn('Shopee category response did not contain usable categories.', {
      responseKeys: Object.keys(categoryResponse),
      categoryCount: rawCategories.length,
      firstCategoryKeys: rawCategories[0] ? Object.keys(rawCategories[0]) : [],
    })
    throw new HttpsError('failed-precondition', 'Shopee tidak mengembalikan kategori. Periksa izin API produk pada Open Platform.')
  }
  const children = new Set(categories.map((category) => category.parentCategoryId).filter((id) => id > 0))
  const byId = new Map(categories.map((category) => [category.categoryId, category]))
  const leafCategories = categories
    .filter((category) => !category.hasChildren && !children.has(category.categoryId))
    .map((category) => {
      const path: string[] = [category.name]
      let parentId = category.parentCategoryId
      let depth = 0
      while (parentId > 0 && byId.has(parentId) && depth < 8) {
        const parent = byId.get(parentId)!
        path.unshift(parent.name)
        parentId = parent.parentCategoryId
        depth += 1
      }
      return { categoryId: category.categoryId, label: path.join(' › ') }
    })
    .sort((a, b) => a.label.localeCompare(b.label))

  const logisticsResponse = productResponse(await shopCall('/api/v2/logistics/get_channel_list'))
  const logistics = list(logisticsResponse.logistics_channel_list ?? logisticsResponse.channels)
    .filter((entry) => entry.enabled === true)
    .map((entry) => ({
      logisticsId: Number(entry.logistics_channel_id ?? entry.logistic_id ?? 0),
      name: String(entry.logistics_channel_name ?? entry.logistic_name ?? ''),
      sizes: list(entry.size_list).map((size) => ({
        sizeId: Number(size.size_id ?? 0),
        name: String(size.name ?? size.size_name ?? ''),
      })).filter((size) => size.sizeId > 0),
    }))
    .filter((channel) => channel.logisticsId > 0 && channel.name)
  if (!logistics.length) {
    throw new HttpsError('failed-precondition', 'Tidak ada jasa kirim aktif pada toko Shopee. Aktifkan jasa kirim pada Seller Center terlebih dahulu.')
  }
  await setupCache.set({ categories: leafCategories, logistics, cachedAt: Date.now() })
  return { categories: leafCategories, logistics }
})

export const shopeeProductRequirements = onCall(options, async (request) => {
  await requireStaff(request, managers)
  const categoryId = whole(input(request).categoryId, 'Kategori')
  if (categoryId < 1) throw new HttpsError('invalid-argument', 'Kategori Shopee tidak valid.')
  const requirementCache = getFirestore().collection('shopeeOpenPlatformCache').doc(`requirements-${categoryId}`)
  const cachedRequirements = await requirementCache.get()
  const cacheAge = Date.now() - Number(cachedRequirements.get('cachedAt') ?? 0)
  const cachedAttributes = cachedRequirements.get('attributes')
  const cachedBrands = cachedRequirements.get('brands')
  if (cacheAge >= 0 && cacheAge < 24 * 60 * 60 * 1000 && Array.isArray(cachedAttributes) && Array.isArray(cachedBrands) && cachedBrands.length) {
    return { attributes: cachedAttributes, brands: cachedBrands }
  }
  const attributesResponse = productResponse(await shopCall('/api/v2/product/get_attributes', { category_id: categoryId }))
  const attributes = list(attributesResponse.attribute_list).map((entry) => ({
    attributeId: Number(entry.attribute_id ?? 0),
    name: String(entry.attribute_name ?? ''),
    mandatory: entry.is_mandatory === true,
    inputType: String(entry.input_type ?? 'TEXT').toUpperCase(),
    maxLength: Number(entry.input_max_length ?? entry.max_length ?? 500),
    values: list(entry.input_value_list ?? entry.value_list).map((value) => ({
      valueId: Number(value.value_id ?? value.original_value_id ?? 0),
      name: String(value.original_value_name ?? value.value_name ?? ''),
    })).filter((value) => value.name),
  })).filter((attribute) => attribute.attributeId > 0 && attribute.name)
  const brands: { brandId: number; name: string }[] = []
  let offset = 0
  for (let page = 0; page < 10; page += 1) {
    const brandResponse = productResponse(await shopCall('/api/v2/product/get_brand_list', {
      category_id: categoryId,
      page_size: 100,
      offset,
      status: 1,
    }))
    const pageBrands = list(brandResponse.brand_list).map((brand) => ({
      brandId: Number(brand.brand_id ?? 0),
      name: String(brand.original_brand_name ?? brand.brand_name ?? ''),
    })).filter((brand) => brand.name)
    brands.push(...pageBrands)
    if (brandResponse.has_next_page !== true) break
    const nextOffset = Number(brandResponse.next_offset)
    if (!Number.isInteger(nextOffset) || nextOffset <= offset) {
      throw new HttpsError('failed-precondition', 'Shopee mengembalikan pagination daftar merek yang tidak valid.')
    }
    offset = nextOffset
    if (page === 9) {
      throw new HttpsError('resource-exhausted', 'Daftar merek Shopee terlalu besar untuk dimuat sekaligus. Pilih kategori yang lebih spesifik.')
    }
  }
  const result = {
    attributes,
    brands: brands.length ? brands : [{ brandId: 0, name: 'Tanpa Merek' }],
  }
  await requirementCache.set({ ...result, cachedAt: Date.now() })
  return result
})

export const shopeePublishProduct = onCall({ ...options, timeoutSeconds: 300 }, async (request) => {
  await requireStaff(request, managers)
  const data = input(request)
  const sku = str(data.sku, 'SKU', 100)
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(sku)) {
    throw new HttpsError('invalid-argument', 'Format SKU produk tidak valid.')
  }
  const imagePath = str(data.imagePath, 'Foto produk', 180)
  const imageExtension = ['jpg', 'jpeg', 'png'].find((extension) => imagePath === `product-images/${sku}.${extension}`)
  if (!imageExtension) {
    throw new HttpsError('invalid-argument', 'Untuk Shopee, nama foto harus sama dengan SKU dan berformat JPG, JPEG, atau PNG.')
  }
  const itemName = str(data.name, 'Nama produk Shopee', 120)
  const description = str(data.description, 'Deskripsi Shopee', 5000)
  const categoryId = whole(data.categoryId, 'Kategori')
  if (categoryId < 1) throw new HttpsError('invalid-argument', 'Kategori Shopee tidak valid.')
  const price = whole(data.price, 'Harga Shopee')
  if (price < 100) throw new HttpsError('invalid-argument', 'Harga Shopee minimal Rp100.')
  try {
    const sheetsAuth = new google.auth.GoogleAuth({
      scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
    })
    const sheets = google.sheets({ version: 'v4', auth: sheetsAuth })
    const master = await sheets.spreadsheets.values.get({
      spreadsheetId: '1Z3GxcqyB2DxGmfJcMuWvjDFKRRv7jceAlHPvfQ_zHR8',
      range: 'A:W',
      valueRenderOption: 'UNFORMATTED_VALUE',
    })
    const matchingRows = (master.data.values ?? [])
      .filter((values, index) => index > 0 && String(values[1] ?? '').trim().toLowerCase() === sku.toLowerCase())
    if (matchingRows.length !== 1) {
      throw new HttpsError(matchingRows.length ? 'failed-precondition' : 'not-found', matchingRows.length ? `SKU ${sku} muncul lebih dari sekali di Google Sheets master.` : `SKU ${sku} belum tersimpan di Google Sheets master.`)
    }
    const [row] = matchingRows
    const masterPrice = amountValue(row[15])
    if (masterPrice === null) throw new HttpsError('failed-precondition', `Harga marketplace master untuk SKU ${sku} belum tersedia.`)
    if (price < masterPrice) {
      throw new HttpsError('failed-precondition', `Harga Shopee tidak boleh di bawah harga master Marketplace (${new Intl.NumberFormat('id-ID').format(masterPrice)}).`)
    }
  } catch (error) {
    logger.error('Unable to verify master marketplace price before Shopee product upload.', { sku, error })
    if (error instanceof HttpsError) throw error
    throw new HttpsError('failed-precondition', 'Harga master Google Sheets tidak dapat diverifikasi. Produk tidak diunggah ke Shopee.')
  }
  const weight = Number(data.weight)
  if (!Number.isFinite(weight) || weight <= 0 || weight > 1000) {
    throw new HttpsError('invalid-argument', 'Berat paket harus lebih dari 0 dan maksimal 1000 kg.')
  }
  const dimension = {
    package_length: whole(data.packageLength, 'Panjang paket'),
    package_width: whole(data.packageWidth, 'Lebar paket'),
    package_height: whole(data.packageHeight, 'Tinggi paket'),
  }
  if (Object.values(dimension).some((value) => value < 1 || value > 1000)) {
    throw new HttpsError('invalid-argument', 'Dimensi paket harus antara 1 sampai 1000 cm.')
  }
  const brandId = whole(data.brandId, 'Merek')
  const brandName = typeof data.brandName === 'string' ? data.brandName.trim().slice(0, 100) : ''
  const requestedAttributes = list(data.attributes).map((attribute) => {
    const entry = obj(attribute)
    const attributeId = whole(entry.attributeId, 'Atribut')
    const values = list(entry.values).map((value) => {
      const selected = obj(value)
      const name = typeof selected.name === 'string' ? selected.name.trim().slice(0, 500) : ''
      const valueId = whole(selected.valueId ?? 0, 'Nilai atribut')
      return { valueId, name }
    }).filter((value) => value.name)
    return { attributeId, values }
  })
  const logisticSelections = list(data.logistics).map((selection) => {
    const entry = obj(selection)
    return {
      logisticsId: whole(entry.logisticsId, 'Jasa kirim'),
      sizeId: whole(entry.sizeId ?? 0, 'Ukuran paket jasa kirim'),
    }
  })
  if (logisticSelections.length === 0) throw new HttpsError('invalid-argument', 'Pilih setidaknya satu jasa kirim aktif.')

  const requiredResponse = productResponse(await shopCall('/api/v2/product/get_attributes', { category_id: categoryId }))
  const categoryAttributes = list(requiredResponse.attribute_list)
  const categoryAttributeIds = new Set(categoryAttributes.map((attribute) => Number(attribute.attribute_id ?? 0)))
  if (requestedAttributes.some((attribute) => !categoryAttributeIds.has(attribute.attributeId))) {
    throw new HttpsError('invalid-argument', 'Atribut yang dikirim tidak cocok dengan kategori Shopee terpilih.')
  }
  const requiredAttributes = categoryAttributes
    .filter((attribute) => attribute.is_mandatory === true)
    .map((attribute) => Number(attribute.attribute_id ?? 0))
    .filter((attributeId) => attributeId > 0)
  for (const requiredId of requiredAttributes) {
    const selected = requestedAttributes.find((attribute) => attribute.attributeId === requiredId)
    if (!selected?.values.length) {
      throw new HttpsError('invalid-argument', 'Lengkapi semua atribut kategori Shopee yang wajib diisi.')
    }
  }
  for (const selected of requestedAttributes) {
    const attribute = categoryAttributes.find((entry) => Number(entry.attribute_id ?? 0) === selected.attributeId)
    const allowedValues = list(attribute?.input_value_list ?? attribute?.value_list)
    if (allowedValues.length && selected.values.some((value) => value.valueId > 0 && !allowedValues.some((allowed) => Number(allowed.value_id ?? allowed.original_value_id ?? 0) === value.valueId))) {
      throw new HttpsError('invalid-argument', 'Nilai atribut tidak tersedia untuk kategori Shopee terpilih.')
    }
  }
  let selectedBrand: Json | undefined
  let brandOffset = 0
  for (let page = 0; page < 10; page += 1) {
    const brandResponse = productResponse(await shopCall('/api/v2/product/get_brand_list', {
      category_id: categoryId,
      page_size: 100,
      offset: brandOffset,
      status: 1,
    }))
    selectedBrand = list(brandResponse.brand_list).find((brand) => Number(brand.brand_id ?? 0) === brandId)
    if (selectedBrand || brandResponse.has_next_page !== true) break
    const nextOffset = Number(brandResponse.next_offset)
    if (!Number.isInteger(nextOffset) || nextOffset <= brandOffset) {
      throw new HttpsError('failed-precondition', 'Shopee mengembalikan pagination daftar merek yang tidak valid.')
    }
    brandOffset = nextOffset
    if (page === 9) throw new HttpsError('resource-exhausted', 'Daftar merek Shopee terlalu besar untuk diverifikasi.')
  }
  if (selectedBrand && brandName && brandName !== String(selectedBrand.original_brand_name ?? selectedBrand.brand_name ?? '')) {
    throw new HttpsError('invalid-argument', 'Nama merek tidak sesuai dengan merek terpilih di Shopee.')
  }
  if (!selectedBrand && brandId !== 0) {
    throw new HttpsError('invalid-argument', 'Merek yang dipilih tidak tersedia untuk kategori Shopee ini.')
  }
  const publishBrandName = selectedBrand ? brandName : ''

  const logisticsResponse = productResponse(await shopCall('/api/v2/logistics/get_channel_list'))
  const activeChannels = list(logisticsResponse.logistics_channel_list ?? logisticsResponse.channels)
    .filter((entry) => entry.enabled === true)
  const logisticInfo = logisticSelections.map((selection) => {
    const channel = activeChannels.find((entry) => Number(entry.logistics_channel_id ?? entry.logistic_id ?? 0) === selection.logisticsId)
    if (!channel) throw new HttpsError('failed-precondition', 'Jasa kirim yang dipilih tidak aktif lagi pada toko Shopee.')
    const sizes = list(channel.size_list)
    if (sizes.length > 0 && !sizes.some((size) => Number(size.size_id ?? 0) === selection.sizeId)) {
      throw new HttpsError('invalid-argument', `Pilih ukuran paket untuk jasa kirim ${String(channel.logistics_channel_name ?? '')}.`)
    }
    return {
      logistic_id: selection.logisticsId,
      enabled: true,
      ...(sizes.length > 0 ? { size_id: selection.sizeId } : {}),
    }
  })

  const database = getFirestore()
  const inventory = await database.collection('inventory').doc(sku.toLowerCase()).get()
  const onHand = Number(inventory.get('onHand') ?? 0)
  const stock = Number.isFinite(onHand) ? Math.floor(onHand) : 0
  if (stock < 1) {
    throw new HttpsError('failed-precondition', `Stok POS untuk SKU ${sku} kurang dari 1 ${String(inventory.get('unit') ?? 'unit')}. Perbarui stok sebelum upload Shopee.`)
  }

  const imageFile = getStorage().bucket().file(imagePath)
  let metadata: { contentType?: string; size?: string | number; metadata?: Record<string, string | number | boolean | null> }
  try {
    const [imageMetadata] = await imageFile.getMetadata()
    metadata = imageMetadata
  } catch (error) {
    logger.error('Unable to verify product image for Shopee publish.', { sku, error })
    const code = typeof error === 'object' && error !== null && 'code' in error ? Number(error.code) : 0
    if (code === 404) throw new HttpsError('not-found', 'Foto produk tidak ditemukan di Firebase Storage.')
    throw new HttpsError('unavailable', 'Tidak dapat memverifikasi foto produk di Firebase Storage.')
  }
  if (
    metadata.contentType !== (imageExtension === 'png' ? 'image/png' : 'image/jpeg') ||
    Number(metadata.size ?? 0) > 5 * 1024 * 1024 ||
    metadata.metadata?.sku !== sku ||
    metadata.metadata?.uploaderUid !== request.auth?.uid
  ) {
    throw new HttpsError('failed-precondition', 'Foto Shopee harus JPG/PNG maksimal 5 MB dan diunggah oleh akun ini dengan nama sesuai SKU.')
  }
  const [imageBytes] = await imageFile.download()
  const imagePayload = await shopImageUpload(`${sku}.${imageExtension}`, metadata.contentType, imageBytes)
  const uploadResponse = productResponse(imagePayload)
  const uploadedImages = list(uploadResponse.image_info_list)
  const uploadedImage = obj(obj(uploadedImages[0]).image_info)
  const imageId = String(uploadedImage.image_id ?? '')
  if (!imageId) {
    logger.error('Shopee image upload returned no image id.', { sku, response: JSON.stringify(uploadResponse).slice(0, 1000) })
    throw new HttpsError('failed-precondition', 'Shopee menerima file tetapi tidak mengembalikan ID foto. Coba lagi.')
  }

  const attributeList = requestedAttributes.filter((attribute) => attribute.values.length).map((attribute) => ({
    attribute_id: attribute.attributeId,
    attribute_value_list: attribute.values.map((value) => ({
      ...(value.valueId > 0 ? { value_id: value.valueId } : {}),
      original_value_name: value.name,
    })),
  }))
  const listingRef = getFirestore().collection('shopeeProductListings').doc(sku.toLowerCase())
  await getFirestore().runTransaction(async (transaction) => {
    const existing = await transaction.get(listingRef)
    if (existing.get('status') === 'published') {
      throw new HttpsError('already-exists', `SKU ${sku} sudah tercatat sebagai listing Shopee ${String(existing.get('itemId') ?? '')}.`)
    }
    if (existing.get('status') === 'publishing' || existing.get('status') === 'unknown') {
      throw new HttpsError('failed-precondition', `Status upload SKU ${sku} belum dapat dipastikan. Periksa produk di Shopee sebelum mencoba kembali.`)
    }
    transaction.set(listingRef, {
      sku,
      status: 'publishing',
      actorUid: request.auth?.uid,
      startedAt: FieldValue.serverTimestamp(),
    })
  })
  let itemResponse: Json
  try {
    itemResponse = productResponse(await shopCall('/api/v2/product/add_item', {}, {
    item_name: itemName,
    description,
    item_sku: sku,
    category_id: categoryId,
    image: { image_id_list: [imageId] },
    attribute_list: attributeList,
    brand: { brand_id: brandId, original_brand_name: publishBrandName },
    original_price: price,
    seller_stock: [{ location_id: 'IDZ', stock }],
    weight,
    dimension,
    logistic_info: logisticInfo,
    condition: 'NEW',
    }))
  } catch (error) {
    await listingRef.set({
      status: error instanceof HttpsError && error.code === 'failed-precondition' ? 'failed' : 'unknown',
      lastError: error instanceof Error ? error.message.slice(0, 1000) : 'Unknown Shopee API result',
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true })
    throw error
  }
  const itemId = Number(itemResponse.item_id ?? 0)
  if (!itemId) {
    logger.error('Shopee product create returned no item id.', { sku, response: JSON.stringify(itemResponse).slice(0, 1500) })
    await listingRef.set({
      status: 'unknown',
      lastError: 'Shopee tidak mengembalikan item_id setelah permintaan create.',
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true })
    throw new HttpsError('failed-precondition', 'Shopee tidak mengembalikan ID produk; periksa Seller Center sebelum mencoba lagi untuk menghindari listing duplikat.')
  }
  await listingRef.set({
    status: 'published',
    itemId,
    stock,
    price,
    categoryId,
    imageId,
    publishedAt: FieldValue.serverTimestamp(),
  }, { merge: true })
  logger.info('Shopee product published from POS.', { sku, itemId, stock, actorUid: request.auth?.uid })
  return { itemId, sku, stock, imageId }
})

async function currentMasterMarketplacePrice(sku: string, priceIndex: number): Promise<number> {
  const auth = new google.auth.GoogleAuth({ scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'] })
  const sheets = google.sheets({ version: 'v4', auth })
  const result = await sheets.spreadsheets.values.get({
    spreadsheetId: '1Z3GxcqyB2DxGmfJcMuWvjDFKRRv7jceAlHPvfQ_zHR8',
    range: 'A:W',
    valueRenderOption: 'UNFORMATTED_VALUE',
  })
  const row = (result.data.values ?? []).find((values, index) => index > 0 && String(values[1] ?? '').trim().toUpperCase() === sku)
  const price = amountValue(row?.[15 + priceIndex])
  if (price === null) {
    throw new HttpsError('failed-precondition', `Harga marketplace master untuk SKU ${sku} belum tersedia.`)
  }
  return price
}

export const shopeeUpdatePrice = storeCall(storeOptions, async (request) => {
  await requireStaff(request, managers)
  const data = input(request)
  const itemId = whole(data.itemId, 'Item')
  const modelId = whole(data.modelId ?? 0, 'Varian')
  const price = whole(data.price, 'Harga')
  if (price < 100) throw new HttpsError('invalid-argument', 'Harga minimal Rp100.')
  // Harga minimum master Marketplace hanya berlaku untuk toko 2goFresh.
  const enforceMasterMinimum = currentStore() === '2gofresh'
  const mapping = enforceMasterMinimum
    ? shopeeMarginMappings.find((entry) => entry.itemId === itemId && entry.modelId === modelId && entry.ready)
    : undefined
  let minimumPrice: number | null = mapping?.marketplacePrice ?? null
  let masterSku: string | undefined = mapping?.sku
  let priceIndex: number | undefined = mapping?.marketplacePriceIndex
  if (enforceMasterMinimum && !mapping) {
    const models = obj((await shopCall('/api/v2/product/get_model_list', { item_id: itemId })).response)
    const model = list(models.model).find((entry) => Number(entry.model_id ?? 0) === modelId)
    const parsed = variantSkuMapping(String(model?.model_sku ?? ''))
    if (parsed) {
      masterSku = parsed.masterSku
      const grams = Math.round(parsed.factor * 1000)
      priceIndex = marketplaceVariantTiers.find((tier) => tier.grams === grams)?.priceIndex
    }
  }
  if (masterSku && priceIndex !== undefined) {
    try {
      minimumPrice = await currentMasterMarketplacePrice(masterSku, priceIndex)
    } catch (error) {
      logger.error('Unable to verify the current master marketplace price before Shopee price update.', { itemId, modelId, error })
      if (error instanceof HttpsError) throw error
      throw new HttpsError('failed-precondition', 'Harga master Google Sheets tidak dapat diverifikasi. Harga Shopee tidak diubah.')
    }
  }
  if (minimumPrice !== null && price < minimumPrice) {
    throw new HttpsError(
      'failed-precondition',
      `Harga tidak boleh di bawah harga minimum master Marketplace (${new Intl.NumberFormat('id-ID').format(minimumPrice)}).`,
    )
  }
  await shopCall('/api/v2/product/update_price', {}, {
    item_id: itemId,
    price_list: [{ model_id: modelId, original_price: price }],
  })
  return { ok: true }
})

export const shopeeUpdateStock = storeCall(storeOptions, async (request) => {
  await requireStaff(request, managers)
  const data = input(request)
  const itemId = whole(data.itemId, 'Item')
  const modelId = whole(data.modelId ?? 0, 'Varian')
  const stock = whole(data.stock, 'Stok')
  await shopCall('/api/v2/product/update_stock', {}, {
    item_id: itemId,
    stock_list: [{ model_id: modelId, seller_stock: [{ stock }] }],
  })
  return { ok: true }
})

export const shopeeReturns = storeCall(storeOptions, async (request) => {
  await requireStaff(request)
  const result = obj((await shopCall('/api/v2/returns/get_return_list', { page_no: 0, page_size: 30 })).response)
  return {
    returns: list(result.return).map((entry) => ({
      returnSn: String(entry.return_sn ?? ''),
      orderSn: String(entry.order_sn ?? ''),
      status: String(entry.status ?? ''),
      reason: String(entry.reason ?? ''),
      amount: Number(entry.refund_amount ?? 0),
      createdAt: Number(entry.create_time ?? 0) * 1000,
    })),
  }
})

async function fetchConversations(type: 'all' | 'unread') {
  const all: Json[] = []
  let params: Record<string, string | number> = { direction: 'older', type, page_size: 60, next_timestamp_nano: `${Date.now()}000000` }
  for (let page = 0; page < 4; page += 1) {
    const result = obj((await shopCall('/api/v2/sellerchat/get_conversation_list', params)).response)
    all.push(...list(result.conversations))
    const paging = obj(result.page_result)
    const cursor = obj(paging.next_cursor)
    if (paging.more !== true || !cursor.next_message_time_nano) break
    params = { direction: 'older', type, page_size: 60, next_timestamp_nano: String(cursor.next_message_time_nano) }
  }
  return all
}

// `unreadOnly` dipakai pengawas notifikasi: hanya percakapan yang belum dibaca di Shopee (termasuk yang sudah dibaca di Seller Center = hilang).
export const shopeeChats = storeCall(storeOptions, async (request) => {
  await requireStaff(request)
  const unreadOnly = input(request).unreadOnly === true
  let all: Json[]
  if (unreadOnly) {
    try {
      all = await fetchConversations('unread')
    } catch (error) {
      logger.warn('Shopee unread chat filter failed; falling back to the full list.', { error })
      all = (await fetchConversations('all')).filter((entry) => Number(entry.unread_count ?? 0) > 0)
    }
  } else {
    all = await fetchConversations('all')
  }
  const seen = new Set<string>()
  const conversations = all
    .map((entry) => {
      const buyerId = Number(entry.to_id ?? 0)
      return {
        id: String(entry.conversation_id ?? ''),
        buyerId,
        buyer: String(entry.to_name ?? ''),
        last: String(obj(entry.latest_message_content).text ?? '') || `[${String(entry.latest_message_type ?? 'pesan')}]`,
        unread: Number(entry.unread_count ?? 0),
        fromBuyer: Number(entry.latest_message_from_id ?? 0) === buyerId,
        latestId: String(entry.latest_message_id ?? ''),
        lastAt: Math.round(Number(entry.last_message_timestamp ?? 0) / 1e6),
      }
    })
    .filter((chat) => chat.id && (!unreadOnly || chat.unread > 0) && !seen.has(chat.id) && !!seen.add(chat.id))
    .sort((a, b) => b.lastAt - a.lastAt)
  return { conversations }
})

// Membuka chat di kasir juga menandainya terbaca di Shopee (best effort; gagal tidak mengganggu balas chat).
export const shopeeMarkChatRead = storeCall(storeOptions, async (request) => {
  await requireStaff(request)
  const data = input(request)
  const conversationId = str(data.conversationId, 'Percakapan', 40)
  const lastMessageId = str(data.lastMessageId, 'Pesan terakhir', 80)
  try {
    await shopCall('/api/v2/sellerchat/read_conversation', {}, { conversation_id: conversationId, last_read_message_id: lastMessageId })
    return { ok: true }
  } catch (error) {
    logger.warn('Shopee read_conversation failed.', { error })
    return { ok: false }
  }
})
export const shopeeMessages = storeCall(storeOptions, async (request) => {
  await requireStaff(request)
  const conversationId = str(input(request).conversationId, 'Percakapan', 40)
  const result = obj((await shopCall('/api/v2/sellerchat/get_message', { conversation_id: conversationId, page_size: 30 })).response)
  const auth = await getAuth()
  return {
    messages: list(result.messages)
      .map((message) => ({
        id: String(message.message_id ?? ''),
        mine: Number(message.from_shop_id ?? 0) === auth.shopId,
        type: String(message.message_type ?? ''),
        text: String(obj(message.content).text ?? ''),
        at: Number(message.created_timestamp ?? 0) * 1000,
      }))
      .reverse(),
  }
})

export const shopeeSendMessage = storeCall(storeOptions, async (request) => {
  await requireStaff(request)
  const data = input(request)
  const text = str(data.text, 'Pesan', 500)
  await shopCall('/api/v2/sellerchat/send_message', {}, {
    to_id: whole(data.buyerId, 'Pembeli'),
    message_type: 'text',
    content: { text },
  })
  return { ok: true }
})
