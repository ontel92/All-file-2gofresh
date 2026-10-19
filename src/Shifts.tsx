import { useEffect, useRef, useState } from 'react'
import { signOut } from 'firebase/auth'
import { collection, doc, limit, onSnapshot, orderBy, query, where } from 'firebase/firestore'
import { httpsCallable } from 'firebase/functions'
import { database } from './firebase'
import { auth, functions } from './posFirebase'
import './Shifts.css'

export type ExpenseCategory = 'nempil' | 'sales' | 'ops'
export type ShiftFunds = { change: number; nempil: number; sales: number; ops: number }
type Totals = {
  count: number
  sales: number
  cash: number
  qris: number
  transfer: number
  retail: number
  b2b: number
}
export type Shift = {
  id: string
  status: 'open' | 'closed'
  cashierUid: string
  cashierName: string
  funds: ShiftFunds
  spent: Record<ExpenseCategory, number>
  totals: Totals
  openedAt: Date | null
  closedAt: Date | null
  expectedCash: number | null
  countedCash: number | null
  difference: number | null
  closeNote: string
}
export type ShiftState = { shiftId: string; cashierUid: string; cashierName: string }
export type CloseSummary = {
  shiftId: string
  expectedCash: number
  countedCash: number
  difference: number
  reportText?: string
  emailSent?: boolean
}
export type Topup = { id: string; category: FundCategory; amount: number; source: string; createdAt: Date | null }
type FundCategory = 'change' | ExpenseCategory
type Expense = { id: string; category: ExpenseCategory; amount: number; note: string; createdAt: Date | null }

const currency = new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', maximumFractionDigits: 0 })
const number = new Intl.NumberFormat('id-ID')

const categoryLabel: Record<ExpenseCategory, string> = {
  nempil: 'Nempil',
  sales: 'Bayar Sales',
  ops: 'Operasional Toko / Ongkir',
}
const categoryHint: Record<ExpenseCategory, string> = {
  nempil: 'Beli produk yang kosong di toko lain',
  sales: 'Bayar produk titipan sales yang laku',
  ops: 'Bensin, konsumsi, ongkir kurir, dll.',
}
const categories: ExpenseCategory[] = ['nempil', 'sales', 'ops']
const fundLabel: Record<FundCategory, string> = { change: 'Modal Kembalian', ...categoryLabel }
const fundKeys: FundCategory[] = ['change', ...categories]

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function toDate(value: unknown): Date | null {
  const converter = (value as { toDate?: () => Date } | null)?.toDate
  return typeof converter === 'function' ? converter.call(value) : null
}

function parseShift(id: string, data: Record<string, unknown>): Shift {
  const funds = (data.funds ?? {}) as Record<string, unknown>
  const spent = (data.spent ?? {}) as Record<string, unknown>
  const totals = (data.totals ?? {}) as Record<string, unknown>
  return {
    id,
    status: data.status === 'closed' ? 'closed' : 'open',
    cashierUid: String(data.cashierUid ?? ''),
    cashierName: String(data.cashierName ?? ''),
    funds: { change: num(funds.change), nempil: num(funds.nempil), sales: num(funds.sales), ops: num(funds.ops) },
    spent: { nempil: num(spent.nempil), sales: num(spent.sales), ops: num(spent.ops) },
    totals: {
      count: num(totals.count),
      sales: num(totals.sales),
      cash: num(totals.cash),
      qris: num(totals.qris),
      transfer: num(totals.transfer),
      retail: num(totals.retail),
      b2b: num(totals.b2b),
    },
    openedAt: toDate(data.openedAt),
    closedAt: toDate(data.closedAt),
    expectedCash: typeof data.expectedCash === 'number' ? data.expectedCash : null,
    countedCash: typeof data.countedCash === 'number' ? data.countedCash : null,
    difference: typeof data.difference === 'number' ? data.difference : null,
    closeNote: String(data.closeNote ?? ''),
  }
}

export function useShift(enabled: boolean) {
  const [state, setState] = useState<ShiftState | null | undefined>(undefined)
  const [shift, setShift] = useState<Shift | null>(null)
  const [expenses, setExpenses] = useState<Expense[]>([])
  const [topups, setTopups] = useState<Topup[]>([])
  const [error, setError] = useState('')

  useEffect(() => {
    if (!enabled) return
    return onSnapshot(
      doc(database, 'shiftState', 'current'),
      (snapshot) => {
        const data = snapshot.data()
        setState(
          data
            ? { shiftId: String(data.shiftId), cashierUid: String(data.cashierUid), cashierName: String(data.cashierName) }
            : null,
        )
      },
      (snapshotError) => setError(snapshotError.message),
    )
  }, [enabled])

  const shiftId = state?.shiftId
  useEffect(() => {
    if (!enabled || !shiftId) return
    const unsubscribeShift = onSnapshot(
      doc(database, 'shifts', shiftId),
      (snapshot) => {
        const data = snapshot.data()
        setShift(data ? parseShift(snapshot.id, data) : null)
      },
      () => setShift(null),
    )
    const unsubscribeExpenses = onSnapshot(
      query(collection(database, 'shifts', shiftId, 'expenses'), orderBy('createdAt', 'desc')),
      (snapshot) =>
        setExpenses(
          snapshot.docs
            .filter((entry) => entry.get('removed') !== true)
            .map((entry) => ({
              id: entry.id,
              category: entry.get('category') as ExpenseCategory,
              amount: num(entry.get('amount')),
              note: String(entry.get('note') ?? ''),
              createdAt: toDate(entry.get('createdAt')),
            })),
        ),
      () => setExpenses([]),
    )
    const unsubscribeTopups = onSnapshot(
      query(collection(database, 'shifts', shiftId, 'topups'), orderBy('createdAt', 'desc')),
      (snapshot) =>
        setTopups(
          snapshot.docs.map((entry) => ({
            id: entry.id,
            category: entry.get('category') as FundCategory,
            amount: num(entry.get('amount')),
            source: String(entry.get('source') ?? ''),
            createdAt: toDate(entry.get('createdAt')),
          })),
        ),
      () => setTopups([]),
    )
    return () => {
      unsubscribeShift()
      unsubscribeExpenses()
      unsubscribeTopups()
    }
  }, [enabled, shiftId])

  const activeShift = shiftId && shift?.id === shiftId ? shift : null
  return { state, shift: activeShift, expenses: activeShift ? expenses : [], topups: activeShift ? topups : [], error }
}

function errorText(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback
}

function MoneyField({
  label,
  value,
  onChange,
  hint,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  hint?: string
}) {
  const amount = Number(value) || 0
  return (
    <label className="sf-field">
      <span>{label}</span>
      <input
        inputMode="numeric"
        placeholder="0"
        autoComplete="off"
        value={amount > 0 ? number.format(amount) : ''}
        onChange={(event) => onChange(event.target.value.replace(/\D/g, '').slice(0, 10))}
      />
      {hint && <small>{hint}</small>}
    </label>
  )
}

export function OpenShiftGate({ displayName }: { displayName: string }) {
  const [funds, setFunds] = useState({ change: '', nempil: '', sales: '', ops: '' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const total = Object.values(funds).reduce((sum, value) => sum + (Number(value) || 0), 0)

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      await httpsCallable(functions, 'openShift')({
        funds: {
          change: Number(funds.change) || 0,
          nempil: Number(funds.nempil) || 0,
          sales: Number(funds.sales) || 0,
          ops: Number(funds.ops) || 0,
        },
      })
    } catch (openError) {
      setError(errorText(openError, 'Shift gagal dibuka.'))
      setBusy(false)
    }
  }

  return (
    <main className="pos-access-page">
      <form className="pos-access-card sf-gate" onSubmit={(event) => void submit(event)}>
        <p className="pos-eyebrow">BUKA SHIFT</p>
        <h1>Halo, {displayName}</h1>
        <p>Isi modal kas yang Anda terima. Kosongkan (0) jika tidak ada.</p>
        <MoneyField label="1. Modal uang kembalian tunai" value={funds.change} onChange={(value) => setFunds({ ...funds, change: value })} />
        <MoneyField label="2. Modal nempil" value={funds.nempil} onChange={(value) => setFunds({ ...funds, nempil: value })} />
        <MoneyField label="3. Modal untuk sales" value={funds.sales} onChange={(value) => setFunds({ ...funds, sales: value })} />
        <MoneyField label="4. Operasional toko" value={funds.ops} onChange={(value) => setFunds({ ...funds, ops: value })} />
        <p className="sf-total">Total modal: <strong>{currency.format(total)}</strong></p>
        {error && <p className="rc-warning" role="alert">{error}</p>}
        <button type="submit" className="sf-primary" disabled={busy}>
          {busy ? 'Membuka shift...' : 'Buka Shift'}
        </button>
        <button type="button" className="sf-link" onClick={() => void signOut(auth)}>Keluar</button>
      </form>
    </main>
  )
}

export function ShiftBlocked({ holderName }: { holderName: string }) {
  return (
    <main className="pos-access-page">
      <section className="pos-access-card sf-gate">
        <p className="pos-eyebrow">SHIFT BELUM DITUTUP</p>
        <h1>Kasir {holderName} belum closing.</h1>
        <p>
          Shift sebelumnya harus ditutup dulu. Minta <strong>{holderName}</strong> login dengan
          passwordnya sendiri, lalu buka menu <strong>Closing Shift</strong>. Setelah itu Anda bisa login
          dan membuka shift baru.
        </p>
        <button type="button" className="sf-primary" onClick={() => void signOut(auth)}>Keluar</button>
      </section>
    </main>
  )
}

export function ClosedScreen({
  summary,
  canReturn,
  onReturn,
}: {
  summary: CloseSummary
  canReturn: boolean
  onReturn: () => void
}) {
  const label = summary.difference === 0 ? 'Uang pas' : summary.difference > 0 ? 'Lebih' : 'Kurang'
  const [waSent, setWaSent] = useState(false)
  const waUrl = `https://wa.me/6281231678067?text=${encodeURIComponent(summary.reportText ?? 'Laporan closing shift')}`
  return (
    <main className="pos-access-page">
      <section className="pos-access-card sf-gate">
        <p className="pos-eyebrow">CLOSING SELESAI</p>
        <h1>Shift berhasil ditutup.</h1>
        <dl className="sf-rows">
          <div><dt>Uang seharusnya</dt><dd>{currency.format(summary.expectedCash)}</dd></div>
          <div><dt>Uang di laci</dt><dd>{currency.format(summary.countedCash)}</dd></div>
          <div className={summary.difference === 0 ? 'ok' : 'bad'}>
            <dt>Selisih ({label})</dt><dd>{currency.format(Math.abs(summary.difference))}</dd>
          </div>
        </dl>
        <p className={summary.emailSent ? 'sf-note' : 'sf-bad'}>
          {summary.emailSent
            ? '✔ Laporan sudah dikirim ke email supervisor.'
            : '⚠ Email laporan belum terkirim (server email belum siap). Hubungi owner; laporan tetap tersimpan.'}
        </p>
        <a className="sf-primary sf-wa" href={waUrl} target="_blank" rel="noreferrer" onClick={() => setWaSent(true)}>
          Kirim Laporan ke WhatsApp (wajib)
        </a>
        <button type="button" className="sf-primary" disabled={!waSent} onClick={() => void signOut(auth)}>Keluar</button>
        {!waSent && <p className="sf-note">Tekan tombol WhatsApp dan kirim pesannya dulu, baru bisa keluar.</p>}
        {canReturn && <button type="button" className="sf-link" onClick={onReturn}>Kembali ke POS</button>}
      </section>
    </main>
  )
}

function TopupTable({ topups }: { topups: Topup[] }) {
  if (topups.length === 0) return null
  return (
    <section className="ct-card">
      <h2>Tambahan modal shift ini</h2>
      <table className="sh-table">
        <thead><tr><th>Jam</th><th>Untuk</th><th>Sumber dana</th><th>Nominal</th></tr></thead>
        <tbody>
          {topups.map((topup) => (
            <tr key={topup.id}>
              <td>{time(topup.createdAt)}</td>
              <td>{fundLabel[topup.category] ?? topup.category}</td>
              <td>{topup.source}</td>
              <td>+ {currency.format(topup.amount)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}

function time(date: Date | null) {
  return date ? date.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' }) : '-'
}

export function ExpensesPanel({
  shift,
  expenses,
  topups,
  canAdd,
}: {
  shift: Shift | null
  expenses: Expense[]
  topups: Topup[]
  canAdd: boolean
}) {
  const [category, setCategory] = useState<ExpenseCategory>('nempil')
  const [amount, setAmount] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const requestId = useRef(crypto.randomUUID())
  const [topCategory, setTopCategory] = useState<FundCategory>('sales')
  const [topAmount, setTopAmount] = useState('')
  const [topSource, setTopSource] = useState('')
  const [topBusy, setTopBusy] = useState(false)
  const [topError, setTopError] = useState('')
  const topRequestId = useRef(crypto.randomUUID())

  if (!shift) {
    return <section className="ct-card"><p>Belum ada shift yang terbuka.</p></section>
  }

  async function submitTopup(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setTopBusy(true)
    setTopError('')
    try {
      await httpsCallable(functions, 'addShiftFund')({
        category: topCategory,
        amount: Number(topAmount),
        source: topSource,
        requestId: topRequestId.current,
      })
      topRequestId.current = crypto.randomUUID()
      setTopAmount('')
      setTopSource('')
    } catch (failure) {
      setTopError(errorText(failure, 'Tambah modal gagal.'))
    } finally {
      setTopBusy(false)
    }
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      await httpsCallable(functions, 'addCashExpense')({
        category,
        amount: Number(amount),
        note,
        requestId: requestId.current,
      })
      requestId.current = crypto.randomUUID()
      setAmount('')
      setNote('')
    } catch (addError) {
      setError(errorText(addError, 'Pengeluaran gagal disimpan.'))
    } finally {
      setBusy(false)
    }
  }

  async function remove(expenseId: string) {
    if (!window.confirm('Hapus pengeluaran ini?')) return
    try {
      await httpsCallable(functions, 'removeCashExpense')({ expenseId })
    } catch (removeError) {
      setError(errorText(removeError, 'Pengeluaran gagal dihapus.'))
    }
  }

  return (
    <div className="sf-page">
      <section className="sf-funds">
        <article className="sf-fund">
          <h3>Modal Kembalian</h3>
          <strong>{currency.format(shift.funds.change)}</strong>
          <small>Tetap di laci untuk uang kembalian</small>
        </article>
        {categories.map((key) => {
          const left = shift.funds[key] - shift.spent[key]
          return (
            <article className="sf-fund" key={key}>
              <h3>{categoryLabel[key]}</h3>
              <strong className={left < 0 ? 'bad' : ''}>{currency.format(left)}</strong>
              <small>Modal {currency.format(shift.funds[key])} · terpakai {currency.format(shift.spent[key])}</small>
            </article>
          )
        })}
      </section>

      {canAdd ? (
        <form className="ct-card sf-form" onSubmit={(event) => void submit(event)}>
          <h2>Catat pengeluaran</h2>
          <div className="sf-cats" role="group" aria-label="Jenis pengeluaran">
            {categories.map((key) => (
              <button
                key={key}
                type="button"
                className={category === key ? 'active' : ''}
                onClick={() => setCategory(key)}
              >
                <strong>{categoryLabel[key]}</strong>
                <small>{categoryHint[key]}</small>
              </button>
            ))}
          </div>
          <MoneyField label="Nominal (Rp)" value={amount} onChange={setAmount} />
          <label className="sf-field">
            <span>Keterangan</span>
            <input
              value={note}
              onChange={(event) => setNote(event.target.value)}
              maxLength={120}
              placeholder="Contoh: beli bawang putih 5 kg di Toko Budi"
            />
          </label>
          {shift.spent[category] + (Number(amount) || 0) > shift.funds[category] && Number(amount) > 0 && (
            <p className="rc-warning">Nominal ini melebihi modal {categoryLabel[category]}. Tetap bisa disimpan.</p>
          )}
          {error && <p className="rc-warning" role="alert">{error}</p>}
          <button type="submit" className="sf-primary" disabled={busy || !(Number(amount) > 0) || note.trim().length < 3}>
            {busy ? 'Menyimpan...' : 'Simpan pengeluaran'}
          </button>
        </form>
      ) : (
        <p className="sf-note">Hanya kasir yang sedang bertugas yang dapat mencatat pengeluaran.</p>
      )}

      {canAdd && (
        <form className="ct-card sf-form" onSubmit={(event) => void submitTopup(event)}>
          <h2>Tambah modal</h2>
          <p className="sf-note">Gunakan jika modal kurang. Sumber dana wajib dicatat (dari siapa / dari mana).</p>
          <div className="sf-cats" role="group" aria-label="Tambah ke modal">
            {fundKeys.map((key) => (
              <button key={key} type="button" className={topCategory === key ? 'active' : ''} onClick={() => setTopCategory(key)}>
                <strong>{fundLabel[key]}</strong>
              </button>
            ))}
          </div>
          <MoneyField label="Nominal tambahan (Rp)" value={topAmount} onChange={setTopAmount} />
          <label className="sf-field">
            <span>Sumber dana (wajib)</span>
            <input
              value={topSource}
              onChange={(event) => setTopSource(event.target.value)}
              maxLength={120}
              placeholder="Contoh: dari Bu Rina (owner) / dari laci penjualan"
            />
          </label>
          {topError && <p className="rc-warning" role="alert">{topError}</p>}
          <button type="submit" className="sf-primary" disabled={topBusy || !(Number(topAmount) > 0) || topSource.trim().length < 3}>
            {topBusy ? 'Menyimpan...' : 'Tambah modal'}
          </button>
        </form>
      )}

      <TopupTable topups={topups} />

      <section className="ct-card">
        <h2>Pengeluaran shift ini</h2>
        {expenses.length === 0 ? (
          <p className="sf-note">Belum ada pengeluaran.</p>
        ) : (
          <table className="sh-table">
            <thead><tr><th>Jam</th><th>Jenis</th><th>Keterangan</th><th>Nominal</th>{canAdd && <th></th>}</tr></thead>
            <tbody>
              {expenses.map((expense) => (
                <tr key={expense.id}>
                  <td>{time(expense.createdAt)}</td>
                  <td>{categoryLabel[expense.category] ?? expense.category}</td>
                  <td>{expense.note}</td>
                  <td>{currency.format(expense.amount)}</td>
                  {canAdd && (
                    <td>
                      <button type="button" className="sh-void" onClick={() => void remove(expense.id)}>Hapus</button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  )
}

function ShiftHistory({ uid, canSeeAll }: { uid: string; canSeeAll: boolean }) {
  const [rows, setRows] = useState<Shift[]>([])
  const [error, setError] = useState('')

  useEffect(() => {
    const base = collection(database, 'shifts')
    const source = canSeeAll
      ? query(base, orderBy('openedAt', 'desc'), limit(60))
      : query(base, where('cashierUid', '==', uid), orderBy('openedAt', 'desc'), limit(60))
    return onSnapshot(
      source,
      (snapshot) => setRows(snapshot.docs.map((entry) => parseShift(entry.id, entry.data()))),
      (snapshotError) => setError(snapshotError.message),
    )
  }, [uid, canSeeAll])

  const closed = rows.filter((row) => row.status === 'closed')
  const daily = new Map<string, { shifts: number; sales: number; spent: number; difference: number }>()
  for (const row of closed) {
    const key = (row.openedAt ?? new Date(0)).toLocaleDateString('id-ID', { dateStyle: 'medium' })
    const entry = daily.get(key) ?? { shifts: 0, sales: 0, spent: 0, difference: 0 }
    entry.shifts += 1
    entry.sales += row.totals.sales
    entry.spent += row.spent.nempil + row.spent.sales + row.spent.ops
    entry.difference += row.difference ?? 0
    daily.set(key, entry)
  }

  return (
    <section className="ct-card">
      <h2>Rekap harian</h2>
      {error && <p className="rc-warning">{error}</p>}
      {closed.length === 0 ? (
        <p className="sf-note">Belum ada shift yang selesai closing.</p>
      ) : (
        <>
          <table className="sh-table">
            <thead><tr><th>Tanggal</th><th>Shift</th><th>Penjualan</th><th>Pengeluaran</th><th>Selisih</th></tr></thead>
            <tbody>
              {[...daily.entries()].map(([day, entry]) => (
                <tr key={day}>
                  <td>{day}</td><td>{entry.shifts}</td><td>{currency.format(entry.sales)}</td>
                  <td>{currency.format(entry.spent)}</td>
                  <td className={entry.difference === 0 ? '' : 'sf-bad'}>{currency.format(entry.difference)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <h3 className="sf-sub">Detail per shift</h3>
          <table className="sh-table">
            <thead><tr><th>Kasir</th><th>Buka</th><th>Tutup</th><th>Penjualan</th><th>Selisih</th><th>Catatan</th></tr></thead>
            <tbody>
              {closed.map((row) => (
                <tr key={row.id}>
                  <td>{row.cashierName}</td>
                  <td>{row.openedAt?.toLocaleString('id-ID', { dateStyle: 'short', timeStyle: 'short' })}</td>
                  <td>{row.closedAt?.toLocaleString('id-ID', { dateStyle: 'short', timeStyle: 'short' })}</td>
                  <td>{currency.format(row.totals.sales)}</td>
                  <td className={row.difference === 0 ? '' : 'sf-bad'}>{currency.format(row.difference ?? 0)}</td>
                  <td>{row.closeNote || '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </section>
  )
}

export function ClosingPanel({
  shift,
  expenses,
  topups,
  holderName,
  canClose,
  uid,
  canSeeAll,
  onClosed,
}: {
  shift: Shift | null
  expenses: Expense[]
  topups: Topup[]
  holderName: string
  canClose: boolean
  uid: string
  canSeeAll: boolean
  onClosed: (summary: CloseSummary) => void
}) {
  const [counted, setCounted] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  let body = <section className="ct-card"><p>Belum ada shift yang terbuka.</p></section>
  if (shift) {
    const fundTotal = shift.funds.change + shift.funds.nempil + shift.funds.sales + shift.funds.ops
    const spentTotal = shift.spent.nempil + shift.spent.sales + shift.spent.ops
    const expected = fundTotal + shift.totals.cash - spentTotal
    const hasCount = counted !== ''
    const difference = (Number(counted) || 0) - expected

    const submit = async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault()
      if (!window.confirm('Tutup shift sekarang? Setelah closing, data shift tidak bisa diubah.')) return
      setBusy(true)
      setError('')
      try {
        const result = await httpsCallable<unknown, CloseSummary>(functions, 'closeShift')({
          countedCash: Number(counted) || 0,
          note,
        })
        onClosed(result.data)
      } catch (closeError) {
        setError(errorText(closeError, 'Closing gagal.'))
        setBusy(false)
      }
    }

    body = (
      <div className="sf-page">
        <p className="sf-note">
          Shift {shift.cashierName} · dibuka {shift.openedAt?.toLocaleString('id-ID', { dateStyle: 'short', timeStyle: 'short' })}
          {!canClose && ` · hanya ${holderName} atau owner/supervisor yang dapat closing`}
        </p>
        <div className="sf-grid">
          <section className="ct-card">
            <h2>Pemasukan (penjualan)</h2>
            <dl className="sf-rows">
              <div><dt>Jumlah transaksi</dt><dd>{shift.totals.count}</dd></div>
              <div><dt>Tunai</dt><dd>{currency.format(shift.totals.cash)}</dd></div>
              <div><dt>QRIS / EDC</dt><dd>{currency.format(shift.totals.qris)}</dd></div>
              <div><dt>Transfer</dt><dd>{currency.format(shift.totals.transfer)}</dd></div>
              <div><dt>Kasir Retail</dt><dd>{currency.format(shift.totals.retail)}</dd></div>
              <div><dt>Kasir B2B</dt><dd>{currency.format(shift.totals.b2b)}</dd></div>
              <div className="total"><dt>Total penjualan</dt><dd>{currency.format(shift.totals.sales)}</dd></div>
            </dl>
          </section>
          <section className="ct-card">
            <h2>Modal & pengeluaran</h2>
            <dl className="sf-rows">
              <div><dt>Modal kembalian</dt><dd>{currency.format(shift.funds.change)}</dd></div>
              {categories.map((key) => (
                <div key={key}>
                  <dt>{categoryLabel[key]} (modal {currency.format(shift.funds[key])})</dt>
                  <dd>− {currency.format(shift.spent[key])}</dd>
                </div>
              ))}
              <div className="total"><dt>Total pengeluaran</dt><dd>− {currency.format(spentTotal)}</dd></div>
            </dl>
          </section>
        </div>

        <TopupTable topups={topups} />

        {expenses.length > 0 && (
          <section className="ct-card">
            <h2>Rincian pengeluaran</h2>
            <table className="sh-table">
              <thead><tr><th>Jam</th><th>Jenis</th><th>Keterangan</th><th>Nominal</th></tr></thead>
              <tbody>
                {expenses.map((expense) => (
                  <tr key={expense.id}>
                    <td>{time(expense.createdAt)}</td>
                    <td>{categoryLabel[expense.category] ?? expense.category}</td>
                    <td>{expense.note}</td>
                    <td>{currency.format(expense.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}

        <form className="ct-card sf-form" onSubmit={(event) => void submit(event)}>
          <h2>Pencocokan uang tunai</h2>
          <dl className="sf-rows">
            <div><dt>Total modal</dt><dd>{currency.format(fundTotal)}</dd></div>
            <div><dt>+ Penjualan tunai</dt><dd>{currency.format(shift.totals.cash)}</dd></div>
            <div><dt>− Pengeluaran</dt><dd>{currency.format(spentTotal)}</dd></div>
            <div className="total"><dt>Uang seharusnya di laci</dt><dd>{currency.format(expected)}</dd></div>
          </dl>
          {canClose ? (
            <>
              <MoneyField label="Hitung uang tunai di laci (Rp)" value={counted} onChange={setCounted} />
              {hasCount && (
                <p className={`sf-diff ${difference === 0 ? 'ok' : 'bad'}`}>
                  {difference === 0
                    ? 'Uang pas, tidak ada selisih.'
                    : `${difference > 0 ? 'Lebih' : 'Kurang'} ${currency.format(Math.abs(difference))}`}
                </p>
              )}
              {hasCount && difference !== 0 && (
                <label className="sf-field">
                  <span>Catatan penyebab selisih (wajib)</span>
                  <input value={note} onChange={(event) => setNote(event.target.value)} maxLength={200} />
                </label>
              )}
              {error && <p className="rc-warning" role="alert">{error}</p>}
              <button
                type="submit"
                className="sf-primary"
                disabled={busy || !hasCount || (difference !== 0 && note.trim().length < 3)}
              >
                {busy ? 'Menutup shift...' : 'Closing Shift'}
              </button>
            </>
          ) : (
            <p className="sf-note">Closing hanya dapat dilakukan oleh {holderName} atau owner/supervisor.</p>
          )}
        </form>
      </div>
    )
  }

  return (
    <div className="sf-page">
      {body}
      <ShiftHistory uid={uid} canSeeAll={canSeeAll} />
    </div>
  )
}
