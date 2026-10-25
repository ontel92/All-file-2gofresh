import { createHash } from 'node:crypto'
import { getFirestore, FieldValue } from 'firebase-admin/firestore'
import { getMessaging } from 'firebase-admin/messaging'
import { logger } from 'firebase-functions'
import { onDocumentCreated, onDocumentUpdated } from 'firebase-functions/v2/firestore'
import { HttpsError, onCall } from 'firebase-functions/v2/https'

const options = {
  region: 'asia-southeast2',
  memory: '256MiB',
  maxInstances: 5,
  serviceAccount: 'catalog-sync-runtime@gofresh-3f2f3.iam.gserviceaccount.com',
} as const

export type PosPushMessage = {
  title: string
  body: string
  channelId: PosPushChannelId
  data: Record<string, string>
}

type PosPushChannelId =
  | 'pos-web-orders-v2'
  | 'pos-live-chats-v2'
  | 'pos-2gofresh-orders-v2'
  | 'pos-2gofresh-chats-v2'
  | 'pos-2gofresh-shipping-v2'
  | 'pos-freshstock-orders-v2'
  | 'pos-freshstock-chats-v2'
  | 'pos-freshstock-shipping-v2'

const notificationSounds: Record<PosPushChannelId, string> = {
  'pos-web-orders-v2': 'order_masuk',
  'pos-live-chats-v2': 'chatmasuk',
  'pos-2gofresh-orders-v2': 'orderanmasuk_2gofresh',
  'pos-2gofresh-chats-v2': 'chatmasuk_2gofresh',
  'pos-2gofresh-shipping-v2': 'kurang10menit_2gofresh',
  'pos-freshstock-orders-v2': 'orderanmasuk_freshstock',
  'pos-freshstock-chats-v2': 'chatmasuk_freshstock',
  'pos-freshstock-shipping-v2': 'kurang10menit_freshstock',
}

function tokenId(token: string) {
  return createHash('sha256').update(token).digest('hex')
}

function requestData(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new HttpsError('invalid-argument', 'Data not valid.')
  }
  return value as Record<string, unknown>
}

async function assertActiveStaff(uid: string) {
  const profile = (await getFirestore().collection('staff').doc(uid).get()).data()
  if (
    profile?.active !== true ||
    !['owner', 'supervisor', 'cashier'].includes(String(profile.role))
  ) {
    throw new HttpsError('permission-denied', 'Akses ini tidak tersedia untuk akun Anda.')
  }
}

export const registerPosPushToken = onCall(options, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Login diperlukan.')
  await assertActiveStaff(request.auth.uid)

  const data = requestData(request.data)
  const token = typeof data.token === 'string' ? data.token.trim() : ''
  if (!token || token.length > 4096) {
    throw new HttpsError('invalid-argument', 'Token notifikasi tidak valid.')
  }

  await getFirestore().collection('posPushDevices').doc(tokenId(token)).set({
    uid: request.auth.uid,
    token,
    platform: 'android',
    updatedAt: FieldValue.serverTimestamp(),
  })
  return { ok: true }
})

export const unregisterPosPushToken = onCall(options, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Login diperlukan.')

  const data = requestData(request.data)
  const token = typeof data.token === 'string' ? data.token.trim() : ''
  if (!token || token.length > 4096) {
    throw new HttpsError('invalid-argument', 'Token notifikasi tidak valid.')
  }

  const tokenRef = getFirestore().collection('posPushDevices').doc(tokenId(token))
  const device = await tokenRef.get()
  if (device.exists && device.get('uid') === request.auth.uid) {
    await tokenRef.delete()
  }
  return { ok: true }
})

export async function sendPosPush(message: PosPushMessage) {
  const database = getFirestore()
  const [staffSnapshot, devicesSnapshot] = await Promise.all([
    database.collection('staff').where('active', '==', true).get(),
    database.collection('posPushDevices').get(),
  ])
  const activeUids = new Set(staffSnapshot.docs.map((staff) => staff.id))
  const devices = devicesSnapshot.docs
    .filter((device) => activeUids.has(String(device.get('uid') ?? '')))
    .filter((device) => device.get('platform') === 'android' && typeof device.get('token') === 'string')
    .map((device) => ({ ref: device.ref, token: device.get('token') as string }))

  if (devices.length === 0) return

  let retryableFailures = 0
  for (let start = 0; start < devices.length; start += 500) {
    const batch = devices.slice(start, start + 500)
    const result = await getMessaging().sendEachForMulticast({
      tokens: batch.map((device) => device.token),
      notification: { title: message.title, body: message.body },
      data: message.data,
      android: {
        priority: 'high',
        notification: {
          channelId: message.channelId,
          sound: notificationSounds[message.channelId],
          visibility: 'public',
        },
      },
    })
    const invalidTokens = result.responses.flatMap((response, index) => {
      if (response.success) return []
      const code = response.error?.code
      if (code === 'messaging/registration-token-not-registered' || code === 'messaging/invalid-registration-token') {
        return [batch[index].ref]
      }
      retryableFailures += 1
      logger.warn('FCM notification delivery failed.', { code })
      return []
    })
    if (invalidTokens.length > 0) {
      await database.runTransaction(async (transaction) => {
        invalidTokens.forEach((ref) => transaction.delete(ref))
      })
    }
  }
  if (retryableFailures > 0) {
    throw new Error(`FCM notification delivery failed for ${retryableFailures} device(s).`)
  }
}

export const notifyNewWebOrder = onDocumentCreated(
  { ...options, document: 'webOrders/{orderId}', retry: true },
  async (event) => {
    const order = event.data?.data()
    if (!order) return

    const orderNo = typeof order.orderNo === 'string' ? order.orderNo : event.params.orderId
    const customerName = typeof order.customerName === 'string' ? order.customerName : 'Pelanggan'
    const total = typeof order.total === 'number'
      ? ` · Rp ${new Intl.NumberFormat('id-ID', { maximumFractionDigits: 0 }).format(order.total)}`
      : ''
    await sendPosPush({
      title: 'Pesanan website baru · 2goFresh',
      body: `${orderNo} · ${customerName}${total}`,
      channelId: 'pos-web-orders-v2',
      data: { panel: 'web-order', kind: 'web-order', orderNo },
    })
  },
)

export const notifyIncomingLiveChat = onDocumentUpdated(
  { ...options, document: 'chats/{chatId}', retry: true },
  async (event) => {
    const before = event.data?.before.data()
    const after = event.data?.after.data()
    if (!before || !after || after.lastSender !== 'customer') return
    if (Number(after.unreadStaff ?? 0) <= Number(before.unreadStaff ?? 0)) return

    const customerName = typeof after.customerName === 'string' ? after.customerName : 'Pelanggan'
    const message = typeof after.lastMessage === 'string' ? after.lastMessage : ''
    await sendPosPush({
      title: `Live Chat · ${customerName}`,
      body: message,
      channelId: 'pos-live-chats-v2',
      data: { panel: 'chat', kind: 'live-chat', chatId: event.params.chatId },
    })
  },
)
