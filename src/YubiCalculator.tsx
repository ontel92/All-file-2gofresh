import { useState } from 'react'
import Calculator from './Calculator'

function YubiCalculator() {
  const [open, setOpen] = useState(false)
  return (
    <div className="yc">
      {open && (
        <section className="yc-panel" aria-label="Kalkulator Yubi">
          <header>
            <img src="/brand/yubi.png" alt="" width="34" height="43" />
            <strong>Kalkulator Yubi</strong>
            <button type="button" aria-label="Tutup kalkulator" onClick={() => setOpen(false)}>×</button>
          </header>
          <Calculator />
        </section>
      )}
      <button type="button" className="yc-fab" aria-label="Buka kalkulator Yubi" title="Kalkulator" onClick={() => setOpen((value) => !value)}>
        <img src="/brand/yubi.png" alt="" width="64" height="81" />
        {!open && <span>🧮 Hitung</span>}
      </button>
    </div>
  )
}

export default YubiCalculator
