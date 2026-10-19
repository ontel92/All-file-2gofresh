import { useEffect, useState } from 'react'
import './Calculator.css'

const rupiah = new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', maximumFractionDigits: 0 })
const plain = new Intl.NumberFormat('id-ID', { maximumFractionDigits: 6 })

// Parser rekursif sederhana (tanpa eval): + - * / % dan kurung.
function evaluate(source: string): number | null {
  const text = source.replaceAll('×', '*').replaceAll('÷', '/').replaceAll(',', '.').replace(/\s+/g, '')
  if (text === '' || !/^[0-9+\-*/%().]+$/.test(text)) return null
  let position = 0

  function number(): number {
    if (text[position] === '(') {
      position += 1
      const inner = expression()
      if (text[position] !== ')') throw new Error('kurung')
      position += 1
      return percent(inner)
    }
    const match = /^\d*\.?\d+|^\d+\.?/.exec(text.slice(position))
    if (!match) throw new Error('angka')
    position += match[0].length
    return percent(Number(match[0]))
  }

  function percent(value: number): number {
    let result = value
    while (text[position] === '%') {
      position += 1
      result /= 100
    }
    return result
  }

  function unary(): number {
    if (text[position] === '-') {
      position += 1
      return -unary()
    }
    if (text[position] === '+') {
      position += 1
      return unary()
    }
    return number()
  }

  function term(): number {
    let value = unary()
    while (text[position] === '*' || text[position] === '/') {
      const operator = text[position]
      position += 1
      const right = unary()
      if (operator === '/' && right === 0) throw new Error('nol')
      value = operator === '*' ? value * right : value / right
    }
    return value
  }

  function expression(): number {
    let value = term()
    while (text[position] === '+' || text[position] === '-') {
      const operator = text[position]
      position += 1
      const right = term()
      value = operator === '+' ? value + right : value - right
    }
    return value
  }

  try {
    const value = expression()
    if (position !== text.length || !Number.isFinite(value)) return null
    return Math.round(value * 1e8) / 1e8
  } catch {
    return null
  }
}

const keys = [
  ['C', '(', ')', '÷'],
  ['7', '8', '9', '×'],
  ['4', '5', '6', '-'],
  ['1', '2', '3', '+'],
  ['0', '000', ',', '%'],
]

type Mode = 'calc' | 'weight' | 'percent'

function Field({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <label className="calc-field">
      <span>{label}</span>
      <input inputMode="decimal" value={value} onChange={(event) => onChange(event.target.value)} placeholder="0" />
    </label>
  )
}

function toNumber(value: string): number {
  const parsed = Number(value.replace(/\./g, '').replace(',', '.'))
  return Number.isFinite(parsed) ? parsed : 0
}

function Calculator() {
  const [mode, setMode] = useState<Mode>('calc')
  const [expression, setExpression] = useState('')
  const [history, setHistory] = useState<{ expression: string; result: number }[]>([])
  const [pricePerKg, setPricePerKg] = useState('')
  const [weight, setWeight] = useState('')
  const [budget, setBudget] = useState('')
  const [base, setBase] = useState('')
  const [rate, setRate] = useState('')

  const result = evaluate(expression)

  function press(key: string) {
    if (key === 'C') {
      setExpression('')
      return
    }
    setExpression((current) => current + key)
  }

  function commit() {
    if (result === null) return
    setHistory((current) => [{ expression, result }, ...current].slice(0, 15))
    setExpression(String(result).replace('.', ','))
  }

  useEffect(() => {
    if (mode !== 'calc') return
    function onKey(event: KeyboardEvent) {
      const target = event.target as HTMLElement
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return
      if (/^[0-9+\-*/%().,]$/.test(event.key)) {
        setExpression((current) => current + event.key.replace('*', '×').replace('/', '÷'))
        event.preventDefault()
      } else if (event.key === 'Backspace') {
        setExpression((current) => current.slice(0, -1))
      } else if (event.key === 'Escape') {
        setExpression('')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [mode])

  const kg = toNumber(weight)
  const perKg = toNumber(pricePerKg)
  const money = toNumber(budget)
  const baseValue = toNumber(base)
  const rateValue = toNumber(rate)

  return (
    <div className="vc">
      <div className="calc-tabs" role="tablist">
        <button type="button" className={mode === 'calc' ? 'active' : ''} onClick={() => setMode('calc')}>🥕 Hitung</button>
        <button type="button" className={mode === 'weight' ? 'active' : ''} onClick={() => setMode('weight')}>🥬 Harga &amp; Berat</button>
        <button type="button" className={mode === 'percent' ? 'active' : ''} onClick={() => setMode('percent')}>🍅 Persen</button>
      </div>

      {mode === 'calc' && (
        <div className="calc-grid">
          <section className="vc-card calc-main">
            <input
              className="calc-display"
              value={expression}
              onChange={(event) => setExpression(event.target.value.replace(/[^0-9+\-*/×÷%().,\s]/g, ''))}
              onKeyDown={(event) => {
                if (event.key === 'Enter') commit()
              }}
              placeholder="0"
              aria-label="Ekspresi"
              inputMode="decimal"
            />
            <p className="calc-result">{result === null ? '\u00a0' : `= ${plain.format(result)}`}</p>
            <div className="calc-keys">
              {keys.flat().map((key) => (
                <button key={key} type="button" className={/[÷×\-+%]/.test(key) ? 'op' : key === 'C' ? 'clear' : ''} onClick={() => press(key)}>
                  {key}
                </button>
              ))}
              <button type="button" onClick={() => setExpression((current) => current.slice(0, -1))}>⌫</button>
              <button type="button" className="equals" onClick={commit} disabled={result === null}>=</button>
            </div>
          </section>
          <section className="vc-card">
            <h2>Riwayat</h2>
            {history.length === 0 ? (
              <p className="sf-note">Belum ada hitungan.</p>
            ) : (
              <ul className="calc-history">
                {history.map((entry, index) => (
                  <li key={index}>
                    <button type="button" onClick={() => setExpression(String(entry.result).replace('.', ','))}>
                      <span>{entry.expression}</span>
                      <strong>{plain.format(entry.result)}</strong>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      )}

      {mode === 'weight' && (
        <div className="calc-grid">
          <section className="vc-card calc-form">
            <h2>Hitung total dari berat</h2>
            <Field label="Harga per kg (Rp)" value={pricePerKg} onChange={setPricePerKg} />
            <Field label="Berat (kg)" value={weight} onChange={setWeight} />
            <p className="calc-out">Total: <strong>{rupiah.format(Math.round(perKg * kg))}</strong></p>
          </section>
          <section className="vc-card calc-form">
            <h2>Hitung berat dari uang</h2>
            <Field label="Harga per kg (Rp)" value={pricePerKg} onChange={setPricePerKg} />
            <Field label="Uang pembeli (Rp)" value={budget} onChange={setBudget} />
            <p className="calc-out">
              Dapat: <strong>{perKg > 0 ? `${plain.format(Math.round((money / perKg) * 1000) / 1000)} kg` : '-'}</strong>
            </p>
          </section>
        </div>
      )}

      {mode === 'percent' && (
        <div className="calc-grid">
          <section className="vc-card calc-form">
            <h2>Persentase</h2>
            <Field label="Nilai awal (Rp)" value={base} onChange={setBase} />
            <Field label="Persen (%)" value={rate} onChange={setRate} />
            <p className="calc-out">{rate || '0'}% dari nilai: <strong>{rupiah.format(Math.round((baseValue * rateValue) / 100))}</strong></p>
            <p className="calc-out">Naik {rate || '0'}%: <strong>{rupiah.format(Math.round(baseValue * (1 + rateValue / 100)))}</strong></p>
            <p className="calc-out">Diskon {rate || '0'}%: <strong>{rupiah.format(Math.round(baseValue * (1 - rateValue / 100)))}</strong></p>
          </section>
          <section className="vc-card calc-form">
            <h2>Margin dari modal & harga jual</h2>
            <Field label="Harga modal (Rp)" value={base} onChange={setBase} />
            <Field label="Harga jual (Rp)" value={budget} onChange={setBudget} />
            <p className="calc-out">Untung: <strong>{rupiah.format(Math.round(money - baseValue))}</strong></p>
            <p className="calc-out">
              Margin: <strong>{money > 0 ? `${plain.format(Math.round(((money - baseValue) / money) * 10000) / 100)}%` : '-'}</strong>
            </p>
          </section>
        </div>
      )}
    </div>
  )
}

export default Calculator
