import { dismissToast, openTarget, useOps } from './opsStore'
import './OpsToasts.css'

// Pop-up notifications (new orders / chats) shown bottom-right on every POS panel.
export default function OpsToasts() {
  const { toasts } = useOps()
  if (toasts.length === 0) return null
  return (
    <div className="ops-toasts" role="status" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} className="ops-toast">
          <span className="ops-toast-icon" aria-hidden="true">{toast.icon}</span>
          <div className="ops-toast-body">
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
