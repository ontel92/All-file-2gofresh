import {
  createHash,
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from 'node:crypto'
import { initializeApp } from 'firebase-admin/app'
import { getAuth } from 'firebase-admin/auth'
import { FieldValue, getFirestore } from 'firebase-admin/firestore'
import type { Transaction } from 'firebase-admin/firestore'
import { logger } from 'firebase-functions'
import { HttpsError, onCall } from 'firebase-functions/v2/https'
import { onSchedule } from 'firebase-functions/v2/scheduler'
import { google } from 'googleapis'
import { buildShiftReport, reportSmtpPass, reportSmtpUser, sendShiftReportEmail } from './shiftReport'

export * from './webstore'
export * from './shopee'

const shiftCallableOptions = {
  region: 'asia-southeast2',
  memory: '256MiB',
  maxInstances: 3,
  serviceAccount: 'catalog-sync-runtime@gofresh-3f2f3.iam.gserviceaccount.com',
  timeoutSeconds: 60,
} as const

const spreadsheetId = '1Z3GxcqyB2DxGmfJcMuWvjDFKRRv7jceAlHPvfQ_zHR8'
const collectionName = 'catalogProducts'
const sheetRange = 'A:W'
const spreadsheetScope = 'https://www.googleapis.com/auth/spreadsheets.readonly'
const batchLimit = 450
const cashierRoster = [
  { loginId: 'dinda', displayName: 'Dinda' },
  { loginId: 'nopal', displayName: 'Nopal' },
  { loginId: 'keple', displayName: 'Keple' },
  { loginId: 'selo', displayName: 'Selo' },
  { loginId: 'lutfi', displayName: 'Lutfi' },
]
const minimumPasswordLength = 12
const maximumPasswordLength = 128
const maxLoginFailures = 5
const loginLockMilliseconds = 15 * 60 * 1000
const credentialsCollection = 'staffCredentials'
const loginAttemptsCollection = 'staffLoginAttempts'

type StaffRole = 'owner' | 'supervisor' | 'cashier'

type StaffAccount = {
  role: StaffRole
  active: boolean
  displayName?: string
  loginId?: string
}

type CatalogProduct = {
  sku: string
  category: string
  name: string
  unit: string
  minQty: number
  retailPrice: number
  imageUrl: string
}

initializeApp()

function normalizedLoginId(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }

  const normalized = value.trim().toLowerCase()
  return /^[a-z0-9_-]{3,32}$/.test(normalized) ? normalized : null
}

function passwordValue(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= minimumPasswordLength &&
    value.length <= maximumPasswordLength
  )
}

function derivePasswordHash(password: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, 64, (error, derivedKey) => {
      if (error) {
        reject(error)
      } else {
        resolve(derivedKey)
      }
    })
  })
}

async function hashPassword(password: string): Promise<{ salt: string; hash: string }> {
  const salt = randomBytes(16).toString('hex')
  const hash = await derivePasswordHash(password, salt)
  return { salt, hash: hash.toString('hex') }
}

async function verifyPassword(password: string, salt: string, expectedHash: string): Promise<boolean> {
  if (!/^[a-f0-9]{32}$/.test(salt) || !/^[a-f0-9]{128}$/.test(expectedHash)) {
    return false
  }

  const actualHash = await derivePasswordHash(password, salt)
  return timingSafeEqual(actualHash, Buffer.from(expectedHash, 'hex'))
}

function temporaryPassword(): string {
  return `Fresh-${randomBytes(12).toString('base64url')}`
}

async function requireStaffRole(
  uid: string,
  allowedRoles: StaffRole[],
): Promise<StaffAccount> {
  const snapshot = await getFirestore().collection('staff').doc(uid).get()
  const staff = snapshot.data() as StaffAccount | undefined
  if (staff?.active !== true || !allowedRoles.includes(staff.role)) {
    throw new HttpsError('permission-denied', 'Akses ini tidak tersedia untuk akun Anda.')
  }
  return staff
}

function callableData(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new HttpsError('invalid-argument', 'Data permintaan tidak valid.')
  }
  return value as Record<string, unknown>
}

function textCell(value: unknown, field: string, rowNumber: number): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Missing or invalid ${field} in spreadsheet row ${rowNumber}.`)
  }
  return value.trim()
}

function quantityCell(value: unknown, rowNumber: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }

  if (typeof value === 'string') {
    const normalized = value.trim().replace(',', '.')
    const parsed = Number(normalized)
    if (Number.isFinite(parsed)) {
      return parsed
    }
  }

  throw new Error(`Invalid MIN_QTY in spreadsheet row ${rowNumber}.`)
}

function priceCell(value: unknown, rowNumber: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }

  if (typeof value === 'string') {
    const digits = value.trim().replace(/\D/g, '')
    const parsed = Number(digits)
    if (digits !== '' && Number.isFinite(parsed)) {
      return parsed
    }
  }

  throw new Error(`Invalid HARGA RETAIL in spreadsheet row ${rowNumber}.`)
}

function imageCell(value: unknown): string {
  const url = typeof value === 'string' ? value.trim() : ''
  return /^https:\/\/[^\s]{8,1500}$/.test(url) ? url : ''
}

function parseCatalog(values: unknown[][]): CatalogProduct[] {
  if (values.length < 2) {
    throw new Error('The spreadsheet has no product rows; refusing to clear the catalog.')
  }

  const headers = values[0].map((value) =>
    String(value ?? '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]/g, ''),
  )
  const expectedHeaders = new Map([
    [0, 'minqty'],
    [1, 'sku'],
    [2, 'kategori'],
    [3, 'namaproduk'],
    [4, 'satuan'],
    [10, 'hargaretail'],
  ])

  for (const [index, expected] of expectedHeaders) {
    if (headers[index] !== expected) {
      throw new Error(`Unexpected spreadsheet header in column ${index + 1}; expected ${expected}.`)
    }
  }

  const seenSkus = new Map<string, number>()
  const duplicateSkus: string[] = []
  const products: CatalogProduct[] = []

  values.slice(1).forEach((row, index) => {
    const rowNumber = index + 2
    if (row.every((value) => value === '' || value === null || value === undefined)) {
      return
    }

    const sku = textCell(row[1], 'SKU', rowNumber)
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(sku)) {
      throw new Error(`Invalid SKU format in spreadsheet row ${rowNumber}.`)
    }

    const documentId = sku.toLowerCase()
    const firstRow = seenSkus.get(documentId)
    if (firstRow !== undefined) {
      duplicateSkus.push(`${sku} in rows ${firstRow} and ${rowNumber}`)
    } else {
      seenSkus.set(documentId, rowNumber)
    }

    const minQty = quantityCell(row[0], rowNumber)
    const retailPrice = priceCell(row[10], rowNumber)
    if (minQty <= 0 || retailPrice < 0) {
      throw new Error(`MIN_QTY and HARGA RETAIL must be valid in spreadsheet row ${rowNumber}.`)
    }

    products.push({
      sku,
      category: textCell(row[2], 'KATEGORI', rowNumber),
      name: textCell(row[3], 'NAMA PRODUK', rowNumber),
      unit: textCell(row[4], 'SATUAN', rowNumber),
      minQty,
      retailPrice,
      imageUrl: imageCell(row[22]),
    })
  })

  if (duplicateSkus.length > 0) {
    throw new Error(`Duplicate SKUs found: ${duplicateSkus.join('; ')}.`)
  }

  if (products.length === 0) {
    throw new Error('No valid products were found; refusing to clear the catalog.')
  }

  return products
}

function hasProductChanged(
  current: FirebaseFirestore.DocumentData | undefined,
  next: CatalogProduct,
): boolean {
  return (
    current?.sku !== next.sku ||
    current?.category !== next.category ||
    current?.name !== next.name ||
    current?.unit !== next.unit ||
    current?.minQty !== next.minQty ||
    current?.retailPrice !== next.retailPrice ||
    (current?.imageUrl ?? '') !== next.imageUrl
  )
}

// Harga B2B (kolom L) hanya untuk staf; baris tanpa harga valid dilewati agar sinkronisasi tidak gagal.
function parseB2bPrices(values: unknown[][]): Map<string, { sku: string; b2bPrice: number }> {
  const prices = new Map<string, { sku: string; b2bPrice: number }>()
  for (const row of values.slice(1)) {
    const sku = typeof row[1] === 'string' ? row[1].trim() : ''
    if (sku === '') continue
    const cell = row[11]
    const price =
      typeof cell === 'number'
        ? cell
        : typeof cell === 'string' && cell.replace(/\D/g, '') !== ''
          ? Number(cell.replace(/\D/g, ''))
          : NaN
    if (Number.isFinite(price) && price > 0) {
      prices.set(sku.toLowerCase(), { sku, b2bPrice: Math.round(price) })
    }
  }
  return prices
}

export const syncCatalogFromSheets = onSchedule(
  {
    schedule: 'every 5 minutes',
    timeZone: 'Asia/Jakarta',
    region: 'asia-southeast2',
    memory: '256MiB',
    timeoutSeconds: 300,
    maxInstances: 1,
    concurrency: 1,
    serviceAccount: 'catalog-sync-runtime@gofresh-3f2f3.iam.gserviceaccount.com',
  },
  async () => {
    const auth = new google.auth.GoogleAuth({ scopes: [spreadsheetScope] })
    const sheets = google.sheets({ version: 'v4', auth })
    const result = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: sheetRange,
      valueRenderOption: 'UNFORMATTED_VALUE',
    })

    const sheetValues = result.data.values ?? []
    const products = parseCatalog(sheetValues)
    const b2bPrices = parseB2bPrices(sheetValues)
    const database = getFirestore()
    const collection = database.collection(collectionName)
    const syncStateRef = database.collection('catalogSyncState').doc('sheets')
    const contentHash = createHash('sha256')
      .update(JSON.stringify(products))
      .update(JSON.stringify([...b2bPrices.values()]))
      .digest('hex')
    const syncStateSnapshot = await syncStateRef.get()

    if (syncStateSnapshot.get('contentHash') === contentHash) {
      logger.info('Catalog unchanged; skipping Firestore reads and writes.', {
        productCount: products.length,
      })
      return
    }

    const existing = await collection.get()
    const existingById = new Map(
      existing.docs.map((document) => [document.id, document.data()]),
    )
    const desiredById = new Map(
      products.map((product) => [product.sku.toLowerCase(), product]),
    )
    const updates = products.filter((product) =>
      hasProductChanged(existingById.get(product.sku.toLowerCase()), product),
    )
    const removals = existing.docs.filter((document) => !desiredById.has(document.id))

    for (let index = 0; index < updates.length; index += batchLimit) {
      const batch = database.batch()
      updates.slice(index, index + batchLimit).forEach((product) => {
        batch.set(collection.doc(product.sku.toLowerCase()), {
          ...product,
          updatedAt: FieldValue.serverTimestamp(),
        })
      })
      await batch.commit()
    }

    for (let index = 0; index < removals.length; index += batchLimit) {
      const batch = database.batch()
      removals.slice(index, index + batchLimit).forEach((document) => {
        batch.delete(document.ref)
      })
      await batch.commit()
    }

    const b2bCollection = database.collection('b2bPrices')
    const existingB2b = await b2bCollection.get()
    const b2bWrites = [...b2bPrices.entries()]
    for (let index = 0; index < b2bWrites.length; index += batchLimit) {
      const batch = database.batch()
      b2bWrites.slice(index, index + batchLimit).forEach(([id, price]) => {
        batch.set(b2bCollection.doc(id), { ...price, updatedAt: FieldValue.serverTimestamp() })
      })
      await batch.commit()
    }
    const staleB2b = existingB2b.docs.filter((document) => !b2bPrices.has(document.id))
    for (let index = 0; index < staleB2b.length; index += batchLimit) {
      const batch = database.batch()
      staleB2b.slice(index, index + batchLimit).forEach((document) => batch.delete(document.ref))
      await batch.commit()
    }

    await syncStateRef.set({
      contentHash,
      productCount: products.length,
      lastSyncedAt: FieldValue.serverTimestamp(),
    })

    logger.info('Catalog synchronization completed.', {
      productCount: products.length,
      changedCount: updates.length,
      removedCount: removals.length,
    })
  },
)

export const initializeCashierAccounts = onCall(
  {
    region: 'asia-southeast2',
    memory: '256MiB',
    maxInstances: 3,
    serviceAccount: 'catalog-sync-runtime@gofresh-3f2f3.iam.gserviceaccount.com',
  },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'Silakan login sebagai owner.')
    }
    await requireStaffRole(request.auth.uid, ['owner'])

    const database = getFirestore()
    const createdAccounts: { loginId: string; displayName: string; temporaryPassword: string }[] = []
    for (const account of cashierRoster) {
      const password = temporaryPassword()
      const { salt, hash } = await hashPassword(password)
      const uid = `staff-${account.loginId}-${randomBytes(8).toString('hex')}`
      const credentialRef = database.collection(credentialsCollection).doc(account.loginId)
      const staffRef = database.collection('staff').doc(uid)

      const created = await database.runTransaction(async (transaction) => {
        const existing = await transaction.get(credentialRef)
        if (existing.exists) {
          return false
        }

        transaction.create(credentialRef, {
          ...account,
          uid,
          salt,
          passwordHash: hash,
          forcePasswordChange: true,
          createdAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        })
        transaction.create(staffRef, {
          ...account,
          role: 'cashier',
          active: true,
          createdAt: FieldValue.serverTimestamp(),
        })
        return true
      })

      if (created) {
        createdAccounts.push({
          ...account,
          temporaryPassword: password,
        })
      }
    }

    logger.info('Cashier login accounts initialized.', {
      actorUid: request.auth.uid,
      createdCount: createdAccounts.length,
    })
    return { accounts: createdAccounts }
  },
)

export const loginWithStaffId = onCall(
  {
    region: 'asia-southeast2',
    memory: '256MiB',
    maxInstances: 5,
    serviceAccount: 'catalog-sync-runtime@gofresh-3f2f3.iam.gserviceaccount.com',
  },
  async (request) => {
    const input = callableData(request.data)
    const loginId = normalizedLoginId(input.loginId)
    const password = input.password
    if (loginId === null || typeof password !== 'string' || password.length > maximumPasswordLength) {
      throw new HttpsError('invalid-argument', 'ID kasir atau password tidak valid.')
    }

    const database = getFirestore()
    const attemptsRef = database.collection(loginAttemptsCollection).doc(loginId)
    const now = Date.now()
    const locked = await database.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(attemptsRef)
      const blockedUntil = snapshot.get('blockedUntil') ?? 0
      return typeof blockedUntil === 'number' && blockedUntil > now
    })
    if (locked) {
      throw new HttpsError(
        'resource-exhausted',
        'Terlalu banyak percobaan. Minta supervisor membantu setelah 15 menit.',
      )
    }

    const credentialRef = database.collection(credentialsCollection).doc(loginId)
    const credentialSnapshot = await credentialRef.get()
    const credential = credentialSnapshot.data()
    const salt = typeof credential?.salt === 'string' ? credential.salt : '0'.repeat(32)
    const expectedHash =
      typeof credential?.passwordHash === 'string'
        ? credential.passwordHash
        : '0'.repeat(128)
    const passwordMatches = await verifyPassword(password, salt, expectedHash)
    const uid = typeof credential?.uid === 'string' ? credential.uid : ''
    const staffSnapshot = uid === '' ? null : await database.collection('staff').doc(uid).get()
    const staff = staffSnapshot?.data() as StaffAccount | undefined

    if (
      !credentialSnapshot.exists ||
      !passwordMatches ||
      staff?.active !== true ||
      staff.role !== 'cashier' ||
      credential?.forcePasswordChange !== true && credential?.forcePasswordChange !== false
    ) {
      await database.runTransaction(async (transaction) => {
        const snapshot = await transaction.get(attemptsRef)
        const previousCount =
          typeof snapshot.get('failures') === 'number' &&
          typeof snapshot.get('blockedUntil') === 'number' &&
          snapshot.get('blockedUntil') <= now
            ? snapshot.get('failures') as number
            : 0
        const failures = previousCount + 1
        transaction.set(attemptsRef, {
          failures,
          blockedUntil: failures >= maxLoginFailures ? now + loginLockMilliseconds : 0,
          updatedAt: FieldValue.serverTimestamp(),
        })
      })
      throw new HttpsError('unauthenticated', 'ID kasir atau password salah.')
    }

    await attemptsRef.delete()
    const customToken = await getAuth().createCustomToken(uid, {
      forcePasswordChange: credential.forcePasswordChange === true,
    })
    return {
      customToken,
      forcePasswordChange: credential.forcePasswordChange === true,
    }
  },
)

export const getStaffSession = onCall(
  {
    region: 'asia-southeast2',
    memory: '256MiB',
    maxInstances: 5,
    serviceAccount: 'catalog-sync-runtime@gofresh-3f2f3.iam.gserviceaccount.com',
  },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'Silakan login ke POS terlebih dahulu.')
    }
    const staff = await requireStaffRole(request.auth.uid, ['owner', 'supervisor', 'cashier'])
    if (staff.role !== 'cashier' || typeof staff.loginId !== 'string') {
      return {
        displayName: staff.displayName ?? request.auth.token.email ?? 'Staf',
        forcePasswordChange: false,
      }
    }

    const credential = await getFirestore()
      .collection(credentialsCollection)
      .doc(staff.loginId)
      .get()
    if (credential.get('uid') !== request.auth.uid) {
      throw new HttpsError('permission-denied', 'Akun kasir sudah direset. Silakan login kembali.')
    }

    return {
      displayName: staff.displayName ?? staff.loginId,
      forcePasswordChange: credential.get('forcePasswordChange') === true,
    }
  },
)

export const changeStaffPassword = onCall(
  {
    region: 'asia-southeast2',
    memory: '256MiB',
    maxInstances: 3,
    serviceAccount: 'catalog-sync-runtime@gofresh-3f2f3.iam.gserviceaccount.com',
  },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'Silakan login ke POS terlebih dahulu.')
    }
    const staff = await requireStaffRole(request.auth.uid, ['cashier'])
    const input = callableData(request.data)
    if (!passwordValue(input.password)) {
      throw new HttpsError(
        'invalid-argument',
        `Password baru harus terdiri dari ${minimumPasswordLength}–${maximumPasswordLength} karakter.`,
      )
    }
    if (typeof staff.loginId !== 'string') {
      throw new HttpsError('failed-precondition', 'ID kasir tidak tersedia.')
    }

    const database = getFirestore()
    const credentialRef = database.collection(credentialsCollection).doc(staff.loginId)
    const credentialSnapshot = await credentialRef.get()
    if (credentialSnapshot.get('uid') !== request.auth.uid) {
      throw new HttpsError('permission-denied', 'Akun kasir sudah tidak aktif.')
    }
    const { salt, hash } = await hashPassword(input.password)
    await credentialRef.update({
      salt,
      passwordHash: hash,
      forcePasswordChange: false,
      updatedAt: FieldValue.serverTimestamp(),
    })
    const customToken = await getAuth().createCustomToken(request.auth.uid, {
      forcePasswordChange: false,
    })
    return { customToken }
  },
)

export const resetCashierPassword = onCall(
  {
    region: 'asia-southeast2',
    memory: '256MiB',
    maxInstances: 3,
    serviceAccount: 'catalog-sync-runtime@gofresh-3f2f3.iam.gserviceaccount.com',
  },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'Silakan login ke POS terlebih dahulu.')
    }
    await requireStaffRole(request.auth.uid, ['owner', 'supervisor'])
    const input = callableData(request.data)
    const loginId = normalizedLoginId(input.loginId)
    if (loginId === null) {
      throw new HttpsError('invalid-argument', 'ID kasir tidak valid.')
    }

    const database = getFirestore()
    const credentialRef = database.collection(credentialsCollection).doc(loginId)
    const credentialSnapshot = await credentialRef.get()
    const oldUid = credentialSnapshot.get('uid')
    if (!credentialSnapshot.exists || typeof oldUid !== 'string') {
      throw new HttpsError('not-found', 'Akun kasir tidak ditemukan.')
    }
    const oldStaffRef = database.collection('staff').doc(oldUid)
    const oldStaffSnapshot = await oldStaffRef.get()
    const oldStaff = oldStaffSnapshot.data() as StaffAccount | undefined
    if (oldStaff?.role !== 'cashier') {
      throw new HttpsError('permission-denied', 'Akun ini tidak dapat direset sebagai kasir.')
    }

    const newPassword = temporaryPassword()
    const { salt, hash } = await hashPassword(newPassword)
    const newUid = `staff-${loginId}-${randomBytes(8).toString('hex')}`
    const newStaffRef = database.collection('staff').doc(newUid)
    await database.runTransaction(async (transaction) => {
      const currentCredential = await transaction.get(credentialRef)
      const currentStaff = await transaction.get(oldStaffRef)
      if (
        currentCredential.get('uid') !== oldUid ||
        currentStaff.get('role') !== 'cashier'
      ) {
        throw new HttpsError('aborted', 'Akun berubah saat reset. Silakan coba lagi.')
      }

      transaction.create(newStaffRef, {
        loginId,
        displayName: oldStaff.displayName ?? credentialSnapshot.get('displayName') ?? loginId,
        role: 'cashier',
        active: oldStaff.active === true,
        createdAt: oldStaffSnapshot.get('createdAt') ?? FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      })
      transaction.delete(oldStaffRef)
      transaction.update(credentialRef, {
        uid: newUid,
        salt,
        passwordHash: hash,
        forcePasswordChange: true,
        updatedAt: FieldValue.serverTimestamp(),
      })
    })
    await database.collection(loginAttemptsCollection).doc(loginId).delete()

    logger.info('Cashier password reset.', {
      loginId,
      actorUid: request.auth.uid,
    })
    return {
      loginId,
      displayName: oldStaff.displayName ?? credentialSnapshot.get('displayName') ?? loginId,
      temporaryPassword: newPassword,
    }
  },
)

export const setOpeningStock = onCall(
  {
    region: 'asia-southeast2',
    memory: '256MiB',
    maxInstances: 3,
    serviceAccount: 'catalog-sync-runtime@gofresh-3f2f3.iam.gserviceaccount.com',
  },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'Silakan login ke POS terlebih dahulu.')
    }

    const actorUid = request.auth.uid
    const database = getFirestore()
    await requireStaffRole(actorUid, ['owner', 'supervisor'])
    if (request.auth.token.forcePasswordChange === true) {
      throw new HttpsError('failed-precondition', 'Ganti password sementara terlebih dahulu.')
    }

    const data: unknown = request.data
    if (typeof data !== 'object' || data === null || Array.isArray(data)) {
      throw new HttpsError('invalid-argument', 'Data stok tidak valid.')
    }

    const input = data as Record<string, unknown>
    const sku = input.sku
    const quantity = input.quantity
    const reason =
      typeof input.reason === 'string' && input.reason.trim() !== ''
        ? input.reason.trim()
        : 'Hitung stok fisik'

    if (
      typeof sku !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(sku) ||
      typeof quantity !== 'number' ||
      !Number.isFinite(quantity) ||
      quantity < 0 ||
      reason.length > 160
    ) {
      throw new HttpsError('invalid-argument', 'SKU, jumlah stok, atau catatan tidak valid.')
    }

    const productRef = database.collection(collectionName).doc(sku.toLowerCase())
    const productSnapshot = await productRef.get()
    const product = productSnapshot.data()
    if (
      !productSnapshot.exists ||
      typeof product?.sku !== 'string' ||
      typeof product.unit !== 'string'
    ) {
      throw new HttpsError('not-found', 'Produk tidak ditemukan di katalog.')
    }

    const unit = product.unit.trim().toUpperCase()
    if (unit !== 'KG' && !Number.isInteger(quantity)) {
      throw new HttpsError(
        'invalid-argument',
        `Jumlah stok untuk satuan ${unit} harus bilangan bulat.`,
      )
    }

    const inventoryRef = database.collection('inventory').doc(sku.toLowerCase())
    const movementRef = database.collection('stockMovements').doc()

    await database.runTransaction(async (transaction) => {
      const currentSnapshot = await transaction.get(inventoryRef)
      const currentQuantity = currentSnapshot.exists
        ? currentSnapshot.get('onHand')
        : 0
      if (typeof currentQuantity !== 'number' || !Number.isFinite(currentQuantity)) {
        throw new HttpsError('failed-precondition', 'Data stok saat ini tidak valid.')
      }

      transaction.set(inventoryRef, {
        sku: product.sku,
        onHand: quantity,
        unit,
        updatedAt: FieldValue.serverTimestamp(),
        updatedBy: actorUid,
      })
      transaction.create(movementRef, {
        sku: product.sku,
        unit,
        movementType: currentSnapshot.exists ? 'stock-count' : 'opening',
        previousOnHand: currentQuantity,
        newOnHand: quantity,
        quantityDelta: quantity - currentQuantity,
        reason,
        actorUid,
        createdAt: FieldValue.serverTimestamp(),
      })
    })

    logger.info('Stock count recorded.', {
      sku,
      unit,
      quantity,
      actorUid,
    })

    return { sku, unit, onHand: quantity }
  },
)

export const setOpeningStockBatch = onCall(
  {
    region: 'asia-southeast2',
    memory: '512MiB',
    maxInstances: 3,
    serviceAccount: 'catalog-sync-runtime@gofresh-3f2f3.iam.gserviceaccount.com',
    timeoutSeconds: 300,
  },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'Silakan login ke POS terlebih dahulu.')
    }
    await requireStaffRole(request.auth.uid, ['owner', 'supervisor'])
    if (request.auth.token.forcePasswordChange === true) {
      throw new HttpsError('failed-precondition', 'Ganti password sementara terlebih dahulu.')
    }

    const input = callableData(request.data)
    const rawItems = input.items
    const reason =
      typeof input.reason === 'string' && input.reason.trim() !== ''
        ? input.reason.trim()
        : 'Hitung stok massal'
    if (
      !Array.isArray(rawItems) ||
      rawItems.length === 0 ||
      rawItems.length > 200 ||
      reason.length > 160
    ) {
      throw new HttpsError(
        'invalid-argument',
        'Pilih 1–200 produk dan gunakan catatan maksimal 160 karakter.',
      )
    }

    const skuSet = new Set<string>()
    const items = rawItems.map((rawItem) => {
      const item = callableData(rawItem)
      const sku = item.sku
      const quantity = item.quantity
      if (
        typeof sku !== 'string' ||
        !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(sku) ||
        typeof quantity !== 'number' ||
        !Number.isFinite(quantity) ||
        quantity < 0
      ) {
        throw new HttpsError('invalid-argument', 'SKU atau jumlah stok tidak valid.')
      }
      const documentId = sku.toLowerCase()
      if (skuSet.has(documentId)) {
        throw new HttpsError('invalid-argument', `SKU ${sku} dikirim lebih dari satu kali.`)
      }
      skuSet.add(documentId)
      return { sku, documentId, quantity }
    })

    const database = getFirestore()
    const entries = items.map((item) => ({
      ...item,
      productRef: database.collection(collectionName).doc(item.documentId),
      inventoryRef: database.collection('inventory').doc(item.documentId),
      movementRef: database.collection('stockMovements').doc(),
    }))

    await database.runTransaction(async (transaction) => {
      const snapshots = await Promise.all(
        entries.map(async (entry) => {
          const [productSnapshot, currentSnapshot] = await Promise.all([
            transaction.get(entry.productRef),
            transaction.get(entry.inventoryRef),
          ])
          const product = productSnapshot.data()
          if (
            !productSnapshot.exists ||
            typeof product?.sku !== 'string' ||
            typeof product.unit !== 'string'
          ) {
            throw new HttpsError('not-found', `Produk ${entry.sku} tidak ditemukan di katalog.`)
          }

          const unit = product.unit.trim().toUpperCase()
          if (unit !== 'KG' && !Number.isInteger(entry.quantity)) {
            throw new HttpsError(
              'invalid-argument',
              `Jumlah stok ${entry.sku} (${unit}) harus bilangan bulat.`,
            )
          }
          const currentQuantity = currentSnapshot.exists
            ? currentSnapshot.get('onHand')
            : 0
          if (typeof currentQuantity !== 'number' || !Number.isFinite(currentQuantity)) {
            throw new HttpsError(
              'failed-precondition',
              `Data stok ${entry.sku} saat ini tidak valid.`,
            )
          }

          return { entry, product, unit, currentSnapshot, currentQuantity }
        }),
      )

      for (const { entry, product, unit, currentSnapshot, currentQuantity } of snapshots) {
        transaction.set(entry.inventoryRef, {
          sku: product.sku,
          onHand: entry.quantity,
          unit,
          updatedAt: FieldValue.serverTimestamp(),
          updatedBy: request.auth!.uid,
        })
        transaction.create(entry.movementRef, {
          sku: product.sku,
          unit,
          movementType: currentSnapshot.exists ? 'stock-count' : 'opening',
          previousOnHand: currentQuantity,
          newOnHand: entry.quantity,
          quantityDelta: entry.quantity - currentQuantity,
          reason,
          actorUid: request.auth!.uid,
          createdAt: FieldValue.serverTimestamp(),
        })
      }
    })

    logger.info('Bulk stock count recorded.', {
      itemCount: entries.length,
      actorUid: request.auth.uid,
    })
    return { updatedCount: entries.length }
  },
)

export const addStockBatch = onCall(
  {
    region: 'asia-southeast2',
    memory: '512MiB',
    maxInstances: 3,
    serviceAccount: 'catalog-sync-runtime@gofresh-3f2f3.iam.gserviceaccount.com',
    timeoutSeconds: 300,
  },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'Silakan login ke POS terlebih dahulu.')
    }
    await requireStaffRole(request.auth.uid, ['owner', 'supervisor'])
    if (request.auth.token.forcePasswordChange === true) {
      throw new HttpsError('failed-precondition', 'Ganti password sementara terlebih dahulu.')
    }

    const input = callableData(request.data)
    const rawItems = input.items
    const requestId = input.requestId
    const reason =
      typeof input.reason === 'string' && input.reason.trim() !== ''
        ? input.reason.trim()
        : 'Penambahan stok massal'
    if (
      !Array.isArray(rawItems) ||
      rawItems.length === 0 ||
      rawItems.length > 200 ||
      typeof requestId !== 'string' ||
      !/^[A-Fa-f0-9-]{36}$/.test(requestId) ||
      reason.length > 160
    ) {
      throw new HttpsError(
        'invalid-argument',
        'Permintaan harus berisi 1–200 produk, ID operasi valid, dan catatan maksimal 160 karakter.',
      )
    }

    const skuSet = new Set<string>()
    const items = rawItems.map((rawItem) => {
      const item = callableData(rawItem)
      const sku = item.sku
      const quantity = item.quantity
      if (
        typeof sku !== 'string' ||
        !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(sku) ||
        typeof quantity !== 'number' ||
        !Number.isFinite(quantity) ||
        quantity <= 0 ||
        quantity > 1_000_000
      ) {
        throw new HttpsError('invalid-argument', 'SKU atau jumlah penambahan stok tidak valid.')
      }
      const documentId = sku.toLowerCase()
      if (skuSet.has(documentId)) {
        throw new HttpsError('invalid-argument', `SKU ${sku} dikirim lebih dari satu kali.`)
      }
      skuSet.add(documentId)
      return { sku, documentId, quantity }
    })

    const database = getFirestore()
    const operationRef = database
      .collection('stockAdjustmentRequests')
      .doc(`${request.auth.uid}_${requestId}`)
    const entries = items.map((item) => ({
      ...item,
      productRef: database.collection(collectionName).doc(item.documentId),
      inventoryRef: database.collection('inventory').doc(item.documentId),
      movementRef: database.collection('stockMovements').doc(),
    }))

    const result = await database.runTransaction(async (transaction) => {
      const priorOperation = await transaction.get(operationRef)
      if (priorOperation.exists) {
        return { updatedCount: priorOperation.get('updatedCount') as number, duplicate: true }
      }

      const snapshots = await Promise.all(
        entries.map(async (entry) => {
          const [productSnapshot, currentSnapshot] = await Promise.all([
            transaction.get(entry.productRef),
            transaction.get(entry.inventoryRef),
          ])
          const product = productSnapshot.data()
          if (
            !productSnapshot.exists ||
            typeof product?.sku !== 'string' ||
            typeof product.unit !== 'string'
          ) {
            throw new HttpsError('not-found', `Produk ${entry.sku} tidak ditemukan di katalog.`)
          }
          const unit = product.unit.trim().toUpperCase()
          if (unit !== 'KG' && !Number.isInteger(entry.quantity)) {
            throw new HttpsError(
              'invalid-argument',
              `Jumlah penambahan stok ${entry.sku} (${unit}) harus bilangan bulat.`,
            )
          }
          const currentQuantity = currentSnapshot.exists
            ? currentSnapshot.get('onHand')
            : 0
          if (
            typeof currentQuantity !== 'number' ||
            !Number.isFinite(currentQuantity) ||
            currentQuantity < 0 ||
            !Number.isFinite(currentQuantity + entry.quantity)
          ) {
            throw new HttpsError(
              'failed-precondition',
              `Data stok ${entry.sku} saat ini tidak valid.`,
            )
          }
          return { entry, product, unit, currentQuantity }
        }),
      )

      for (const { entry, product, unit, currentQuantity } of snapshots) {
        const newOnHand = currentQuantity + entry.quantity
        transaction.set(entry.inventoryRef, {
          sku: product.sku,
          onHand: newOnHand,
          unit,
          updatedAt: FieldValue.serverTimestamp(),
          updatedBy: request.auth!.uid,
        })
        transaction.create(entry.movementRef, {
          sku: product.sku,
          unit,
          movementType: 'restock',
          previousOnHand: currentQuantity,
          newOnHand,
          quantityDelta: entry.quantity,
          reason,
          actorUid: request.auth!.uid,
          createdAt: FieldValue.serverTimestamp(),
        })
      }

      transaction.create(operationRef, {
        updatedCount: entries.length,
        actorUid: request.auth!.uid,
        createdAt: FieldValue.serverTimestamp(),
      })
      return { updatedCount: entries.length, duplicate: false }
    })

    logger.info('Bulk stock addition recorded.', {
      itemCount: result.updatedCount,
      actorUid: request.auth.uid,
      duplicate: result.duplicate,
    })
    return { updatedCount: result.updatedCount }
  },
)

// Harga ecer (< 1 kg) = harga grosir/kg + 10%, dibulatkan ke atas per Rp 500.
const retailSurchargeRate = 0.1
const retailPriceStep = 500

function retailPerKg(wholesalePerKg: number): number {
  return Math.ceil((wholesalePerKg * (1 + retailSurchargeRate)) / retailPriceStep) * retailPriceStep
}

type SaleLine = { quantity: number; total: number }

function priceSaleLine(
  unit: string,
  price: number,
  mode: unknown,
  rawQuantity: unknown,
  rawAmount: unknown,
  sku: string,
): SaleLine {
  const invalid = () => new HttpsError('invalid-argument', `Jumlah atau nominal ${sku} tidak valid.`)
  if (unit !== 'KG') {
    if (
      mode !== 'quantity' ||
      typeof rawQuantity !== 'number' ||
      !Number.isInteger(rawQuantity) ||
      rawQuantity < 1 ||
      rawQuantity > 100_000
    ) {
      throw invalid()
    }
    return { quantity: rawQuantity, total: price * rawQuantity }
  }

  const ecerPrice = retailPerKg(price)
  if (mode === 'nominal') {
    if (
      typeof rawAmount !== 'number' ||
      !Number.isInteger(rawAmount) ||
      rawAmount < 100 ||
      rawAmount > 50_000_000
    ) {
      throw invalid()
    }
    const rate = rawAmount >= price ? price : ecerPrice
    const quantity = Math.floor((rawAmount / rate) * 1000) / 1000
    if (quantity <= 0) throw invalid()
    return { quantity, total: rawAmount }
  }
  if (
    mode !== 'quantity' ||
    typeof rawQuantity !== 'number' ||
    !Number.isFinite(rawQuantity) ||
    rawQuantity <= 0 ||
    rawQuantity > 100_000
  ) {
    throw invalid()
  }
  const quantity = Math.round(rawQuantity * 1000) / 1000
  if (quantity <= 0) throw invalid()
  const total =
    quantity >= 1
      ? Math.round(price * quantity)
      : Math.max(100, Math.round((ecerPrice * quantity) / 100) * 100)
  return { quantity, total }
}

export const createRetailSale = onCall(
  {
    region: 'asia-southeast2',
    memory: '512MiB',
    maxInstances: 5,
    serviceAccount: 'catalog-sync-runtime@gofresh-3f2f3.iam.gserviceaccount.com',
    timeoutSeconds: 60,
  },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'Silakan login ke POS terlebih dahulu.')
    }
    const staff = await requireStaffRole(request.auth.uid, ['owner', 'supervisor', 'cashier'])
    if (request.auth.token.forcePasswordChange === true) {
      throw new HttpsError('failed-precondition', 'Ganti password sementara terlebih dahulu.')
    }

    const input = callableData(request.data)
    const rawItems = input.items
    const requestId = input.requestId
    const paymentMethod = input.paymentMethod
    const cashReceived = input.cashReceived
    const qrisReference =
      typeof input.qrisReference === 'string' ? input.qrisReference.trim().toUpperCase() : ''
    if (paymentMethod === 'qris' && !/^[A-Z0-9][A-Z0-9._/-]{5,39}$/.test(qrisReference)) {
      throw new HttpsError(
        'invalid-argument',
        'Nomor transaksi QRIS/EDC wajib diisi (6–40 huruf/angka).',
      )
    }
    if (
      !Array.isArray(rawItems) ||
      rawItems.length === 0 ||
      rawItems.length > 100 ||
      typeof requestId !== 'string' ||
      !/^[A-Fa-f0-9-]{36}$/.test(requestId) ||
      (paymentMethod !== 'cash' && paymentMethod !== 'qris')
    ) {
      throw new HttpsError('invalid-argument', 'Keranjang atau metode pembayaran tidak valid.')
    }

    const seen = new Set<string>()
    const lines = rawItems.map((rawItem) => {
      const item = callableData(rawItem)
      const sku = item.sku
      if (typeof sku !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(sku)) {
        throw new HttpsError('invalid-argument', 'SKU tidak valid.')
      }
      const documentId = sku.toLowerCase()
      if (seen.has(documentId)) {
        throw new HttpsError('invalid-argument', `SKU ${sku} dikirim lebih dari satu kali.`)
      }
      seen.add(documentId)
      return { documentId, mode: item.mode, quantity: item.quantity, amount: item.amount }
    })

    const database = getFirestore()
    const saleRef = database.collection('sales').doc(`${request.auth.uid}_${requestId}`)
    const dayKey = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Jakarta' })
      .format(new Date())
      .replaceAll('-', '')
    const counterRef = database.collection('salesCounters').doc(dayKey)
    const qrisRef = database
      .collection('qrisReferences')
      .doc(encodeURIComponent(qrisReference || 'none'))
    const entries = lines.map((line) => ({
      ...line,
      productRef: database.collection(collectionName).doc(line.documentId),
      inventoryRef: database.collection('inventory').doc(line.documentId),
      movementRef: database.collection('stockMovements').doc(),
    }))

    const receipt = await database.runTransaction(async (transaction) => {
      const prior = await transaction.get(saleRef)
      if (prior.exists) {
        return prior.data() as Record<string, unknown>
      }
      const shiftId = await currentShiftIdForSale(transaction, request.auth!.uid, staff.role)
      const counterSnapshot = await transaction.get(counterRef)
      if (paymentMethod === 'qris') {
        const usedReference = await transaction.get(qrisRef)
        if (usedReference.exists) {
          throw new HttpsError(
            'already-exists',
            `Nomor transaksi ${qrisReference} sudah dipakai pada struk ${usedReference.get('receiptNo')}.`,
          )
        }
      }
      const resolved = await Promise.all(
        entries.map(async (entry) => {
          const [productSnapshot, stockSnapshot] = await Promise.all([
            transaction.get(entry.productRef),
            transaction.get(entry.inventoryRef),
          ])
          const product = productSnapshot.data()
          if (
            !productSnapshot.exists ||
            typeof product?.sku !== 'string' ||
            typeof product.name !== 'string' ||
            typeof product.unit !== 'string' ||
            typeof product.retailPrice !== 'number'
          ) {
            throw new HttpsError('not-found', 'Ada produk yang tidak ditemukan di katalog.')
          }
          const unit = product.unit.trim().toUpperCase()
          const line = priceSaleLine(
            unit,
            product.retailPrice,
            entry.mode,
            entry.quantity,
            entry.amount,
            product.sku,
          )
          const onHand = stockSnapshot.exists ? stockSnapshot.get('onHand') : null
          if (typeof onHand !== 'number' || !Number.isFinite(onHand) || onHand < line.quantity) {
            throw new HttpsError(
              'failed-precondition',
              `Stok ${product.name} tidak cukup (tersisa ${typeof onHand === 'number' ? onHand : 0} ${unit}).`,
            )
          }
          return { entry, product, unit, line, onHand }
        }),
      )

      const total = resolved.reduce((sum, row) => sum + row.line.total, 0)
      let change = 0
      if (paymentMethod === 'cash') {
        if (
          typeof cashReceived !== 'number' ||
          !Number.isInteger(cashReceived) ||
          cashReceived < total ||
          cashReceived > 1_000_000_000
        ) {
          throw new HttpsError('invalid-argument', 'Uang tunai yang diterima kurang dari total tagihan.')
        }
        change = cashReceived - total
      }

      const sequence = (counterSnapshot.exists ? (counterSnapshot.get('last') as number) : 0) + 1
      const receiptNo = `RTL-${dayKey}-${String(sequence).padStart(4, '0')}`
      const items = resolved.map(({ product, unit, line }) => ({
        sku: product.sku as string,
        name: product.name as string,
        unit,
        quantity: line.quantity,
        total: line.total,
      }))

      for (const { entry, product, unit, line, onHand } of resolved) {
        const newOnHand = Math.round((onHand - line.quantity) * 1000) / 1000
        transaction.set(entry.inventoryRef, {
          sku: product.sku,
          onHand: newOnHand,
          unit,
          updatedAt: FieldValue.serverTimestamp(),
          updatedBy: request.auth!.uid,
        })
        transaction.create(entry.movementRef, {
          sku: product.sku,
          unit,
          movementType: 'sale',
          previousOnHand: onHand,
          newOnHand,
          quantityDelta: -line.quantity,
          reason: `Penjualan retail ${receiptNo}`,
          actorUid: request.auth!.uid,
          createdAt: FieldValue.serverTimestamp(),
        })
      }
      transaction.set(counterRef, { last: sequence })
      if (paymentMethod === 'qris') {
        transaction.create(qrisRef, {
          receiptNo,
          reference: qrisReference,
          createdAt: FieldValue.serverTimestamp(),
        })
      }

      const sale = {
        receiptNo,
        channel: 'retail-offline',
        items,
        total,
        paymentMethod,
        cashReceived: paymentMethod === 'cash' ? (cashReceived as number) : null,
        qrisReference: paymentMethod === 'qris' ? qrisReference : null,
        change,
        cashierUid: request.auth!.uid,
        cashierName: staff.displayName,
        shiftId,
        createdAtIso: new Date().toISOString(),
      }
      transaction.create(saleRef, { ...sale, createdAt: FieldValue.serverTimestamp() })
      recordShiftSale(transaction, shiftId, 'retail', paymentMethod, total, 1)
      if (items.some((item) => item.sku.toLowerCase() === vipCardSku)) {
        transaction.create(database.collection('memberRegistrations').doc(saleRef.id), {
          saleId: saleRef.id,
          receiptNo,
          source: 'retail-offline',
          status: 'pending',
          createdByName: staff.displayName,
          createdAt: FieldValue.serverTimestamp(),
        })
      }
      return sale
    })

    logger.info('Retail sale recorded.', { receiptNo: receipt.receiptNo, actorUid: request.auth.uid })
    return receipt
  },
)

export const createB2bSale = onCall(
  {
    region: 'asia-southeast2',
    memory: '512MiB',
    maxInstances: 5,
    serviceAccount: 'catalog-sync-runtime@gofresh-3f2f3.iam.gserviceaccount.com',
    timeoutSeconds: 60,
  },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'Silakan login ke POS terlebih dahulu.')
    }
    const staff = await requireStaffRole(request.auth.uid, ['owner', 'supervisor', 'cashier'])
    if (request.auth.token.forcePasswordChange === true) {
      throw new HttpsError('failed-precondition', 'Ganti password sementara terlebih dahulu.')
    }

    const input = callableData(request.data)
    const rawItems = input.items
    const requestId = input.requestId
    const paymentMethod = input.paymentMethod
    const cashReceived = input.cashReceived
    const memberPhone = input.memberPhone
    const reference =
      typeof input.paymentReference === 'string' ? input.paymentReference.trim().toUpperCase() : ''
    if (
      !Array.isArray(rawItems) ||
      rawItems.length === 0 ||
      rawItems.length > 100 ||
      typeof requestId !== 'string' ||
      !/^[A-Fa-f0-9-]{36}$/.test(requestId) ||
      typeof memberPhone !== 'string' ||
      !/^628[0-9]{7,12}$/.test(memberPhone) ||
      (paymentMethod !== 'cash' && paymentMethod !== 'transfer' && paymentMethod !== 'qris')
    ) {
      throw new HttpsError('invalid-argument', 'Keranjang, member, atau metode pembayaran tidak valid.')
    }
    if (
      paymentMethod !== 'cash' &&
      !/^[A-Z0-9][A-Z0-9._/-]{5,39}$/.test(reference)
    ) {
      throw new HttpsError(
        'invalid-argument',
        'Nomor referensi bukti transfer/QRIS wajib diisi (6–40 huruf/angka).',
      )
    }

    const seen = new Set<string>()
    const lines = rawItems.map((rawItem) => {
      const item = callableData(rawItem)
      const sku = item.sku
      const quantity = item.quantity
      if (
        typeof sku !== 'string' ||
        !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(sku) ||
        typeof quantity !== 'number' ||
        !Number.isFinite(quantity) ||
        quantity <= 0 ||
        quantity > 100_000
      ) {
        throw new HttpsError('invalid-argument', 'SKU atau jumlah tidak valid.')
      }
      const documentId = sku.toLowerCase()
      if (seen.has(documentId)) {
        throw new HttpsError('invalid-argument', `SKU ${sku} dikirim lebih dari satu kali.`)
      }
      seen.add(documentId)
      return { documentId, quantity: Math.round(quantity * 1000) / 1000 }
    })

    const database = getFirestore()
    const saleRef = database.collection('sales').doc(`${request.auth.uid}_${requestId}`)
    const memberRef = database.collection('b2bMembers').doc(memberPhone)
    const dayKey = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Jakarta' })
      .format(new Date())
      .replaceAll('-', '')
    const counterRef = database.collection('salesCounters').doc(`b2b-${dayKey}`)
    const referenceRef = database
      .collection('qrisReferences')
      .doc(encodeURIComponent(reference || 'none'))
    const entries = lines.map((line) => ({
      ...line,
      productRef: database.collection(collectionName).doc(line.documentId),
      priceRef: database.collection('b2bPrices').doc(line.documentId),
      inventoryRef: database.collection('inventory').doc(line.documentId),
      movementRef: database.collection('stockMovements').doc(),
    }))

    const receipt = await database.runTransaction(async (transaction) => {
      const prior = await transaction.get(saleRef)
      if (prior.exists) {
        return prior.data() as Record<string, unknown>
      }
      const memberSnapshot = await transaction.get(memberRef)
      if (!memberSnapshot.exists || memberSnapshot.get('active') !== true) {
        throw new HttpsError('failed-precondition', 'Nomor HP ini bukan member B2B yang aktif.')
      }
      const shiftId = await currentShiftIdForSale(transaction, request.auth!.uid, staff.role)
      const counterSnapshot = await transaction.get(counterRef)
      if (paymentMethod !== 'cash') {
        const used = await transaction.get(referenceRef)
        if (used.exists) {
          throw new HttpsError(
            'already-exists',
            `Nomor referensi ${reference} sudah dipakai pada struk ${used.get('receiptNo')}.`,
          )
        }
      }

      const resolved = await Promise.all(
        entries.map(async (entry) => {
          const [productSnapshot, priceSnapshot, stockSnapshot] = await Promise.all([
            transaction.get(entry.productRef),
            transaction.get(entry.priceRef),
            transaction.get(entry.inventoryRef),
          ])
          const product = productSnapshot.data()
          const b2bPrice = priceSnapshot.get('b2bPrice')
          if (
            !productSnapshot.exists ||
            typeof product?.sku !== 'string' ||
            typeof product.name !== 'string' ||
            typeof product.unit !== 'string'
          ) {
            throw new HttpsError('not-found', 'Ada produk yang tidak ditemukan di katalog.')
          }
          if (typeof b2bPrice !== 'number' || b2bPrice <= 0) {
            throw new HttpsError('failed-precondition', `Harga B2B ${product.name} belum diisi di sheet.`)
          }
          const unit = product.unit.trim().toUpperCase()
          if (unit !== 'KG' && !Number.isInteger(entry.quantity)) {
            throw new HttpsError('invalid-argument', `Jumlah ${product.name} (${unit}) harus bilangan bulat.`)
          }
          const onHand = stockSnapshot.exists ? stockSnapshot.get('onHand') : null
          if (typeof onHand !== 'number' || !Number.isFinite(onHand) || onHand < entry.quantity) {
            throw new HttpsError(
              'failed-precondition',
              `Stok ${product.name} tidak cukup (tersisa ${typeof onHand === 'number' ? onHand : 0} ${unit}).`,
            )
          }
          return { entry, product, unit, onHand, total: Math.round(b2bPrice * entry.quantity) }
        }),
      )

      const total = resolved.reduce((sum, row) => sum + row.total, 0)
      let change = 0
      if (paymentMethod === 'cash') {
        if (
          typeof cashReceived !== 'number' ||
          !Number.isInteger(cashReceived) ||
          cashReceived < total ||
          cashReceived > 1_000_000_000
        ) {
          throw new HttpsError('invalid-argument', 'Uang tunai yang diterima kurang dari total tagihan.')
        }
        change = cashReceived - total
      }

      const sequence = (counterSnapshot.exists ? (counterSnapshot.get('last') as number) : 0) + 1
      const receiptNo = `B2B-${dayKey}-${String(sequence).padStart(4, '0')}`
      const items = resolved.map(({ product, unit, entry, total: lineTotal }) => ({
        sku: product.sku as string,
        name: product.name as string,
        unit,
        quantity: entry.quantity,
        total: lineTotal,
      }))

      for (const { entry, product, unit, onHand } of resolved) {
        const newOnHand = Math.round((onHand - entry.quantity) * 1000) / 1000
        transaction.set(entry.inventoryRef, {
          sku: product.sku,
          onHand: newOnHand,
          unit,
          updatedAt: FieldValue.serverTimestamp(),
          updatedBy: request.auth!.uid,
        })
        transaction.create(entry.movementRef, {
          sku: product.sku,
          unit,
          movementType: 'sale',
          previousOnHand: onHand,
          newOnHand,
          quantityDelta: -entry.quantity,
          reason: `Penjualan B2B ${receiptNo}`,
          actorUid: request.auth!.uid,
          createdAt: FieldValue.serverTimestamp(),
        })
      }
      transaction.set(counterRef, { last: sequence })
      if (paymentMethod !== 'cash') {
        transaction.create(referenceRef, {
          receiptNo,
          reference,
          createdAt: FieldValue.serverTimestamp(),
        })
      }

      const sale = {
        receiptNo,
        channel: 'b2b-offline',
        items,
        total,
        paymentMethod,
        cashReceived: paymentMethod === 'cash' ? (cashReceived as number) : null,
        paymentReference: paymentMethod === 'cash' ? null : reference,
        change,
        memberPhone,
        memberName: memberSnapshot.get('name') as string,
        cashierUid: request.auth!.uid,
        cashierName: staff.displayName,
        shiftId,
        createdAtIso: new Date().toISOString(),
      }
      transaction.create(saleRef, { ...sale, createdAt: FieldValue.serverTimestamp() })
      recordShiftSale(transaction, shiftId, 'b2b', paymentMethod as string, total, 1)
      return sale
    })

    logger.info('B2B sale recorded.', { receiptNo: receipt.receiptNo, actorUid: request.auth.uid })
    return receipt
  },
)
export const voidSale = onCall(
  {
    region: 'asia-southeast2',
    memory: '256MiB',
    maxInstances: 3,
    serviceAccount: 'catalog-sync-runtime@gofresh-3f2f3.iam.gserviceaccount.com',
    timeoutSeconds: 60,
  },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'Silakan login ke POS terlebih dahulu.')
    }
    const staff = await requireStaffRole(request.auth.uid, ['owner', 'supervisor'])
    if (request.auth.token.forcePasswordChange === true) {
      throw new HttpsError('failed-precondition', 'Ganti password sementara terlebih dahulu.')
    }

    const input = callableData(request.data)
    const saleId = input.saleId
    const reason = typeof input.reason === 'string' ? input.reason.trim() : ''
    if (typeof saleId !== 'string' || !/^[A-Za-z0-9_-]{10,120}$/.test(saleId)) {
      throw new HttpsError('invalid-argument', 'Transaksi tidak valid.')
    }
    if (reason.length < 3 || reason.length > 200) {
      throw new HttpsError('invalid-argument', 'Alasan void wajib diisi (3–200 karakter).')
    }

    const database = getFirestore()
    const saleRef = database.collection('sales').doc(saleId)

    await database.runTransaction(async (transaction) => {
      const saleSnapshot = await transaction.get(saleRef)
      if (!saleSnapshot.exists) {
        throw new HttpsError('not-found', 'Transaksi tidak ditemukan.')
      }
      const sale = saleSnapshot.data() ?? {}
      if (sale.voided === true) return
      if (sale.channel === 'web') {
        throw new HttpsError('failed-precondition', 'Pesanan website dibatalkan lewat panel Web Order.')
      }
      const saleShiftRef =
        typeof sale.shiftId === 'string' ? database.collection('shifts').doc(sale.shiftId) : null
      const saleShift = saleShiftRef ? await transaction.get(saleShiftRef) : null
      const registrationRef = database.collection('memberRegistrations').doc(saleId)
      const registration = await transaction.get(registrationRef)
      const rawItems: unknown = sale.items
      if (!Array.isArray(rawItems) || rawItems.length === 0) {
        throw new HttpsError('failed-precondition', 'Transaksi ini tidak memiliki item.')
      }

      const returns = rawItems.map((raw) => {
        const item = callableData(raw)
        if (typeof item.sku !== 'string' || typeof item.quantity !== 'number' || typeof item.unit !== 'string') {
          throw new HttpsError('failed-precondition', 'Data item transaksi tidak lengkap.')
        }
        return {
          sku: item.sku,
          unit: item.unit,
          quantity: item.quantity,
          inventoryRef: database.collection('inventory').doc(item.sku.toLowerCase()),
          movementRef: database.collection('stockMovements').doc(),
        }
      })
      const stocks = await Promise.all(returns.map((entry) => transaction.get(entry.inventoryRef)))

      returns.forEach((entry, index) => {
        const current = stocks[index].exists ? (stocks[index].get('onHand') as number) : 0
        const previous = typeof current === 'number' ? current : 0
        const newOnHand = Math.round((previous + entry.quantity) * 1000) / 1000
        transaction.set(entry.inventoryRef, {
          sku: entry.sku,
          onHand: newOnHand,
          unit: entry.unit,
          updatedAt: FieldValue.serverTimestamp(),
          updatedBy: request.auth!.uid,
        })
        transaction.create(entry.movementRef, {
          sku: entry.sku,
          unit: entry.unit,
          movementType: 'void',
          previousOnHand: previous,
          newOnHand,
          quantityDelta: entry.quantity,
          reason: `Void ${String(sale.receiptNo ?? saleId)}: ${reason}`,
          actorUid: request.auth!.uid,
          createdAt: FieldValue.serverTimestamp(),
        })
      })
      transaction.update(saleRef, {
        voided: true,
        voidReason: reason,
        voidedByUid: request.auth!.uid,
        voidedByName: staff.displayName,
        voidedAt: FieldValue.serverTimestamp(),
      })
      if (registration.exists) {
        transaction.update(registrationRef, { status: registration.get('status') === 'done' ? 'done' : 'cancelled' })
        const memberPhone = registration.get('memberPhone')
        if (registration.get('status') === 'done' && typeof memberPhone === 'string') {
          transaction.update(database.collection('retailMembers').doc(memberPhone), { active: false })
        }
      }
      if (saleShift?.exists && saleShift.get('status') === 'open' && saleShiftRef) {
        const channel = sale.channel === 'b2b-offline' ? 'b2b' : 'retail'
        const method = typeof sale.paymentMethod === 'string' ? sale.paymentMethod : 'cash'
        const total = typeof sale.total === 'number' ? sale.total : 0
        transaction.update(saleShiftRef, shiftTotalsUpdate(channel, method, total, -1))
      }
    })

    logger.info('Sale voided.', { saleId, actorUid: request.auth.uid })
    return { saleId }
  },
)

export const sendChatMessage = onCall(
  { ...shiftCallableOptions, maxInstances: 5 },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'Sesi chat belum siap. Muat ulang halaman.')
    }
    const input = callableData(request.data)
    const text = typeof input.text === 'string' ? input.text.trim() : ''
    const name = typeof input.name === 'string' ? input.name.trim() : ''
    const phone = typeof input.phone === 'string' ? input.phone.trim() : ''
    if (text.length < 1 || text.length > 500) {
      throw new HttpsError('invalid-argument', 'Pesan harus 1–500 karakter.')
    }
    if (name.length < 2 || name.length > 40) {
      throw new HttpsError('invalid-argument', 'Nama wajib diisi (2–40 karakter).')
    }
    if (phone !== '' && !/^628[0-9]{7,12}$/.test(phone)) {
      throw new HttpsError('invalid-argument', 'Nomor WA tidak valid.')
    }

    const database = getFirestore()
    const uid = request.auth.uid
    const chatRef = database.collection('chats').doc(uid)
    const messageRef = chatRef.collection('messages').doc()
    const statusSnapshot = await storeStatusRef().get()
    const online = statusSnapshot.get('cashierOnline') === true

    await database.runTransaction(async (transaction) => {
      const chat = await transaction.get(chatRef)
      const lastAt = chat.get('lastCustomerAt') as { toMillis?: () => number } | undefined
      if (lastAt?.toMillis && Date.now() - lastAt.toMillis() < 1500) {
        throw new HttpsError('resource-exhausted', 'Terlalu cepat, coba sebentar lagi.')
      }
      transaction.set(
        chatRef,
        {
          customerUid: uid,
          customerName: name,
          customerPhone: phone,
          status: 'open',
          lastMessage: text.slice(0, 120),
          lastSender: 'customer',
          lastMessageAt: FieldValue.serverTimestamp(),
          lastCustomerAt: FieldValue.serverTimestamp(),
          unreadStaff: FieldValue.increment(1),
          cashierWasOnline: online,
          ...(chat.exists ? {} : { createdAt: FieldValue.serverTimestamp(), unreadCustomer: 0 }),
        },
        { merge: true },
      )
      transaction.create(messageRef, {
        sender: 'customer',
        text,
        createdAt: FieldValue.serverTimestamp(),
      })
    })
    return { chatId: uid, cashierOnline: online }
  },
)

export const replyChat = onCall(shiftCallableOptions, async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Silakan login ke POS terlebih dahulu.')
  }
  const staff = await requireStaffRole(request.auth.uid, ['owner', 'supervisor', 'cashier'])
  const input = callableData(request.data)
  const chatId = input.chatId
  const text = typeof input.text === 'string' ? input.text.trim() : ''
  if (typeof chatId !== 'string' || !/^[A-Za-z0-9]{10,128}$/.test(chatId)) {
    throw new HttpsError('invalid-argument', 'Chat tidak valid.')
  }
  if (text.length < 1 || text.length > 1000) {
    throw new HttpsError('invalid-argument', 'Balasan harus 1–1000 karakter.')
  }
  const database = getFirestore()
  const chatRef = database.collection('chats').doc(chatId)
  const messageRef = chatRef.collection('messages').doc()
  await database.runTransaction(async (transaction) => {
    const chat = await transaction.get(chatRef)
    if (!chat.exists) {
      throw new HttpsError('not-found', 'Chat tidak ditemukan.')
    }
    transaction.update(chatRef, {
      status: 'open',
      lastMessage: text.slice(0, 120),
      lastSender: 'staff',
      lastMessageAt: FieldValue.serverTimestamp(),
      unreadStaff: 0,
      unreadCustomer: FieldValue.increment(1),
    })
    transaction.create(messageRef, {
      sender: 'staff',
      senderName: staff.displayName,
      text,
      createdAt: FieldValue.serverTimestamp(),
    })
  })
  return { ok: true }
})

export const markChatRead = onCall(shiftCallableOptions, async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Silakan login ke POS terlebih dahulu.')
  }
  await requireStaffRole(request.auth.uid, ['owner', 'supervisor', 'cashier'])
  const input = callableData(request.data)
  const chatId = input.chatId
  const close = input.close === true
  if (typeof chatId !== 'string' || !/^[A-Za-z0-9]{10,128}$/.test(chatId)) {
    throw new HttpsError('invalid-argument', 'Chat tidak valid.')
  }
  await getFirestore()
    .collection('chats')
    .doc(chatId)
    .update(close ? { unreadStaff: 0, status: 'closed' } : { unreadStaff: 0 })
  return { ok: true }
})

export const markChatSeenByCustomer = onCall(shiftCallableOptions, async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Sesi chat belum siap.')
  }
  const chatRef = getFirestore().collection('chats').doc(request.auth.uid)
  if ((await chatRef.get()).exists) {
    await chatRef.update({ unreadCustomer: 0 })
  }
  return { ok: true }
})

type ShiftFunds = { change: number; nempil: number; sales: number; ops: number }
const vipCardSku = 'vip-card-01'

export const registerRetailMember = onCall(shiftCallableOptions, async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Silakan login ke POS terlebih dahulu.')
  }
  const staff = await requireStaffRole(request.auth.uid, ['owner', 'supervisor', 'cashier'])
  if (request.auth.token.forcePasswordChange === true) {
    throw new HttpsError('failed-precondition', 'Ganti password sementara terlebih dahulu.')
  }
  const input = callableData(request.data)
  const registrationId = input.registrationId
  const name = typeof input.name === 'string' ? input.name.trim() : ''
  const phone = typeof input.phone === 'string' ? input.phone.trim() : ''
  if (typeof registrationId !== 'string' || !/^[A-Za-z0-9_-]{8,120}$/.test(registrationId)) {
    throw new HttpsError('invalid-argument', 'Pendaftaran tidak valid.')
  }
  if (name.length < 2 || name.length > 80) {
    throw new HttpsError('invalid-argument', 'Nama member wajib diisi (2–80 karakter).')
  }
  if (!/^628[0-9]{7,12}$/.test(phone)) {
    throw new HttpsError('invalid-argument', 'Nomor HP/WA tidak valid.')
  }

  const database = getFirestore()
  const registrationRef = database.collection('memberRegistrations').doc(registrationId)
  const memberRef = database.collection('retailMembers').doc(phone)
  await database.runTransaction(async (transaction) => {
    const registration = await transaction.get(registrationRef)
    if (!registration.exists) {
      throw new HttpsError('not-found', 'Pendaftaran member tidak ditemukan.')
    }
    if (registration.get('status') === 'done') {
      throw new HttpsError('failed-precondition', 'Pendaftaran ini sudah diisi.')
    }
    const saleId = registration.get('saleId') as string | undefined
    const saleSnapshot = saleId ? await transaction.get(database.collection('sales').doc(saleId)) : null
    if (saleSnapshot?.get('voided') === true) {
      throw new HttpsError('failed-precondition', 'Transaksi kartu VIP ini sudah di-void.')
    }
    const existing = await transaction.get(memberRef)
    const phoneClaim = await transaction.get(database.collection('customerPhones').doc(phone))
    if (existing.exists && existing.get('active') === true) {
      throw new HttpsError('already-exists', 'Nomor ini sudah terdaftar sebagai member retail.')
    }
    transaction.set(memberRef, {
      name,
      phone,
      active: true,
      source: registration.get('source') ?? 'retail-offline',
      receiptNo: registration.get('receiptNo') ?? '',
      registrationId,
      registeredByName: staff.displayName,
      createdAt: FieldValue.serverTimestamp(),
    })
    if (phoneClaim.exists) {
      transaction.set(database.collection('customers').doc(phoneClaim.get('uid')), { vip: true }, { merge: true })
    }
    transaction.update(registrationRef, {
      status: 'done',
      memberPhone: phone,
      memberName: name,
      completedByName: staff.displayName,
      completedAt: FieldValue.serverTimestamp(),
    })
  })
  return { ok: true }
})
const expenseCategories = ['nempil', 'sales', 'ops'] as const

function storeStatusRef() {
  return getFirestore().collection('storeStatus').doc('current')
}

function shiftStateRef() {
  return getFirestore().collection('shiftState').doc('current')
}

function moneyValue(value: unknown, label: string, max = 100_000_000): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > max) {
    throw new HttpsError('invalid-argument', `${label} harus berupa angka rupiah yang valid.`)
  }
  return value
}

async function currentShiftIdForSale(
  transaction: Transaction,
  uid: string,
  role: StaffRole,
): Promise<string | null> {
  const state = await transaction.get(shiftStateRef())
  const current = state.exists ? state.data() : undefined
  if (role === 'cashier') {
    if (!current) {
      throw new HttpsError('failed-precondition', 'Buka shift dan isi modal toko terlebih dahulu.')
    }
    if (current.cashierUid !== uid) {
      throw new HttpsError(
        'failed-precondition',
        `Shift kasir ${String(current.cashierName)} belum di-closing.`,
      )
    }
  }
  return current && typeof current.shiftId === 'string' ? current.shiftId : null
}

function shiftTotalsUpdate(
  channel: 'retail' | 'b2b',
  method: string,
  total: number,
  sign: 1 | -1,
): Record<string, FieldValue> {
  const methodKey = method === 'qris' || method === 'transfer' ? method : 'cash'
  return {
    'totals.count': FieldValue.increment(sign),
    'totals.sales': FieldValue.increment(sign * total),
    [`totals.${methodKey}`]: FieldValue.increment(sign * total),
    [`totals.${channel}`]: FieldValue.increment(sign * total),
  }
}

function recordShiftSale(
  transaction: Transaction,
  shiftId: string | null,
  channel: 'retail' | 'b2b',
  method: string,
  total: number,
  sign: 1 | -1,
) {
  if (!shiftId) return
  transaction.update(
    getFirestore().collection('shifts').doc(shiftId),
    shiftTotalsUpdate(channel, method, total, sign),
  )
}

export const openShift = onCall(shiftCallableOptions, async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Silakan login ke POS terlebih dahulu.')
  }
  const staff = await requireStaffRole(request.auth.uid, ['owner', 'supervisor', 'cashier'])
  if (request.auth.token.forcePasswordChange === true) {
    throw new HttpsError('failed-precondition', 'Ganti password sementara terlebih dahulu.')
  }
  const input = callableData(request.data)
  const rawFunds = callableData(input.funds)
  const funds: ShiftFunds = {
    change: moneyValue(rawFunds.change, 'Modal kembalian'),
    nempil: moneyValue(rawFunds.nempil, 'Modal nempil'),
    sales: moneyValue(rawFunds.sales, 'Modal sales'),
    ops: moneyValue(rawFunds.ops, 'Modal operasional'),
  }

  const database = getFirestore()
  const shiftRef = database.collection('shifts').doc()
  const stateRef = shiftStateRef()
  const uid = request.auth.uid
  const shiftId = await database.runTransaction(async (transaction) => {
    const state = await transaction.get(stateRef)
    if (state.exists) {
      if (state.get('cashierUid') === uid) return state.get('shiftId') as string
      throw new HttpsError(
        'failed-precondition',
        `Shift kasir ${String(state.get('cashierName'))} belum di-closing.`,
      )
    }
    transaction.create(shiftRef, {
      status: 'open',
      cashierUid: uid,
      cashierName: staff.displayName,
      funds,
      spent: { nempil: 0, sales: 0, ops: 0 },
      totals: { count: 0, sales: 0, cash: 0, qris: 0, transfer: 0, retail: 0, b2b: 0 },
      openedAt: FieldValue.serverTimestamp(),
    })
    transaction.set(stateRef, {
      shiftId: shiftRef.id,
      cashierUid: uid,
      cashierName: staff.displayName,
      openedAt: FieldValue.serverTimestamp(),
    })
    transaction.set(storeStatusRef(), {
      cashierOnline: true,
      cashierName: staff.displayName,
      updatedAt: FieldValue.serverTimestamp(),
    })
    return shiftRef.id
  })
  logger.info('Shift opened.', { shiftId, actorUid: uid })
  return { shiftId }
})

export const addCashExpense = onCall(shiftCallableOptions, async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Silakan login ke POS terlebih dahulu.')
  }
  const staff = await requireStaffRole(request.auth.uid, ['owner', 'supervisor', 'cashier'])
  if (request.auth.token.forcePasswordChange === true) {
    throw new HttpsError('failed-precondition', 'Ganti password sementara terlebih dahulu.')
  }
  const input = callableData(request.data)
  const category = input.category
  const requestId = input.requestId
  const note = typeof input.note === 'string' ? input.note.trim() : ''
  if (!expenseCategories.includes(category as (typeof expenseCategories)[number])) {
    throw new HttpsError('invalid-argument', 'Jenis pengeluaran tidak valid.')
  }
  if (typeof requestId !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(requestId)) {
    throw new HttpsError('invalid-argument', 'ID permintaan tidak valid.')
  }
  const amount = moneyValue(input.amount, 'Nominal', 50_000_000)
  if (amount < 1) {
    throw new HttpsError('invalid-argument', 'Nominal harus lebih dari 0.')
  }
  if (note.length < 3 || note.length > 120) {
    throw new HttpsError('invalid-argument', 'Keterangan wajib diisi (3–120 karakter).')
  }

  const database = getFirestore()
  const uid = request.auth.uid
  await database.runTransaction(async (transaction) => {
    const state = await transaction.get(shiftStateRef())
    if (!state.exists || state.get('cashierUid') !== uid) {
      throw new HttpsError('failed-precondition', 'Anda belum membuka shift.')
    }
    const shiftRef = database.collection('shifts').doc(state.get('shiftId') as string)
    const expenseRef = shiftRef.collection('expenses').doc(requestId)
    if ((await transaction.get(expenseRef)).exists) return
    transaction.create(expenseRef, {
      category,
      amount,
      note,
      removed: false,
      cashierUid: uid,
      cashierName: staff.displayName,
      createdAt: FieldValue.serverTimestamp(),
    })
    transaction.update(shiftRef, { [`spent.${String(category)}`]: FieldValue.increment(amount) })
  })
  return { ok: true }
})

export const addShiftFund = onCall(shiftCallableOptions, async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Silakan login ke POS terlebih dahulu.')
  }
  const staff = await requireStaffRole(request.auth.uid, ['owner', 'supervisor', 'cashier'])
  if (request.auth.token.forcePasswordChange === true) {
    throw new HttpsError('failed-precondition', 'Ganti password sementara terlebih dahulu.')
  }
  const input = callableData(request.data)
  const category = input.category
  const requestId = input.requestId
  const source = typeof input.source === 'string' ? input.source.trim() : ''
  if (!['change', ...expenseCategories].includes(category as string)) {
    throw new HttpsError('invalid-argument', 'Jenis modal tidak valid.')
  }
  if (typeof requestId !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(requestId)) {
    throw new HttpsError('invalid-argument', 'ID permintaan tidak valid.')
  }
  const amount = moneyValue(input.amount, 'Nominal', 50_000_000)
  if (amount < 1) {
    throw new HttpsError('invalid-argument', 'Nominal harus lebih dari 0.')
  }
  if (source.length < 3 || source.length > 120) {
    throw new HttpsError('invalid-argument', 'Sumber dana wajib diisi (3–120 karakter).')
  }

  const database = getFirestore()
  const uid = request.auth.uid
  await database.runTransaction(async (transaction) => {
    const state = await transaction.get(shiftStateRef())
    if (!state.exists || state.get('cashierUid') !== uid) {
      throw new HttpsError('failed-precondition', 'Anda belum membuka shift.')
    }
    const shiftRef = database.collection('shifts').doc(state.get('shiftId') as string)
    const topupRef = shiftRef.collection('topups').doc(requestId)
    if ((await transaction.get(topupRef)).exists) return
    transaction.create(topupRef, {
      category,
      amount,
      source,
      cashierUid: uid,
      cashierName: staff.displayName,
      createdAt: FieldValue.serverTimestamp(),
    })
    transaction.update(shiftRef, { [`funds.${String(category)}`]: FieldValue.increment(amount) })
  })
  return { ok: true }
})

export const removeCashExpense = onCall(shiftCallableOptions, async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Silakan login ke POS terlebih dahulu.')
  }
  await requireStaffRole(request.auth.uid, ['owner', 'supervisor', 'cashier'])
  const expenseId = callableData(request.data).expenseId
  if (typeof expenseId !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(expenseId)) {
    throw new HttpsError('invalid-argument', 'Pengeluaran tidak valid.')
  }

  const database = getFirestore()
  const uid = request.auth.uid
  await database.runTransaction(async (transaction) => {
    const state = await transaction.get(shiftStateRef())
    if (!state.exists || state.get('cashierUid') !== uid) {
      throw new HttpsError('failed-precondition', 'Anda belum membuka shift.')
    }
    const shiftRef = database.collection('shifts').doc(state.get('shiftId') as string)
    const expenseRef = shiftRef.collection('expenses').doc(expenseId)
    const expense = await transaction.get(expenseRef)
    if (!expense.exists || expense.get('removed') === true) return
    transaction.update(expenseRef, { removed: true, removedAt: FieldValue.serverTimestamp() })
    transaction.update(shiftRef, {
      [`spent.${String(expense.get('category'))}`]: FieldValue.increment(-(expense.get('amount') as number)),
    })
  })
  return { ok: true }
})

export const closeShift = onCall({ ...shiftCallableOptions, secrets: [reportSmtpUser, reportSmtpPass] }, async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Silakan login ke POS terlebih dahulu.')
  }
  const staff = await requireStaffRole(request.auth.uid, ['owner', 'supervisor', 'cashier'])
  if (request.auth.token.forcePasswordChange === true) {
    throw new HttpsError('failed-precondition', 'Ganti password sementara terlebih dahulu.')
  }
  const input = callableData(request.data)
  const countedCash = moneyValue(input.countedCash, 'Uang tunai di laci', 1_000_000_000)
  const note = typeof input.note === 'string' ? input.note.trim() : ''
  if (note.length > 200) {
    throw new HttpsError('invalid-argument', 'Catatan maksimal 200 karakter.')
  }

  const database = getFirestore()
  const uid = request.auth.uid
  const stateRef = shiftStateRef()
  const summary = await database.runTransaction(async (transaction) => {
    const state = await transaction.get(stateRef)
    if (!state.exists) {
      throw new HttpsError('failed-precondition', 'Tidak ada shift yang sedang terbuka.')
    }
    if (state.get('cashierUid') !== uid && staff.role === 'cashier') {
      throw new HttpsError('permission-denied', 'Closing hanya bisa dilakukan oleh kasir shift ini.')
    }
    const shiftRef = database.collection('shifts').doc(state.get('shiftId') as string)
    const shift = await transaction.get(shiftRef)
    if (!shift.exists || shift.get('status') !== 'open') {
      throw new HttpsError('failed-precondition', 'Shift sudah ditutup.')
    }
    const funds = shift.get('funds') as ShiftFunds
    const spent = shift.get('spent') as Record<string, number>
    const totals = shift.get('totals') as Record<string, number>
    const fundTotal = funds.change + funds.nempil + funds.sales + funds.ops
    const spentTotal = (spent.nempil ?? 0) + (spent.sales ?? 0) + (spent.ops ?? 0)
    const expectedCash = fundTotal + (totals.cash ?? 0) - spentTotal
    const difference = countedCash - expectedCash
    if (difference !== 0 && note.length < 3) {
      throw new HttpsError('invalid-argument', 'Ada selisih uang. Isi catatan penyebab selisih.')
    }
    transaction.update(shiftRef, {
      status: 'closed',
      closedAt: FieldValue.serverTimestamp(),
      closedByUid: uid,
      closedByName: staff.displayName,
      countedCash,
      expectedCash,
      difference,
      closeNote: note,
    })
    transaction.delete(stateRef)
    transaction.set(storeStatusRef(), {
      cashierOnline: false,
      cashierName: '',
      updatedAt: FieldValue.serverTimestamp(),
    })
    return { shiftId: shiftRef.id, expectedCash, countedCash, difference }
  })
  logger.info('Shift closed.', { ...summary, actorUid: uid })
  const report = await buildShiftReport(summary.shiftId, staff.displayName ?? '')
  const emailSent = await sendShiftReportEmail(summary.shiftId, report.text, report.cashierName)
  return { ...summary, reportText: report.text, emailSent }
})

