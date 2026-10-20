import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import {
  onAuthStateChanged,
  sendPasswordResetEmail,
  signInWithCustomToken,
  signInWithEmailAndPassword,
  signOut,
  type User,
} from 'firebase/auth'
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  onSnapshot,
  serverTimestamp,
  setDoc,
  updateDoc,
} from 'firebase/firestore'
import { httpsCallable } from 'firebase/functions'
import { database } from './firebase'
import B2bCashier from './B2bCashier'
import type { B2bMember, B2bReceipt, B2bSaleRequest } from './B2bCashier'
import B2bMembers from './B2bMembers'
import CatalogPanel from './CatalogPanel'
import SalesHistory from './SalesHistory'
import PendingOrders from './PendingOrders'
import PrinterGate from './PrinterGate'
import YubiCalculator from './YubiCalculator'
import ShopeeWatcher from './ShopeeWatcher'
import { useStoreChats } from './LiveChat'
import AllChats from './AllChats'
import StaffOnline, { useOnlineStaff, usePresence } from './StaffOnline'
import MarketplaceTiktok from './MarketplaceTiktok'
import OpsToasts from './OpsToasts'
import { playSound, pushToast, setOps, useOps } from './opsStore'
import MarketplaceShopee from './MarketplaceShopee'
import RetailMembers from './RetailMembers'
import { useMemberData } from './memberData'
import WebOrders, { useWebOrders } from './WebOrders'
import { ClosedScreen, ClosingPanel, ExpensesPanel, OpenShiftGate, ShiftBlocked, useShift } from './Shifts'
import type { CloseSummary } from './Shifts'
import { usePrinter } from './printer'
import type { PendingOrder } from './PendingOrders'
import RetailCashier from './RetailCashier'
import type { SaleReceipt, SaleRequest } from './RetailCashier'
import type { CartLine } from './retailPricing'
import { auth, functions } from './posFirebase'
import './PosApp.css'
import './PosTheme.css'

type CatalogItem = {
  sku: string
  name: string
  category: string
  unit: string
  retailPrice: number
  minQty: number
}

type StaffProfile = {
  role: 'owner' | 'supervisor' | 'cashier'
  active: boolean
  displayName: string
  loginId?: string
}

type StaffMember = {
  uid: string
  loginId: string
  displayName: string
}

type TemporaryCredential = {
  loginId: string
  displayName: string
  temporaryPassword: string
}

type StockCountInput = {
  sku: string
  quantity: number
}

const posNavigation = [
  { id: 'retail', label: 'Kasir Retail', icon: '🛒', group: 'KASIR', ready: true },
  { id: 'b2b', label: 'Kasir B2B', icon: '💻', group: 'KASIR', ready: true },
  { id: 'pending', label: 'Pending Order', icon: '⏳', group: 'KASIR', ready: true },
  { id: 'expenses', label: 'Pengeluaran Kas', icon: '🧾', group: 'KAS & SHIFT', ready: true },
  { id: 'closing', label: 'Closing Shift', icon: '📕', group: 'KAS & SHIFT', ready: true },
  { id: 'sales-history', label: 'Riwayat Penjualan', icon: '📜', group: 'LAPORAN & DATA', ready: true },
  { id: 'catalog', label: 'Katalog Produk', icon: '📒', group: 'LAPORAN & DATA', ready: true },
  { id: 'stock', label: 'Stok Produk', icon: '📦', group: 'LAPORAN & DATA', ready: true },
  { id: 'b2b-members', label: 'Member B2B', icon: '🪪', group: 'MEMBER', ready: true },
  { id: 'retail-members', label: 'Member Retail', icon: '🎫', group: 'MEMBER', ready: true },
  { id: 'web-order', label: 'Web Order', icon: '🌐', group: 'ONLINE', ready: true },
  { id: 'marketplace', label: 'Marketplace Shopee', icon: '🟧', group: 'ONLINE', ready: true },
  { id: 'tiktok', label: 'Marketplace Tokopedia/TikTok', icon: 'ᕷ', group: 'ONLINE', ready: true },
  { id: 'monitor', label: 'Kasir Online', icon: '👩🏻‍💻', group: 'KAS & SHIFT', ready: true },
  { id: 'chat', label: 'Semua Chat', icon: '🗫', group: 'ONLINE', ready: true },
] as const

type InventoryItem = {
  onHand: number
  unit: string
}

type ProfileStatus = 'loading' | 'ready' | 'missing' | 'error'

const currency = new Intl.NumberFormat('id-ID', {
  style: 'currency',
  currency: 'IDR',
  maximumFractionDigits: 0,
})
const quantityFormat = new Intl.NumberFormat('id-ID', {
  maximumFractionDigits: 3,
})

function parseCatalogItem(id: string, data: Record<string, unknown>): CatalogItem {
  if (
    typeof data.sku !== 'string' ||
    typeof data.name !== 'string' ||
    typeof data.category !== 'string' ||
    typeof data.unit !== 'string' ||
    typeof data.retailPrice !== 'number' ||
    typeof data.minQty !== 'number'
  ) {
    throw new Error(`Data katalog untuk ${id} tidak valid.`)
  }

  return {
    sku: data.sku,
    name: data.name,
    category: data.category,
    unit: data.unit,
    retailPrice: data.retailPrice,
    minQty: data.minQty,
  }
}

type StockRowProps = {
  product: CatalogItem
  stock: InventoryItem | undefined
  canEdit: boolean
  onSave: (sku: string, quantity: number, reason: string) => Promise<void>
}

function StockRow({ product, stock, canEdit, onSave }: StockRowProps) {
  const [quantityDraft, setQuantityDraft] = useState<string | null>(null)
  const [reason, setReason] = useState('')
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')
  const quantity = quantityDraft ?? (stock ? String(stock.onHand) : '')

  async function submitStock(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setMessage('')
    const parsedQuantity = Number(quantity)
    if (quantity.trim() === '' || !Number.isFinite(parsedQuantity) || parsedQuantity < 0) {
      setMessage('Masukkan jumlah stok nol atau lebih.')
      return
    }

    setSaving(true)
    try {
      await onSave(product.sku, parsedQuantity, reason)
      setMessage('Stok tersimpan.')
      setQuantityDraft(null)
      setReason('')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Stok gagal disimpan.')
    } finally {
      setSaving(false)
    }
  }

  const isCounted = stock !== undefined

  return (
    <article className="stock-row">
      <div className="stock-product">
        <span className="stock-category">{product.category}</span>
        <h3>{product.name}</h3>
        <span className="stock-sku">{product.sku}</span>
      </div>
      <div className="stock-price">
        <span>Harga retail</span>
        <strong>{currency.format(product.retailPrice)}</strong>
        <small>Min. {quantityFormat.format(product.minQty)} {product.unit}</small>
      </div>
      <div className={`stock-current${isCounted ? ' is-counted' : ' is-uncounted'}`}>
        <span>Stok saat ini</span>
        <strong>
          {isCounted
            ? `${quantityFormat.format(stock.onHand)} ${stock.unit}`
            : 'Belum dihitung'}
        </strong>
      </div>
      {canEdit ? (
        <form className="stock-entry" onSubmit={(event) => void submitStock(event)}>
          <label>
            <span>{isCounted ? 'Hasil hitung fisik' : 'Stok pembukaan'}</span>
            <div className="quantity-input">
              <input
                type="number"
                min="0"
                step={product.unit.toUpperCase() === 'KG' ? '0.001' : '1'}
                value={quantity}
                onChange={(event) => setQuantityDraft(event.target.value)}
                required
                aria-label={`Jumlah stok ${product.name}`}
              />
              <span>{product.unit}</span>
            </div>
          </label>
          <label className="stock-reason">
            <span>Catatan (opsional)</span>
            <input
              type="text"
              maxLength={160}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Contoh: hitung stok rak"
            />
          </label>
          <button className="stock-save" type="submit" disabled={saving}>
            {saving ? 'Menyimpan...' : isCounted ? 'Simpan hitungan' : 'Catat stok'}
          </button>
          {message && (
            <p className={`stock-message${message === 'Stok tersimpan.' ? ' success' : ''}`} role="status">
              {message}
            </p>
          )}
        </form>
      ) : (
        <div className="stock-readonly">
          <span>Akses kasir</span>
          <strong>Hanya lihat stok</strong>
        </div>
      )}
    </article>
  )
}

function PosLogin() {
  const [loginId, setLoginId] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')

  async function handleLogin(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setBusy(true)
    setMessage('')
    try {
      if (loginId.includes('@')) {
        await signInWithEmailAndPassword(auth, loginId.trim(), password)
        return
      }

      const login = httpsCallable<
        { loginId: string; password: string },
        { customToken: string; forcePasswordChange: boolean }
      >(functions, 'loginWithStaffId')
      const result = await login({ loginId: loginId.trim(), password })
      await signInWithCustomToken(auth, result.data.customToken)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Login gagal.')
    } finally {
      setBusy(false)
    }
  }

  async function handlePasswordReset() {
    if (!loginId.includes('@')) {
      setMessage('Kasir tanpa email harus meminta owner atau supervisor mereset password.')
      return
    }

    setBusy(true)
    setMessage('')
    try {
      await sendPasswordResetEmail(auth, loginId.trim())
      setMessage('Jika email terdaftar, tautan reset password sudah dikirim.')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Tautan reset gagal dikirim.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="pos-login-page">
      <a className="pos-back-link" href="/">← Kembali ke 2goFresh</a>
      <section className="pos-login-card">
        <div className="pos-logo-mark" aria-hidden="true">2go<span>✳</span></div>
        <p className="pos-eyebrow">RUANG TOKO · 2GOFRESH</p>
        <h1>Selamat datang.</h1>
        <p className="pos-login-copy">
          Masuk dengan email untuk owner/supervisor, atau ID kasir untuk akun kasir.
        </p>
        <form onSubmit={(event) => void handleLogin(event)}>
          <label>
            Email atau ID kasir
            <input
              type="text"
              autoComplete="username"
              value={loginId}
              onChange={(event) => setLoginId(event.target.value)}
              required
            />
          </label>
          <label>
            Password
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
            />
          </label>
          {message && <p className="pos-login-message" role="alert">{message}</p>}
          <button className="pos-login-button" type="submit" disabled={busy}>
            {busy ? 'Memeriksa akun...' : 'Masuk ke POS'}
          </button>
        </form>
        <button
          className="pos-reset-button"
          type="button"
          onClick={() => void handlePasswordReset()}
          disabled={busy}
        >
          Lupa password email? Kirim tautan reset
        </button>
        <p className="pos-private-note">
          Lupa password? Minta owner atau supervisor mereset akun Anda.
        </p>
      </section>
    </main>
  )
}

function ChangeTemporaryPassword({
  displayName,
  onChanged,
}: {
  displayName: string
  onChanged: () => void
}) {
  const [password, setPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setMessage('')
    if (password.length < 12) {
      setMessage('Gunakan password baru minimal 12 karakter.')
      return
    }
    if (password !== confirmation) {
      setMessage('Konfirmasi password belum sama.')
      return
    }

    setBusy(true)
    try {
      const changePassword = httpsCallable<
        { password: string },
        { customToken: string }
      >(functions, 'changeStaffPassword')
      const result = await changePassword({ password })
      await signInWithCustomToken(auth, result.data.customToken)
      onChanged()
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Password gagal diganti.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="pos-login-page">
      <section className="pos-login-card">
        <div className="pos-logo-mark" aria-hidden="true">2go<span>✳</span></div>
        <p className="pos-eyebrow">RUANG TOKO · 2GOFRESH</p>
        <h1>Ganti password.</h1>
        <p className="pos-login-copy">
          Halo {displayName}, buat password baru pribadi untuk melanjutkan.
          Gunakan minimal 12 karakter dan jangan bagikan kepada siapa pun.
        </p>
        <form onSubmit={(event) => void handleSubmit(event)}>
          <label>
            Password baru
            <input
              type="password"
              autoComplete="new-password"
              minLength={12}
              maxLength={128}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
            />
          </label>
          <label>
            Ulangi password baru
            <input
              type="password"
              autoComplete="new-password"
              minLength={12}
              maxLength={128}
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
              required
            />
          </label>
          {message && <p className="pos-login-message" role="alert">{message}</p>}
          <button className="pos-login-button" type="submit" disabled={busy}>
            {busy ? 'Menyimpan...' : 'Simpan password baru'}
          </button>
        </form>
      </section>
    </main>
  )
}

function StaffAccountPanel({
  isOwner,
  staffMembers,
  onInitialize,
  onReset,
}: {
  isOwner: boolean
  staffMembers: StaffMember[]
  onInitialize: () => Promise<TemporaryCredential[]>
  onReset: (loginId: string) => Promise<TemporaryCredential>
}) {
  const [busyLoginId, setBusyLoginId] = useState('')
  const [message, setMessage] = useState('')
  const [temporaryCredentials, setTemporaryCredentials] = useState<TemporaryCredential[]>([])

  async function initializeAccounts() {
    setBusyLoginId('initialize')
    setMessage('')
    setTemporaryCredentials([])
    try {
      const accounts = await onInitialize()
      setTemporaryCredentials(accounts)
      setMessage(
        accounts.length > 0
          ? 'Akun baru dibuat. Serahkan password sementara secara pribadi; kasir wajib menggantinya saat login pertama.'
          : 'Semua akun kasir sudah dibuat.',
      )
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Akun kasir gagal dibuat.')
    } finally {
      setBusyLoginId('')
    }
  }

  async function resetPassword(member: StaffMember) {
    setBusyLoginId(member.loginId)
    setMessage('')
    setTemporaryCredentials([])
    try {
      const result = await onReset(member.loginId)
      setTemporaryCredentials([result])
      setMessage(
        'Password sementara hanya ditampilkan kali ini. Serahkan langsung kepada kasir; jangan kirim password lama.',
      )
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Reset password gagal.')
    } finally {
      setBusyLoginId('')
    }
  }

  return (
    <section className="pos-staff-admin">
      <div className="pos-staff-admin-heading">
        <div>
          <p className="pos-eyebrow">AKSES TIM</p>
          <h2>Akun kasir</h2>
          <p>Reset akan membuat password sementara baru dan mengeluarkan sesi lama kasir.</p>
        </div>
        {isOwner && (
          <button
            type="button"
            className="pos-account-button"
            onClick={() => void initializeAccounts()}
            disabled={busyLoginId !== ''}
          >
            {busyLoginId === 'initialize' ? 'Menyiapkan...' : 'Siapkan akun kasir'}
          </button>
        )}
      </div>

      {message && <p className="pos-account-message" role="status">{message}</p>}
      {temporaryCredentials.length > 0 && (
        <div className="pos-temporary-credentials">
          {temporaryCredentials.map((credential) => (
            <p key={credential.loginId}>
              <strong>{credential.displayName} · {credential.loginId}</strong>
              <code>{credential.temporaryPassword}</code>
            </p>
          ))}
        </div>
      )}

      <div className="pos-staff-list">
        {staffMembers.map((member) => (
          <article key={member.uid}>
            <div>
              <strong>{member.displayName}</strong>
              <span>ID kasir: {member.loginId}</span>
            </div>
            <button
              type="button"
              className="pos-account-button secondary"
              onClick={() => void resetPassword(member)}
              disabled={busyLoginId !== ''}
            >
              {busyLoginId === member.loginId ? 'Mereset...' : 'Reset password'}
            </button>
          </article>
        ))}
        {staffMembers.length === 0 && (
          <p className="pos-account-empty">
            Belum ada akun kasir. Owner dapat menyiapkannya di sini.
          </p>
        )}
      </div>
    </section>
  )
}

function BulkStockPanel({
  products,
  inventory,
  onSaveBatch,
}: {
  products: CatalogItem[]
  inventory: Record<string, InventoryItem>
  onSaveBatch: (items: StockCountInput[], reason: string) => Promise<void>
}) {
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [reason, setReason] = useState('')
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')

  const pendingItems = products.flatMap((product) => {
    const draft = drafts[product.sku.toLowerCase()]
    if (draft === undefined || draft.trim() === '') {
      return []
    }
    const quantity = Number(draft)
    if (!Number.isFinite(quantity) || quantity < 0) {
      return [{ sku: product.sku, quantity: Number.NaN }]
    }
    return [{ sku: product.sku, quantity }]
  })

  async function submitBulkStock(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setMessage('')
    if (pendingItems.length === 0) {
      setMessage('Isi stok untuk minimal satu produk sebelum menyimpan.')
      return
    }
    const invalidProduct = pendingItems.find((item) => {
      const product = products.find((candidate) => candidate.sku === item.sku)
      return (
        !Number.isFinite(item.quantity) ||
        (product?.unit.toUpperCase() !== 'KG' && !Number.isInteger(item.quantity))
      )
    })
    if (invalidProduct) {
      setMessage(`Jumlah stok ${invalidProduct.sku} tidak valid untuk satuannya.`)
      return
    }

    setSaving(true)
    let savedCount = 0
    try {
      for (let index = 0; index < pendingItems.length; index += 200) {
        const chunk = pendingItems.slice(index, index + 200)
        await onSaveBatch(chunk, reason)
        savedCount += chunk.length
        setDrafts((current) => {
          const next = { ...current }
          chunk.forEach((item) => delete next[item.sku.toLowerCase()])
          return next
        })
      }
      setReason('')
      setMessage(`${savedCount} produk berhasil diperbarui dan dicatat di riwayat mutasi.`)
    } catch (error) {
      setMessage(
        savedCount > 0
          ? `${savedCount} produk berhasil disimpan. Batch selanjutnya gagal: ${
              error instanceof Error ? error.message : 'Terjadi kesalahan.'
            } Stok yang belum tersimpan tetap ada di tabel.`
          : error instanceof Error
            ? error.message
            : 'Update stok massal gagal. Data masih ada di tabel.',
      )
    } finally {
      setSaving(false)
    }
  }

  return (
    <form className="pos-bulk-stock" onSubmit={(event) => void submitBulkStock(event)}>
      <div className="pos-bulk-stock-heading">
        <div>
          <h3>Update stok massal</h3>
          <p>Isi jumlah hanya untuk produk yang dihitung. Kolom kosong tidak akan diubah.</p>
        </div>
        <span>{pendingItems.length} produk diisi</span>
      </div>
      <label className="pos-bulk-reason">
        <span>Catatan untuk riwayat mutasi (opsional, berlaku untuk semua produk)</span>
        <input
          type="text"
          maxLength={160}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          placeholder="Contoh: stok opname 18 Oktober"
          disabled={saving}
        />
      </label>
      <div className="pos-bulk-table-scroll">
        <table className="pos-bulk-table">
          <thead>
            <tr>
              <th>Produk</th>
              <th>SKU</th>
              <th>Stok saat ini</th>
              <th>Jumlah hitung</th>
            </tr>
          </thead>
          <tbody>
            {products.map((product) => {
              const key = product.sku.toLowerCase()
              const stock = inventory[key]
              return (
                <tr key={key}>
                  <td>{product.name}</td>
                  <td>{product.sku}</td>
                  <td>{stock ? `${quantityFormat.format(stock.onHand)} ${stock.unit}` : 'Belum dihitung'}</td>
                  <td>
                    <div className="pos-bulk-quantity">
                      <input
                        type="number"
                        min="0"
                        step={product.unit.toUpperCase() === 'KG' ? '0.001' : '1'}
                        value={drafts[key] ?? ''}
                        onChange={(event) =>
                          setDrafts((current) => ({ ...current, [key]: event.target.value }))
                        }
                        aria-label={`Jumlah hitung stok ${product.name}`}
                        disabled={saving}
                      />
                      <span>{product.unit}</span>
                    </div>
                  </td>
                </tr>
              )
            })}
            {products.length === 0 && (
              <tr><td colSpan={4}>Tidak ada produk yang cocok dengan pencarian.</td></tr>
            )}
          </tbody>
        </table>
      </div>
      {message && <p className="pos-account-message" role="status">{message}</p>}
      <button className="pos-account-button" type="submit" disabled={saving || pendingItems.length === 0}>
        {saving ? 'Menyimpan stok...' : `Simpan ${pendingItems.length} produk`}
      </button>
    </form>
  )
}

function BulkStockAdjustmentPanel({
  products,
  visibleProducts,
  inventory,
  onAddBatch,
}: {
  products: CatalogItem[]
  visibleProducts: CatalogItem[]
  inventory: Record<string, InventoryItem>
  onAddBatch: (
    items: StockCountInput[],
    reason: string,
    requestId: string,
  ) => Promise<void>
}) {
  const [selectedSkus, setSelectedSkus] = useState<Set<string>>(() => new Set())
  const [quantity, setQuantity] = useState('')
  const [reason, setReason] = useState('')
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')
  const requestIds = useRef(new Map<string, string>())

  const selectedProducts = products.filter((product) =>
    selectedSkus.has(product.sku.toLowerCase()),
  )
  const allVisibleSelected =
    visibleProducts.length > 0 &&
    visibleProducts.every((product) => selectedSkus.has(product.sku.toLowerCase()))

  function toggleVisibleProducts() {
    setSelectedSkus((current) => {
      const next = new Set(current)
      if (allVisibleSelected) {
        visibleProducts.forEach((product) => next.delete(product.sku.toLowerCase()))
      } else {
        visibleProducts.forEach((product) => next.add(product.sku.toLowerCase()))
      }
      return next
    })
  }

  function toggleProduct(sku: string) {
    const key = sku.toLowerCase()
    setSelectedSkus((current) => {
      const next = new Set(current)
      if (next.has(key)) {
        next.delete(key)
      } else {
        next.add(key)
      }
      return next
    })
  }

  async function submitAdjustment(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setMessage('')
    const amount = Number(quantity)
    if (!Number.isFinite(amount) || amount <= 0 || amount > 1_000_000) {
      setMessage('Masukkan jumlah penambahan lebih dari 0 dan maksimal 1.000.000.')
      return
    }
    if (selectedProducts.length === 0) {
      setMessage('Pilih minimal satu produk yang akan ditambah stoknya.')
      return
    }
    const fractionalForWholeUnit = selectedProducts.find(
      (product) => product.unit.toUpperCase() !== 'KG' && !Number.isInteger(amount),
    )
    if (fractionalForWholeUnit) {
      setMessage(`Penambahan untuk ${fractionalForWholeUnit.unit} harus bilangan bulat.`)
      return
    }
    const kgCount = selectedProducts.filter(
      (product) => product.unit.toUpperCase() === 'KG',
    ).length
    if (
      kgCount > 0 &&
      !window.confirm(
        `Pilihan mencakup ${kgCount} produk satuan KG. Tambahkan ${quantity} KG ke stok setiap produk KG yang dipilih?`,
      )
    ) {
      return
    }

    setSaving(true)
    let savedCount = 0
    try {
      for (let index = 0; index < selectedProducts.length; index += 200) {
        const chunk = selectedProducts.slice(index, index + 200)
        const batchKey = `${amount}|${reason}|${chunk
          .map((product) => product.sku.toLowerCase())
          .sort()
          .join(',')}`
        const requestId = requestIds.current.get(batchKey) ?? crypto.randomUUID()
        requestIds.current.set(batchKey, requestId)
        await onAddBatch(
          chunk.map((product) => ({ sku: product.sku, quantity: amount })),
          reason,
          requestId,
        )
        requestIds.current.delete(batchKey)
        savedCount += chunk.length
        setSelectedSkus((current) => {
          const next = new Set(current)
          chunk.forEach((product) => next.delete(product.sku.toLowerCase()))
          return next
        })
      }
      setQuantity('')
      setReason('')
      setMessage(`${savedCount} produk berhasil ditambah ${amount} unit dan dicatat di riwayat mutasi.`)
    } catch (error) {
      setMessage(
        savedCount > 0
          ? `${savedCount} produk berhasil ditambah. Batch selanjutnya gagal: ${
              error instanceof Error ? error.message : 'Terjadi kesalahan.'
            } Produk yang belum diproses tetap terpilih.`
          : error instanceof Error
            ? error.message
            : 'Penambahan stok gagal. Pilihan tetap tersimpan.',
      )
    } finally {
      setSaving(false)
    }
  }

  return (
    <form className="pos-bulk-stock" onSubmit={(event) => void submitAdjustment(event)}>
      <div className="pos-bulk-stock-heading">
        <div>
          <h3>Tambah stok ke produk terpilih</h3>
          <p>Jumlah yang dimasukkan akan ditambahkan ke stok saat ini untuk setiap produk terpilih.</p>
        </div>
        <span>{selectedProducts.length} produk dipilih</span>
      </div>
      <div className="pos-adjustment-controls">
        <label className="pos-bulk-reason">
          <span>Jumlah yang ditambahkan ke setiap produk</span>
          <input
            type="number"
            min="0.001"
            max="1000000"
            step="any"
            value={quantity}
            onChange={(event) => setQuantity(event.target.value)}
            placeholder="Contoh: 200"
            required
            disabled={saving}
          />
        </label>
        <label className="pos-bulk-reason">
          <span>Catatan riwayat (opsional)</span>
          <input
            type="text"
            maxLength={160}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Contoh: stok tambahan"
            disabled={saving}
          />
        </label>
      </div>
      <div className="pos-bulk-selection-toolbar">
        <label>
          <input
            type="checkbox"
            checked={allVisibleSelected}
            onChange={toggleVisibleProducts}
            disabled={saving || visibleProducts.length === 0}
          />
          Pilih semua hasil yang terlihat ({visibleProducts.length})
        </label>
        <button
          type="button"
          className="pos-account-button secondary"
          onClick={() => setSelectedSkus(new Set())}
          disabled={saving || selectedProducts.length === 0}
        >
          Hapus pilihan
        </button>
      </div>
      <div className="pos-bulk-table-scroll">
        <table className="pos-bulk-table pos-bulk-adjustment-table">
          <thead>
            <tr>
              <th>Pilih</th>
              <th>Produk</th>
              <th>SKU</th>
              <th>Stok sekarang</th>
              <th>Stok setelah ditambah</th>
            </tr>
          </thead>
          <tbody>
            {visibleProducts.map((product) => {
              const key = product.sku.toLowerCase()
              const stock = inventory[key]
              const onHand = stock?.onHand ?? 0
              const amount = Number(quantity)
              const projected =
                selectedSkus.has(key) && Number.isFinite(amount) && amount > 0
                  ? `${quantityFormat.format(onHand + amount)} ${product.unit}`
                  : '—'
              return (
                <tr key={key}>
                  <td>
                    <input
                      type="checkbox"
                      checked={selectedSkus.has(key)}
                      onChange={() => toggleProduct(product.sku)}
                      aria-label={`Pilih ${product.name}`}
                      disabled={saving}
                    />
                  </td>
                  <td>{product.name}</td>
                  <td>{product.sku}</td>
                  <td>{stock ? `${quantityFormat.format(stock.onHand)} ${stock.unit}` : `0 ${product.unit}`}</td>
                  <td>{projected}</td>
                </tr>
              )
            })}
            {visibleProducts.length === 0 && (
              <tr><td colSpan={5}>Tidak ada produk yang cocok dengan pencarian.</td></tr>
            )}
          </tbody>
        </table>
      </div>
      {message && <p className="pos-account-message" role="status">{message}</p>}
      <button
        className="pos-account-button"
        type="submit"
        disabled={saving || selectedProducts.length === 0 || quantity === ''}
      >
        {saving
          ? 'Menambah stok...'
          : `Tambah stok sekarang · ${selectedProducts.length} produk`}
      </button>
    </form>
  )
}

function PosApp() {
  const [user, setUser] = useState<User | null>(null)
  const [authLoading, setAuthLoading] = useState(true)
  const [passwordChangeRequired, setPasswordChangeRequired] = useState<boolean | null>(null)
  const [sessionDisplayName, setSessionDisplayName] = useState('Staf')
  const [profileStatus, setProfileStatus] = useState<ProfileStatus>('loading')
  const [profile, setProfile] = useState<StaffProfile | null>(null)
  const [profileError, setProfileError] = useState('')
  const [staffMembers, setStaffMembers] = useState<StaffMember[]>([])
  const [catalog, setCatalog] = useState<CatalogItem[]>([])
  const [inventory, setInventory] = useState<Record<string, InventoryItem>>({})
  const [dataError, setDataError] = useState('')
  const [search, setSearch] = useState('')
  const [savingSku, setSavingSku] = useState('')
  const [bulkMode, setBulkMode] = useState<'off' | 'count' | 'add'>('off')
  const [activePanel, setActivePanel] = useState(() => {
    const requestedPanel = new URLSearchParams(window.location.search).get('panel')
    return requestedPanel || 'retail'
  })
  const [cart, setCart] = useState<CartLine[]>([])
  const [pendingOrders, setPendingOrders] = useState<PendingOrder[]>([])
  const [resumed, setResumed] = useState<{ id: string; label: string } | null>(null)
  const [waPhone, setWaPhone] = useState('')
  const [b2bCart, setB2bCart] = useState<CartLine[]>([])
  const [b2bPhone, setB2bPhone] = useState('')
  const [resumedB2b, setResumedB2b] = useState<{ id: string; label: string } | null>(null)
  const [b2bPrices, setB2bPrices] = useState<Record<string, number>>({})
  const [b2bMembers, setB2bMembers] = useState<B2bMember[]>([])
  const [pendingBusyId, setPendingBusyId] = useState('')
  const [closedSummary, setClosedSummary] = useState<CloseSummary | null>(null)
  const shiftData = useShift(profileStatus === 'ready' && passwordChangeRequired === false)
  const dataReady = profileStatus === 'ready' && passwordChangeRequired === false
  const memberData = useMemberData(dataReady)
  const webOrderData = useWebOrders(dataReady)
  const chatData = useStoreChats(dataReady)
  const enableChatSound = chatData.enableSound
  const ops = useOps()
  const isManager = profile?.role === 'owner' || profile?.role === 'supervisor'
  usePresence(dataReady, user?.uid, profile?.displayName ?? '', profile?.role ?? '', activePanel)
  const staffOnline = useOnlineStaff(dataReady && isManager)
  const knownWebOrders = useRef<Set<string> | null>(null)
  useEffect(() => {
    const seen = knownWebOrders.current
    const fresh = webOrderData.orders.filter((order) => order.status === 'new' && !seen?.has(order.id))
    knownWebOrders.current = new Set(webOrderData.orders.map((order) => order.id))
    if (!seen || fresh.length === 0) return
    playSound('/order_masuk.mp3')
    for (const order of fresh) {
      pushToast({ icon: '🛒', title: `Web Order baru ${order.orderNo}`, body: `${order.customerName || 'Pelanggan'} · ${currency.format(order.total)}`, sticky: true, actions: [{ label: 'Buka Web Order', panel: 'web-order' }] })
    }
  }, [webOrderData.orders])

  useEffect(() => {
    if (!ops.navRequest) return
    const target = ops.navRequest
    setOps({ navRequest: '' })
    setActivePanel(target)
    const url = new URL(window.location.href)
    url.searchParams.set('panel', target)
    window.history.pushState({ panel: target }, '', url)
    if (!window.matchMedia('(min-width: 901px)').matches) setSidebarOpen(false)
  }, [ops.navRequest])

  useEffect(() => {
    const syncPanel = () => {
      setActivePanel(new URLSearchParams(window.location.search).get('panel') || 'retail')
    }
    window.addEventListener('popstate', syncPanel)
    return () => window.removeEventListener('popstate', syncPanel)
  }, [])
  const ownedShiftRef = useRef('')
  const closedHereRef = useRef(false)

  useEffect(() => {
    closedHereRef.current = closedSummary !== null
    if (closedSummary) ownedShiftRef.current = ''
  }, [closedSummary])

  // Another device closed this cashier's shift: sign this one out to prevent a double closing.
  useEffect(() => {
    const state = shiftData.state
    if (!user) return
    if (state && state.cashierUid === user.uid) {
      ownedShiftRef.current = state.shiftId
      return
    }
    if (state === null && ownedShiftRef.current) {
      const timer = window.setTimeout(() => {
        if (!closedHereRef.current && ownedShiftRef.current) {
          ownedShiftRef.current = ''
          void signOut(auth)
        }
      }, 4000)
      return () => window.clearTimeout(timer)
    }
  }, [shiftData.state, user])
  useEffect(() => {
    window.addEventListener('pointerdown', enableChatSound, { once: true })
    return () => window.removeEventListener('pointerdown', enableChatSound)
  }, [enableChatSound])
  const printer = usePrinter()
  const [printerPanelOpen, setPrinterPanelOpen] = useState(false)


  const [sidebarOpen, setSidebarOpen] = useState(
    () => window.matchMedia('(min-width: 901px)').matches,
  )

  useEffect(
    () =>
      onAuthStateChanged(
        auth,
        (currentUser) => {
          setUser(currentUser)
          setAuthLoading(false)
          setProfile(null)
          setProfileStatus(currentUser ? 'loading' : 'missing')
          setPasswordChangeRequired(currentUser ? null : false)
          setStaffMembers([])
        },
        (error) => {
          setProfileError(error.message)
          setProfileStatus('error')
          setAuthLoading(false)
        },
      ),
    [],
  )

  useEffect(() => {
    if (!user) {
      return
    }

    let active = true
    const getSession = httpsCallable<
      Record<string, never>,
      { displayName: string; forcePasswordChange: boolean }
    >(functions, 'getStaffSession')
    void getSession({}).then(
      ({ data }) => {
        if (active) {
          setSessionDisplayName(data.displayName)
          setPasswordChangeRequired(data.forcePasswordChange)
        }
      },
      (error: unknown) => {
        if (active) {
          setProfileError(error instanceof Error ? error.message : 'Akses staf gagal diperiksa.')
          setProfileStatus('error')
          setPasswordChangeRequired(false)
        }
      },
    )
    return () => {
      active = false
    }
  }, [user])

  useEffect(() => {
    if (!user || passwordChangeRequired !== false) {
      return
    }

    return onSnapshot(
      doc(database, 'staff', user.uid),
      (snapshot) => {
        const data = snapshot.data()
        if (
          !snapshot.exists() ||
          data?.active !== true ||
          (data.role !== 'owner' &&
            data.role !== 'supervisor' &&
            data.role !== 'cashier')
        ) {
          setProfile(null)
          setProfileStatus('missing')
          return
        }

        setProfile({
          role: data.role,
          active: data.active,
          displayName:
            typeof data.displayName === 'string'
              ? data.displayName
              : user.email ?? sessionDisplayName,
          ...(typeof data.loginId === 'string' ? { loginId: data.loginId } : {}),
        })
        setProfileStatus('ready')
        setProfileError('')
      },
      (error) => {
        setProfileError(error.message)
        setProfileStatus('error')
      },
    )
  }, [passwordChangeRequired, sessionDisplayName, user])

  useEffect(() => {
    if (
      profileStatus !== 'ready' ||
      (profile?.role !== 'owner' && profile?.role !== 'supervisor')
    ) {
      return
    }

    return onSnapshot(
      collection(database, 'staff'),
      (snapshot) => {
        const next = snapshot.docs.flatMap((document) => {
          const data = document.data()
          if (
            data.role !== 'cashier' ||
            data.active !== true ||
            typeof data.loginId !== 'string' ||
            typeof data.displayName !== 'string'
          ) {
            return []
          }
          return [{
            uid: document.id,
            loginId: data.loginId,
            displayName: data.displayName,
          }]
        })
        setStaffMembers(next.sort((first, second) => first.displayName.localeCompare(second.displayName, 'id')))
      },
      (error) => setDataError(error.message),
    )
  }, [profile?.role, profileStatus])

  useEffect(() => {
    if (!user || profileStatus !== 'ready') {
      return
    }

    const unsubscribeCatalog = onSnapshot(
      collection(database, 'catalogProducts'),
      (snapshot) => {
        try {
          setCatalog(
            snapshot.docs.map((document) =>
              parseCatalogItem(document.id, document.data()),
            ),
          )
          setDataError('')
        } catch (error) {
          setDataError(error instanceof Error ? error.message : 'Katalog tidak valid.')
        }
      },
      (error) => setDataError(error.message),
    )
    const unsubscribeInventory = onSnapshot(
      collection(database, 'inventory'),
      (snapshot) => {
        const next: Record<string, InventoryItem> = {}
        for (const document of snapshot.docs) {
          const data = document.data()
          if (
            typeof data.onHand !== 'number' ||
            !Number.isFinite(data.onHand) ||
            typeof data.unit !== 'string'
          ) {
            setDataError(`Data stok ${document.id} tidak valid.`)
            return
          }
          next[document.id] = { onHand: data.onHand, unit: data.unit }
        }
        setInventory(next)
      },
      (error) => setDataError(error.message),
    )

    const unsubscribePending = onSnapshot(
      collection(database, 'pendingOrders'),
      (snapshot) => {
        const next = snapshot.docs.flatMap((document) => {
          const data = document.data()
          if (!Array.isArray(data.items) || typeof data.label !== 'string') return []
          const items = data.items.flatMap((item: unknown) => {
            const line = item as Partial<CartLine>
            return typeof line?.sku === 'string' &&
              (line.mode === 'quantity' || line.mode === 'nominal') &&
              typeof line.input === 'string'
              ? [{ sku: line.sku, mode: line.mode, input: line.input }]
              : []
          })
          const updated = data.updatedAt?.toDate?.() as Date | undefined
          return [{
            id: document.id,
            channel: data.channel === 'b2b' ? ('b2b' as const) : ('retail' as const),
            label: data.label,
            items,
            memberPhone: typeof data.memberPhone === 'string' ? data.memberPhone : '',
            memberName: typeof data.memberName === 'string' ? data.memberName : '',
            createdByName: typeof data.createdByName === 'string' ? data.createdByName : '',
            updatedAt: updated ?? null,
          }]
        })
        next.sort((a, b) => (a.updatedAt?.getTime() ?? Infinity) - (b.updatedAt?.getTime() ?? Infinity))
        setPendingOrders(next)
      },
      (error) => setDataError(error.message),
    )
    const unsubscribeB2bPrices = onSnapshot(
      collection(database, 'b2bPrices'),
      (snapshot) => {
        const next: Record<string, number> = {}
        for (const document of snapshot.docs) {
          const price = document.data().b2bPrice
          if (typeof price === 'number' && price > 0) next[document.id] = price
        }
        setB2bPrices(next)
      },
      (error) => setDataError(error.message),
    )
    const unsubscribeMembers = onSnapshot(
      collection(database, 'b2bMembers'),
      (snapshot) => {
        setB2bMembers(
          snapshot.docs.flatMap((document) => {
            const data = document.data()
            return typeof data.name === 'string' && typeof data.phone === 'string'
              ? [{ phone: data.phone, name: data.name, active: data.active === true }]
              : []
          }),
        )
      },
      (error) => setDataError(error.message),
    )

    return () => {
      unsubscribeCatalog()
      unsubscribeInventory()
      unsubscribePending()
      unsubscribeB2bPrices()
      unsubscribeMembers()
    }
  }, [profileStatus, user])

  const sortedCatalog = useMemo(
    () =>
      [...catalog].sort(
        (first, second) =>
          first.category.localeCompare(second.category, 'id') ||
          first.name.localeCompare(second.name, 'id'),
      ),
    [catalog],
  )
  const visibleProducts = useMemo(() => {
    const query = search.trim().toLocaleLowerCase('id-ID')
    if (!query) {
      return sortedCatalog
    }
    return sortedCatalog.filter((product) =>
      `${product.sku} ${product.name} ${product.category}`
        .toLocaleLowerCase('id-ID')
        .includes(query),
    )
  }, [search, sortedCatalog])
  const countedProductCount = sortedCatalog.filter(
    (product) => inventory[product.sku.toLowerCase()] !== undefined,
  ).length
  const stockBySku = useMemo(
    () => Object.fromEntries(Object.entries(inventory).map(([sku, item]) => [sku, item.onHand])),
    [inventory],
  )
  const b2bProducts = useMemo(
    () =>
      sortedCatalog.flatMap((product) => {
        const price = b2bPrices[product.sku.toLowerCase()]
        return price ? [{ sku: product.sku, name: product.name, unit: product.unit, retailPrice: price }] : []
      }),
    [b2bPrices, sortedCatalog],
  )

  function selectPanel(panel: string) {
    setActivePanel(panel)
    const url = new URL(window.location.href)
    url.searchParams.set('panel', panel)
    window.history.pushState({ panel }, '', url)
    if (!window.matchMedia('(min-width: 901px)').matches) {
      setSidebarOpen(false)
    }
  }

  async function createRetailSale(request: SaleRequest): Promise<SaleReceipt> {
    const sell = httpsCallable<SaleRequest, SaleReceipt>(functions, 'createRetailSale')
    const receipt = (await sell(request)).data
    if (resumed) {
      try {
        await deleteDoc(doc(database, 'pendingOrders', resumed.id))
      } catch {
        setDataError('Transaksi tersimpan, tetapi pending order lama gagal dihapus. Hapus manual di panel Pending Order.')
      }
      setResumed(null)
    }
    return receipt
  }

  async function pendCart(label: string, waNumber: string) {
    if (!user || cart.length === 0) return
    const payload = {
      label,
      channel: 'retail',
      ...(waNumber ? { memberPhone: waNumber } : {}),
      items: cart.map(({ sku, mode, input }) => ({ sku, mode, input })),
    }
    if (resumed) {
      await updateDoc(doc(database, 'pendingOrders', resumed.id), {
        ...payload,
        label: label || resumed.label,
        updatedAt: serverTimestamp(),
      })
    } else {
      await addDoc(collection(database, 'pendingOrders'), {
        ...payload,
        createdBy: user.uid,
        createdByName: profile?.displayName ?? '',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      })
    }
    setCart([])
    setWaPhone('')
    setResumed(null)
  }

  function resumePending(order: PendingOrder) {
    if (order.channel === 'b2b') {
      setB2bCart(order.items)
      setB2bPhone(order.memberPhone)
      setResumedB2b({ id: order.id, label: order.memberName || order.label })
      selectPanel('b2b')
      return
    }
    setCart(order.items)
    setWaPhone(order.memberPhone)
    setResumed({ id: order.id, label: order.label })
    selectPanel('retail')
  }

  async function createB2bSale(request: B2bSaleRequest): Promise<B2bReceipt> {
    const sell = httpsCallable<B2bSaleRequest, B2bReceipt>(functions, 'createB2bSale')
    const receipt = (await sell(request)).data
    if (resumedB2b) {
      try {
        await deleteDoc(doc(database, 'pendingOrders', resumedB2b.id))
      } catch {
        setDataError('Transaksi tersimpan, tetapi pending order lama gagal dihapus. Hapus manual di panel Pending Order.')
      }
      setResumedB2b(null)
    }
    return receipt
  }

  async function pendB2b(memberPhone: string, memberName: string) {
    if (!user || b2bCart.length === 0) return
    const payload = {
      label: memberName,
      channel: 'b2b',
      memberPhone,
      memberName,
      items: b2bCart.map(({ sku, mode, input }) => ({ sku, mode, input })),
    }
    if (resumedB2b) {
      await updateDoc(doc(database, 'pendingOrders', resumedB2b.id), {
        ...payload,
        updatedAt: serverTimestamp(),
      })
    } else {
      await addDoc(collection(database, 'pendingOrders'), {
        ...payload,
        createdBy: user.uid,
        createdByName: profile?.displayName ?? '',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      })
    }
    setB2bCart([])
    setB2bPhone('')
    setResumedB2b(null)
    selectPanel('pending')
  }

  async function saveB2bMember(member: B2bMember) {
    await setDoc(doc(database, 'b2bMembers', member.phone), {
      name: member.name,
      phone: member.phone,
      active: member.active,
      updatedAt: serverTimestamp(),
    })
  }

  async function deletePending(order: PendingOrder) {
    setPendingBusyId(order.id)
    try {
      await deleteDoc(doc(database, 'pendingOrders', order.id))
      if (resumed?.id === order.id) setResumed(null)
      if (resumedB2b?.id === order.id) setResumedB2b(null)
    } catch (error) {
      setDataError(error instanceof Error ? error.message : 'Pending order gagal dihapus.')
    } finally {
      setPendingBusyId('')
    }
  }

  async function saveStock(sku: string, quantity: number, reason: string) {
    setSavingSku(sku)
    try {
      const setStock = httpsCallable<
        { sku: string; quantity: number; reason: string },
        { sku: string; unit: string; onHand: number }
      >(functions, 'setOpeningStock')
      await setStock({ sku, quantity, reason })
    } finally {
      setSavingSku('')
    }
  }

  async function saveStockBatch(items: StockCountInput[], reason: string) {
    const setStockBatch = httpsCallable<
      { items: StockCountInput[]; reason: string },
      { updatedCount: number }
    >(functions, 'setOpeningStockBatch')
    await setStockBatch({ items, reason })
  }

  async function addStockBatch(
    items: StockCountInput[],
    reason: string,
    requestId: string,
  ) {
    const addStock = httpsCallable<
      { items: StockCountInput[]; reason: string; requestId: string },
      { updatedCount: number }
    >(functions, 'addStockBatch')
    await addStock({ items, reason, requestId })
  }

  async function initializeCashierAccounts(): Promise<TemporaryCredential[]> {
    const initialize = httpsCallable<
      Record<string, never>,
      { accounts: TemporaryCredential[] }
    >(functions, 'initializeCashierAccounts')
    const result = await initialize({})
    return result.data.accounts
  }

  async function resetCashierPassword(loginId: string): Promise<TemporaryCredential> {
    const reset = httpsCallable<
      { loginId: string },
      TemporaryCredential
    >(functions, 'resetCashierPassword')
    const result = await reset({ loginId })
    return result.data
  }

  if (authLoading) {
    return <main className="pos-loading">Membuka ruang toko...</main>
  }

  if (!user) {
    return <PosLogin />
  }

  if (passwordChangeRequired === null) {
    return <main className="pos-loading">Memeriksa sesi staf...</main>
  }

  if (passwordChangeRequired) {
    return (
      <ChangeTemporaryPassword
        displayName={sessionDisplayName}
        onChanged={() => setPasswordChangeRequired(false)}
      />
    )
  }

  if (profileStatus === 'loading') {
    return <main className="pos-loading">Memeriksa akses staf...</main>
  }

  if (profileStatus === 'error') {
    return (
      <main className="pos-access-page">
        <section className="pos-access-card">
          <p className="pos-eyebrow">AKSES POS</p>
          <h1>Akses belum dapat diperiksa.</h1>
          <p role="alert">{profileError}</p>
          <button type="button" onClick={() => void signOut(auth)}>Keluar</button>
        </section>
      </main>
    )
  }

  if (profileStatus === 'missing' || !profile) {
    return (
      <main className="pos-access-page">
        <section className="pos-access-card">
          <p className="pos-eyebrow">AKSES POS</p>
          <h1>Akun belum didaftarkan.</h1>
          <p>
            Minta owner menambahkan profil staf untuk akun ini. UID akun:
          </p>
          <code>{user.uid}</code>
          <p className="pos-setup-hint">
            Di Firestore Console, buat dokumen <code>staff/{user.uid}</code> dengan
            `role` owner, supervisor, atau cashier dan `active` true.
          </p>
          <button type="button" onClick={() => void signOut(auth)}>Keluar</button>
        </section>
      </main>
    )
  }

  const isOwner = profile.role === 'owner'
  const isCashier = profile.role === 'cashier'
  const shiftHolder = shiftData.state ?? null
  const ownsShift = shiftHolder?.cashierUid === user.uid
  const canManageStock = profile.role !== 'cashier'
  const visibleNavigation = posNavigation.filter(
    (item) => item.id === 'monitor' ? canManageStock : canManageStock || (item.ready && item.id !== 'stock' && item.id !== 'b2b-members'),
  )
  const navBadge = (id: string) =>
    id === 'retail-members' ? memberData.pendingCount : id === 'web-order' ? webOrderData.newCount : id === 'chat' ? chatData.unreadTotal + ops.shopeeUnreadChats : id === 'marketplace' ? ops.shopeeToShip : id === 'monitor' ? staffOnline.online.length : 0
  const canManageStaff = profile.role === 'owner' || profile.role === 'supervisor'
  const roleLabel = {
    owner: 'Owner · akses penuh',
    supervisor: 'Supervisor · stok & akun kasir',
    cashier: 'Kasir · hanya lihat stok',
  }[profile.role]

  if (closedSummary) {
    return (
      <ClosedScreen summary={closedSummary} canReturn={!isCashier} onReturn={() => setClosedSummary(null)} />
    )
  }

  if (isCashier) {
    if (shiftData.state === undefined) {
      return <main className="pos-loading">{shiftData.error || 'Memeriksa shift...'}</main>
    }
    if (shiftData.state === null) {
      return <OpenShiftGate displayName={profile.displayName} />
    }
    if (!ownsShift) {
      return <ShiftBlocked holderName={shiftData.state.cashierName} />
    }
  }

  if (printerPanelOpen) {
    return (
      <PrinterGate
        displayName={profile.displayName}
        eyebrow="PRINTER STRUK"
        continueLabel="Kembali ke kasir"
        onContinue={() => setPrinterPanelOpen(false)}
        skipLabel="Kembali ke kasir"
        onSkip={() => setPrinterPanelOpen(false)}
      />
    )
  }

  return (
    <main className="pos-shell">
      <header className="pos-header">
        <button
          type="button"
          className="pos-sidebar-toggle"
          onClick={() => setSidebarOpen((open) => !open)}
          aria-expanded={sidebarOpen}
          aria-controls="pos-sidebar"
          aria-label={sidebarOpen ? 'Tutup menu' : 'Buka menu'}
        >
          {sidebarOpen ? '‹' : '☰'}
        </button>
        <a className="pos-brand" href="/" aria-label="2goFresh POS">
          <span className="pos-logo-mark" aria-hidden="true">2go<span>✳</span></span>
          <span className="pos-brand-copy">
            <strong>2goFresh POS</strong>
            <small><i aria-hidden="true" /> SINKRONISASI · {catalog.length} PRODUK</small>
          </span>
        </a>
        <div className="pos-header-actions">
          <div className="pos-user">
            <span className="pos-avatar" aria-hidden="true">{profile.displayName.slice(0, 1).toUpperCase()}</span>
            <span className="pos-user-text">
              <strong>{profile.displayName}</strong>
              <span>{roleLabel}</span>
            </span>
          </div>
          <span className={`pos-chip ${shiftHolder ? 'on' : 'off'}`}>
            {shiftHolder ? `Shift: ${shiftHolder.cashierName}` : 'Shift tertutup'}
          </span>
          <button
            type="button"
            className={`pos-header-utility ${printer.status === 'connected' ? 'printer-on' : 'printer-off'}`}
            onClick={() => setPrinterPanelOpen(true)}
            title="Kelola koneksi printer"
          >
            ▣ {printer.status === 'connected' ? printer.name : 'Printer terputus'}
          </button>
          <button type="button" className="pos-logout" onClick={() => void signOut(auth)}>Keluar</button>
        </div>
      </header>

      <div className="pos-dashboard">
        <aside
          id="pos-sidebar"
          className={`pos-sidebar${sidebarOpen ? ' open' : ''}`}
          aria-label="Menu POS"
        >
          <nav>
            {visibleNavigation.map((item, index) => (
              <Fragment key={item.id}>
                {(index === 0 || visibleNavigation[index - 1].group !== item.group) && (
                  <p className="pos-nav-group">{item.group}</p>
                )}
                <a
                  href={`${window.location.pathname}?panel=${encodeURIComponent(item.id)}`}
                  className={`pos-nav-item${activePanel === item.id ? ' active' : ''}${item.ready ? '' : ' soon'}`}
                  onClick={(event) => {
                    event.preventDefault()
                    selectPanel(item.id)
                  }}
                  aria-current={activePanel === item.id ? 'page' : undefined}
                >
                  <span className="pos-nav-icon" aria-hidden="true">{item.icon}</span>
                  <span>{item.label}</span>
                  {navBadge(item.id) > 0 && <b className="nav-badge">{navBadge(item.id)}</b>}
                  {item.id === 'pending' && pendingOrders.length > 0 ? (
                    <small className="pos-nav-badge">{pendingOrders.length}</small>
                  ) : (
                    !item.ready && <small>Segera Hadir</small>
                  )}
                </a>
              </Fragment>
            ))}
          </nav>
          {canManageStaff && (
            <div className="pos-sidebar-footer">
              <a
                href={`${window.location.pathname}?panel=staff`}
                className={`pos-nav-item${activePanel === 'staff' ? ' active' : ''}`}
                onClick={(event) => {
                  event.preventDefault()
                  selectPanel('staff')
                }}
                aria-current={activePanel === 'staff' ? 'page' : undefined}
              >
                <span className="pos-nav-icon" aria-hidden="true">♙</span>
                <span>Anggota Kasir</span>
              </a>
            </div>
          )}
        </aside>
        {sidebarOpen && (
          <button
            type="button"
            className="pos-sidebar-backdrop"
            aria-label="Tutup menu"
            onClick={() => setSidebarOpen(false)}
          />
        )}

        <section className="pos-content">
          {activePanel === 'retail' ? (
            <RetailCashier
              products={sortedCatalog}
              stockBySku={stockBySku}
              cart={cart}
              setCart={setCart}
              resumedLabel={resumed ? resumed.label : null}
              waPhone={waPhone}
              setWaPhone={setWaPhone}
              onSale={createRetailSale}
              onPend={pendCart}
            />
          ) : activePanel === 'b2b' ? (
            <B2bCashier
              products={b2bProducts}
              stockBySku={stockBySku}
              members={b2bMembers}
              cart={b2bCart}
              setCart={setB2bCart}
              phone={b2bPhone}
              setPhone={setB2bPhone}
              resumedLabel={resumedB2b ? resumedB2b.label : null}
              onSale={createB2bSale}
              onPend={pendB2b}
            />
          ) : activePanel === 'catalog' ? (
            <CatalogPanel products={sortedCatalog} b2bPrices={b2bPrices} />
          ) : activePanel === 'sales-history' && user ? (
            <SalesHistory uid={user.uid} canSeeAll={canManageStock} canVoid={canManageStock} />
          ) : activePanel === 'b2b-members' ? (
            <B2bMembers members={b2bMembers} canManage={canManageStock} onSave={saveB2bMember} />
          ) : activePanel === 'expenses' ? (
            <ExpensesPanel shift={shiftData.shift} expenses={shiftData.expenses} topups={shiftData.topups} canAdd={ownsShift} />
          ) : activePanel === 'closing' ? (
            <ClosingPanel
              shift={shiftData.shift}
              expenses={shiftData.expenses}
              topups={shiftData.topups}
              holderName={shiftHolder?.cashierName ?? ''}
              canClose={ownsShift || !isCashier}
              uid={user.uid}
              canSeeAll={canManageStock}
              onClosed={setClosedSummary}
            />
          ) : activePanel === 'retail-members' ? (
            <RetailMembers registrations={memberData.registrations} members={memberData.members} />
          ) : activePanel === 'web-order' ? (
            <WebOrders orders={webOrderData.orders} />
          ) : activePanel === 'marketplace' ? (
            <MarketplaceShopee />
          ) : activePanel === 'monitor' && canManageStock ? (
            <StaffOnline shift={shiftData.state && shiftData.shift ? { cashierUid: shiftData.state.cashierUid, cashierName: shiftData.state.cashierName, sales: shiftData.shift.totals.sales, count: shiftData.shift.totals.count, openedAt: shiftData.shift.openedAt } : shiftData.state ? { cashierUid: shiftData.state.cashierUid, cashierName: shiftData.state.cashierName, sales: 0, count: 0, openedAt: null } : null} online={staffOnline.online} offline={staffOnline.offline} now={staffOnline.now} />
          ) : activePanel === 'tiktok' ? (
            <MarketplaceTiktok />
          ) : activePanel === 'chat' ? (
            <AllChats
              storeUnread={chatData.unreadTotal}
              chats={chatData.chats}
              soundOn={chatData.soundOn}
              onEnableSound={chatData.enableSound}
              staffName={profile.displayName}
            />
          ) : activePanel === 'pending' ? (
            <PendingOrders
              orders={pendingOrders}
              retailProducts={sortedCatalog}
              b2bProducts={b2bProducts}
              retailCartInUse={cart.length > 0}
              b2bCartInUse={b2bCart.length > 0}
              busyId={pendingBusyId}
              onResume={resumePending}
              onDelete={deletePending}
            />
          ) : activePanel === 'stock' ? (
            <>
              <div className="pos-page-heading">
                <div>
                  <p className="pos-eyebrow">INVENTARIS TOKO</p>
                  <h1>Stok produk</h1>
                  <p>Kelola stok dan pantau jumlah produk yang sudah dihitung.</p>
                </div>
                <a href="/">Lihat katalog ↗</a>
              </div>

              <div className="pos-summary">
                <article><span>Total produk</span><strong>{sortedCatalog.length}</strong></article>
                <article><span>Sudah dihitung</span><strong>{countedProductCount}</strong></article>
                <article><span>Belum dihitung</span><strong>{Math.max(sortedCatalog.length - countedProductCount, 0)}</strong></article>
              </div>

              <div className="pos-stock-toolbar">
                <div>
                  <h2>{canManageStock ? 'Kelola stok pembukaan' : 'Ringkasan persediaan'}</h2>
                  <p>
                    {canManageStock
                      ? 'Owner dan supervisor dapat mencatat atau memperbarui hitungan stok.'
                      : 'Stok kosong atau belum dihitung akan diblokir dari penjualan.'}
                  </p>
                </div>
                <label className="pos-search">
                  <span aria-hidden="true">⌕</span>
                  <input
                    type="search"
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    placeholder="Cari nama atau SKU"
                    aria-label="Cari nama produk atau SKU"
                  />
                </label>
                {canManageStock && (
                  <div className="pos-stock-actions">
                    <button
                      type="button"
                      className={`pos-account-button${bulkMode === 'count' ? '' : ' secondary'}`}
                      onClick={() => setBulkMode((current) => current === 'count' ? 'off' : 'count')}
                    >
                      Hitung stok massal
                    </button>
                    <button
                      type="button"
                      className={`pos-account-button${bulkMode === 'add' ? '' : ' secondary'}`}
                      onClick={() => setBulkMode((current) => current === 'add' ? 'off' : 'add')}
                    >
                      Tambah stok massal
                    </button>
                  </div>
                )}
              </div>

              {dataError && <p className="pos-data-error" role="alert">{dataError}</p>}
              {savingSku && <p className="pos-saving-status" role="status">Menyimpan stok {savingSku}...</p>}

              {canManageStock && bulkMode !== 'off' && (
                <button
                  type="button"
                  className="pos-drawer-backdrop"
                  aria-label="Tutup panel"
                  onClick={() => setBulkMode('off')}
                />
              )}
              <aside
                className={`pos-drawer${canManageStock && bulkMode !== 'off' ? ' open' : ''}`}
                aria-hidden={bulkMode === 'off'}
                aria-label={bulkMode === 'count' ? 'Hitung stok massal' : 'Tambah stok massal'}
              >
                <button
                  type="button"
                  className="pos-drawer-close"
                  onClick={() => setBulkMode('off')}
                  aria-label="Tutup panel"
                >
                  ×
                </button>
                {canManageStock && bulkMode === 'count' && (
                  <BulkStockPanel
                    products={visibleProducts}
                    inventory={inventory}
                    onSaveBatch={saveStockBatch}
                  />
                )}
                {canManageStock && bulkMode === 'add' && (
                  <BulkStockAdjustmentPanel
                    products={sortedCatalog}
                    visibleProducts={visibleProducts}
                    inventory={inventory}
                    onAddBatch={addStockBatch}
                  />
                )}
              </aside>

              <div className="stock-list">
                {visibleProducts.map((product) => (
                  <StockRow
                    key={product.sku}
                    product={product}
                    stock={inventory[product.sku.toLowerCase()]}
                    canEdit={canManageStock}
                    onSave={saveStock}
                  />
                ))}
                {visibleProducts.length === 0 && !dataError && (
                  <div className="pos-no-products">
                    {sortedCatalog.length === 0
                      ? 'Katalog belum tersedia.'
                      : 'Produk tidak ditemukan. Coba SKU atau kata kunci lain.'}
                  </div>
                )}
              </div>
            </>
          ) : activePanel === 'staff' && canManageStaff ? (
            <>
              <div className="pos-page-heading">
                <div>
                  <p className="pos-eyebrow">AKSES TIM</p>
                  <h1>Anggota kasir</h1>
                  <p>Siapkan akun dan bantu kasir mengatur ulang password.</p>
                </div>
              </div>
              <StaffAccountPanel
                isOwner={isOwner}
                staffMembers={staffMembers}
                onInitialize={initializeCashierAccounts}
                onReset={resetCashierPassword}
              />
            </>
          ) : (
            <div className="pos-coming-soon">
              <span className="pos-coming-soon-icon" aria-hidden="true">
                {posNavigation.find((item) => item.id === activePanel)?.icon ?? '✧'}
              </span>
              <p className="pos-eyebrow">DASHBOARD 2GOFRESH</p>
              <h1>{posNavigation.find((item) => item.id === activePanel)?.label ?? 'Menu POS'}</h1>
              <p>Panel ini sedang disiapkan dan belum dapat digunakan.</p>
              <button type="button" className="pos-account-button" onClick={() => selectPanel('stock')}>
                Buka Stok Produk
              </button>
            </div>
          )}
        </section>
      </div>
      <ShopeeWatcher />
      <OpsToasts />
      <YubiCalculator />
    </main>
  )
}

export default PosApp
