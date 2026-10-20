import { useSyncExternalStore } from 'react'

export type ToastAction = { label: string; panel: string; orderSn?: string }
export type Toast = { id: string; icon: string; title: string; body: string; actions: ToastAction[]; sticky: boolean }
type State = {
  shopeeToShip: number
  shopeeUnreadChats: number
  toasts: Toast[]
  openOrderSn: string
  navRequest: string
}

let state: State = { shopeeToShip: 0, shopeeUnreadChats: 0, toasts: [], openOrderSn: '', navRequest: '' }
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
  setOps({ toasts: [...state.toasts, { ...toast, id }].slice(-5) })
  if (!toast.sticky) window.setTimeout(() => dismissToast(id), 12000)
}

export function dismissToast(id: string) {
  setOps({ toasts: state.toasts.filter((toast) => toast.id !== id) })
}

// Jump to a panel; when orderSn is given the Shopee panel opens that order's detail.
export function openTarget(action: ToastAction) {
  setOps({ navRequest: action.panel, openOrderSn: action.orderSn ?? '' })
}

const sounds: Record<string, HTMLAudioElement> = {}

// One dedicated, preloaded Audio per file so order and chat sounds never get mixed up.
function soundFor(src: string) {
  sounds[src] ??= Object.assign(new Audio(src), { preload: 'auto' })
  return sounds[src]
}

export function playSound(src: string) {
  const audio = soundFor(src)
  audio.currentTime = 0
  void audio.play().catch(() => undefined)
}

if (typeof window !== 'undefined') {
  const unlock = () => {
    for (const src of ['/order_masuk.mp3', '/chatmasuk.mp3', '/loud_alarm.mp3']) {
      const audio = soundFor(src)
      audio.muted = true
      void audio.play().then(() => {
        audio.pause()
        audio.currentTime = 0
        audio.muted = false
      }).catch(() => {
        audio.muted = false
      })
    }
    window.removeEventListener('pointerdown', unlock)
  }
  window.addEventListener('pointerdown', unlock)
}
