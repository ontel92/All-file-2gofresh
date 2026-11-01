import { FieldValue, getFirestore } from 'firebase-admin/firestore'
import { logger } from 'firebase-functions'
import { HttpsError, onCall } from 'firebase-functions/v2/https'
import { input, managers, obj, requireStaff, whole } from './shopee'

const ledgerOptions = {
  region: 'asia-southeast2',
  memory: '512MiB',
  maxInstances: 3,
  serviceAccount: 'catalog-sync-runtime@gofresh-3f2f3.iam.gserviceaccount.com',
  timeoutSeconds: 60,
} as const

const incomeCategories = ['tiktok', 'freshstock', 'shopee', 'lainnya'] as const
const expenseCategories = ['operasional', 'bayar-sales', 'nempil', 'kulakan', 'lainnya'] as const
const cashExpenseMap: Record<string, string> = { ops: 'operasional', sales: 'bayar-sales', nempil: 'nempil' }
const maxRangeDays = 93

type AutoRow = { date: string; kind: 'income' | 'expense'; source: string; label: string; amount: number; count: number }

function dateKey(value: unknown, label: string) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || Number.isNaN(Date.parse(`${text}T00:00:00Z`))) {
    throw new HttpsError('invalid-argument', `${label} harus berformat YYYY-MM-DD.`)
  }
  return text
}

const utcDay = (millis: number) => new Date(millis).toISOString().slice(0, 10)

export const ledgerAdd = onCall(ledgerOptions, async (request) => {
  await requireStaff(request, managers)
  const data = input(request)
  const type = data.type
  if (type !== 'income' && type !== 'expense') throw new HttpsError('invalid-argument', 'Jenis catatan tidak valid.')
  const allowed: readonly string[] = type === 'income' ? incomeCategories : expenseCategories
  const category = typeof data.category === 'string' ? data.category : ''
  if (!allowed.includes(category)) throw new HttpsError('invalid-argument', 'Kategori tidak valid.')
  const requestId = typeof data.requestId === 'string' ? data.requestId : ''
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(requestId)) throw new HttpsError('invalid-argument', 'ID permintaan tidak valid.')
  const amount = whole(data.amount, 'Nominal')
  if (amount < 1 || amount > 5_000_000_000) throw new HttpsError('invalid-argument', 'Nominal tidak valid.')
  const note = typeof data.note === 'string' ? data.note.trim() : ''
  if (note.length < 3 || note.length > 200) throw new HttpsError('invalid-argument', 'Keterangan wajib diisi (3–200 karakter).')
  const date = dateKey(data.date, 'Tanggal')
  const staff = (await getFirestore().collection('staff').doc(request.auth!.uid).get()).data()
  const ref = getFirestore().collection('ledgerEntries').doc(requestId)
  await getFirestore().runTransaction(async (transaction) => {
    if ((await transaction.get(ref)).exists) return
    transaction.create(ref, {
      type,
      category,
      amount,
      note,
      date,
      removed: false,
      createdBy: request.auth!.uid,
      createdByName: String(staff?.displayName ?? ''),
      createdAt: FieldValue.serverTimestamp(),
    })
  })
  return { ok: true }
})

export const ledgerRemove = onCall(ledgerOptions, async (request) => {
  await requireStaff(request, managers)
  const id = typeof input(request).id === 'string' ? (input(request).id as string) : ''
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(id)) throw new HttpsError('invalid-argument', 'Catatan tidak valid.')
  const ref = getFirestore().collection('ledgerEntries').doc(id)
  if (!(await ref.get()).exists) throw new HttpsError('not-found', 'Catatan tidak ditemukan.')
  await ref.update({ removed: true, removedBy: request.auth!.uid, removedAt: FieldValue.serverTimestamp() })
  return { ok: true }
})

export const ledgerSummary = onCall(ledgerOptions, async (request) => {
  await requireStaff(request, managers)
  const data = input(request)
  const from = dateKey(data.from, 'Tanggal awal')
  const to = dateKey(data.to, 'Tanggal akhir')
  const spanDays = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000
  if (spanDays < 0 || spanDays > maxRangeDays) {
    throw new HttpsError('invalid-argument', `Rentang tanggal maksimal ${maxRangeDays} hari.`)
  }
  const fromMs = Date.parse(`${from}T00:00:00Z`)
  const toMs = Date.parse(`${to}T00:00:00Z`) + 86_400_000
  const database = getFirestore()
  const warnings: string[] = []

  const entriesSnapshot = await database.collection('ledgerEntries')
    .where('date', '>=', from)
    .where('date', '<=', to)
    .limit(3000)
    .get()
  const entries = entriesSnapshot.docs
    .filter((document) => document.get('removed') !== true)
    .map((document) => ({
      id: document.id,
      type: document.get('type') as string,
      category: document.get('category') as string,
      amount: Number(document.get('amount') ?? 0),
      note: String(document.get('note') ?? ''),
      date: String(document.get('date') ?? ''),
      createdByName: String(document.get('createdByName') ?? ''),
    }))

  const auto: AutoRow[] = []
  const addTotals = (kind: AutoRow['kind'], source: string, label: string, totals: Map<string, { amount: number; count: number }>) => {
    for (const [date, value] of totals) auto.push({ date, kind, source, label, amount: value.amount, count: value.count })
  }
  const bucket = (totals: Map<string, { amount: number; count: number }>, date: string, amount: number) => {
    const current = totals.get(date) ?? { amount: 0, count: 0 }
    totals.set(date, { amount: current.amount + amount, count: current.count + 1 })
  }

  const salesSnapshot = await database.collection('sales')
    .where('createdAtIso', '>=', new Date(fromMs).toISOString())
    .where('createdAtIso', '<', new Date(toMs).toISOString())
    .limit(6000)
    .get()
  if (salesSnapshot.size === 6000) warnings.push('Penjualan kasir melebihi 6.000 transaksi; persempit rentang tanggal.')
  const cashierTotals = new Map<string, { amount: number; count: number }>()
  for (const document of salesSnapshot.docs) {
    if (document.get('voided') === true) continue
    const iso = String(document.get('createdAtIso') ?? '')
    bucket(cashierTotals, iso.slice(0, 10), Number(document.get('total') ?? 0))
  }
  addTotals('income', 'kasir', 'Penjualan kasir', cashierTotals)

  for (const [store, collectionName, label] of [
    ['2gofresh', 'shopeeMarginReleased', 'Shopee 2goFresh (dana cair)'],
    ['freshstock', 'shopeeMarginReleasedFreshstock', 'Shopee Freshstock (dana cair)'],
  ] as const) {
    const released = await database.collection(collectionName)
      .where('releasedAt', '>=', fromMs)
      .where('releasedAt', '<', toMs)
      .limit(5000)
      .get()
    if (released.size === 5000) warnings.push(`${label} melebihi 5.000 order; persempit rentang tanggal.`)
    const totals = new Map<string, { amount: number; count: number }>()
    for (const document of released.docs) {
      const payout = Number(obj(document.get('escrow')).payout_amount)
      if (Number.isFinite(payout)) bucket(totals, utcDay(Number(document.get('releasedAt'))), payout)
    }
    addTotals('income', store, label, totals)
  }

  try {
    const cashExpenses = await database.collectionGroup('expenses')
      .where('createdAt', '>=', new Date(fromMs))
      .where('createdAt', '<', new Date(toMs))
      .limit(5000)
      .get()
    const byCategory = new Map<string, Map<string, { amount: number; count: number }>>()
    for (const document of cashExpenses.docs) {
      if (document.get('removed') === true) continue
      const category = cashExpenseMap[String(document.get('category'))] ?? 'lainnya'
      const created = (document.get('createdAt') as { toMillis?: () => number } | undefined)?.toMillis?.() ?? 0
      const totals = byCategory.get(category) ?? new Map()
      bucket(totals, utcDay(created), Number(document.get('amount') ?? 0))
      byCategory.set(category, totals)
    }
    for (const [category, totals] of byCategory) addTotals('expense', `kas-${category}`, `Kas shift · ${category}`, totals)
  } catch (error) {
    logger.error('Ledger cash expense query failed.', error)
    warnings.push('Pengeluaran kas shift belum dapat dibaca (indeks Firestore mungkin belum aktif).')
  }

  return { from, to, entries, auto, warnings, generatedAt: Date.now() }
})
