import { useEffect, useState } from 'react'
import { alertStoreNames, openTarget, useOps } from './opsStore'
import type { AlertStoreId } from './opsStore'
import { dismissShipAlert } from './ShipAlarm'
import './ShipAlarmPopup.css'

function countdown(ms: number) {
  if (ms <= 0) return 'SUDAH LEWAT'
  const minutes = Math.floor(ms / 60000)
  const seconds = Math.floor((ms % 60000) / 1000)
  return `${minutes}m ${String(seconds).padStart(2, '0')}d`
}

// Pop-up pesanan yang harus segera dikirim sebelum dibatalkan otomatis oleh marketplace.
export default function ShipAlarmPopup() {
  const { shipAlerts } = useOps()
  const [now, setNow] = useState(() => Date.now())
  const groups = (Object.keys(shipAlerts) as AlertStoreId[]).filter((store) => (shipAlerts[store]?.length ?? 0) > 0)
  const open = groups.length > 0

  useEffect(() => {
    if (!open) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [open])

  if (!open) return null
  return (
    <div className="ship-popup-backdrop" role="alertdialog" aria-modal="true" aria-label="Pesanan harus segera dikirim">
      <div className="ship-popup">
        <h2>⏰ Segera kirim pesanan!</h2>
        <p>Batas kirim kurang dari 12 menit. Jika terlambat, pesanan dibatalkan otomatis oleh marketplace dan berdampak ke penilaian toko.</p>
        {groups.map((store) => (
          <section key={store} className={`ship-popup-group store-${store}`}>
            <header>
              <b>{alertStoreNames[store]}</b>
              <span>{shipAlerts[store]?.length} pesanan</span>
            </header>
            <ul>
              {shipAlerts[store]?.map((order) => (
                <li key={order.id}>
                  <div>
                    <strong>{order.id}</strong>
                    <small>{order.buyer || 'Pembeli'}</small>
                  </div>
                  <span className={order.shipBy - now <= 0 ? 'late' : ''}>{countdown(order.shipBy - now)}</span>
                  <button
                    type="button"
                    onClick={() => {
                      dismissShipAlert(store)
                      openTarget(store === 'tiktok'
                        ? { label: 'Buka', panel: 'tiktok' }
                        : { label: 'Buka', panel: 'marketplace', orderSn: order.id, store })
                    }}
                  >
                    Kerjakan
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}
        <button type="button" className="ship-popup-close" onClick={() => groups.forEach(dismissShipAlert)}>
          Tutup (alarm bunyi lagi 2 menit)
        </button>
      </div>
    </div>
  )
}
