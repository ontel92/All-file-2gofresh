import { dismissToast, openTarget, shopeeStoreNames, useOps } from './opsStore'
import './OpsToasts.css'

// Pop-up notifications (new orders / chats) shown bottom-right on every POS panel.
// Menutup pop-up (tombol × atau aksi) juga mematikan suara notifikasinya.
export default function OpsToasts() {
  const { toasts } = useOps()
  if (toasts.length === 0) return null
  return (
    <div className="ops-toasts" role="status" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} className={`ops-toast${toast.store ? ` store-${toast.store}` : ''}`}>
          <span className="ops-toast-icon" aria-hidden="true">{toast.icon}</span>
          <div className="ops-toast-body">
            {toast.store && <em className="ops-toast-tag">{shopeeStoreNames[toast.store]}</em>}
            <b>{toast.title}</b>
            <span>{toast.body}</span>
            <div className="ops-toast-actions">
              {toast.actions.map((action) => (
                <button
                  key={action.label + (action.orderSn ?? '')}
                  type="button"
                  onClick={() => {
                    openTarget(action)
                    dismissToast(toast.id)
                  }}
                >
                  {action.label}
                </button>
              ))}
            </div>
          </div>
          <button type="button" className="ops-toast-close" aria-label="Tutup" onClick={() => dismissToast(toast.id)}>×</button>
        </div>
      ))}
    </div>
  )
}
