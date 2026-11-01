import { useMemo, useState } from 'react'
import { httpsCallable } from 'firebase/functions'
import { functions } from './posFirebase'
import './Kulak.css'

type Line = { id: number; name: string; qty: number; unit: string; total: number; perUnit: number; perUnitLabel: string }
type Extra = { name: string; total: number }
type Parsed = { lines: Line[]; extras: Extra[]; modal: number | null; pakai: number | null; sisa: number | null; unknown: string[] }
type MasterProduct = { sku: string; name: string; unit: string; hpp: number; effectiveHpp: number }
type Pick = { text: string; checked: boolean }
type ScanModel = { name: string; masterSku: string; grams: number | null; price: number; stock: number }
type ScanItem = { name: string; masterSku: string; unit: string; models: ScanModel[] }
type ScanPage = { items: ScanItem[]; more: boolean; next: number | string }
type RiskRow = { store: string; product: string; variant: string; price: number; cost: number; margin: number; safePrice: number; level: 'rugi' | 'tipis' }

const scanSources = [
  { label: 'Shopee 2goFresh', call: 'shopeeSyncOverview', extra: { store: '2gofresh' }, cursor: (next: number | string) => ({ offset: next }), first: 0 as number | string },
  { label: 'Shopee Freshstock', call: 'shopeeSyncOverview', extra: { store: 'freshstock' }, cursor: (next: number | string) => ({ offset: next }), first: 0 as number | string },
  { label: 'TikTok 2goFresh', call: 'tiktokSyncOverview', extra: {}, cursor: (next: number | string) => ({ pageToken: next }), first: '' as number | string },
] as const
const safeMargin = 0.15

const money = new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', maximumFractionDigits: 0 })
const units = 'kg|kilo|gr|gram|g|ons|sisir|sir|pcs|pc|ikat|biji|bh|butir|pak|bks|bungkus|ekor|liter|ltr|lt|karung|krg|dus|box|kotak|pot|lembar'
const itemPattern = new RegExp(`^(.*?)\\s*(\\d+(?:[.,]\\d+)?)\\s*(${units})\\.?\\s*[:=@-]?\\s*(?:rp\\.?\\s*)?([\\d.,]+)\\s*(rb|ribu|k)?$`, 'i')
const extraPattern = /^(.*?)\s*[:=-]?\s*(?:rp\.?\s*)?([\d.,]+)\s*(rb|ribu|k)?$/i

function money_(raw: string, suffix?: string) {
  const digits = raw.replace(/[.,]/g, '')
  const value = Number(digits)
  if (!Number.isFinite(value)) return 0
  return suffix ? value * 1000 : value
}

function parseQty(raw: string) {
  return Number(raw.replace(',', '.'))
}

function normalizeUnit(unit: string, qty: number) {
  const value = unit.toLowerCase()
  if (value === 'kilo' || value === 'kg') return { unit: 'kg', qty }
  if (['g', 'gr', 'gram'].includes(value)) return { unit: 'kg', qty: qty / 1000 }
  if (value === 'ons') return { unit: 'kg', qty: qty / 10 }
  if (value === 'sir') return { unit: 'sisir', qty }
  if (value === 'pc') return { unit: 'pcs', qty }
  return { unit: value, qty }
}

function cleanName(raw: string) {
  return raw.replace(/^[\s\-•*\d]+[.)]\s+/, '').replace(/[\s:=-]+$/, '').replace(/^[-•*\s]+/, '').trim()
}

export function parseKulak(text: string): Parsed {
  const result: Parsed = { lines: [], extras: [], modal: null, pakai: null, sisa: null, unknown: [] }
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/^\[[^\]]*\]\s*[^:]*:\s*/, '').trim()
    if (!line) continue
    const summary = line.match(/^(modal|pakai|dipakai|terpakai|sisa)\b\s*[:=-]?\s*(?:rp\.?\s*)?([\d.,]+)\s*(rb|ribu|k)?$/i)
    if (summary) {
      const value = money_(summary[2], summary[3])
      const key = summary[1].toLowerCase()
      if (key === 'modal') result.modal = value
      else if (key === 'sisa') result.sisa = value
      else result.pakai = value
      continue
    }
    const item = line.match(itemPattern)
    if (item) {
      const name = cleanName(item[1])
      const qty = parseQty(item[2])
      const total = money_(item[4], item[5])
      if (name && qty > 0 && total > 0) {
        const normalized = normalizeUnit(item[3], qty)
        result.lines.push({
          id: result.lines.length,
          name,
          qty: normalized.qty,
          unit: normalized.unit,
          total,
          perUnit: Math.round(total / normalized.qty),
          perUnitLabel: normalized.unit,
        })
        continue
      }
    }
    const extra = line.match(extraPattern)
    if (extra) {
      const name = cleanName(extra[1])
      const total = money_(extra[2], extra[3])
      if (name && total > 0) {
        result.extras.push({ name, total })
        continue
      }
    }
    result.unknown.push(line)
  }
  return result
}

const stopWords = new Set(['fresh', 'segar', 'rempah', 'kg', 'gr', 'dan'])

function tokens(value: string) {
  return new Set(value.split('|')[0].toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ').filter((token) => token && !stopWords.has(token)))
}

function bestMatch(line: Line, master: MasterProduct[]) {
  const words = new Set(line.name.toUpperCase().split(/\s+/).map((word) => word.replace(/[^A-Z0-9-]/g, '')))
  const bySku = master.find((product) => words.has(product.sku.toUpperCase()))
  if (bySku) return bySku
  const wanted = tokens(line.name)
  if (wanted.size === 0) return null
  let best: { product: MasterProduct; score: number } | null = null
  for (const product of master) {
    let score = 0
    for (const variant of product.name.split('|')[0].split('/')) {
      const have = tokens(variant)
      if (have.size === 0) continue
      let shared = 0
      wanted.forEach((token) => { if (have.has(token)) shared += 1 })
      score = Math.max(score, shared / (wanted.size + have.size - shared))
    }
    if (product.unit.toLowerCase() === line.unit) score += 0.05
    if (!best || score > best.score) best = { product, score }
  }
  return best && best.score >= 0.5 ? best.product : null
}

const pickLabel = (product: MasterProduct) => `${product.sku} — ${product.name.split('|')[0].trim()}`

function qtyText(qty: number) {
  return Number.isInteger(qty) ? String(qty) : String(Math.round(qty * 1000) / 1000).replace('.', ',')
}

function requestId() {
  return `kulak-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

function message(error: unknown) {
  return error instanceof Error ? error.message : 'Gagal mencatat.'
}

export default function Kulak({ canRecord }: { canRecord: boolean }) {
  const [text, setText] = useState('')
  const [parsed, setParsed] = useState<Parsed | null>(null)
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10))
  const [status, setStatus] = useState('')
  const [saving, setSaving] = useState(false)
  const [master, setMaster] = useState<MasterProduct[]>([])
  const [picks, setPicks] = useState<Record<number, Pick>>({})
  const [hppBusy, setHppBusy] = useState(false)

  const masterBySku = useMemo(() => new Map(master.map((product) => [product.sku.toUpperCase(), product])), [master])
  const productOf = (id: number) => masterBySku.get((picks[id]?.text ?? '').split(' — ')[0].trim().toUpperCase())
  const hppRows = (parsed?.lines ?? []).map((line) => {
    const product = productOf(line.id)
    const unitOk = !product || product.unit.toLowerCase() === line.unit
    const diff = product && product.hpp > 0 ? ((line.perUnit - product.hpp) / product.hpp) * 100 : null
    return { line, product, unitOk, diff, checked: Boolean(product && unitOk && picks[line.id]?.checked) }
  })
  const selectedHpp = hppRows.filter((row) => row.checked)
  const [scanOpen, setScanOpen] = useState(false)
  const [scanning, setScanning] = useState(false)
  const [scanProgress, setScanProgress] = useState('')
  const [risks, setRisks] = useState<RiskRow[]>([])
  const [scanErrors, setScanErrors] = useState<string[]>([])
  const [scannedCount, setScannedCount] = useState(0)

  async function checkMarketplace() {
    const costBySku = new Map<string, { perUnit: number; unit: string; name: string }>()
    for (const row of hppRows) {
      if (row.product && row.unitOk) costBySku.set(row.product.sku.toUpperCase(), { perUnit: row.line.perUnit, unit: row.product.unit, name: row.line.name })
    }
    if (costBySku.size === 0) return
    setScanOpen(true)
    setScanning(true)
    setRisks([])
    setScanErrors([])
    setScannedCount(0)
    const found: RiskRow[] = []
    const errors: string[] = []
    let scanned = 0
    await Promise.all(scanSources.map(async (source) => {
      let cursor: number | string = source.first
      try {
        for (let page = 0; page < 100; page += 1) {
          setScanProgress(`Memeriksa ${source.label}...`)
          const result = (await httpsCallable<unknown, ScanPage>(functions, source.call)({ ...source.extra, ...source.cursor(cursor) })).data
          for (const item of result.items) {
            for (const model of item.models) {
              const cost = costBySku.get(model.masterSku.toUpperCase())
              if (!cost || model.price <= 0) continue
              scanned += 1
              const kgUnit = cost.unit === 'KG'
              if (kgUnit && model.grams === null && item.models.length > 1) continue
              const unitCost = kgUnit ? Math.round((cost.perUnit * (model.grams ?? 1000)) / 1000) : cost.perUnit
              const margin = (model.price - unitCost) / model.price
              if (margin >= safeMargin) continue
              found.push({
                store: source.label,
                product: cost.name,
                variant: model.name || (model.grams ? `${model.grams} gr` : '—'),
                price: model.price,
                cost: unitCost,
                margin,
                safePrice: Math.ceil(unitCost / (1 - safeMargin) / 100) * 100,
                level: margin <= 0 ? 'rugi' : 'tipis',
              })
            }
          }
          if (!result.more) break
          cursor = result.next
        }
      } catch (failure) {
        errors.push(`${source.label}: ${message(failure)}`)
      }
    }))
    found.sort((a, b) => a.margin - b.margin)
    setRisks(found)
    setScanErrors(errors)
    setScannedCount(scanned)
    setScanning(false)
  }

  async function split() {
    setStatus('')
    const next = parseKulak(text)
    // Baris yang tidak terbaca dianggap biaya operasional, nominalnya diisi manual.
    next.extras.push(...next.unknown.map((name) => ({ name, total: 0 })))
    next.unknown = []
    setParsed(next)
    let products = master
    if (products.length === 0) {
      try {
        const result = await httpsCallable<unknown, { products: MasterProduct[] }>(functions, 'kulakMaster')()
        products = result.data.products
        setMaster(products)
      } catch (failure) {
        setStatus(`Master belum terbaca, pencocokan HPP dilewati: ${message(failure)}`)
      }
    }
    setPicks(Object.fromEntries(next.lines.map((line) => {
      const match = bestMatch(line, products)
      return [line.id, { text: match ? pickLabel(match) : '', checked: Boolean(match && match.unit.toLowerCase() === line.unit) }]
    })))
  }

  async function updateHpp() {
    if (selectedHpp.length === 0) return
    const preview = selectedHpp.map((row) => `${row.product!.sku}: ${money.format(row.product!.hpp)} → ${money.format(row.line.perUnit)}`).join('\n')
    if (!window.confirm(`Update HPP di master Google Sheets untuk ${selectedHpp.length} produk?\n\n${preview}`)) return
    setHppBusy(true)
    setStatus('')
    try {
      await httpsCallable(functions, 'kulakApplyHpp')({ items: selectedHpp.map((row) => ({ sku: row.product!.sku, hpp: row.line.perUnit })) })
      setMaster((current) => current.map((product) => {
        const row = selectedHpp.find((entry) => entry.product!.sku === product.sku)
        return row ? { ...product, hpp: row.line.perUnit } : product
      }))
      setStatus(`HPP ${selectedHpp.length} produk di master sudah diupdate ✓`)
    } catch (failure) {
      setStatus(message(failure))
    } finally {
      setHppBusy(false)
    }
  }

  const itemsTotal = useMemo(() => parsed?.lines.reduce((sum, line) => sum + line.total, 0) ?? 0, [parsed])
  const extrasTotal = useMemo(() => parsed?.extras.reduce((sum, extra) => sum + extra.total, 0) ?? 0, [parsed])
  const grand = itemsTotal + extrasTotal

  function removeLine(index: number) {
    setParsed((current) => current && { ...current, lines: current.lines.filter((_, position) => position !== index) })
  }

  function removeExtra(index: number) {
    setParsed((current) => current && { ...current, extras: current.extras.filter((_, position) => position !== index) })
  }

  function editExtra(index: number, patch: Partial<Extra>) {
    setParsed((current) => current && { ...current, extras: current.extras.map((extra, position) => position === index ? { ...extra, ...patch } : extra) })
  }

  function addExtra() {
    setParsed((current) => current && { ...current, extras: [...current.extras, { name: '', total: 0 }] })
  }

  function moveToExtra(line: Line) {
    setParsed((current) => current && {
      ...current,
      lines: current.lines.filter((entry) => entry.id !== line.id),
      extras: [...current.extras, { name: line.name, total: line.total }],
    })
  }

  const missingLines = master.length > 0 ? (parsed?.lines ?? []).filter((line) => !productOf(line.id)) : []

  async function copyResult() {
    if (!parsed) return
    const rows = parsed.lines.map((line) => `${line.name}\t${qtyText(line.qty)} ${line.unit}\t${money.format(line.perUnit)}/${line.perUnitLabel}\t${money.format(line.total)}`)
    await navigator.clipboard.writeText(rows.join('\n'))
    setStatus('Hasil disalin ✓')
  }

  async function record() {
    if (!parsed || grand <= 0) return
    if (!window.confirm(`Catat ke Pembukuan tanggal ${date}?\nKulakan ${money.format(itemsTotal)}${extrasTotal ? `\nOperasional ${money.format(extrasTotal)}` : ''}`)) return
    setSaving(true)
    setStatus('')
    try {
      const call = httpsCallable(functions, 'ledgerAdd')
      if (itemsTotal > 0) {
        await call({ type: 'expense', category: 'kulakan', amount: itemsTotal, note: `Kulakan pasar: ${parsed.lines.length} produk`.slice(0, 200), date, requestId: requestId() })
      }
      if (extrasTotal > 0) {
        const note = `Kulak (${parsed.extras.filter((extra) => extra.total > 0).map((extra) => extra.name.trim() || 'biaya').join(', ')})`.slice(0, 200)
        await call({ type: 'expense', category: 'operasional', amount: extrasTotal, note, date, requestId: requestId() })
      }
      setStatus('Tercatat di Pembukuan ✓')
    } catch (failure) {
      setStatus(message(failure))
    } finally {
      setSaving(false)
    }
  }

  const pakaiGap = parsed && parsed.pakai !== null ? grand - parsed.pakai : null
  const modalGap = parsed && parsed.modal !== null && parsed.sisa !== null && parsed.pakai !== null ? parsed.modal - parsed.pakai - parsed.sisa : null

  return (
    <section className="kulak">
      <header>
        <h2>Catatan Kulak</h2>
        <p>Paste chat WhatsApp kulak, lalu tekan Pisahkan Sekarang. Format: <code>Nama 10kg 70.000</code> (juga sisir, pcs, ikat, dll).</p>
      </header>
      <textarea value={text} onChange={(event) => setText(event.target.value)} rows={12} placeholder={'Tomat buah 10kg 70.000\nKentang baby 10kg 75.000\nParkir 2.000\n\nModal 1.500.000\nPakai 1.195.000\nSisa 305.000'} />
      <div className="kulak-actions">
        <button type="button" className="primary" disabled={!text.trim()}         onClick={() => void split()}>Pisahkan sekarang</button>
                <button type="button" disabled={!text && !parsed} onClick={() => { setText(''); setParsed(null); setPicks({}); setStatus('') }}>Bersihkan</button>
      </div>
      {parsed && (
        <>
          <div className="kulak-summary">
            <div><span>Total belanja</span><b>{money.format(itemsTotal)}</b></div>
            <div><span>Biaya lain (parkir, bensin, dll)</span><b>{money.format(extrasTotal)}</b></div>
            <div><span>Total keluar</span><b>{money.format(grand)}</b></div>
            {parsed.modal !== null && <div><span>Modal</span><b>{money.format(parsed.modal)}</b></div>}
            {parsed.pakai !== null && <div><span>Pakai (di chat)</span><b>{money.format(parsed.pakai)}</b></div>}
            {parsed.sisa !== null && <div><span>Sisa (di chat)</span><b>{money.format(parsed.sisa)}</b></div>}
          </div>
          {pakaiGap !== null && pakaiGap !== 0 && (
            <p className="kulak-warn">Total hitungan {money.format(grand)} beda {money.format(Math.abs(pakaiGap))} dari "Pakai" di chat ({pakaiGap > 0 ? 'hitungan lebih besar' : 'hitungan lebih kecil'}). Cek baris yang salah ketik atau belum terbaca.</p>
          )}
          {modalGap !== null && modalGap !== 0 && <p className="kulak-warn">Modal − Pakai − Sisa tidak sama dengan 0 (selisih {money.format(Math.abs(modalGap))}).</p>}
          {pakaiGap === 0 && <p className="kulak-ok">Total cocok dengan "Pakai" di chat ✓</p>}
          <div className="kulak-table">
            <table>
              <thead><tr><th>Produk</th><th>Jumlah</th><th>Harga kulak / satuan</th><th>Nominal</th><th /></tr></thead>
              <tbody>
                {parsed.lines.map((line, index) => (
                  <tr key={`${line.name}-${index}`}>
                    <td>{line.name}{master.length > 0 && !productOf(line.id) && <small className="kulak-missing"> ⚠ tidak ada di database</small>}</td>
                    <td>{qtyText(line.qty)} {line.unit}</td>
                    <td><b>{money.format(line.perUnit)}</b> / {line.perUnitLabel}</td>
                    <td>{money.format(line.total)}</td>
                    <td>
                      {master.length > 0 && !productOf(line.id) && <button type="button" className="kulak-move" onClick={() => moveToExtra(line)}>→ biaya</button>}
                      <button type="button" onClick={() => removeLine(index)} aria-label={`Hapus ${line.name}`}>✕</button>
                    </td>
                  </tr>
                ))}
                {parsed.extras.map((extra, index) => (
                  <tr key={index} className="kulak-extra">
                    <td><input value={extra.name} placeholder="Nama biaya" onChange={(event) => editExtra(index, { name: event.target.value })} /></td>
                    <td>biaya</td><td>—</td>
                    <td><input inputMode="numeric" className="kulak-amount" value={extra.total ? String(extra.total) : ''} placeholder="Nominal" onChange={(event) => editExtra(index, { total: Number(event.target.value.replace(/\D/g, '')) })} /></td>
                    <td><button type="button" onClick={() => removeExtra(index)} aria-label={`Hapus ${extra.name}`}>✕</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {missingLines.length > 0 && (
            <p className="kulak-warn">⚠ Tidak ada di database master: {missingLines.map((line) => line.name).join(', ')}. Pilih produk master di bagian Update HPP, pindahkan ke biaya operasional, atau tambahkan produknya ke master dulu.</p>
          )}
          <div className="kulak-actions">
            <button type="button" onClick={addExtra}>+ Tambah biaya (parkir, bensin, dll)</button>
          </div>
          {canRecord && master.length > 0 && hppRows.length > 0 && (
            <div className="kulak-hpp">
              <h3>Update HPP master</h3>
              <p>HPP master = harga kulak per satuan (kolom HPP awal). Harga jual yang berumus di sheet ikut berubah otomatis. Cek pasangan produknya, ubah kalau salah.</p>
              <datalist id="kulak-master">
                {master.map((product) => <option key={product.sku} value={pickLabel(product)} />)}
              </datalist>
              <div className="kulak-table">
                <table>
                  <thead><tr><th /><th>Produk di chat</th><th>Produk master</th><th>HPP lama</th><th>HPP baru</th><th>Selisih</th></tr></thead>
                  <tbody>
                    {hppRows.map(({ line, product, unitOk, diff, checked }) => (
                      <tr key={line.id}>
                        <td><input type="checkbox" checked={checked} disabled={!product || !unitOk} onChange={(event) => setPicks((current) => ({ ...current, [line.id]: { text: current[line.id]?.text ?? '', checked: event.target.checked } }))} /></td>
                        <td>{line.name}</td>
                        <td>
                          <input list="kulak-master" value={picks[line.id]?.text ?? ''} placeholder="Cari produk master" onChange={(event) => setPicks((current) => ({ ...current, [line.id]: { text: event.target.value, checked: true } }))} />
                          {product && !unitOk && <small className="kulak-warn"> satuan master {product.unit}, chat {line.unit}</small>}
                        </td>
                        <td>{product ? `${money.format(product.hpp)}/${product.unit.toLowerCase()}` : '—'}</td>
                        <td><b>{money.format(line.perUnit)}</b></td>
                        <td className={diff !== null && Math.abs(diff) >= 15 ? 'kulak-warn' : ''}>{diff === null ? '—' : `${diff > 0 ? '+' : ''}${diff.toFixed(1)}%`}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="kulak-actions">
                <button type="button" className="primary" disabled={hppBusy || selectedHpp.length === 0} onClick={() => void updateHpp()}>{hppBusy ? 'Mengupdate...' : `Update HPP master (${selectedHpp.length} produk)`}</button>
                <button type="button" disabled={scanning || hppRows.every((row) => !row.product || !row.unitOk)} onClick={() => void checkMarketplace()}>{scanning ? 'Memeriksa...' : '⚠ Cek harga di marketplace'}</button>
              </div>
            </div>
          )}
          <div className="kulak-actions">
            <button type="button" onClick={() => void copyResult()}>Salin hasil</button>
            {canRecord && (
              <>
                <input type="date" value={date} onChange={(event) => setDate(event.target.value)} />
                <button type="button" className="primary" disabled={saving || grand <= 0} onClick={() => void record()}>{saving ? 'Mencatat...' : 'Catat ke Pembukuan'}</button>
              </>
            )}
          </div>
        </>
      )}
      {status && <p className={status.includes('✓') ? 'kulak-ok' : 'kulak-warn'}>{status}</p>}
      {scanOpen && (
        <div className="kulak-modal" role="dialog" aria-modal="true" aria-label="Cek harga marketplace">
          <div className="kulak-modal-card">
            <h3>Tugas: update harga di marketplace</h3>
            {scanning ? (
              <p>{scanProgress} Mohon tunggu, bisa sampai 1–2 menit.</p>
            ) : risks.length === 0 ? (
              <p className="kulak-ok">Tidak ada varian yang rugi atau margin di bawah {safeMargin * 100}% ({scannedCount} varian diperiksa) ✓</p>
            ) : (
              <>
                <p className="kulak-warn">{risks.filter((row) => row.level === 'rugi').length} varian RUGI dan {risks.filter((row) => row.level === 'tipis').length} varian margin tipis (&lt; {safeMargin * 100}%) dengan harga kulak baru. Naikkan harganya di Seller Centre. Margin belum dikurangi biaya admin marketplace.</p>
                <div className="kulak-table">
                  <table>
                    <thead><tr><th>Toko</th><th>Produk</th><th>Varian</th><th>Harga tayang</th><th>Modal baru</th><th>Margin</th><th>Saran min.</th></tr></thead>
                    <tbody>
                      {risks.map((row, index) => (
                        <tr key={index} className={row.level === 'rugi' ? 'kulak-rugi' : ''}>
                          <td>{row.store}</td><td>{row.product}</td><td>{row.variant}</td>
                          <td>{money.format(row.price)}</td><td>{money.format(row.cost)}</td>
                          <td><b>{row.level === 'rugi' ? 'RUGI ' : ''}{(row.margin * 100).toFixed(1)}%</b></td>
                          <td>{money.format(row.safePrice)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
            {scanErrors.map((error) => <p key={error} className="kulak-warn">Gagal memeriksa — {error}</p>)}
            <div className="kulak-actions"><button type="button" className="primary" disabled={scanning} onClick={() => setScanOpen(false)}>Tutup</button></div>
          </div>
        </div>
      )}
    </section>
  )
}
