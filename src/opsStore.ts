import { useSyncExternalStore } from 'react'

export type ShopeeStoreId = '2gofresh' | 'freshstock'
export type ToastAction = { label: string; panel: string; orderSn?: string; store?: ShopeeStoreId }
export type Toast = {
  id: string
  icon: string
  title: string
  body: string
  actions: ToastAction[]
  sticky: boolean
  // Suara yang menyertai pop-up; berhenti begitu pop-up ditutup.
  sound?: string
  // Toko Shopee asal pop-up, untuk label dan warna.
  store?: ShopeeStoreId
}

export const shopeeStoreNames: Record<ShopeeStoreId, string> = { '2gofresh': '2goFresh', freshstock: 'Freshstock' }
export const SHIP_ALARM_WINDOW_MS = 10 * 60 * 1000
export const shopeeSounds: Record<ShopeeStoreId, { order: string; chat: string; alarm: string }> = {
  '2gofresh': { order: '/orderanmasuk_2gofresh.mp3', chat: '/chatmasuk_2gofresh.mp3', alarm: '/kurang10menit_2gofresh.mp3' },
  freshstock: { order: '/orderanmasuk_freshstock.mp3', chat: '/chatmasuk_freshstock.mp3', alarm: '/kurang10menit_freshstock.mp3' },
}
type State = {
  shopeeToShip: number
  shopeeUnreadChats: number
  freshstockToShip: number
  freshstockUnreadChats: number
  toasts: Toast[]
  openOrderSn: string
  openOrderStore: ShopeeStoreId
  navRequest: string
}

let state: State = {
  shopeeToShip: 0,
  shopeeUnreadChats: 0,
  freshstockToShip: 0,
  freshstockUnreadChats: 0,
  toasts: [],
  openOrderSn: '',
  openOrderStore: '2gofresh',
  navRequest: '',
}
const listeners = new Set<() => void>()

export const getOps = () => state

export function setOps(patch: Partial<State>) {
  state = { ...state, ...patch }
  listeners.forEach((listener) => listener())
}

export function useOps() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => state,
  )
}

export function pushToast(toast: Omit<Toast, 'id'>) {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
  const next = [...state.toasts, { ...toast, id }]
  next.slice(0, -5).forEach((dropped) => releaseToastSound(dropped.id))
  setOps({ toasts: next.slice(-5) })
  if (toast.sound) startToastSound(id, toast.sound)
  if (!toast.sticky) window.setTimeout(() => dismissToast(id), 12000)
}

export function dismissToast(id: string) {
  stopToastSound(id)
  setOps({ toasts: state.toasts.filter((toast) => toast.id !== id) })
}

// Jump to a panel; when orderSn is given the Shopee panel opens that order's detail in the right store.
export function openTarget(action: ToastAction) {
  setOps({ navRequest: action.panel, openOrderSn: action.orderSn ?? '', openOrderStore: action.store ?? '2gofresh' })
}

const sounds: Record<string, HTMLAudioElement> = {}
// File suara -> pop-up yang tercakup oleh pemutaran yang sedang berjalan.
const soundOwners = new Map<string, Set<string>>()

// One dedicated, preloaded Audio per file so order and chat sounds never get mixed up.
function soundFor(src: string) {
  if (!sounds[src]) {
    sounds[src] = Object.assign(new Audio(src), { preload: 'auto' })
    sounds[src].addEventListener('ended', () => soundOwners.get(src)?.clear())
  }
  return sounds[src]
}

export function playSound(src: string) {
  const audio = soundFor(src)
  audio.pause()
  audio.currentTime = 0
  void audio.play().catch(() => undefined)
}

export function stopSound(src: string) {
  const audio = sounds[src]
  if (!audio) return
  audio.pause()
  audio.currentTime = 0
  soundOwners.get(src)?.clear()
}

function startToastSound(id: string, src: string) {
  const owners = soundOwners.get(src) ?? new Set<string>()
  soundOwners.set(src, owners)
  const audio = soundFor(src)
  // Beberapa pop-up datang bersamaan: satu pemutaran dipakai bersama, tidak diulang dari awal.
  if (owners.size > 0 && !audio.paused && !audio.ended) {
    owners.add(id)
    return
  }
  owners.clear()
  owners.add(id)
  playSound(src)
}

function releaseToastSound(id: string) {
  soundOwners.forEach((owners) => owners.delete(id))
}

// Menutup pop-up langsung mematikan suaranya.
function stopToastSound(id: string) {
  soundOwners.forEach((owners, src) => {
    if (owners.has(id)) stopSound(src)
  })
  releaseToastSound(id)
}
