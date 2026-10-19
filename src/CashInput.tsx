import { parseNumber } from './retailPricing'

const denominations = [100000, 50000, 25000, 10000, 5000, 2000, 1000, 500]
const number = new Intl.NumberFormat('id-ID')
const currency = new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', maximumFractionDigits: 0 })

type Props = {
  value: string
  onChange: (value: string) => void
  total: number
}

function CashInput({ value, onChange, total }: Props) {
  const received = parseNumber(value)
  const amount = Number.isFinite(received) ? received : 0
  const change = amount - total

  return (
    <div className="rc-cashbox">
      <label className="rc-cash">
        <span>Uang diterima (Rp)</span>
        <span className="rc-cash-field">
          <input
            inputMode="numeric"
            value={amount > 0 ? number.format(amount) : ''}
            onChange={(event) => onChange(event.target.value.replace(/\D/g, '').slice(0, 10))}
            placeholder="0"
            autoComplete="off"
          />
          {value !== '' && (
            <button type="button" className="rc-clear" aria-label="Hapus nominal" onClick={() => onChange('')}>
              ×
            </button>
          )}
        </span>
      </label>
      <div className="rc-denoms" role="group" aria-label="Tambah nominal cepat">
        {denominations.map((denomination) => (
          <button
            key={denomination}
            type="button"
            onClick={() => onChange(String(amount + denomination))}
          >
            {number.format(denomination)}
          </button>
        ))}
        <button type="button" className="exact" disabled={total <= 0} onClick={() => onChange(String(total))}>
          Uang pas
        </button>
      </div>
      <p className={`rc-change${amount > 0 && change < 0 ? ' short' : ''}`}>
        {amount > 0 && change < 0 ? 'Kurang:' : 'Kembalian:'}{' '}
        <strong>{currency.format(Math.abs(amount > 0 ? change : 0))}</strong>
      </p>
    </div>
  )
}

export default CashInput
