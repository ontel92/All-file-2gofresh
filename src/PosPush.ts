import { useEffect } from 'react'
import { Capacitor } from '@capacitor/core'
import type { PluginListenerHandle } from '@capacitor/core'
import { LocalNotifications } from '@capacitor/local-notifications'
import { PushNotifications } from '@capacitor/push-notifications'
import { httpsCallable } from 'firebase/functions'
import { functions } from './posFirebase'
import { openTarget, pushToast } from './opsStore'
import type { ToastAction } from './opsStore'

let registeredToken = ''

const notificationChannels = [
  { id: 'pos-web-orders-v2', name: 'Pesanan Website', sound: 'order_masuk' },
  { id: 'pos-live-chats-v2', name: 'Chat Website', sound: 'chatmasuk' },
  { id: 'pos-2gofresh-orders-v2', name: 'Pesanan Shopee 2goFresh', sound: 'orderanmasuk_2gofresh' },
  { id: 'pos-2gofresh-chats-v2', name: 'Chat Shopee 2goFresh', sound: 'chatmasuk_2gofresh' },
  { id: 'pos-2gofresh-shipping-v2', name: 'Batas Kirim 2goFresh', sound: 'kurang10menit_2gofresh' },
  { id: 'pos-freshstock-orders-v2', name: 'Pesanan Shopee Freshstock', sound: 'orderanmasuk_freshstock' },
  { id: 'pos-freshstock-chats-v2', name: 'Chat Shopee Freshstock', sound: 'chatmasuk_freshstock' },
  { id: 'pos-freshstock-shipping-v2', name: 'Batas Kirim Freshstock', sound: 'kurang10menit_freshstock' },
] as const

function actionFromData(value: unknown): ToastAction | null {
  if (typeof value !== 'object' || value === null) return null
  const data = value as Record<string, unknown>
  const panels = new Set(['marketplace', 'chat', 'web-order'])
  if (typeof data.panel !== 'string' || !panels.has(data.panel)) return null
  const action: ToastAction = { label: 'Buka', panel: data.panel }
  if (typeof data.orderSn === 'string') action.orderSn = data.orderSn
  if (data.store === '2gofresh' || data.store === 'freshstock') action.store = data.store
  return action
}

async function unregisterToken(token: string) {
  await httpsCallable<{ token: string }, { ok: boolean }>(functions, 'unregisterPosPushToken')({ token })
}

export async function unregisterCurrentPosPushToken() {
  if (!registeredToken) return
  await unregisterToken(registeredToken)
  registeredToken = ''
}

export function usePosNotificationActions() {
  useEffect(() => {
    if (Capacitor.getPlatform() !== 'android') return
    let active = true
    let listener: PluginListenerHandle | undefined

    void PushNotifications.addListener('pushNotificationActionPerformed', ({ notification }) => {
      const action = actionFromData(notification.data)
      if (action) openTarget(action)
    }).then((handle) => {
      if (active) listener = handle
      else void handle.remove()
    }).catch((error: unknown) => {
      console.error('Gagal memasang aksi notifikasi Android.', error)
    })

    return () => {
      active = false
      void listener?.remove()
    }
  }, [])
}

export function usePosPush(uid: string | undefined, enabled: boolean) {
  useEffect(() => {
    if (!uid || !enabled || Capacitor.getPlatform() !== 'android') return
    let active = true
    let listenerHandles: PluginListenerHandle[] = []

    async function addListener(
      listener: Promise<PluginListenerHandle>,
    ) {
      const handle = await listener
      if (active) listenerHandles.push(handle)
      else await handle.remove()
    }

    async function registerDevice(token: string) {
      try {
        if (registeredToken && registeredToken !== token) {
          await unregisterToken(registeredToken)
        }
        await httpsCallable<{ token: string }, { ok: boolean }>(functions, 'registerPosPushToken')({ token })
        registeredToken = token
      } catch (error) {
        console.error('Gagal mendaftarkan perangkat untuk notifikasi POS.', error)
        pushToast({
          icon: '🔔',
          title: 'Notifikasi belum terhubung',
          body: 'Perangkat belum dapat didaftarkan untuk menerima pesanan dan chat.',
          sticky: false,
          actions: [],
        })
      }
    }

    async function initialize() {
      try {
        await addListener(PushNotifications.addListener('registration', ({ value }) => {
          if (active) void registerDevice(value)
        }))
        await addListener(PushNotifications.addListener('registrationError', (error) => {
          console.error('Pendaftaran FCM gagal.', error)
          pushToast({
            icon: '🔔',
            title: 'Pendaftaran notifikasi gagal',
            body: 'Periksa koneksi internet, lalu buka kembali aplikasi POS.',
            sticky: false,
            actions: [],
          })
        }))

        const localPermission = await LocalNotifications.checkPermissions()
        const grantedLocalPermission = localPermission.display === 'granted'
          ? localPermission
          : await LocalNotifications.requestPermissions()
        if (!active) return
        if (grantedLocalPermission.display !== 'granted') {
          pushToast({
            icon: '🔔',
            title: 'Izin notifikasi belum aktif',
            body: 'Aktifkan melalui Setelan Android > Aplikasi > 2goFresh POS > Notifikasi.',
            sticky: false,
            actions: [],
          })
          return
        }

        const pushPermission = await PushNotifications.checkPermissions()
        const grantedPushPermission = pushPermission.receive === 'granted'
          ? pushPermission
          : await PushNotifications.requestPermissions()
        if (!active) return
        if (grantedPushPermission.receive !== 'granted') {
          pushToast({
            icon: '🔔',
            title: 'Izin push notification belum aktif',
            body: 'Aktifkan notifikasi 2goFresh POS di pengaturan Android.',
            sticky: false,
            actions: [],
          })
          return
        }

        await Promise.all(notificationChannels.map((channel) => LocalNotifications.createChannel({
          ...channel,
          description: `Notifikasi POS: ${channel.name}.`,
          importance: 5,
          visibility: 1,
          vibration: true,
        })))
        if (active) await PushNotifications.register()
      } catch (error) {
        console.error('Inisialisasi notifikasi Android gagal.', error)
        pushToast({
          icon: '🔔',
          title: 'Notifikasi Android gagal disiapkan',
          body: 'Periksa izin notifikasi dan konfigurasi Firebase perangkat.',
          sticky: false,
          actions: [],
        })
      }
    }

    void initialize()
    return () => {
      active = false
      listenerHandles.forEach((handle) => void handle.remove())
      listenerHandles = []
    }
  }, [uid, enabled])
}
