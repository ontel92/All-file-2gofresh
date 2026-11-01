import { FieldValue, getFirestore } from 'firebase-admin/firestore'
import { logger } from 'firebase-functions'
import { HttpsError, onCall } from 'firebase-functions/v2/https'
import { google } from 'googleapis'
import { input, managers, obj, requireStaff } from './shopee'

const kulakOptions = {
  region: 'asia-southeast2',
  memory: '512MiB',
  maxInstances: 3,
  serviceAccount: 'catalog-sync-runtime@gofresh-3f2f3.iam.gserviceaccount.com',
  timeoutSeconds: 60,
} as const

const masterSpreadsheetId = '1Z3GxcqyB2DxGmfJcMuWvjDFKRRv7jceAlHPvfQ_zHR8'
const masterSheet = "'Master Data 2gofresh'"

function sheetsClient() {
  return google.sheets({ version: 'v4', auth: new google.auth.GoogleAuth({ scopes: ['https://www.googleapis.com/auth/spreadsheets'] }) })
}

const num = (value: unknown) => {
  const parsed = typeof value === 'number' ? value : Number(String(value ?? '').replace(/[^\d.-]/g, ''))
  return Number.isFinite(parsed) ? parsed : 0
}

export const kulakMaster = onCall(kulakOptions, async (request) => {
  await requireStaff(request, ['owner', 'supervisor', 'cashier'])
  const result = await sheetsClient().spreadsheets.values.get({
    spreadsheetId: masterSpreadsheetId,
    range: `${masterSheet}!A:H`,
    valueRenderOption: 'UNFORMATTED_VALUE',
  })
  const products = (result.data.values ?? []).slice(1)
    .map((row) => ({
      sku: String(row[1] ?? '').trim(),
      name: String(row[3] ?? '').trim(),
      unit: String(row[4] ?? '').trim().toUpperCase(),
      hpp: num(row[5]),
      effectiveHpp: num(row[7]),
    }))
    .filter((product) => product.sku && product.name)
  return { products }
})

export const kulakApplyHpp = onCall(kulakOptions, async (request) => {
  await requireStaff(request, managers)
  const data = input(request)
  const items = Array.isArray(data.items) ? data.items.map(obj) : []
  if (items.length < 1 || items.length > 200) throw new HttpsError('invalid-argument', 'Pilih 1–200 produk untuk diupdate.')
  const wanted = new Map<string, number>()
  for (const item of items) {
    const sku = String(item.sku ?? '').trim().toUpperCase()
    const hpp = Math.round(Number(item.hpp))
    if (!sku || !Number.isFinite(hpp) || hpp < 1 || hpp > 10_000_000) throw new HttpsError('invalid-argument', `Data HPP untuk ${sku || 'produk'} tidak valid.`)
    if (wanted.has(sku)) throw new HttpsError('invalid-argument', `SKU ${sku} dipilih lebih dari sekali.`)
    wanted.set(sku, hpp)
  }

  const sheets = sheetsClient()
  const values = await sheets.spreadsheets.values.get({
    spreadsheetId: masterSpreadsheetId,
    range: `${masterSheet}!A:H`,
    valueRenderOption: 'UNFORMATTED_VALUE',
  })
  const rowBySku = new Map<string, { row: number; count: number }>()
  ;(values.data.values ?? []).forEach((row, index) => {
    const sku = String(row[1] ?? '').trim().toUpperCase()
    if (index === 0 || !wanted.has(sku)) return
    const known = rowBySku.get(sku)
    rowBySku.set(sku, { row: index + 1, count: (known?.count ?? 0) + 1 })
  })
  for (const sku of wanted.keys()) {
    const found = rowBySku.get(sku)
    if (!found) throw new HttpsError('not-found', `SKU ${sku} tidak ditemukan di master.`)
    if (found.count > 1) throw new HttpsError('failed-precondition', `SKU ${sku} muncul lebih dari sekali di master.`)
  }

  const formulaRead = await sheets.spreadsheets.values.batchGet({
    spreadsheetId: masterSpreadsheetId,
    ranges: [...rowBySku.values()].map(({ row }) => `${masterSheet}!F${row}:H${row}`),
    valueRenderOption: 'FORMULA',
  })
  const updates: { range: string; values: (string | number)[][] }[] = []
  const log: Record<string, unknown>[] = []
  const entries = [...rowBySku.entries()]
  entries.forEach(([sku, { row }], index) => {
    const hpp = wanted.get(sku)!
    const current = formulaRead.data.valueRanges?.[index]?.values?.[0] ?? []
    const oldHpp = num(current[0])
    const effective = current[2]
    const effectiveIsFormula = typeof effective === 'string' && effective.startsWith('=')
    updates.push({ range: `${masterSheet}!F${row}`, values: [[hpp]] })
    let newEffective: number | null = null
    if (!effectiveIsFormula) {
      const ratio = oldHpp > 0 && num(effective) > 0 ? num(effective) / oldHpp : 1
      newEffective = Math.round(hpp * ratio)
      updates.push({ range: `${masterSheet}!H${row}`, values: [[newEffective]] })
    }
    log.push({ sku, row, oldHpp, newHpp: hpp, effectiveFormula: effectiveIsFormula, newEffective })
  })

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: masterSpreadsheetId,
    requestBody: { valueInputOption: 'USER_ENTERED', data: updates },
  })
  const staff = (await getFirestore().collection('staff').doc(request.auth!.uid).get()).data()
  await getFirestore().collection('masterHppLog').add({
    items: log,
    actorUid: request.auth!.uid,
    actorName: String(staff?.displayName ?? ''),
    createdAt: FieldValue.serverTimestamp(),
  })
  logger.info('Master HPP updated from kulak.', { count: log.length, actorUid: request.auth!.uid })
  return { updated: log.length }
})
