import { useEffect, useState } from 'react'

// Pita peringatan saat perangkat kehilangan internet (mis. mati lampu).
export default function OfflineBanner() {
  const [online, setOnline] = useState(() => navigator.onLine)

  useEffect(() => {
    const update = () => setOnline(navigator.onLine)
    window.addEventListener('online', update)
    window.addEventListener('offline', update)
    return () => {
      window.removeEventListener('online', update)
      window.removeEventListener('offline', update)
    }
  }, [])

  if (online) return null
  return (
    <div className="pos-offline-banner" role="status">
      📡 Tidak ada koneksi internet. Penjualan dan data terbaru memerlukan internet; aplikasi akan lanjut otomatis begitu tersambung.
    </div>
  )
}
