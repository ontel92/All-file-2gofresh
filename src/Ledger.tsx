import { useCallback, useEffect, useMemo, useState } from 'react'
import { httpsCallable } from 'firebase/functions'
import { functions } from './posFirebase'
import './Ledger.css'

type Entry = { id: string; type: 'income' | 'expense'; category: string; amount: number; note: string; date: string; createdByName: string }
type AutoRow = { date: string; kind: 'income' | 'expense'; source: string; label: string; amount: number; count: number }
type Summary = { from: string; to: string; entries: Entry[]; auto: AutoRow[]; warnings: string[]; generatedAt: number }

const money = new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', maximumFractionDigits: 0 })
const incomeCategories = [['tiktok', 'TikTok / Tokopedia'], ['freshstock', 'Freshstock'], ['shopee', 'Shopee (manual)'], ['lainnya', 'Lainnya']]
const expenseCategories = [['operasional', 'Operasional'], ['bayar-sales', 'Bayar sales'], ['nempil', 'Nempil'], ['kulakan', 'Kulakan'], ['lainnya', 'Lainnya']]
const categoryLabel = (type: Entry['type'], key: string) =>
  (type === 'income' ? incomeCategories : expenseCategories).find(([value]) => value === key)?.[1] ?? key

const today = () => new Date().toISOString().slice(0, 10)
const monthStart = () => `${today().slice(0, 8)}01`
const requestId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`

function message(error: unknown) {
  return error instanceof Error ? error.message : 'Terjadi kesalahan.'
}

export default function Ledger() {
  const [from, setFrom] = useState(monthStart())
  const [to, setTo] = useState(today())
  const [summary, setSummary] = useState<Summary | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [type, setType] = useState<Entry['type']>('expense')
  const [category, setCategory] = useState('operasional')
  const [amount, setAmount] = useState('')
  const [date, setDate] = useState(today())
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const result = await httpsCallable<{ from: string; to: string }, Summary>(functions, 'ledgerSummary')({ from, to })
      setSummary(result.data)
    } catch (failure) {
      setError(message(failure))
    } finally {
      setLoading(false)
    }
  }, [from, to])

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0)
    return () => window.clearTimeout(timer)
  }, [load])

  async function save(event: React.FormEvent) {
    event.preventDefault()
    setSaving(true)
    setError('')
    try {
      await httpsCallable(functions, 'ledgerAdd')({
        type,
        category,
        amount: Number(amount.replace(/\D/g, '')),
        note,
        date,
        requestId: requestId(),
      })
      setAmount('')
      setNote('')
      await load()
    } catch (failure) {
      setError(message(failure))
    } finally {
      setSaving(false)
    }
  }

  async function remove(entry: Entry) {
    if (!window.confirm(`Hapus catatan "${entry.note}" (${money.format(entry.amount)})?`)) return
    try {
      await httpsCallable(functions, 'ledgerRemove')({ id: entry.id })
      await load()
    } catch (failure) {
      setError(message(failure))
    }
  }

  const totals = useMemo(() => {
    const result = { income: 0, expense: 0, autoIncome: 0, autoExpense: 0, manualIncome: 0, manualExpense: 0 }
    for (const row of summary?.auto ?? []) {
      if (row.kind === 'income') { result.income += row.amount; result.autoIncome += row.amount }
      else { result.expense += row.amount; result.autoExpense += row.amount }
    }
    for (const entry of summary?.entries ?? []) {
      if (entry.type === 'income') { result.income += entry.amount; result.manualIncome += entry.amount }
      else { result.expense += entry.amount; result.manualExpense += entry.amount }
    }
    return result
  }, [summary])

  const bySource = useMemo(() => {
    const map = new Map<string, { label: string; kind: 'income' | 'expense'; amount: number; count: number }>()
    for (const row of summary?.auto ?? []) {
      const current = map.get(row.source) ?? { label: row.label, kind: row.kind, amount: 0, count: 0 }
      map.set(row.source, { ...current, amount: current.amount + row.amount, count: current.count + row.count })
    }
    for (const entry of summary?.entries ?? []) {
      const key = `manual-${entry.type}-${entry.category}`
      const current = map.get(key) ?? { label: `${categoryLabel(entry.type, entry.category)} (catatan manual)`, kind: entry.type, amount: 0, count: 0 }
      map.set(key, { ...current, amount: current.amount + entry.amount, count: current.count + 1 })
    }
    return [...map.values()].sort((a, b) => a.kind.localeCompare(b.kind) || b.amount - a.amount)
  }, [summary])

  const days = useMemo(() => {
    const map = new Map<string, { income: number; expense: number }>()
    const add = (day: string, kind: 'income' | 'expense', value: number) => {
      const current = map.get(day) ?? { income: 0, expense: 0 }
      map.set(day, { ...current, [kind]: current[kind] + value })
    }
    for (const row of summary?.auto ?? []) add(row.date, row.kind, row.amount)
    for (const entry of summary?.entries ?? []) add(entry.date, entry.type, entry.amount)
    return [...map.entries()].sort(([a], [b]) => b.localeCompare(a))
  }, [summary])

  const categories = type === 'income' ? incomeCategories : expenseCategories

  return (
    <section className="lg">
      <header className="pos-page-heading">
        <div>
          <p className="pos-eyebrow">SUPERVISOR &amp; OWNER</p>
          <h1>Pembukuan</h1>
          <p>Tanggal memakai standar internasional (UTC, format YYYY-MM-DD). Kasir, Shopee, dan kas shift terbaca otomatis.</p>
        </div>
        <button type="button" className="sp-btn ghost" disabled={loading} onClick={() => void load()}>{loading ? 'Memuat...' : '↻ Muat ulang'}</button>
      </header>

      <div className="lg-toolbar">
        <label>Dari<input type="date" value={from} max={to} onChange={(event) => setFrom(event.target.value)} /></label>
        <label>Sampai<input type="date" value={to} min={from} onChange={(event) => setTo(event.target.value)} /></label>
      </div>

      {error && <p className="lg-error" role="alert">{error}</p>}
      {summary?.warnings.map((warning) => <p key={warning} className="lg-warning">{warning}</p>)}

      <div className="lg-cards">
        <div className="lg-card in"><span>Pemasukan</span><b>{money.format(totals.income)}</b><small>Otomatis {money.format(totals.autoIncome)} · Manual {money.format(totals.manualIncome)}</small></div>
        <div className="lg-card out"><span>Pengeluaran</span><b>{money.format(totals.expense)}</b><small>Otomatis {money.format(totals.autoExpense)} · Manual {money.format(totals.manualExpense)}</small></div>
        <div className={`lg-card ${totals.income - totals.expense >= 0 ? 'in' : 'out'}`}><span>Selisih (kas bersih)</span><b>{money.format(totals.income - totals.expense)}</b><small>Belum memperhitungkan HPP</small></div>
      </div>

      <div className="lg-grid">
        <form className="lg-form" onSubmit={save}>
          <h2>Catat transaksi</h2>
          <div className="lg-seg">
            <button type="button" className={type === 'expense' ? 'on' : ''} onClick={() => { setType('expense'); setCategory('operasional') }}>Pengeluaran</button>
            <button type="button" className={type === 'income' ? 'on' : ''} onClick={() => { setType('income'); setCategory('tiktok') }}>Pemasukan</button>
          </div>
          <label>Kategori
            <select value={category} onChange={(event) => setCategory(event.target.value)}>
              {categories.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </label>
          <label>Tanggal<input type="date" value={date} onChange={(event) => setDate(event.target.value)} required /></label>
          <label>Nominal (Rp)<input inputMode="numeric" value={amount} onChange={(event) => setAmount(event.target.value.replace(/\D/g, ''))} placeholder="0" required /></label>
          <label>Keterangan<input value={note} onChange={(event) => setNote(event.target.value)} placeholder="Contoh: kulakan sayur pasar" minLength={3} maxLength={200} required /></label>
          <button type="submit" className="sp-btn" disabled={saving || !amount || note.trim().length < 3}>{saving ? 'Menyimpan...' : 'Simpan'}</button>
          <p className="lg-hint">Jangan catat ulang penjualan kasir, dana cair Shopee, atau pengeluaran kas shift: itu sudah masuk otomatis.</p>
        </form>

        <div>
          <h2>Ringkasan per sumber</h2>
          <table className="lg-table">
            <thead><tr><th>Sumber</th><th>Jenis</th><th>Jumlah</th><th>Nominal</th></tr></thead>
            <tbody>
              {bySource.map((row) => (
                <tr key={`${row.kind}-${row.label}`}><td>{row.label}</td><td>{row.kind === 'income' ? 'Masuk' : 'Keluar'}</td><td>{row.count}</td><td className={row.kind}>{money.format(row.amount)}</td></tr>
              ))}
              {bySource.length === 0 && <tr><td colSpan={4} className="lg-empty">Belum ada data pada rentang ini.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      <h2>Per tanggal (UTC)</h2>
      <table className="lg-table">
        <thead><tr><th>Tanggal</th><th>Pemasukan</th><th>Pengeluaran</th><th>Selisih</th></tr></thead>
        <tbody>
          {days.map(([day, value]) => (
            <tr key={day}><td>{day}</td><td className="income">{money.format(value.income)}</td><td className="expense">{money.format(value.expense)}</td><td>{money.format(value.income - value.expense)}</td></tr>
          ))}
        </tbody>
      </table>

      <h2>Catatan manual</h2>
      <table className="lg-table">
        <thead><tr><th>Tanggal</th><th>Jenis</th><th>Kategori</th><th>Keterangan</th><th>Nominal</th><th /></tr></thead>
        <tbody>
          {[...(summary?.entries ?? [])].sort((a, b) => b.date.localeCompare(a.date)).map((entry) => (
            <tr key={entry.id}>
              <td>{entry.date}</td><td>{entry.type === 'income' ? 'Masuk' : 'Keluar'}</td><td>{categoryLabel(entry.type, entry.category)}</td>
              <td>{entry.note}<small> · {entry.createdByName}</small></td><td className={entry.type}>{money.format(entry.amount)}</td>
              <td><button type="button" className="sp-btn ghost" onClick={() => void remove(entry)}>Hapus</button></td>
            </tr>
          ))}
          {(summary?.entries.length ?? 0) === 0 && <tr><td colSpan={6} className="lg-empty">Belum ada catatan manual.</td></tr>}
        </tbody>
      </table>
    </section>
  )
}
