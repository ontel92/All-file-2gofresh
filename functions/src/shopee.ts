import { createHmac } from 'node:crypto'
import { FieldValue, getFirestore } from 'firebase-admin/firestore'
import { logger } from 'firebase-functions'
import { defineSecret } from 'firebase-functions/params'
import { HttpsError, onCall, onRequest } from 'firebase-functions/v2/https'

const shopeeOptions = {
  region: 'asia-southeast2',
  memory: '512MiB',
  maxInstances: 3,
  serviceAccount: 'catalog-sync-runtime@gofresh-3f2f3.iam.gserviceaccount.com',
  timeoutSeconds: 120,
} as const

const partnerIdSecret = defineSecret('SHOPEE_PARTNER_ID')
const partnerKeySecret = defineSecret('SHOPEE_PARTNER_KEY')
const options = { ...shopeeOptions, secrets: [partnerIdSecret, partnerKeySecret] }
const shopeeHost = { value: () => process.env.SHOPEE_HOST ?? 'https://partner.shopeemobile.com' }

const callbackUrl = 'https://kasir.2gofresh.com/shopee/callback'
const authDoc = () => getFirestore().collection('shopeeAuth').doc('current')

type ShopeeAuth = { shopId: number; accessToken: string; refreshToken: string; expiresAt: number }
type Json = Record<string, unknown>
type Role = 'owner' | 'supervisor' | 'cashier'

function sign(base: string) {
  return createHmac('sha256', partnerKeySecret.value().trim()).update(base).digest('hex')
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
  const partnerId = partnerIdSecret.value().trim()
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
  const partnerId = partnerIdSecret.value().trim()
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

const list = (value: unknown): Json[] => (Array.isArray(value) ? (value as Json[]) : [])
const obj = (value: unknown): Json => (typeof value === 'object' && value !== null ? (value as Json) : {})

export const shopeeConnectUrl = onCall(options, async (request) => {
  await requireStaff(request, managers)
  const partnerId = partnerIdSecret.value().trim()
  const path = '/api/v2/shop/auth_partner'
  const timestamp = Math.floor(Date.now() / 1000)
  return {
    url: `${shopeeHost.value()}${path}?partner_id=${partnerId}&timestamp=${timestamp}&sign=${sign(`${partnerId}${path}${timestamp}`)}&redirect=${encodeURIComponent(callbackUrl)}`,
  }
})

export const shopeeCallback = onRequest(options, async (request, response) => {
  const code = String(request.query.code ?? '')
  const shopId = Number(request.query.shop_id ?? 0)
  if (!code || !shopId) {
    response.status(400).send('Parameter tidak lengkap.')
    return
  }
  try {
    await saveTokens(shopId, await publicCall('/api/v2/auth/token/get', { code, shop_id: shopId }))
    response.redirect('https://kasir.2gofresh.com/?shopee=connected')
  } catch (error) {
    logger.error('Shopee callback gagal', error)
    response.status(500).send('Gagal menghubungkan Shopee. Coba lagi dari POS.')
  }
})

export const shopeeStatus = onCall(options, async (request) => {
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

export const shopeeOrders = onCall(options, async (request) => {
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

export const shopeeTracking = onCall(options, async (request) => {
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
export const shopeeOrderCounts = onCall(options, async (request) => {
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

export const shopeeShipInfo = onCall(options, async (request) => {
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

export const shopeeShip = onCall(options, async (request) => {
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

export const shopeeLabel = onCall(options, async (request) => {
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

export const shopeeProducts = onCall(options, async (request) => {
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

export const shopeeUpdatePrice = onCall(options, async (request) => {
  await requireStaff(request, managers)
  const data = input(request)
  const itemId = whole(data.itemId, 'Item')
  const modelId = whole(data.modelId ?? 0, 'Varian')
  const price = whole(data.price, 'Harga')
  if (price < 100) throw new HttpsError('invalid-argument', 'Harga minimal Rp100.')
  await shopCall('/api/v2/product/update_price', {}, {
    item_id: itemId,
    price_list: [{ model_id: modelId, original_price: price }],
  })
  return { ok: true }
})

export const shopeeUpdateStock = onCall(options, async (request) => {
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

export const shopeeReturns = onCall(options, async (request) => {
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

export const shopeeChats = onCall(options, async (request) => {
  await requireStaff(request)
  const result = obj(
    (await shopCall('/api/v2/sellerchat/get_conversation_list', { direction: 'latest', type: 'all', page_size: 25 })).response,
  )
  return {
    conversations: list(result.conversations).map((entry) => ({
      id: String(entry.conversation_id ?? ''),
      buyerId: Number(entry.to_id ?? 0),
      buyer: String(entry.to_name ?? ''),
      last: String(obj(entry.latest_message_content).text ?? ''),
      unread: Number(entry.unread_count ?? 0),
    })),
  }
})

export const shopeeMessages = onCall(options, async (request) => {
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

export const shopeeSendMessage = onCall(options, async (request) => {
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
