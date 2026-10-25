// Aplikasi POS dipasang dari Chrome Android ("Instal aplikasi") hanya di kasir.2gofresh.com.
// Manifest dan service worker sengaja tidak aktif di website toko.
const isPosHost = /^(www\.)?kasir\./i.test(window.location.hostname)

export function setupPosApp() {
  if (!isPosHost) return

  const manifest = document.createElement('link')
  manifest.rel = 'manifest'
  manifest.href = '/pos.webmanifest'
  document.head.appendChild(manifest)
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', '#07775a')

  if (!('serviceWorker' in navigator)) return
  const register = () => {
    navigator.serviceWorker
      .register('/sw.js')
      .then(() => navigator.serviceWorker.ready)
      .then((registration) => registration.active?.postMessage('precache'))
      .catch(() => undefined)
  }
  if (document.readyState === 'complete') register()
  else window.addEventListener('load', register, { once: true })
}
