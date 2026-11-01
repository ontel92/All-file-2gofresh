import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { httpsCallable } from 'firebase/functions'
import { functions } from './posFirebase'
import './MarketplaceSync.css'

type SyncModel = {
  modelId: number | string
  name: string
  sku: string
  masterSku: string
  grams: number | null
  price: number
  originalPrice: number
  stock: number
  masterPrice: number | null
  diffPct: number | null
  issue: string
}
type SyncItem = {
  itemId: number | string
  name: string
  image: string
  status: string
  itemSku: string
  masterSku: string
  masterName: string
  unit: string
  minQty: number | null
  hasModel: boolean
  suggestedMasterSku?: string
  suggestedMasterName?: string
  suggestionMatch?: string
  models: SyncModel[]
  missingTiers: { grams: number; name: string; price: number }[]
}
type Page = { items: SyncItem[]; more: boolean; next: number | string }
type ResetResult = { results: { itemId: number | string; ok: boolean; error?: string }[] }

export type SyncPlatform = 'shopee' | 'tiktok'

// Perbedaan panggilan backend per marketplace; tampilan dan logika selisih harga sama.
const platforms = {
  shopee: {
    name: 'Shopee',
    overview: 'shopeeSyncOverview',
    cursor: (cursor: number | string) => ({ offset: cursor }),
    firstCursor: 0 as number | string,
    price: (itemId: number | string, modelId: number | string, price: number) => ({ call: 'shopeeUpdatePrice', data: { itemId, modelId, price } }),
    stock: (itemId: number | string, modelId: number | string, stock: number) => ({ call: 'shopeeUpdateStock', data: { itemId, modelId, stock } }),
    reset: 'shopeeResetStock',
    resetItems: (items: SyncItem[]) => items.map((item) => ({ itemId: item.itemId, modelIds: item.hasModel ? item.models.map((model) => model.modelId) : [0] })),
  },
  tiktok: {
    name: 'TikTok',
    overview: 'tiktokSyncOverview',
    cursor: (cursor: number | string) => ({ pageToken: cursor }),
    firstCursor: '' as number | string,
    price: (itemId: number | string, modelId: number | string, price: number) => ({ call: 'tiktokUpdatePrice', data: { productId: itemId, skuId: modelId, price } }),
    stock: (itemId: number | string, modelId: number | string, stock: number) => ({ call: 'tiktokUpdateStock', data: { productId: itemId, skuId: modelId, stock } }),
    reset: 'tiktokResetStock',
    resetItems: (items: SyncItem[]) => items.map((item) => ({ productId: item.itemId })),
  },
} as const

type Verdict = 'mahal' | 'murah' | 'ok' | 'masalah' | 'min'
type Filter = 'all' | 'attention' | 'mahal' | 'murah' | 'masalah' | 'missing' | 'stock'
type Sort = 'shopee' | 'mahal' | 'murah' | 'nama-az' | 'nama-za' | 'harga-tinggi' | 'harga-rendah' | 'stok-banyak' | 'stok-sedikit' | 'sku-az'

const money = new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', maximumFractionDigits: 0 })
const issueText: Record<string, string> = {
  'sku-kosong': 'SKU varian kosong',
  'sku-tidak-ada': 'SKU tidak ada di master',
  'tier-tidak-ada': 'Gramasi tidak punya tier harga master',
  'harga-master-kosong': 'Harga master kosong',
  'di-bawah-min': 'Di bawah MIN_QTY master masih ada stok',
}

function errorText(failure: unknown) {
  return failure instanceof Error ? failure.message : 'Terjadi kesalahan.'
}

function gramsLabel(grams: number | null) {
  if (grams === null) return '-'
  return grams >= 1000 && grams % 1000 === 0 ? `${grams / 1000} kg` : `${grams} gr`
}

function diffOf(model: SyncModel) {
  if (model.masterPrice === null || model.price <= 0) return null
  return Math.round(((model.price - model.masterPrice) / model.masterPrice) * 1000) / 10
}

function pct(value: number) {
  return `${value > 0 ? '+' : ''}${value.toLocaleString('id-ID', { maximumFractionDigits: 1 })}%`
}

function verdictOf(model: SyncModel, high: number, low: number): Verdict {
  if (model.issue === 'di-bawah-min') return 'min'
  if (model.issue) return 'masalah'
  const diff = diffOf(model)
  if (diff === null) return 'masalah'
  if (diff > high) return 'mahal'
  if (diff < -low) return 'murah'
  return 'ok'
}

function SyncRow({ platform, store, itemId, model, verdict, onPatch }: {
  platform: SyncPlatform
  store: string
  itemId: number | string
  model: SyncModel
  verdict: Verdict
  onPatch: (modelId: number | string, patch: Partial<SyncModel>) => void
}) {
  const [priceInput, setPriceInput] = useState(String(model.originalPrice))
  const [stockInput, setStockInput] = useState(String(model.stock))
  const [busy, setBusy] = useState('')
  const [note, setNote] = useState('')
  const diff = diffOf(model)
  const promo = model.originalPrice > 0 && model.price < model.originalPrice

  async function save(kind: 'price' | 'stock') {
    setBusy(kind)
    setNote('')
    try {
      if (kind === 'price') {
        const price = Number(priceInput)
        const request = platforms[platform].price(itemId, model.modelId, price)
        await httpsCallable(functions, request.call)(platform === 'shopee' ? { ...request.data, store } : request.data)
        onPatch(model.modelId, { originalPrice: price, price: promo ? model.price : price })
      } else {
        const stock = Number(stockInput)
        const request = platforms[platform].stock(itemId, model.modelId, stock)
        await httpsCallable(functions, request.call)(platform === 'shopee' ? { ...request.data, store } : request.data)
        onPatch(model.modelId, { stock })
      }
      setNote('Tersimpan ✓')
    } catch (failure) {
      setNote(errorText(failure))
    } finally {
      setBusy('')
    }
  }

  return (
    <div className={`ms-row ms-${verdict}`}>
      <div className="ms-sku">
        <b>{model.sku || '(tanpa SKU)'}</b>
        <small>{model.name || 'Tanpa variasi'}{model.grams !== null ? ` · ${gramsLabel(model.grams)}` : ''}</small>
      </div>
      <div className="ms-price">
        <span>Harga tayang</span>
        <b>{money.format(model.price)}</b>
        {promo && <small>Normal {money.format(model.originalPrice)} · promo</small>}
      </div>
      <div className="ms-price">
        <span>Harga master</span>
        <b>{model.masterPrice === null ? '-' : money.format(model.masterPrice)}</b>
        {model.masterPrice !== null && <small>{money.format(model.price - model.masterPrice)}</small>}
      </div>
      <div className={`ms-diff ms-badge-${verdict}`}>
        <b>{diff === null ? '-' : pct(diff)}</b>
        <small>
          {verdict === 'mahal' && 'Terlalu mahal'}
          {verdict === 'murah' && 'Terlalu murah'}
          {verdict === 'ok' && 'Wajar'}
          {(verdict === 'masalah' || verdict === 'min') && (issueText[model.issue] ?? 'Perlu dicek')}
        </small>
      </div>
      <div className="ms-edit">
        <label>Harga normal
          <span>
            <input inputMode="numeric" value={priceInput} onChange={(event) => setPriceInput(event.target.value.replace(/\D/g, ''))} />
            <button type="button" disabled={busy !== '' || !priceInput || Number(priceInput) === model.originalPrice} onClick={() => void save('price')}>
              {busy === 'price' ? '...' : 'Simpan'}
            </button>
          </span>
        </label>
        <label>Stok
          <span>
            <input inputMode="numeric" value={stockInput} onChange={(event) => setStockInput(event.target.value.replace(/\D/g, ''))} />
            <button type="button" disabled={busy !== '' || stockInput === '' || Number(stockInput) === model.stock} onClick={() => void save('stock')}>
              {busy === 'stock' ? '...' : 'Simpan'}
            </button>
          </span>
        </label>
        {note && <small className={note.includes('✓') ? 'ms-ok' : 'ms-error'}>{note}</small>}
      </div>
    </div>
  )
}

function ItemTools({ item, store, onReload }: { item: SyncItem; store: string; onReload: (itemId: number | string) => Promise<void> }) {
  const [induk, setInduk] = useState(item.itemSku || item.masterSku)
  const [skus, setSkus] = useState<Record<string, string>>(() => Object.fromEntries(item.models.map((model) => [String(model.modelId), model.sku])))
  const [stocks, setStocks] = useState<Record<number, string>>({})
  const [busy, setBusy] = useState('')
  const [note, setNote] = useState<{ kind: 'sku' | 'add'; text: string } | null>(null)
  const normalizedInduk = induk.trim().toUpperCase()

  function autoFill() {
    if (!normalizedInduk) return
    setSkus(Object.fromEntries(item.models.map((model) => [
      String(model.modelId),
      model.grams !== null && item.hasModel ? `${normalizedInduk}-${model.grams}G` : normalizedInduk,
    ])))
  }

  async function run(kind: 'sku' | 'add') {
    setBusy(kind)
    setNote(null)
    try {
      if (kind === 'sku') {
        const models = item.hasModel
          ? item.models
            .filter((model) => (skus[String(model.modelId)] ?? '').trim().toUpperCase() !== model.sku.trim().toUpperCase())
            .map((model) => ({ modelId: model.modelId, sku: skus[String(model.modelId)] }))
          : []
        const sendItemSku = normalizedInduk !== item.itemSku.trim().toUpperCase()
        if (!sendItemSku && models.length === 0) {
          setNote({ kind: 'sku', text: 'SKU sudah sama dengan di Shopee, tidak ada yang perlu disimpan.' })
          return
        }
        await httpsCallable(functions, 'shopeeUpdateSku')({ store, itemId: item.itemId, ...(sendItemSku ? { itemSku: normalizedInduk } : {}), models })
      } else {
        const stockByGrams = Object.fromEntries(item.missingTiers.map((tier) => [String(tier.grams), Number(stocks[tier.grams] || 0)]))
        await httpsCallable(functions, 'shopeeAddVariants')({ store, itemId: item.itemId, masterSku: item.masterSku, stockByGrams })
      }
      await onReload(item.itemId)
    } catch (failure) {
      setNote({ kind, text: errorText(failure) })
    } finally {
      setBusy('')
    }
  }

  const suggestion = item.suggestedMasterSku && item.suggestedMasterSku !== normalizedInduk ? item.suggestedMasterSku : ''
  return (
    <details className="ms-tools">
      <summary>Edit SKU{item.missingTiers.length > 0 && item.masterSku ? ' & tambah varian pecahan' : ''}</summary>
      <div className="ms-tools-body">
        <label>SKU induk
          <span>
            <input value={induk} onChange={(event) => setInduk(event.target.value)} placeholder="Kode master, contoh SMG-001" />
            {suggestion && (
              <button type="button" onClick={() => setInduk(suggestion)} title={item.suggestedMasterName}>Pakai saran: {suggestion}</button>
            )}
          </span>
        </label>
        {item.hasModel && item.models.map((model) => (
          <label key={String(model.modelId)}>SKU {model.name || 'varian'}{model.grams !== null ? ` (${gramsLabel(model.grams)})` : ''}
            <span><input value={skus[String(model.modelId)] ?? ''} onChange={(event) => setSkus((current) => ({ ...current, [String(model.modelId)]: event.target.value }))} /></span>
          </label>
        ))}
        <div className="ms-tools-actions">
          {item.hasModel && <button type="button" disabled={!normalizedInduk || busy !== ''} onClick={autoFill}>Isi otomatis SKU pecahan (INDUK-gramG)</button>}
          <button type="button" className="primary" disabled={!normalizedInduk || busy !== ''} onClick={() => void run('sku')}>{busy === 'sku' ? 'Menyimpan...' : 'Simpan SKU ke Shopee'}</button>
        </div>
        {note?.kind === 'sku' && <small className="ms-error">{note.text}</small>}
        {item.masterSku && item.missingTiers.length > 0 && item.hasModel && (
          <div className="ms-tools-add">
            <b>Tambah varian pecahan yang belum ada (harga awal = harga master, stok awal bisa 0):</b>
            {item.missingTiers.map((tier) => (
              <label key={tier.grams}>{tier.name} · {money.format(tier.price)} · SKU {item.masterSku}-{tier.grams}G
                <span><input inputMode="numeric" placeholder="Stok" value={stocks[tier.grams] ?? ''} onChange={(event) => setStocks((current) => ({ ...current, [tier.grams]: event.target.value.replace(/\D/g, '') }))} /></span>
              </label>
            ))}
            <button type="button" className="primary" disabled={busy !== ''} onClick={() => void run('add')}>{busy === 'add' ? 'Menambah ke Shopee...' : `Tambah ${item.missingTiers.length} varian`}</button>
            {note?.kind === 'add' && <small className="ms-error">{note.text}</small>}
          </div>
        )}
        {item.masterSku && item.missingTiers.length > 0 && !item.hasModel && <small>Produk tanpa variasi: buat variasi pertama di Seller Centre, baru pecahannya bisa ditambah dari sini.</small>}
        {!item.masterSku && <small>SKU induk belum cocok dengan master. Simpan SKU dulu; setelah cocok, varian pecahan yang kurang akan muncul di sini.</small>}
      </div>
    </details>
  )
}

export default function MarketplaceSync({ isOwner, platform = 'shopee' }: { isOwner: boolean; platform?: SyncPlatform }) {
  const platformName = platforms[platform].name
  const [items, setItems] = useState<SyncItem[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [high, setHigh] = useState('10')
  const [low, setLow] = useState('10')
  const [filter, setFilter] = useState<Filter>('attention')
  const [sort, setSort] = useState<Sort>('shopee')
  const [search, setSearch] = useState('')
  const [resetText, setResetText] = useState('')
  const [resetBusy, setResetBusy] = useState(false)
  const [resetNote, setResetNote] = useState('')
  const [resetEpoch, setResetEpoch] = useState(0)
  const [store, setStore] = useState('2gofresh')
  const storeName = platform === 'shopee' && store === 'freshstock' ? 'Shopee Freshstock' : platformName
  const runId = useRef(0)
  const [excluded, setExcluded] = useState<Set<number | string>>(new Set())
  const [bulkBusy, setBulkBusy] = useState(false)
  const [bulkNote, setBulkNote] = useState('')
  const suggestions = useMemo(
    () => items.filter((item) => platform === 'shopee' && !item.masterSku && item.suggestedMasterSku),
    [items, platform],
  )
  const chosen = suggestions.filter((item) => !excluded.has(item.itemId))

  async function applySuggestions() {
    if (chosen.length === 0 || bulkBusy) return
    if (!window.confirm(`Simpan SKU induk saran ke ${chosen.length} produk di ${storeName}? SKU varian berukuran gram ikut diisi (SKU-gramG).`)) return
    setBulkBusy(true)
    setBulkNote('')
    const failed: string[] = []
    let ok = 0
    for (const [index, item] of chosen.entries()) {
      setBulkNote(`Menyimpan ${index + 1}/${chosen.length}...`)
      const sku = item.suggestedMasterSku!
      const models = item.hasModel
        ? item.models.filter((model) => model.grams !== null).map((model) => ({ modelId: model.modelId, sku: `${sku}-${model.grams}G` }))
        : []
      try {
        await httpsCallable(functions, 'shopeeUpdateSku')({ store, itemId: item.itemId, itemSku: sku, models })
        await reloadItem(item.itemId)
        ok += 1
      } catch (failure) {
        failed.push(`${item.name.slice(0, 40)}: ${errorText(failure)}`)
      }
    }
    setBulkNote(failed.length ? `${ok} berhasil, ${failed.length} gagal: ${failed.slice(0, 3).join('; ')}` : `${ok} produk berhasil disimpan ✓`)
    setBulkBusy(false)
  }

  const load = useCallback(async () => {
    const id = ++runId.current
    setLoading(true)
    setError('')
    setItems([])
    let loaded: SyncItem[] = []
    let cursor: number | string = platforms[platform].firstCursor
    try {
      for (let page = 0; page < 100; page += 1) {
        const base = platforms[platform].cursor(cursor)
        const result = (await httpsCallable<unknown, Page>(functions, platforms[platform].overview)(platform === 'shopee' ? { ...base, store } : base)).data
        if (id !== runId.current) return
        loaded = [...loaded, ...result.items]
        setItems(loaded)
        if (!result.more) break
        cursor = result.next
      }
    } catch (failure) {
      if (id === runId.current) setError(errorText(failure))
    } finally {
      if (id === runId.current) setLoading(false)
    }
  }, [platform, store])

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0)
    return () => {
      window.clearTimeout(timer)
      runId.current += 1
    }
  }, [load])

  const highLimit = Math.max(Number(high) || 0, 0)
  const lowLimit = Math.max(Number(low) || 0, 0)

  const analyzed = useMemo(() => items.map((item) => {
    const verdicts = item.models.map((model) => verdictOf(model, highLimit, lowLimit))
    const diffs = item.models.map(diffOf).filter((diff): diff is number => diff !== null)
    return {
      item,
      verdicts,
      maxDiff: diffs.length ? Math.max(...diffs) : null,
      minDiff: diffs.length ? Math.min(...diffs) : null,
      counts: {
        mahal: verdicts.filter((verdict) => verdict === 'mahal').length,
        murah: verdicts.filter((verdict) => verdict === 'murah').length,
        masalah: verdicts.filter((verdict) => verdict === 'masalah' || verdict === 'min').length,
        missing: item.missingTiers.length,
        stock: item.models.filter((model) => model.stock > 0).length,
      },
    }
  }), [items, highLimit, lowLimit])

  const totals = useMemo(() => ({
    products: analyzed.length,
    variants: analyzed.reduce((sum, entry) => sum + entry.item.models.length, 0),
    mahal: analyzed.reduce((sum, entry) => sum + entry.counts.mahal, 0),
    murah: analyzed.reduce((sum, entry) => sum + entry.counts.murah, 0),
    masalah: analyzed.reduce((sum, entry) => sum + entry.counts.masalah, 0),
    missing: analyzed.reduce((sum, entry) => sum + entry.counts.missing, 0),
  }), [analyzed])

  const shown = useMemo(() => {
    const needle = search.trim().toLowerCase()
    const rows = analyzed.filter(({ item, counts }) => {
      if (needle && ![item.name, item.masterName, item.masterSku, item.itemSku, ...item.models.map((model) => model.sku)]
        .some((text) => text.toLowerCase().includes(needle))) return false
      if (filter === 'attention') return counts.mahal + counts.murah + counts.masalah + counts.missing > 0
      if (filter === 'stock') return counts.stock > 0
      return filter === 'all' || counts[filter] > 0
    })
    if (sort === 'mahal') rows.sort((a, b) => (b.maxDiff ?? -Infinity) - (a.maxDiff ?? -Infinity))
    if (sort === 'murah') rows.sort((a, b) => (a.minDiff ?? Infinity) - (b.minDiff ?? Infinity))
    const byName = (a: (typeof rows)[number], b: (typeof rows)[number]) => a.item.name.localeCompare(b.item.name, 'id')
    const topPrice = (entry: (typeof rows)[number]) => Math.max(0, ...entry.item.models.map((model) => model.price))
    const lowPrice = (entry: (typeof rows)[number]) => Math.min(Infinity, ...entry.item.models.filter((model) => model.price > 0).map((model) => model.price))
    const totalStock = (entry: (typeof rows)[number]) => entry.item.models.reduce((sum, model) => sum + model.stock, 0)
    if (sort === 'nama-az') rows.sort(byName)
    if (sort === 'nama-za') rows.sort((a, b) => byName(b, a))
    if (sort === 'harga-tinggi') rows.sort((a, b) => topPrice(b) - topPrice(a) || byName(a, b))
    if (sort === 'harga-rendah') rows.sort((a, b) => lowPrice(a) - lowPrice(b) || byName(a, b))
    if (sort === 'stok-banyak') rows.sort((a, b) => totalStock(b) - totalStock(a) || byName(a, b))
    if (sort === 'stok-sedikit') rows.sort((a, b) => totalStock(a) - totalStock(b) || byName(a, b))
    if (sort === 'sku-az') rows.sort((a, b) => (a.item.masterSku || a.item.itemSku || '\uffff').localeCompare(b.item.masterSku || b.item.itemSku || '\uffff') || byName(a, b))
    return rows
  }, [analyzed, filter, search, sort])

  function patchModel(itemId: number | string, modelId: number | string, patch: Partial<SyncModel>) {
    setItems((current) => current.map((item) => (item.itemId === itemId
      ? { ...item, models: item.models.map((model) => (model.modelId === modelId ? { ...model, ...patch } : model)) }
      : item)))
  }

  async function reloadItem(itemId: number | string) {
    const result = (await httpsCallable<unknown, Page>(functions, platforms[platform].overview)({ itemId, store })).data
    const fresh = result.items[0]
    if (fresh) setItems((current) => current.map((item) => (item.itemId === itemId ? fresh : item)))
  }

  async function resetMarketplaceStock() {
    if (resetText !== 'RESET' || loading || items.length === 0) return
    if (!window.confirm(`Semua stok ${totals.variants} varian di ${totals.products} produk ${storeName} akan menjadi 0. Lanjutkan?`)) return
    setResetBusy(true)
    setResetNote('')
    const failed: string[] = []
    try {
      for (let start = 0; start < items.length; start += 20) {
        const chunk = items.slice(start, start + 20)
        setResetNote(`Mereset stok ${platformName} ${Math.min(start + 20, items.length)}/${items.length} produk...`)
        const result = (await httpsCallable<unknown, ResetResult>(functions, platforms[platform].reset)({
          items: platforms[platform].resetItems(chunk),
          ...(platform === 'shopee' ? { store } : {}),
        })).data
        const okIds = new Set(result.results.filter((entry) => entry.ok).map((entry) => entry.itemId))
        failed.push(...result.results.filter((entry) => !entry.ok).map((entry) => `${entry.itemId}: ${entry.error ?? 'gagal'}`))
        setItems((current) => current.map((item) => (okIds.has(item.itemId)
          ? { ...item, models: item.models.map((model) => ({ ...model, stock: 0 })) }
          : item)))
      }
      setResetNote(failed.length ? `Selesai dengan ${failed.length} produk gagal: ${failed.slice(0, 5).join('; ')}` : `Semua stok ${platformName} sudah direset ke 0 ✓`)
      setResetText('')
      setResetEpoch((epoch) => epoch + 1)
    } catch (failure) {
      setResetNote(errorText(failure))
    } finally {
      setResetBusy(false)
    }
  }

  return (
    <div className="ms">
      <div className="pos-page-heading">
        <div>
          <p className="pos-eyebrow">SINKRON MASTER ↔ {platformName.toUpperCase()} · 2GOFRESH</p>
          <h1>Sinkron Master {platformName}</h1>
          <p>SKU induk, SKU pecahan, harga master vs harga tayang {platformName}{platform === 'shopee' ? ' (termasuk promo)' : ''}, dan stok.</p>
        </div>
        <div className="ms-actions">
          {platform === 'shopee' && (
            <select value={store} disabled={loading} onChange={(event) => setStore(event.target.value === 'freshstock' ? 'freshstock' : '2gofresh')} aria-label="Toko Shopee">
              <option value="2gofresh">Shopee 2goFresh</option>
              <option value="freshstock">Shopee Freshstock</option>
            </select>
          )}
          <button type="button" className="ms-btn" disabled={loading} onClick={() => void load()}>
            {loading ? `Memuat ${items.length} produk...` : `↻ Muat ulang dari ${storeName}`}
          </button>
        </div>
      </div>

      <div className="ms-summary">
        {([
          ['all', 'ms-sum-all', 'Produk', totals.products],
          ['all', 'ms-sum-all', 'Varian', totals.variants],
          ['mahal', 'ms-sum-mahal', 'Terlalu mahal', totals.mahal],
          ['murah', 'ms-sum-murah', 'Terlalu murah', totals.murah],
          ['masalah', 'ms-sum-masalah', 'SKU/harga bermasalah', totals.masalah],
          ['missing', 'ms-sum-missing', 'Varian belum dibuat', totals.missing],
        ] as const).map(([key, className, label, value]) => (
          <button
            type="button"
            key={label}
            className={`ms-card-btn ${className}${filter === key ? ' active' : ''}`}
            aria-pressed={filter === key}
            onClick={() => setFilter(key)}
          >
            <span>{label}</span><strong>{value}</strong>
          </button>
        ))}
      </div>

      {suggestions.length > 0 && (
        <details className="ms-suggest" open>
          <summary>⚡ Saran SKU dari nama master: {suggestions.length} produk di {storeName} belum punya SKU induk yang cocok</summary>
          <div className="ms-suggest-body">
            <p className="ms-hint">Dicocokkan lewat nama dengan master. “mirip” berarti nama tidak persis sama, cek dulu sebelum disimpan. Hilangkan centang untuk melewati produk.</p>
            <div className="ms-suggest-list">
              {suggestions.map((item) => (
                <label key={item.itemId}>
                  <input type="checkbox" checked={!excluded.has(item.itemId)} onChange={(event) => setExcluded((current) => {
                    const next = new Set(current)
                    if (event.target.checked) next.delete(item.itemId)
                    else next.add(item.itemId)
                    return next
                  })} />
                  <span>{item.name}<small>master: {item.suggestedMasterName}</small></span>
                  <code>{item.suggestedMasterSku}</code>
                  <em className={item.suggestionMatch === 'mirip' ? 'warn' : ''}>{item.suggestionMatch === 'mirip' ? 'mirip' : 'sama'}</em>
                </label>
              ))}
            </div>
            <div className="ms-tools-actions">
              <button type="button" className="primary" disabled={bulkBusy || chosen.length === 0} onClick={() => void applySuggestions()}>
                {bulkBusy ? 'Menyimpan...' : `Terapkan ${chosen.length} saran SKU`}
              </button>
              {bulkNote && <small className={bulkNote.includes('✓') ? 'ms-ok' : 'ms-error'}>{bulkNote}</small>}
            </div>
          </div>
        </details>
      )}

      <div className="ms-toolbar">
        <input type="search" placeholder="Cari nama, SKU induk, atau SKU pecahan" value={search} onChange={(event) => setSearch(event.target.value)} />
        <label>Batas mahal (%)
          <input inputMode="decimal" value={high} onChange={(event) => setHigh(event.target.value.replace(/[^\d.]/g, ''))} />
        </label>
        <label>Batas murah (%)
          <input inputMode="decimal" value={low} onChange={(event) => setLow(event.target.value.replace(/[^\d.]/g, ''))} />
        </label>
        <label>Tampilkan
          <select value={filter} onChange={(event) => setFilter(event.target.value as Filter)}>
            <option value="attention">Perlu perhatian</option>
            <option value="all">Semua produk</option>
            <option value="mahal">Terlalu mahal</option>
            <option value="murah">Terlalu murah</option>
            <option value="masalah">SKU/harga bermasalah</option>
            <option value="missing">Varian belum dibuat</option>
            <option value="stock">Masih ada stok</option>
          </select>
        </label>
        <label>Urutkan
          <select value={sort} onChange={(event) => setSort(event.target.value as Sort)}>
            <option value="shopee">Urutan {platformName}</option>
            <option value="mahal">Selisih + terbesar</option>
            <option value="murah">Selisih − terbesar</option>
            <option value="nama-az">Nama A → Z</option>
            <option value="nama-za">Nama Z → A</option>
            <option value="harga-tinggi">Harga tayang termahal</option>
            <option value="harga-rendah">Harga tayang termurah</option>
            <option value="stok-banyak">Stok terbanyak</option>
            <option value="stok-sedikit">Stok tersedikit</option>
            <option value="sku-az">SKU induk A → Z</option>
          </select>
        </label>
      </div>
      <p className="ms-hint">
        Selisih = (harga tayang − harga master) ÷ harga master.
        {platform === 'shopee'
          ? ' Harga tayang sudah termasuk promo toko; kolom "Harga normal" mengubah harga normal di Shopee dan tidak mengubah promo.'
          : ' Harga tayang adalah harga jual SKU di TikTok (promo kampanye tidak termasuk).'}
        Harga master per SKU induk memakai tier 1 kg; SKU pecahan MASTER-500G memakai tier 500 gr, dst.
      </p>

      {error && <p className="ms-error" role="alert">{error}</p>}
      {loading && items.length === 0 && <p className="ms-empty">Membaca produk dan master Google Sheets...</p>}

      {shown.map(({ item, verdicts }) => (
        <article key={item.itemId} className="ms-card">
          <header>
            {item.image ? <img src={item.image} alt="" loading="lazy" /> : <div className="ms-noimg" />}
            <div>
              <h3>{item.name}</h3>
              <p>
                SKU induk: <code>{item.masterSku || item.itemSku || '-'}</code>
                {item.masterName && <> · Master: {item.masterName}</>}
                {item.unit && <> · {item.unit}</>}
                {item.minQty !== null && <> · MIN_QTY {item.minQty}</>}
                {' · '}<small>ID {item.itemId}</small>
              </p>
              {item.missingTiers.length > 0 && (
                <p className="ms-missing">
                  Varian pecahan belum ada di {platformName}: {item.missingTiers.map((tier) => `${tier.name} (${money.format(tier.price)})`).join(', ')}
                </p>
              )}
            </div>
          </header>
          {platform === 'shopee' && (
            <ItemTools
              key={`${item.itemId}:${item.itemSku}:${item.models.map((model) => `${model.modelId}=${model.sku}`).join(',')}`}
              item={item}
              store={store}
              onReload={reloadItem}
            />
          )}
          {item.models.map((model, index) => (
            <SyncRow
              key={`${model.modelId}:${resetEpoch}`}
              platform={platform}
              store={store}
              itemId={item.itemId}
              model={model}
              verdict={verdicts[index]}
              onPatch={(modelId, patch) => patchModel(item.itemId, modelId, patch)}
            />
          ))}
        </article>
      ))}
      {!loading && items.length > 0 && shown.length === 0 && <p className="ms-empty">Tidak ada produk untuk filter ini.</p>}

      {isOwner && (
        <section className="ms-reset">
          <h3>Reset stok {platformName} (khusus owner)</h3>
          <p>Mengubah stok semua varian pada {totals.products} produk yang sedang dimuat menjadi 0. Reset stok POS ada di panel Stok Produk.</p>
          <div>
            <input placeholder="Ketik RESET untuk konfirmasi" value={resetText} onChange={(event) => setResetText(event.target.value)} />
            <button type="button" className="ms-danger" disabled={resetText !== 'RESET' || resetBusy || loading || items.length === 0} onClick={() => void resetMarketplaceStock()}>
              {resetBusy ? 'Mereset...' : `Reset semua stok ${platformName}`}
            </button>
          </div>
          {resetNote && <small>{resetNote}</small>}
        </section>
      )}
    </div>
  )
}
