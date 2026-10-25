// Service worker khusus aplikasi POS (kasir.2gofresh.com). Dipakai agar aplikasi bisa dibuka tanpa internet.
// Data transaksi tetap diproses server; worker ini hanya menyimpan berkas aplikasi (HTML, JS, CSS, ikon, suara).
const VERSION = 'pos-v1'
const SHELL_CACHE = `${VERSION}-shell`
const ASSET_CACHE = `${VERSION}-assets`
const SHELL_FILES = [
  '/',
  '/pos.webmanifest',
  '/pwa/icon-192.png',
  '/pwa/icon-512.png',
  '/orderanmasuk_2gofresh.mp3',
  '/orderanmasuk_freshstock.mp3',
  '/chatmasuk_2gofresh.mp3',
  '/chatmasuk_freshstock.mp3',
  '/kurang10menit_2gofresh.mp3',
  '/kurang10menit_freshstock.mp3',
  '/order_masuk.mp3',
  '/chatmasuk.mp3',
]
const NAVIGATION_TIMEOUT_MS = 4000

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then((cache) => Promise.all(SHELL_FILES.map((url) => cache.add(url).catch(() => undefined))))
      .then(() => self.skipWaiting()),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => !key.startsWith(VERSION)).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  )
})

// Halaman meminta worker mengunduh semua berkas build terbaru (daftar dibuat saat build di /precache.json).
self.addEventListener('message', (event) => {
  if (event.data !== 'precache') return
  event.waitUntil(precacheBuildAssets())
})

async function precacheBuildAssets() {
  try {
    const response = await fetch('/precache.json', { cache: 'no-store' })
    if (!response.ok) return
    const files = await response.json()
    const cache = await caches.open(ASSET_CACHE)
    // Buang berkas build lama yang tidak dipakai lagi agar penyimpanan tablet tidak menumpuk.
    for (const request of await cache.keys()) {
      if (!files.includes(new URL(request.url).pathname)) await cache.delete(request)
    }
    for (const file of files) {
      if (await cache.match(file)) continue
      try {
        await cache.add(file)
      } catch {
        // Berkas yang gagal diunduh akan di-cache saat dipakai pertama kali.
      }
    }
  } catch {
    // Offline: dicoba lagi pada pembukaan aplikasi berikutnya.
  }
}

function networkFirstNavigation(request) {
  return new Promise((resolve) => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), NAVIGATION_TIMEOUT_MS)
    fetch(request, { signal: controller.signal })
      .then(async (response) => {
        clearTimeout(timer)
        if (response.ok) {
          const cache = await caches.open(SHELL_CACHE)
          await cache.put('/', response.clone())
        }
        resolve(response)
      })
      .catch(async () => {
        clearTimeout(timer)
        const cached = await caches.match('/')
        resolve(cached ?? Response.error())
      })
  })
}

async function cacheFirst(request) {
  const cached = await caches.match(request)
  if (cached) return cached
  const response = await fetch(request)
  if (response.ok) (await caches.open(ASSET_CACHE)).put(request, response.clone())
  return response
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(SHELL_CACHE)
  const cached = await cache.match(request)
  const refresh = fetch(request)
    .then((response) => {
      if (response.ok) cache.put(request, response.clone())
      return response
    })
    .catch(() => undefined)
  return cached ?? (await refresh) ?? Response.error()
}

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET') return
  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return
  if (url.pathname.startsWith('/__/') || url.pathname.startsWith('/shopee/')) return

  if (request.mode === 'navigate') {
    event.respondWith(networkFirstNavigation(request))
  } else if (url.pathname.startsWith('/assets/')) {
    event.respondWith(cacheFirst(request))
  } else if (!['/sw.js', '/precache.json'].includes(url.pathname)) {
    event.respondWith(staleWhileRevalidate(request))
  }
})
