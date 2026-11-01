import { onAuthStateChanged, signOut } from 'firebase/auth'
import { auth } from './posFirebase'
import { unregisterCurrentPosPushToken } from './PosPush'

const IDLE_LIMIT_MS = 10 * 60 * 60 * 1000
const STORAGE_KEY = '2gofresh-last-activity'
const WRITE_THROTTLE_MS = 30 * 1000
const CHECK_INTERVAL_MS = 60 * 1000

function readLast() {
  const value = Number(localStorage.getItem(STORAGE_KEY))
  return Number.isFinite(value) && value > 0 ? value : 0
}

function touch() {
  localStorage.setItem(STORAGE_KEY, String(Date.now()))
}

async function logoutIfIdle() {
  if (!auth.currentUser) return
  const last = readLast()
  if (last && Date.now() - last >= IDLE_LIMIT_MS) {
    try {
      await unregisterCurrentPosPushToken()
    } catch {
      // abaikan, tetap keluar
    }
    await signOut(auth)
    localStorage.removeItem(STORAGE_KEY)
  }
}

// Keluar otomatis bila akun tidak ada aktivitas 10 jam (berlaku di semua perangkat/tab).
export function setupIdleLogout() {
  let lastWrite = 0
  const onActivity = () => {
    const now = Date.now()
    if (now - lastWrite < WRITE_THROTTLE_MS) return
    lastWrite = now
    if (auth.currentUser) touch()
  }

  for (const name of ['pointerdown', 'keydown', 'wheel', 'touchstart', 'scroll']) {
    window.addEventListener(name, onActivity, { passive: true, capture: true })
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void logoutIfIdle()
  })
  window.setInterval(() => void logoutIfIdle(), CHECK_INTERVAL_MS)

  onAuthStateChanged(auth, (user) => {
    if (!user) {
      localStorage.removeItem(STORAGE_KEY)
      return
    }
    // Sesi lama tanpa catatan aktivitas dihitung mulai sekarang.
    void logoutIfIdle().then(() => {
      if (auth.currentUser && !readLast()) touch()
    })
  })
}
