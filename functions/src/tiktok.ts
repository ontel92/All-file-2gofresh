import { createHmac, randomBytes } from 'node:crypto'
import { FieldValue, getFirestore } from 'firebase-admin/firestore'
import { logger } from 'firebase-functions'
import { defineSecret } from 'firebase-functions/params'
import { HttpsError, onCall, onRequest } from 'firebase-functions/v2/https'
import { onSchedule } from 'firebase-functions/v2/scheduler'
import { sendPosPush } from './pushNotifications'
import {
  buildSyncModels,
  cachedMasterRows,
  currentMasterMarketplacePrice,
  input,
  list,
  managers,
  marketplaceVariantTiers,
  masterSkuIndex,
  normalizeSku,
  obj,
  parseVariantSku,
  partnerIdSecret,
  partnerKeySecret,
  requireStaff,
  shopCall,
  summarizeSyncItem,
} from './shopee'

type Json = Record<string, unknown>

const appKeySecret = defineSecret('TIKTOK_APP_KEY')
const appSecretSecret = defineSecret('TIKTOK_APP_SECRET')
const tiktokOptions = {
  region: 'asia-southeast2' as const,
  memory: '512MiB' as const,
  maxInstances: 3,
  serviceAccount: 'catalog-sync-runtime@gofresh-3f2f3.iam.gserviceaccount.com',
  timeoutSeconds: 120,
  secrets: [appKeySecret, appSecretSecret],
  cors: [
    'http://127.0.0.1:5173',
    'http://localhost:5173',
    'https://localhost',
    'capacitor://localhost',
    'https://kasir.2gofresh.com',
    'https://www.kasir.2gofresh.com',
  ],
}

const authHost = 'https://auth.tiktok-shops.com'
const apiHost = 'https://open-api.tiktokglobalshop.com'
const appUrl = 'https://kasir.2gofresh.com'
const authDoc = () => getFirestore().collection('tiktokAuth').doc('current')
const stateCollection = () => getFirestore().collection('tiktokAuthState')

type TiktokAuth = {
  accessToken: string
  refreshToken: string
  accessExpiresAt: number
  refreshExpiresAt: number
  shopId: string
  shopCipher: string
  shopName: string
  region: string
}

// TikTok mengirim waktu kedaluwarsa sebagai timestamp unix; nilai kecil dianggap detik relatif.
function expiryMs(value: unknown, fallbackSeconds: number) {
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) return Date.now() + fallbackSeconds * 1000
  return number > 1e9 ? number * 1000 : Date.now() + number * 1000
}

async function authRequest(path: string, params: Record<string, string>) {
  const query = new URLSearchParams({
    app_key: appKeySecret.value().trim(),
    app_secret: appSecretSecret.value().trim(),
    ...params,
  })
  const json = (await (await fetch(`${authHost}${path}?${query}`)).json()) as Json
  if (json.code !== 0) {
    logger.error('TikTok auth error', { path, code: json.code, message: json.message })
    throw new HttpsError('failed-precondition', `TikTok menolak: ${String(json.message ?? json.code ?? 'tidak diketahui')}`)
  }
  return obj(json.data)
}

function tokenFields(data: Json) {
  const accessToken = String(data.access_token ?? '')
  const refreshToken = String(data.refresh_token ?? '')
  if (!accessToken || !refreshToken) throw new HttpsError('failed-precondition', 'TikTok tidak mengembalikan token.')
  return {
    accessToken,
    refreshToken,
    accessExpiresAt: expiryMs(data.access_token_expire_in, 3600),
    refreshExpiresAt: expiryMs(data.refresh_token_expire_in, 30 * 24 * 3600),
  }
}

// Tanda tangan TikTok Shop: path + parameter query terurut (tanpa sign/access_token) + body, dibungkus app secret.
async function signedFetch(
  accessToken: string,
  shopCipher: string,
  method: 'GET' | 'POST' | 'PUT',
  path: string,
  query: Record<string, string | number>,
  body?: Json,
  form?: FormData,
) {
  const secret = appSecretSecret.value().trim()
  const params: Record<string, string> = {
    ...Object.fromEntries(Object.entries(query).map(([key, value]) => [key, String(value)])),
    app_key: appKeySecret.value().trim(),
    timestamp: String(Math.floor(Date.now() / 1000)),
  }
  if (shopCipher && !path.startsWith('/authorization/') && !path.startsWith('/seller/') && path !== '/product/202309/images/upload') params.shop_cipher = shopCipher
  // Upload multipart tidak ikut ditandatangani; body JSON harus identik dengan yang dikirim.
  const bodyText = method === 'GET' || form ? '' : JSON.stringify(body ?? {})
  const base = path + Object.keys(params).sort().map((key) => `${key}${params[key]}`).join('')
  params.sign = createHmac('sha256', secret).update(`${secret}${base}${bodyText}${secret}`).digest('hex')
  const response = await fetch(`${apiHost}${path}?${new URLSearchParams(params)}`, {
    method,
    headers: form
      ? { 'x-tts-access-token': accessToken }
      : { 'content-type': 'application/json', 'x-tts-access-token': accessToken },
    body: method === 'GET' ? undefined : form ?? bodyText,
  })
  const json = (await response.json()) as Json
  if (json.code !== 0) {
    logger.error('TikTok API error', { path, code: json.code, detail: json.message })
    throw new HttpsError('failed-precondition', `TikTok: ${String(json.message ?? json.code ?? 'kesalahan tidak diketahui')}`)
  }
  return obj(json.data)
}

let refreshing: Promise<TiktokAuth> | null = null

async function getTiktokAuth(): Promise<TiktokAuth> {
  const saved = (await authDoc().get()).data() as TiktokAuth | undefined
  if (!saved) throw new HttpsError('failed-precondition', 'TikTok belum terhubung. Klik "Hubungkan TikTok" dulu.')
  if (saved.accessExpiresAt - 5 * 60 * 1000 > Date.now()) return saved
  if (saved.refreshExpiresAt <= Date.now()) {
    throw new HttpsError('failed-precondition', 'Akses TikTok kedaluwarsa. Hubungkan ulang dari panel.')
  }
  refreshing ??= (async () => {
    try {
      const data = await authRequest('/api/v2/token/refresh', { refresh_token: saved.refreshToken, grant_type: 'refresh_token' })
      const next: TiktokAuth = { ...saved, ...tokenFields(data) }
      await authDoc().set({ ...next, updatedAt: FieldValue.serverTimestamp() })
      return next
    } finally {
      refreshing = null
    }
  })()
  return refreshing
}

async function fetchShopInfo(accessToken: string) {
  const shops = list((await signedFetch(accessToken, '', 'GET', '/authorization/202309/shops', {})).shops)
  const shop = shops[0]
  if (!shop) throw new HttpsError('failed-precondition', 'Tidak ada toko yang diotorisasi.')
  return {
    shopId: String(shop.id ?? ''),
    shopCipher: String(shop.cipher ?? ''),
    shopName: String(shop.name ?? ''),
    region: String(shop.region ?? ''),
  }
}

async function ttCall(method: 'GET' | 'POST' | 'PUT', path: string, query: Record<string, string | number> = {}, body?: Json, form?: FormData) {
  let auth = await getTiktokAuth()
  if (!auth.shopCipher) {
    auth = { ...auth, ...(await fetchShopInfo(auth.accessToken)) }
    await authDoc().set({ ...auth, updatedAt: FieldValue.serverTimestamp() })
  }
  return signedFetch(auth.accessToken, auth.shopCipher, method, path, query, body, form)
}

export const tiktokConnectUrl = onCall(tiktokOptions, async (request) => {
  await requireStaff(request, managers)
  const state = randomBytes(16).toString('hex')
  await stateCollection().doc(state).set({ createdAt: Date.now(), uid: request.auth?.uid ?? '' })
  const query = new URLSearchParams({ app_key: appKeySecret.value().trim(), state })
  return { url: `https://services.tiktokshop.com/open/authorize?${query}` }
})

// Kode otorisasi hanya berlaku sekali; browser/TikTok kadang memanggil callback dua kali, jadi hasilnya dibagikan.
const codeResults = new Map<string, Promise<void>>()

async function exchangeAuthCode(code: string) {
  const data = await authRequest('/api/v2/token/get', { auth_code: code, grant_type: 'authorized_code' })
  const tokens = tokenFields(data)
  const base: TiktokAuth = {
    ...tokens,
    shopId: '',
    shopCipher: '',
    shopName: String(data.seller_name ?? ''),
    region: String(data.seller_base_region ?? ''),
  }
  // Token disimpan lebih dulu agar kode yang sudah terpakai tidak hilang bila langkah toko gagal.
  await authDoc().set({ ...base, updatedAt: FieldValue.serverTimestamp() })
  const shop = await fetchShopInfo(tokens.accessToken)
  await authDoc().set({ ...base, ...shop, shopName: shop.shopName || base.shopName, region: shop.region || base.region, updatedAt: FieldValue.serverTimestamp() })
}

export const tiktokCallback = onRequest(tiktokOptions, async (request, response) => {
  const code = String(request.query.code ?? '')
  const state = String(request.query.state ?? '')
  logger.info('TikTok callback received', { keys: Object.keys(request.query), hasCode: code !== '', hasState: state !== '' })
  if (!code) {
    response.status(400).send(`Kode otorisasi TikTok tidak ada (parameter diterima: ${Object.keys(request.query).join(', ') || 'kosong'}). Ulangi dari POS.`)
    return
  }
  try {
    let result = codeResults.get(code)
    if (!result) {
      // TikTok tidak selalu mengembalikan state; tanpa itu, terima hanya jika owner/supervisor baru saja memulai proses hubungkan.
      const freshSince = Date.now() - 15 * 60 * 1000
      let valid = false
      if (state) {
        const stateRef = stateCollection().doc(state.replace(/[^a-f0-9]/gi, '').slice(0, 64) || 'invalid')
        const stateSnapshot = await stateRef.get()
        await stateRef.delete()
        valid = stateSnapshot.exists && Number(stateSnapshot.get('createdAt') ?? 0) > freshSince
      }
      if (!valid) {
        const pending = await stateCollection().where('createdAt', '>', freshSince).limit(20).get()
        valid = !pending.empty
        await Promise.all(pending.docs.map((doc) => doc.ref.delete()))
      }
      if (!valid) {
        response.status(400).send('Sesi otorisasi tidak valid atau kedaluwarsa. Ulangi dari POS.')
        return
      }
      result = exchangeAuthCode(code)
      codeResults.set(code, result)
      setTimeout(() => codeResults.delete(code), 2 * 60 * 1000).unref()
    }
    await result
    response.redirect(`${appUrl}/?panel=tiktok&tiktok=connected`)
  } catch (error) {
    logger.error('TikTok callback gagal', { error })
    response.status(500).send(`Gagal menghubungkan TikTok: ${error instanceof Error ? error.message : 'kesalahan tidak diketahui'}. Coba lagi dari POS.`)
  }
})

export const tiktokStatus = onCall(tiktokOptions, async (request) => {
  await requireStaff(request)
  const saved = (await authDoc().get()).data() as TiktokAuth | undefined
  if (!saved) return { connected: false }
  if (!saved.shopCipher) {
    // Token ada tetapi data toko belum terbaca: coba lagi dan tampilkan penyebabnya (mis. scope belum disetujui).
    try {
      const refreshed = await getTiktokAuth()
      const shop = await fetchShopInfo(refreshed.accessToken)
      await authDoc().set({ ...refreshed, ...shop, updatedAt: FieldValue.serverTimestamp() })
      return { connected: true, shopName: shop.shopName, region: shop.region }
    } catch (error) {
      return { connected: false, tokenSaved: true, reason: error instanceof Error ? error.message : 'Gagal membaca data toko.' }
    }
  }
  return { connected: true, shopName: saved.shopName, region: saved.region }
})

const orderStatuses = [
  'ALL', 'UNPAID', 'ON_HOLD', 'AWAITING_SHIPMENT', 'PARTIALLY_SHIPPING', 'AWAITING_COLLECTION',
  'IN_TRANSIT', 'DELIVERED', 'COMPLETED', 'CANCELLED',
]

function numberOf(value: unknown) {
  const number = Number(value)
  return Number.isFinite(number) ? number : 0
}

// Satu line_item TikTok mewakili satu unit; gabungkan per SKU agar jumlahnya terbaca seperti Shopee.
function mapOrder(order: Json) {
  const grouped = new Map<string, { productId: string; skuId: string; name: string; variant: string; sku: string; quantity: number; price: number; image: string }>()
  for (const line of list(order.line_items)) {
    const key = String(line.sku_id ?? line.id ?? '')
    const existing = grouped.get(key)
    if (existing) {
      existing.quantity += 1
      continue
    }
    grouped.set(key, {
      productId: String(line.product_id ?? ''),
      skuId: String(line.sku_id ?? ''),
      name: String(line.product_name ?? ''),
      variant: String(line.sku_name ?? ''),
      sku: String(line.seller_sku ?? ''),
      quantity: 1,
      price: numberOf(line.sale_price),
      image: String(line.sku_image ?? ''),
    })
  }
  const address = obj(order.recipient_address)
  return {
    orderId: String(order.id ?? ''),
    status: String(order.status ?? ''),
    buyer: String(address.name ?? order.buyer_email ?? ''),
    total: numberOf(obj(order.payment).total_amount),
    carrier: String(order.shipping_provider ?? ''),
    trackingNumber: String(order.tracking_number ?? ''),
    payment: String(order.payment_method_name ?? ''),
    createdAt: numberOf(order.create_time) * 1000,
    shipBy: numberOf(order.shipping_due_time ?? order.rts_sla_time) * 1000,
    buyerMessage: String(order.buyer_message ?? ''),
    cancelReason: String(order.cancel_reason ?? ''),
    recipient: String(address.name ?? ''),
    phone: String(address.phone_number ?? ''),
    address: String(address.full_address ?? ''),
    packages: list(order.packages).map((pack) => String(pack.id ?? '')).filter(Boolean),
    items: [...grouped.values()],
  }
}

export const tiktokOrders = onCall(tiktokOptions, async (request) => {
  await requireStaff(request)
  const data = input(request)
  const status = typeof data.status === 'string' ? data.status : 'AWAITING_SHIPMENT'
  if (!orderStatuses.includes(status)) throw new HttpsError('invalid-argument', 'Status tidak valid.')
  const pageToken = typeof data.pageToken === 'string' ? data.pageToken.slice(0, 500) : ''
  const now = Math.floor(Date.now() / 1000)
  const query: Record<string, string | number> = { page_size: 30, sort_field: 'create_time', sort_order: 'DESC' }
  if (pageToken) query.page_token = pageToken
  const result = await ttCall('POST', '/order/202309/orders/search', query, {
    ...(status === 'ALL' ? {} : { order_status: status }),
    create_time_ge: now - 14 * 86400,
    create_time_lt: now,
  })
  return {
    orders: list(result.orders).map(mapOrder),
    more: Boolean(result.next_page_token),
    pageToken: String(result.next_page_token ?? ''),
  }
})

const tiktokAlarmWindowMs = 12 * 60 * 1000
const tiktokAlarmRepeatMs = 110 * 1000

function numberMap(value: unknown): Record<string, number> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, number] => typeof entry[1] === 'number'))
}

// Notifikasi HP: pesanan TikTok baru dan alarm batas kirim (<12 menit, diulang tiap 2 menit).
export const notifyTiktokPushEvents = onSchedule(
  {
    region: 'asia-southeast2',
    schedule: 'every 1 minutes',
    timeZone: 'Asia/Jakarta',
    memory: '512MiB',
    timeoutSeconds: 120,
    maxInstances: 1,
    secrets: [appKeySecret, appSecretSecret],
  },
  async () => {
    try {
      if (!(await authDoc().get()).exists) return
      const now = Math.floor(Date.now() / 1000)
      const result = await ttCall('POST', '/order/202309/orders/search', { page_size: 50, sort_field: 'create_time', sort_order: 'DESC' }, {
        order_status: 'AWAITING_SHIPMENT',
        create_time_ge: now - 14 * 86400,
        create_time_lt: now,
      })
      const orders = list(result.orders).map(mapOrder).filter((order) => order.orderId)
      const stateRef = getFirestore().collection('posPushState').doc('tiktok')
      const state = (await stateRef.get()).data() ?? {}
      const knownOrders = new Set<string>(Array.isArray(state.orderIds) ? state.orderIds.filter((id): id is string => typeof id === 'string') : [])
      const knownUrgent = numberMap(state.urgentAlerts)

      if (state.initialized === true) {
        for (const order of orders) {
          if (knownOrders.has(order.orderId)) continue
          await sendPosPush({
            title: 'Pesanan TikTok baru · 2goFresh',
            body: `${order.orderId} · ${order.buyer || 'Pembeli'}`,
            channelId: 'pos-tiktok-orders-v3',
            data: { panel: 'tiktok', kind: 'tiktok-order' },
          })
        }
        const nowMs = Date.now()
        for (const order of orders) {
          if (order.shipBy > 0 && order.shipBy - nowMs <= tiktokAlarmWindowMs && nowMs - (knownUrgent[order.orderId] ?? 0) >= tiktokAlarmRepeatMs) {
            await sendPosPush({
              title: 'Batas kirim kurang dari 12 menit · TikTok 2goFresh',
              body: `${order.orderId} · ${order.buyer || 'Pembeli'}`,
              channelId: 'pos-tiktok-shipping-v3',
              data: { panel: 'tiktok', kind: 'tiktok-shipping-alert' },
            })
            knownUrgent[order.orderId] = nowMs
          }
        }
      }

      await stateRef.set({
        initialized: true,
        orderIds: [...new Set([...knownOrders, ...orders.map((order) => order.orderId)])].slice(-500),
        urgentAlerts: Object.fromEntries(orders.filter((order) => knownUrgent[order.orderId] !== undefined).map((order) => [order.orderId, knownUrgent[order.orderId]])),
        updatedAt: FieldValue.serverTimestamp(),
      })
    } catch (error) {
      logger.error('TikTok push notification polling failed.', { error })
    }
  },
)

export const tiktokOrderCounts = onCall(tiktokOptions, async (request) => {
  await requireStaff(request)
  const now = Math.floor(Date.now() / 1000)
  const statuses = orderStatuses.filter((status) => status !== 'ALL')
  const entries = await Promise.all(statuses.map(async (status) => {
    const result = await ttCall('POST', '/order/202309/orders/search', { page_size: 1 }, {
      order_status: status,
      create_time_ge: now - 14 * 86400,
      create_time_lt: now,
    })
    return [status, numberOf(result.total_count)] as const
  }))
  return { counts: Object.fromEntries(entries) }
})

function packageIdOf(value: unknown) {
  const id = typeof value === 'string' ? value.trim() : ''
  if (!/^\d{1,32}$/.test(id)) throw new HttpsError('invalid-argument', 'ID paket tidak valid.')
  return id
}

export const tiktokShip = onCall(tiktokOptions, async (request) => {
  await requireStaff(request, managers)
  const data = input(request)
  const packageId = packageIdOf(data.packageId)
  const method = data.handoverMethod === 'DROP_OFF' ? 'DROP_OFF' : 'PICKUP'
  await ttCall('POST', `/fulfillment/202309/packages/${packageId}/ship`, {}, { handover_method: method })
  return { ok: true }
})

export const tiktokLabel = onCall(tiktokOptions, async (request) => {
  await requireStaff(request)
  const packageId = packageIdOf(input(request).packageId)
  const result = await ttCall('GET', `/fulfillment/202309/packages/${packageId}/shipping_documents`, {
    document_type: 'SHIPPING_LABEL',
    document_size: 0,
  })
  const url = String(result.doc_url ?? '')
  if (!url) throw new HttpsError('failed-precondition', 'Label belum tersedia untuk paket ini.')
  return { url }
})

type TiktokSku = { skuId: string; sellerSku: string; price: number; currency: string; stock: number; warehouseId: string }

function mapSku(sku: Json): TiktokSku {
  const price = obj(sku.price)
  const inventory = list(sku.inventory)
  return {
    skuId: String(sku.id ?? ''),
    sellerSku: String(sku.seller_sku ?? ''),
    price: numberOf(price.sale_price ?? price.tax_exclusive_price),
    currency: String(price.currency ?? 'IDR'),
    stock: inventory.reduce((sum, entry) => sum + numberOf(entry.quantity), 0),
    warehouseId: String(inventory[0]?.warehouse_id ?? ''),
  }
}

async function productsPage(status: string, pageToken: string) {
  const query: Record<string, string | number> = { page_size: 20 }
  if (pageToken) query.page_token = pageToken
  const result = await ttCall('POST', '/product/202309/products/search', query, { status })
  // Hasil pencarian tidak selalu memuat stok; lengkapi dari detail produk bila perlu.
  const products = await Promise.all(list(result.products).map(async (product) => {
    const skus = list(product.skus)
    if (skus.length > 0 && skus.every((sku) => Array.isArray(sku.inventory))) return product
    const detail = await ttCall('GET', `/product/202309/products/${String(product.id)}`)
    return { ...product, skus: list(detail.skus) }
  }))
  return { products, more: Boolean(result.next_page_token), pageToken: String(result.next_page_token ?? '') }
}

export const tiktokProducts = onCall(tiktokOptions, async (request) => {
  await requireStaff(request)
  const data = input(request)
  const pageToken = typeof data.pageToken === 'string' ? data.pageToken.slice(0, 500) : ''
  const page = await productsPage('ALL', pageToken)
  return {
    items: page.products.map((product) => ({
      productId: String(product.id ?? ''),
      name: String(product.title ?? ''),
      status: String(product.status ?? ''),
      skus: list(product.skus).map(mapSku),
    })),
    more: page.more,
    pageToken: page.pageToken,
  }
})

function idOf(value: unknown, label: string) {
  const id = typeof value === 'string' ? value.trim() : ''
  if (!/^\d{1,32}$/.test(id)) throw new HttpsError('invalid-argument', `${label} tidak valid.`)
  return id
}

async function productSkus(productId: string) {
  const detail = await ttCall('GET', `/product/202309/products/${productId}`)
  return list(detail.skus).map((sku) => ({
    skuId: String(sku.id ?? ''),
    sellerSku: String(sku.seller_sku ?? ''),
    warehouseIds: list(sku.inventory).map((entry) => String(entry.warehouse_id ?? '')).filter(Boolean),
  }))
}

// Harga minimum master mengikuti SKU penjual: SKU induk = tier 1 kg, MASTER-<gram>G = tier gramasi tersebut.
async function masterMinimumFor(sellerSku: string) {
  const sku = normalizeSku(sellerSku)
  if (!sku) return null
  const parsed = parseVariantSku(sku)
  const tierIndex = parsed ? marketplaceVariantTiers.find((tier) => tier.grams === parsed.grams)?.priceIndex : 0
  const masterSku = parsed && tierIndex !== undefined ? parsed.masterSku : sku
  if (tierIndex === undefined) return null
  try {
    const price = await currentMasterMarketplacePrice(masterSku, tierIndex)
    if (price === null && parsed) throw new HttpsError('failed-precondition', `Harga marketplace master untuk SKU ${masterSku} belum tersedia.`)
    return price
  } catch (error) {
    if (error instanceof HttpsError) throw error
    throw new HttpsError('failed-precondition', 'Harga master Google Sheets tidak dapat diverifikasi. Harga TikTok tidak diubah.')
  }
}

export const tiktokUpdatePrice = onCall(tiktokOptions, async (request) => {
  await requireStaff(request, managers)
  const data = input(request)
  const productId = idOf(data.productId, 'Produk')
  const skuId = idOf(data.skuId, 'SKU')
  const price = Number(data.price)
  if (!Number.isInteger(price) || price < 100) throw new HttpsError('invalid-argument', 'Harga minimal Rp100.')
  const sku = (await productSkus(productId)).find((entry) => entry.skuId === skuId)
  if (!sku) throw new HttpsError('not-found', 'SKU tidak ditemukan pada produk ini.')
  const minimum = await masterMinimumFor(sku.sellerSku)
  if (minimum !== null && price < minimum) {
    throw new HttpsError(
      'failed-precondition',
      `Harga tidak boleh di bawah harga minimum master Marketplace (${new Intl.NumberFormat('id-ID').format(minimum)}).`,
    )
  }
  await ttCall('POST', `/product/202309/products/${productId}/prices/update`, {}, {
    skus: [{ id: skuId, price: { amount: String(price), currency: 'IDR' } }],
  })
  return { ok: true }
})

export const tiktokUpdateStock = onCall(tiktokOptions, async (request) => {
  await requireStaff(request, managers)
  const data = input(request)
  const productId = idOf(data.productId, 'Produk')
  const skuId = idOf(data.skuId, 'SKU')
  const stock = Number(data.stock)
  if (!Number.isInteger(stock) || stock < 0) throw new HttpsError('invalid-argument', 'Stok harus bilangan bulat ≥ 0.')
  const sku = (await productSkus(productId)).find((entry) => entry.skuId === skuId)
  if (!sku || sku.warehouseIds.length === 0) throw new HttpsError('not-found', 'Gudang SKU tidak ditemukan.')
  await ttCall('POST', `/product/202309/products/${productId}/inventory/update`, {}, {
    skus: [{ id: skuId, inventory: [{ warehouse_id: sku.warehouseIds[0], quantity: stock }] }],
  })
  return { ok: true }
})

export const tiktokResetStock = onCall(tiktokOptions, async (request) => {
  await requireStaff(request, ['owner'])
  const entries = list(input(request).items)
  if (entries.length < 1 || entries.length > 20) {
    throw new HttpsError('invalid-argument', 'Reset 1 sampai 20 produk per permintaan.')
  }
  const results: { itemId: string; ok: boolean; error?: string }[] = []
  for (const entry of entries) {
    const productId = idOf(entry.productId, 'Produk')
    try {
      const skus = (await productSkus(productId)).filter((sku) => sku.warehouseIds.length > 0)
      if (skus.length > 0) {
        await ttCall('POST', `/product/202309/products/${productId}/inventory/update`, {}, {
          skus: skus.map((sku) => ({
            id: sku.skuId,
            inventory: sku.warehouseIds.map((warehouseId) => ({ warehouse_id: warehouseId, quantity: 0 })),
          })),
        })
      }
      results.push({ itemId: productId, ok: true })
    } catch (error) {
      results.push({ itemId: productId, ok: false, error: error instanceof Error ? error.message : 'Gagal mereset stok TikTok.' })
    }
  }
  logger.warn('TikTok stock reset to zero by owner.', { uid: request.auth?.uid, itemCount: entries.length })
  return { results }
})

export const tiktokSyncOverview = onCall(tiktokOptions, async (request) => {
  await requireStaff(request, managers)
  const data = input(request)
  const pageToken = typeof data.pageToken === 'string' ? data.pageToken.slice(0, 500) : ''
  const masterBySku = masterSkuIndex(await cachedMasterRows())
  const page = await productsPage('ACTIVATE', pageToken)
  const items = page.products.map((product) => {
    const models = buildSyncModels(list(product.skus).map(mapSku).map((sku) => ({
      modelId: sku.skuId,
      name: '',
      sku: sku.sellerSku,
      price: sku.price,
      originalPrice: sku.price,
      stock: sku.stock,
      nameGrams: null,
    })), masterBySku)
    return {
      itemId: String(product.id ?? ''),
      name: String(product.title ?? ''),
      image: '',
      status: String(product.status ?? ''),
      itemSku: '',
      ...summarizeSyncItem(models, models.map((model) => model.sku), masterBySku),
      hasModel: true,
      models,
    }
  })
  return { items, more: page.more, next: page.pageToken }
})

// ---- Salin produk Shopee → draf TikTok ----

const uploadsCollection = () => getFirestore().collection('tiktokUploads')
const clip = (value: unknown, max: number) => String(value ?? '').trim().slice(0, max)

async function uploadTiktokImage(url: string) {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`Gambar Shopee tidak dapat diunduh (${response.status}).`)
  const type = response.headers.get('content-type') ?? 'image/jpeg'
  const form = new FormData()
  form.append('data', new Blob([await response.arrayBuffer()], { type }), 'image')
  form.append('use_case', 'MAIN_IMAGE')
  const result = await ttCall('POST', '/product/202309/images/upload', {}, undefined, form)
  const uri = String(result.uri ?? '')
  if (!uri) throw new Error('TikTok tidak mengembalikan URI gambar.')
  return uri
}

function shopeeDescription(item: Json) {
  const plain = String(item.description ?? '').trim()
  if (plain) return plain
  const fields = list(obj(obj(item.description_info).extended_description).field_list)
  return fields
    .filter((field) => field.field_type === 'text')
    .map((field) => String(field.text ?? '').trim())
    .filter(Boolean)
    .join('\n')
}

function htmlDescription(text: string) {
  const escape = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => `<p>${escape(line)}</p>`).join('')
}

function shopeePrice(priceInfo: unknown) {
  const entry = Array.isArray(priceInfo) ? obj(priceInfo[0]) : obj(priceInfo)
  return Math.round(numberOf(entry.original_price) || numberOf(entry.current_price))
}

function shopeeStock(stockInfo: unknown) {
  return numberOf(obj(obj(stockInfo).summary_info).total_available_stock)
}

let warehouseCache: string | null = null
async function salesWarehouseId() {
  if (warehouseCache) return warehouseCache
  const warehouses = list((await ttCall('GET', '/logistics/202309/warehouses')).warehouses)
  const chosen = warehouses.find((warehouse) => warehouse.type === 'SALES_WAREHOUSE' && warehouse.is_default === true)
    ?? warehouses.find((warehouse) => warehouse.type === 'SALES_WAREHOUSE')
    ?? warehouses[0]
  const id = String(chosen?.id ?? '')
  if (!id) throw new Error('Gudang penjualan TikTok tidak ditemukan.')
  warehouseCache = id
  return id
}

async function recommendCategory(title: string, description: string, imageUris: string[]) {
  const result = await ttCall('POST', '/product/202309/categories/recommend', {}, {
    product_title: title,
    description,
    images: imageUris.slice(0, 5).map((uri) => ({ uri })),
    category_version: 'v2',
  })
  const categories = list(result.categories)
  const id = String(obj(result.leaf_category).id ?? categories[categories.length - 1]?.id ?? '')
  if (!id) throw new Error('TikTok tidak dapat merekomendasikan kategori untuk produk ini.')
  return id
}

type UploadResult = {
  itemId: number
  name: string
  status: 'created' | 'skipped' | 'failed'
  variants: number
  tiktokProductId?: string
  error?: string
}

// TikTok mewajibkan judul 25-255 karakter; judul pendek dilengkapi otomatis dan bisa diedit dari panel.
function fitTitle(name: string) {
  let title = name.trim()
  for (const suffix of [' Segar 2goFresh', ' - Sayur & Bumbu Segar Berkualitas']) {
    if (title.length >= 25) break
    title += suffix
  }
  return title.slice(0, 255)
}

async function copyItemToTiktokDraft(itemId: number, copyStock: boolean, uid: string, titleOverride: string): Promise<UploadResult> {
  const existing = await uploadsCollection().doc(String(itemId)).get()
  const base = list(obj((await shopCall('/api/v2/product/get_item_base_info', { item_id_list: String(itemId) })).response).item_list)[0]
  const name = String(base?.item_name ?? '')
  if (!base) return { itemId, name, status: 'failed', variants: 0, error: 'Produk tidak ditemukan di Shopee.' }
  const hasModel = base.has_model === true
  const modelData = hasModel ? obj((await shopCall('/api/v2/product/get_model_list', { item_id: itemId })).response) : {}
  const models = hasModel ? list(modelData.model) : []
  const variants = hasModel ? models.length : 1
  if (existing.get('tiktokProductId')) {
    return { itemId, name, status: 'skipped', variants, tiktokProductId: String(existing.get('tiktokProductId') ?? '') }
  }
  try {
    const title = clip(titleOverride || fitTitle(name), 255)
    if (title.length < 25) throw new Error('Judul TikTok minimal 25 karakter. Lengkapi judul lalu upload ulang.')
    const rawImages = obj(base.image).image_url_list
    const imageUrls = (Array.isArray(rawImages) ? rawImages.map(String) : []).slice(0, 9)
    if (imageUrls.length === 0) throw new Error('Produk Shopee tidak punya gambar.')
    const imageUris: string[] = []
    for (const url of imageUrls) imageUris.push(await uploadTiktokImage(url))

    const description = shopeeDescription(base) || name
    const categoryId = await recommendCategory(title, description, imageUris)
    const warehouseId = await salesWarehouseId()
    const tiers = list(modelData.tier_variation)
    const inventory = (stock: number) => [{ warehouse_id: warehouseId, quantity: copyStock ? Math.max(0, Math.floor(stock)) : 0 }]
    const skus = hasModel
      ? models.map((model) => {
        const indexes = Array.isArray(model.tier_index) ? model.tier_index.map(Number) : []
        return {
          seller_sku: clip(model.model_sku, 50),
          price: { amount: String(shopeePrice(model.price_info)), currency: 'IDR' },
          inventory: inventory(shopeeStock(model.stock_info_v2)),
          sales_attributes: tiers.slice(0, 3).map((tier, position) => ({
            name: clip(tier.name || 'Variasi', 20),
            value_name: clip(String(obj(list(tier.option_list)[indexes[position]]).option ?? model.model_name ?? ''), 30),
          })),
        }
      })
      : [{
        seller_sku: clip(base.item_sku, 50),
        price: { amount: String(shopeePrice(base.price_info)), currency: 'IDR' },
        inventory: inventory(shopeeStock(base.stock_info_v2)),
      }]

    const weight = numberOf(base.weight)
    const dimension = obj(base.dimension)
    const body: Json = {
      save_mode: 'AS_DRAFT',
      title,
      description: htmlDescription(description),
      category_id: categoryId,
      category_version: 'v2',
      main_images: imageUris.map((uri) => ({ uri })),
      skus,
      ...(weight > 0 ? { package_weight: { value: String(weight), unit: 'KILOGRAM' } } : {}),
      ...(numberOf(dimension.package_length) > 0 && numberOf(dimension.package_width) > 0 && numberOf(dimension.package_height) > 0
        ? {
          package_dimensions: {
            length: String(Math.ceil(numberOf(dimension.package_length))),
            width: String(Math.ceil(numberOf(dimension.package_width))),
            height: String(Math.ceil(numberOf(dimension.package_height))),
            unit: 'CENTIMETER',
          },
        }
        : {}),
    }
    const created = await ttCall('POST', '/product/202309/products', {}, body)
    const tiktokProductId = String(created.product_id ?? '')
    if (!tiktokProductId) throw new Error('TikTok tidak mengembalikan ID produk.')
    await uploadsCollection().doc(String(itemId)).set({
      tiktokProductId,
      name,
      variants,
      saveMode: 'AS_DRAFT',
      createdAt: FieldValue.serverTimestamp(),
      createdBy: uid,
    })
    return { itemId, name, status: 'created', variants, tiktokProductId }
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'Gagal membuat draf TikTok.'
    await uploadsCollection().doc(String(itemId)).set({ name, variants, status: 'failed', error: reason, failedAt: FieldValue.serverTimestamp() }, { merge: true })
    return { itemId, name, status: 'failed', variants, error: reason }
  }
}

// Daftar semua produk Shopee beserta status upload ke TikTok; produk baru otomatis berstatus "pending".
export const tiktokUploadStatus = onCall(
  {
    ...tiktokOptions,
    memory: '512MiB' as const,
    timeoutSeconds: 300,
    secrets: [appKeySecret, appSecretSecret, partnerIdSecret, partnerKeySecret],
  },
  async (request) => {
    await requireStaff(request, managers)
    const ids: number[] = []
    for (let offset = 0; offset < 5000;) {
      const listing = obj((await shopCall('/api/v2/product/get_item_list', { offset, page_size: 100, item_status: 'NORMAL' })).response)
      const page = list(listing.item).map((item) => Number(item.item_id))
      ids.push(...page)
      if (listing.has_next_page !== true || page.length === 0) break
      offset = Number(listing.next_offset ?? offset + page.length)
    }
    const saved = new Map((await uploadsCollection().get()).docs.map((doc) => [doc.id, doc.data()]))
    const items: { itemId: number; name: string; suggestedTitle: string; status: 'uploaded' | 'failed' | 'pending'; error: string; tiktokProductId: string }[] = []
    for (let start = 0; start < ids.length; start += 50) {
      const chunk = ids.slice(start, start + 50)
      const infos = list(obj((await shopCall('/api/v2/product/get_item_base_info', { item_id_list: chunk.join(',') })).response).item_list)
      for (const info of infos) {
        const itemId = Number(info.item_id)
        const record = saved.get(String(itemId))
        const tiktokProductId = String(record?.tiktokProductId ?? '')
        const name = String(info.item_name ?? '')
        items.push({
          itemId,
          name,
          suggestedTitle: fitTitle(name),
          status: tiktokProductId ? 'uploaded' : record?.status === 'failed' ? 'failed' : 'pending',
          error: tiktokProductId ? '' : String(record?.error ?? ''),
          tiktokProductId,
        })
      }
    }
    return { items }
  },
)

// Satu halaman (5 produk) per panggilan agar muat dalam batas waktu; klien mengulang sampai selesai.
export const tiktokUploadFromShopee = onCall(
  {
    ...tiktokOptions,
    memory: '1GiB' as const,
    timeoutSeconds: 540,
    secrets: [appKeySecret, appSecretSecret, partnerIdSecret, partnerKeySecret],
  },
  async (request) => {
    await requireStaff(request, managers)
    const data = input(request)
    const ids = (Array.isArray(data.itemIds) ? data.itemIds : []).map(Number).filter((id) => Number.isInteger(id) && id > 0).slice(0, 3)
    const titles = obj(data.titles)
    const results: UploadResult[] = []
    for (const itemId of ids) {
      results.push(await copyItemToTiktokDraft(itemId, data.copyStock === true, request.auth?.uid ?? '', String(titles[String(itemId)] ?? '').trim()))
    }
    logger.info('Shopee to TikTok draft batch processed.', { uid: request.auth?.uid, count: results.length })
    return { results }
  },
)
