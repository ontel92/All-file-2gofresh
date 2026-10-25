import { useEffect, useState } from 'react'
import {
  discardOfflineSale,
  retryOfflineSale,
  syncOfflineSales,
  useOfflineSales,
  useOnlineStatus,
} from './offlineSales'
import './OfflineSalesStatus.css'

const currency = new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', maximumFractionDigits: 0 })
const SYNC_INTERVAL_MS = 30000

// Mengirim antrean penjualan offline otomatis dan menampilkan statusnya.
export default function OfflineSalesStatus({ uid }: { uid: string }) {
  const sales = useOfflineSales()
  const online = useOnlineStatus()
  const [open, setOpen] = useState(false)

  useEffect(() => {
    const run = () => void syncOfflineSales(uid)
    run()
    const timer = window.setInterval(run, SYNC_INTERVAL_MS)
    window.addEventListener('online', run)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('online', run)
    }
  }, [uid])

  if (sales.length === 0) return null
  const pending = sales.filter((sale) => sale.status === 'pending').length
  const failed = sales.length - pending

  return (
    <>
      <button type="button" className={`pos-offline-pill${failed > 0 ? ' failed' : ''}`} onClick={() => setOpen(true)}>
        {failed > 0 ? `⚠ ${failed} penjualan offline gagal` : `⏳ ${pending} penjualan offline ${online ? 'sedang dikirim' : 'menunggu internet'}`}
      </button>
      {open && (
        <div className="pos-offline-modal" role="dialog" aria-modal="true" aria-label="Penjualan offline">
          <div className="pos-offline-card">
            <header>
              <h3>Penjualan offline</h3>
              <button type="button" onClick={() => setOpen(false)} aria-label="Tutup">×</button>
            </header>
            <p className="pos-offline-hint">
              Dicatat saat internet mati dan dikirim otomatis begitu tersambung. Nomor struk final dari server menggantikan nomor sementara (OFF-…).
            </p>
            <div className="pos-offline-list">
              {sales.map((sale) => (
                <article key={sale.id} className={sale.status}>
                  <div>
                    <b>{sale.draftReceiptNo}</b>
                    <span>{sale.kind === 'retail' ? 'Retail' : 'B2B'} · {currency.format(sale.total)} · {sale.paymentMethod}</span>
                    <small>{new Date(sale.soldAtMs).toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' })}</small>
                    {sale.status === 'failed' && <em>{sale.error}</em>}
                    {sale.uid !== uid && <em>Dibuat oleh akun lain; akan terkirim saat akun itu login.</em>}
                  </div>
                  {sale.status === 'failed' && sale.uid === uid && (
                    <div className="pos-offline-actions">
                      <button type="button" onClick={() => retryOfflineSale(sale.id)}>Coba lagi</button>
                      <button
                        type="button"
                        className="danger"
                        onClick={() => {
                          if (window.confirm(`Hapus ${sale.draftReceiptNo} dari antrean? Penjualan ini TIDAK akan tercatat di server.`)) discardOfflineSale(sale.id)
                        }}
                      >
                        Hapus
                      </button>
                    </div>
                  )}
                </article>
              ))}
            </div>
            <button type="button" className="pos-offline-send" disabled={!online || pending === 0} onClick={() => void syncOfflineSales(uid)}>
              {online ? 'Kirim sekarang' : 'Menunggu internet'}
            </button>
          </div>
        </div>
      )}
    </>
  )
}
