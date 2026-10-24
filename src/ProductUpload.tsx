import { useCallback, useEffect, useState } from 'react'
import { getMetadata, getStorage, ref, uploadBytes } from 'firebase/storage'
import { httpsCallable } from 'firebase/functions'
import { app } from './firebase'
import { functions } from './posFirebase'
import './ProductUpload.css'

type Props = { categories: string[]; units: string[]; uid: string }
type ProductForm = {
  minQty: string
  sku: string
  category: string
  name: string
  unit: string
  hpp: string
  shrinkage: string
  effectiveHpp: string
  retailMargin: string
  b2bMargin: string
  retailPrice: string
  b2bPrice: string
  retail500: string
  retail250: string
  marketplaceFee: string
  marketplacePrice: string
  marketplace500: string
  marketplace250: string
  marketplace100: string
  marketplace50: string
  marketplace10: string
  marketplace5: string
}

type ShopeeAttributeValue = { valueId: number; name: string }
type ShopeeListingData = {
  itemName: string
  description: string
  initialStock: string
  categoryId: number
  brandId: number
  brandName: string
  attributes: { attributeId: number; values: ShopeeAttributeValue[] }[]
  logistics: { logisticsId: number; sizeId: number }[]
  weight: string
  packageLength: string
  packageWidth: string
  packageHeight: string
}

const emptyShopeeListing: ShopeeListingData = {
  itemName: '',
  description: '',
  initialStock: '',
  categoryId: 0,
  brandId: -1,
  brandName: '',
  attributes: [],
  logistics: [],
  weight: '',
  packageLength: '',
  packageWidth: '',
  packageHeight: '',
}

const empty: ProductForm = {
  minQty: '1', sku: '', category: '', name: '', unit: '', hpp: '', shrinkage: '0',
  effectiveHpp: '', retailMargin: '', b2bMargin: '', retailPrice: '', b2bPrice: '',
  retail500: '', retail250: '', marketplaceFee: '', marketplacePrice: '',
  marketplace500: '', marketplace250: '', marketplace100: '', marketplace50: '',
  marketplace10: '', marketplace5: '',
}

const idr = new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', maximumFractionDigits: 0 })
const imageMimeByExtension: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
}

export default function ProductUpload({ categories, units, uid }: Props) {
  const [form, setForm] = useState<ProductForm>(() => ({
    ...empty,
    category: categories[0] ?? '',
    unit: units[0] ?? '',
  }))
  const [image, setImage] = useState<File | null>(null)
  const [imagePath, setImagePath] = useState('')
  const [publishToShopee, setPublishToShopee] = useState(false)
  const [shopeeListing, setShopeeListing] = useState<ShopeeListingData>(emptyShopeeListing)
  const [masterSaved, setMasterSaved] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')

  function setField(key: keyof ProductForm, value: string) {
    setForm((current) => ({ ...current, [key]: value }))
  }

  const effectiveHpp = Number(form.effectiveHpp)
  const marketplacePrice = Number(form.marketplacePrice)
  const fee = Number(form.marketplaceFee) / 100
  const breakEven = effectiveHpp > 0 && fee >= 0 && fee < 1 ? Math.ceil(effectiveHpp / (1 - fee)) : 0
  const priceWarning = breakEven > 0 && marketplacePrice > 0 && marketplacePrice < breakEven

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setBusy(true)
    setError('')
    setSuccess('')
    let saved = masterSaved
    try {
      const safeSku = form.sku.trim()
      if (publishToShopee) {
        const extension = (masterSaved ? imagePath.split('.').pop() : image?.name.split('.').pop())?.toLowerCase()
        if (!['jpg', 'jpeg', 'png'].includes(extension ?? '')) {
          throw new Error('Foto untuk upload langsung ke Shopee harus berformat JPG atau PNG.')
        }
        if (!shopeeListing.categoryId || shopeeListing.brandId < 0) {
          throw new Error('Pilih kategori dan merek Shopee terlebih dahulu.')
        }
        if (shopeeListing.logistics.length === 0) throw new Error('Pilih minimal satu jasa kirim aktif Shopee.')
        if (!shopeeListing.description.trim() || !shopeeListing.weight || !shopeeListing.packageLength || !shopeeListing.packageWidth || !shopeeListing.packageHeight) {
          throw new Error('Lengkapi deskripsi, berat, dan seluruh dimensi paket untuk Shopee.')
        }
        if (!Number.isFinite(Number(shopeeListing.initialStock)) || Number(shopeeListing.initialStock) < 1) {
          throw new Error('Stok awal POS minimal 1 agar dapat diunggah sebagai stok Shopee.')
        }
      }
      if (!saved) {
        if (!image) throw new Error('Foto produk wajib dipilih.')
        if (!/^([A-Za-z0-9][A-Za-z0-9._-]{0,99})$/.test(safeSku)) throw new Error('Format SKU tidak valid.')
        if (image.size > 5 * 1024 * 1024) throw new Error('Foto harus berupa gambar maksimal 5 MB.')

        const extension = image.name.split('.').pop()?.toLowerCase()
        if (!extension || !imageMimeByExtension[extension] || image.name !== `${safeSku}.${extension}`) {
          throw new Error(`Nama file foto harus tepat ${safeSku}.jpg, ${safeSku}.png, atau ekstensi gambar yang didukung lainnya.`)
        }
        if (image.type !== imageMimeByExtension[extension]) throw new Error('Format file dan ekstensi foto tidak cocok.')
        const storagePath = `product-images/${image.name}`
        const storageRef = ref(getStorage(app), storagePath)
        try {
          const existing = await getMetadata(storageRef)
          if (existing.customMetadata?.uploaderUid !== uid || existing.customMetadata?.sku !== safeSku) {
            throw new Error(`File ${image.name} sudah digunakan unggahan lain. Gunakan nama file yang berbeda atau periksa Firebase Storage.`)
          }
        } catch (failure) {
          if (!(failure instanceof Error && 'code' in failure && failure.code === 'storage/object-not-found')) throw failure
          await uploadBytes(storageRef, image, {
            contentType: image.type,
            customMetadata: { uploaderUid: uid, sku: safeSku },
          })
        }
        setImagePath(storagePath)

        const number = (key: keyof ProductForm) => Number(form[key])
        const optional = (key: keyof ProductForm) => form[key] === '' ? null : Number(form[key])
        await httpsCallable(functions, 'addMasterProduct')({
          minQty: number('minQty'),
          sku: safeSku,
          category: form.category,
          name: form.name,
          unit: form.unit,
          hpp: number('hpp'),
          shrinkage: number('shrinkage') / 100,
          effectiveHpp: number('effectiveHpp'),
          retailMargin: number('retailMargin') / 100,
          b2bMargin: number('b2bMargin') / 100,
          retailPrice: number('retailPrice'),
          b2bPrice: number('b2bPrice'),
          retail500: optional('retail500'),
          retail250: optional('retail250'),
          marketplaceFee: number('marketplaceFee') / 100,
          marketplacePrice: number('marketplacePrice'),
          marketplace500: optional('marketplace500'),
          marketplace250: optional('marketplace250'),
          marketplace100: optional('marketplace100'),
          marketplace50: optional('marketplace50'),
          marketplace10: optional('marketplace10'),
          marketplace5: optional('marketplace5'),
          imagePath: storagePath,
        })
        saved = true
        setMasterSaved(true)
      }

      if (publishToShopee) {
        if (!shopeeListing.categoryId) throw new Error('Pilih kategori produk Shopee.')
        await httpsCallable<
          { sku: string; quantity: number },
          { sku: string; unit: string; onHand: number; alreadySet: boolean }
        >(functions, 'setNewProductOpeningStock')({
          sku: safeSku,
          quantity: Number(shopeeListing.initialStock),
        })
        const result = await httpsCallable<
          Record<string, unknown>,
          { itemId: number; sku: string; stock: number }
        >(functions, 'shopeePublishProduct')({
          sku: safeSku,
          name: shopeeListing.itemName.trim() || form.name.trim(),
          description: shopeeListing.description,
          categoryId: shopeeListing.categoryId,
          price: Number(form.marketplacePrice),
          brandId: shopeeListing.brandId,
          brandName: shopeeListing.brandName,
          attributes: shopeeListing.attributes,
          logistics: shopeeListing.logistics,
          weight: Number(shopeeListing.weight),
          packageLength: Number(shopeeListing.packageLength),
          packageWidth: Number(shopeeListing.packageWidth),
          packageHeight: Number(shopeeListing.packageHeight),
          imagePath: imagePath || `product-images/${safeSku}.${image?.name.split('.').pop()?.toLowerCase() ?? ''}`,
        })
        setSuccess(`Produk ${safeSku} tersimpan ke master dan berhasil diunggah ke Shopee (ID ${result.data.itemId}, stok ${result.data.stock}).`)
      } else {
        setSuccess(`Produk ${safeSku} berhasil ditambahkan ke master. Katalog website/POS diperbarui setelah sinkronisasi Sheets berikutnya.`)
      }
      setForm({ ...empty, category: categories[0] ?? '', unit: units[0] ?? '' })
      setImage(null)
      setImagePath('')
      setMasterSaved(false)
      setPublishToShopee(false)
      setShopeeListing(emptyShopeeListing)
      const picker = document.getElementById('product-upload-image') as HTMLInputElement | null
      if (picker) picker.value = ''
    } catch (failure) {
      if (saved) setSuccess(`Produk ${form.sku.trim()} sudah tersimpan di Google Sheets. Upload Shopee belum berhasil; data form tetap tersedia agar dapat dicoba lagi.`)
      setError(failure instanceof Error ? failure.message : 'Gagal menyimpan produk.')
    } finally {
      setBusy(false)
    }
  }

  function input(key: keyof ProductForm, label: string, options: { required?: boolean; step?: string; min?: string; max?: string; hint?: string } = {}) {
    return (
      <label className="pu-field" key={key}>
        <span>{label}{options.required !== false && <b> *</b>}</span>
        <input
          type="number"
          min={options.min ?? '0'}
          max={options.max}
          step={options.step ?? '1'}
          required={options.required !== false}
          value={form[key]}
          onChange={(event) => setField(key, event.target.value)}
        />
        {options.hint && <small>{options.hint}</small>}
      </label>
    )
  }

  return (
    <section className="pu">
      <header className="pos-page-heading">
        <div>
          <p className="pos-eyebrow">MASTER PRODUK</p>
          <h1>Upload produk baru</h1>
          <p>Foto disimpan ke Firebase Storage, lalu seluruh 23 kolom master produk ditambahkan ke Google Sheets.</p>
        </div>
      </header>
      <form className="pu-form" onSubmit={(event) => void submit(event)}>
        <fieldset disabled={masterSaved}>
          <legend>Informasi produk</legend>
          <div className="pu-grid">
            <label className="pu-field"><span>SKU *</span><input required maxLength={100} value={form.sku} onChange={(event) => setField('sku', event.target.value)} /></label>
            <label className="pu-field"><span>Nama produk *</span><input required maxLength={160} value={form.name} onChange={(event) => setField('name', event.target.value)} /></label>
            <label className="pu-field"><span>Kategori *</span><select required value={form.category} onChange={(event) => setField('category', event.target.value)}>{categories.map((category) => <option key={category}>{category}</option>)}</select></label>
            <label className="pu-field"><span>Satuan *</span><select required value={form.unit} onChange={(event) => setField('unit', event.target.value)}>{units.map((unit) => <option key={unit}>{unit}</option>)}</select></label>
            {input('minQty', 'MIN_QTY', { min: '0.0001', step: '0.001' })}
            <label className="pu-field"><span>Foto produk Firebase *</span><input id="product-upload-image" required type="file" disabled={masterSaved} accept=".jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp" onChange={(event) => setImage(event.target.files?.[0] ?? null)} /><small>Nama file wajib sama persis dengan SKU, contoh {form.sku.trim() || 'SKU'}.jpg. JPG, PNG, WebP, maksimal 5 MB.</small></label>
          </div>
        </fieldset>

        <fieldset disabled={masterSaved}>
          <legend>Harga pokok dan retail</legend>
          <div className="pu-grid">
            {input('hpp', 'HPP Awal')}
            {input('shrinkage', 'Est. Penyusutan (%)', { max: '100', step: '0.01' })}
            {input('effectiveHpp', 'HPP EFEKTIF')}
            {input('retailMargin', 'Margin Retail (%)', { max: '100', step: '0.01' })}
            {input('b2bMargin', 'Margin B2B (%)', { max: '100', step: '0.01' })}
            {input('retailPrice', 'HARGA RETAIL')}
            {input('b2bPrice', 'HARGA B2B')}
            {input('retail500', 'Harga Retail 500g', { required: false })}
            {input('retail250', 'Harga Retail 250g', { required: false })}
          </div>
        </fieldset>

        <fieldset disabled={masterSaved}>
          <legend>Harga marketplace (sesuai kolom master)</legend>
          <div className="pu-grid">
            {input('marketplaceFee', 'Fee MP (%)', { max: '100', step: '0.01' })}
            {input('marketplacePrice', 'HARGA MARKETPLACE')}
            {input('marketplace500', 'Marketplace 500gr', { required: false })}
            {input('marketplace250', 'Marketplace 250gr', { required: false })}
            {input('marketplace100', 'Marketplace 100gr', { required: false })}
            {input('marketplace50', 'Marketplace 50g', { required: false })}
            {input('marketplace10', 'Marketplace 10g', { required: false })}
            {input('marketplace5', 'Marketplace 5g', { required: false })}
          </div>
          {priceWarning && <p className="pu-warning" role="alert">Harga marketplace lebih rendah dari titik impas setelah fee. Minimal perkiraan agar HPP tertutup: {idr.format(breakEven)}. Periksa master harga sebelum menyimpan.</p>}
        </fieldset>
        <div className="pu-publish-toggle">
          <label>
            <input type="checkbox" checked={publishToShopee} onChange={(event) => setPublishToShopee(event.target.checked)} />
            <span><b>Unggah produk ini langsung ke Shopee</b><small>Listing dikirim ke toko; status tayang mengikuti pemeriksaan Shopee. Harga mengikuti master dan stok awal dicatat ke inventory POS.</small></span>
          </label>
        </div>
        {publishToShopee && (
          <ShopeePublishFields
            productName={form.name}
            productUnit={form.unit}
            marketplacePrice={form.marketplacePrice}
            value={shopeeListing}
            onChange={setShopeeListing}
          />
        )}
        {error && <p className="pu-error" role="alert">{error}</p>}
        {success && <p className="pu-success" role="status">{success}</p>}
        <button className="sf-primary pu-submit" type="submit" disabled={busy}>{busy ? 'Menyimpan dan mengunggah...' : publishToShopee ? masterSaved ? 'Coba upload Shopee lagi' : 'Simpan master & unggah ke Shopee' : masterSaved ? 'Selesai' : 'Upload foto & simpan ke Master Sheets'}</button>
        <p className="pu-note">Akses khusus owner/supervisor. Kategori, atribut wajib, merek, dan jasa kirim dimuat dari toko Shopee. Jika listing ditolak, produk master tetap tersimpan. Jika hasil API tidak pasti, periksa Shopee sebelum mencoba ulang agar tidak membuat listing ganda.</p>
      </form>
      <MissingProductImages uid={uid} />
    </section>
  )
}

type ShopeeCategory = { categoryId: number; label: string }
type ShopeeLogistics = { logisticsId: number; name: string; sizes: { sizeId: number; name: string }[] }
type ShopeeAttribute = {
  attributeId: number
  name: string
  mandatory: boolean
  inputType: string
  maxLength: number
  values: ShopeeAttributeValue[]
}
type ShopeeBrand = { brandId: number; name: string }

async function callShopeeSetup() {
  return (await httpsCallable<null, { categories: ShopeeCategory[]; logistics: ShopeeLogistics[] }>(
    functions,
    'shopeeProductSetup',
  )(null)).data
}

function ShopeePublishFields({
  productName,
  productUnit,
  marketplacePrice,
  value,
  onChange,
}: {
  productName: string
  productUnit: string
  marketplacePrice: string
  value: ShopeeListingData
  onChange: (value: ShopeeListingData) => void
}) {
  const [categories, setCategories] = useState<ShopeeCategory[]>([])
  const [logistics, setLogistics] = useState<ShopeeLogistics[]>([])
  const [attributes, setAttributes] = useState<ShopeeAttribute[]>([])
  const [brands, setBrands] = useState<ShopeeBrand[]>([])
  const [loading, setLoading] = useState(true)
  const [requirementsLoading, setRequirementsLoading] = useState(Boolean(value.categoryId))
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true
    const load = async () => {
      try {
        const result = await callShopeeSetup()
        if (active) {
          setCategories(result.categories)
          setLogistics(result.logistics)
        }
      } catch (failure) {
        if (active) setError(failure instanceof Error ? failure.message : 'Gagal memuat kategori dan jasa kirim Shopee.')
      } finally {
        if (active) setLoading(false)
      }
    }
    void load()
    return () => { active = false }
  }, [])

  useEffect(() => {
    if (!value.categoryId) return
    let active = true
    const load = async () => {
      try {
        const result = await httpsCallable<{ categoryId: number }, { attributes: ShopeeAttribute[]; brands: ShopeeBrand[] }>(
          functions,
          'shopeeProductRequirements',
        )({ categoryId: value.categoryId })
        if (active) {
          setAttributes(result.data.attributes)
          setBrands(result.data.brands)
        }
      } catch (failure) {
        if (active) setError(failure instanceof Error ? failure.message : 'Gagal memuat atribut wajib Shopee.')
      } finally {
        if (active) setRequirementsLoading(false)
      }
    }
    void load()
    return () => { active = false }
  }, [value.categoryId])

  const update = (patch: Partial<ShopeeListingData>) => onChange({ ...value, ...patch })

  function selectCategory(categoryId: number) {
    update({ categoryId, attributes: [], brandId: -1, brandName: '' })
    setAttributes([])
    setBrands([])
    setError('')
    setRequirementsLoading(categoryId > 0)
  }

  function setAttributeValues(attributeId: number, values: ShopeeAttributeValue[]) {
    const next = value.attributes.filter((attribute) => attribute.attributeId !== attributeId)
    if (values.length) next.push({ attributeId, values })
    update({ attributes: next })
  }

  function toggleLogistics(channel: ShopeeLogistics, checked: boolean) {
    const next = value.logistics.filter((entry) => entry.logisticsId !== channel.logisticsId)
    if (checked) next.push({ logisticsId: channel.logisticsId, sizeId: channel.sizes[0]?.sizeId ?? 0 })
    update({ logistics: next })
  }

  return (
    <fieldset className="pu-shopee">
      <legend>Data wajib listing Shopee</legend>
      {loading && <p className="pu-note">Mengambil kategori dan jasa kirim dari Shopee...</p>}
      {error && <p className="pu-error" role="alert">{error}</p>}
      <div className="pu-grid">
        <label className="pu-field pu-span-all">
          <span>Judul produk Shopee *</span>
          <input required maxLength={120} value={value.itemName || productName} onChange={(event) => update({ itemName: event.target.value })} />
        </label>
        <label className="pu-field pu-span-all">
          <span>Deskripsi produk *</span>
          <textarea required minLength={10} maxLength={5000} rows={5} value={value.description} onChange={(event) => update({ description: event.target.value })} />
        </label>
        <label className="pu-field pu-span-all">
          <span>Kategori Shopee *</span>
          <select required value={value.categoryId || ''} disabled={loading} onChange={(event) => selectCategory(Number(event.target.value))}>
            <option value="">Pilih kategori</option>
            {categories.map((category) => <option key={category.categoryId} value={category.categoryId}>{category.label}</option>)}
          </select>
        </label>
        <label className="pu-field">
          <span>Harga Shopee *</span>
          <input readOnly required type="number" value={marketplacePrice} />
          <small>Mengikuti kolom HARGA MARKETPLACE pada master.</small>
        </label>
        <label className="pu-field">
          <span>Stok awal *</span>
          <input required type="number" min="1" step={productUnit.trim().toUpperCase() === 'KG' ? '0.001' : '1'} value={value.initialStock} onChange={(event) => update({ initialStock: event.target.value })} />
          <small>Dicatat sebagai stok pembukaan POS; Shopee mengambil dari inventory tersebut dan membulatkan ke bawah ke unit utuh.</small>
        </label>
      </div>

      {requirementsLoading && <p className="pu-note">Memuat atribut dan merek untuk kategori terpilih...</p>}
      {value.categoryId > 0 && !requirementsLoading && (
        <div className="pu-grid pu-shopee-requirements">
          <label className="pu-field">
            <span>Merek Shopee *</span>
            <select
              required
              value={value.brandId >= 0 ? value.brandId : ''}
              onChange={(event) => {
                const brandId = Number(event.target.value)
                const brand = brands.find((entry) => entry.brandId === brandId)
                update({ brandId, brandName: brand?.name ?? '' })
              }}
            >
              <option value="" disabled>Pilih merek</option>
              {brands.map((brand) => <option key={`${brand.brandId}-${brand.name}`} value={brand.brandId}>{brand.name}</option>)}
            </select>
          </label>
          {attributes.map((attribute) => {
            const selected = value.attributes.find((entry) => entry.attributeId === attribute.attributeId)?.values ?? []
            const isMulti = attribute.inputType.includes('MULTI')
            return (
              <label className="pu-field" key={attribute.attributeId}>
                <span>{attribute.name}{attribute.mandatory && <b> *</b>}</span>
                {attribute.values.length > 0 ? (
                  <select
                    required={attribute.mandatory}
                    multiple={isMulti}
                    value={selected.map((entry) => String(entry.valueId))}
                    onChange={(event) => {
                      const chosen = Array.from(event.currentTarget.selectedOptions)
                        .map((option) => attribute.values.find((entry) => entry.valueId === Number(option.value)))
                        .filter((entry): entry is ShopeeAttributeValue => Boolean(entry))
                      setAttributeValues(attribute.attributeId, isMulti ? chosen : chosen.slice(0, 1))
                    }}
                  >
                    {!isMulti && <option value="">Pilih {attribute.name}</option>}
                    {attribute.values.map((option) => <option key={`${option.valueId}-${option.name}`} value={option.valueId}>{option.name}</option>)}
                  </select>
                ) : (
                  <input
                    required={attribute.mandatory}
                    maxLength={attribute.maxLength || 500}
                    type={attribute.inputType.includes('DATE') ? 'date' : attribute.inputType.includes('NUMBER') ? 'number' : 'text'}
                    value={selected[0]?.name ?? ''}
                    onChange={(event) => setAttributeValues(attribute.attributeId, event.target.value ? [{ valueId: 0, name: event.target.value }] : [])}
                  />
                )}
              </label>
            )
          })}
        </div>
      )}

      <div className="pu-grid pu-shopee-dimensions">
        <label className="pu-field"><span>Berat paket (kg) *</span><input required type="number" min="0.01" max="1000" step="0.01" value={value.weight} onChange={(event) => update({ weight: event.target.value })} /></label>
        <label className="pu-field"><span>Panjang (cm) *</span><input required type="number" min="1" max="1000" step="1" value={value.packageLength} onChange={(event) => update({ packageLength: event.target.value })} /></label>
        <label className="pu-field"><span>Lebar (cm) *</span><input required type="number" min="1" max="1000" step="1" value={value.packageWidth} onChange={(event) => update({ packageWidth: event.target.value })} /></label>
        <label className="pu-field"><span>Tinggi (cm) *</span><input required type="number" min="1" max="1000" step="1" value={value.packageHeight} onChange={(event) => update({ packageHeight: event.target.value })} /></label>
      </div>

      <div className="pu-logistics">
        <b>Jasa kirim aktif *</b>
        {logistics.map((channel) => {
          const selected = value.logistics.find((entry) => entry.logisticsId === channel.logisticsId)
          return (
            <div className="pu-logistics-row" key={channel.logisticsId}>
              <label><input type="checkbox" checked={Boolean(selected)} onChange={(event) => toggleLogistics(channel, event.target.checked)} />{channel.name}</label>
              {selected && channel.sizes.length > 0 && (
                <select required aria-label={`Ukuran paket ${channel.name}`} value={selected.sizeId} onChange={(event) => update({ logistics: value.logistics.map((entry) => entry.logisticsId === channel.logisticsId ? { ...entry, sizeId: Number(event.target.value) } : entry) })}>
                  {channel.sizes.map((size) => <option key={size.sizeId} value={size.sizeId}>{size.name || `Ukuran ${size.sizeId}`}</option>)}
                </select>
              )}
            </div>
          )
        })}
        {value.logistics.length === 0 && <small>Pilih sedikitnya satu jasa kirim yang aktif.</small>}
      </div>
    </fieldset>
  )
}

type MissingProduct = { sku: string; name: string; category: string; rowNumber: number }
type MissingProductsResponse = { products: MissingProduct[]; count: number }

async function fetchMissingProducts() {
  const result = await httpsCallable<null, MissingProductsResponse>(functions, 'listProductsMissingImages')(null)
  return result.data.products
}

function MissingProductImages({ uid }: { uid: string }) {
  const [products, setProducts] = useState<MissingProduct[]>([])
  const [files, setFiles] = useState<Record<string, File | undefined>>({})
  const [loading, setLoading] = useState(true)
  const [busySku, setBusySku] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const load = useCallback(async () => {
    try {
      setProducts(await fetchMissingProducts())
      setError('')
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Gagal membaca produk tanpa foto dari Google Sheets.')
    } finally {
      setLoading(false)
    }
  }, [])

  const refresh = () => {
    setLoading(true)
    setError('')
    void load()
  }

  useEffect(() => {
    let active = true
    const initialLoad = async () => {
      try {
        const missingProducts = await fetchMissingProducts()
        if (active) {
          setProducts(missingProducts)
          setError('')
        }
      } catch (failure) {
        if (active) setError(failure instanceof Error ? failure.message : 'Gagal membaca produk tanpa foto dari Google Sheets.')
      } finally {
        if (active) setLoading(false)
      }
    }
    void initialLoad()
    return () => { active = false }
  }, [])

  async function upload(product: MissingProduct) {
    const file = files[product.sku]
    if (!file) {
      setError(`Pilih foto untuk SKU ${product.sku}.`)
      return
    }
    const extension = file.name.split('.').pop()?.toLowerCase()
    if (file.name !== `${product.sku}.${extension}` || !extension || !['jpg', 'jpeg', 'png', 'webp'].includes(extension)) {
      setError(`Nama file harus sama persis dengan SKU: ${product.sku}.jpg (atau .jpeg, .png, .webp).`)
      return
    }
    if (file.size > 5 * 1024 * 1024) {
      setError('Foto harus berupa gambar maksimal 5 MB.')
      return
    }
    if (file.type !== imageMimeByExtension[extension]) {
      setError('Format file dan ekstensi foto tidak cocok.')
      return
    }

    setBusySku(product.sku)
    setError('')
    setNotice('')
    try {
      const storageRef = ref(getStorage(app), `product-images/${file.name}`)
      try {
        await getMetadata(storageRef)
      } catch (failure) {
        if (!(failure instanceof Error && 'code' in failure && failure.code === 'storage/object-not-found')) throw failure
        await uploadBytes(storageRef, file, {
          contentType: file.type,
          customMetadata: { uploaderUid: uid, sku: product.sku },
        })
      }
      await httpsCallable(functions, 'setMasterProductImage')({
        sku: product.sku,
        imagePath: `product-images/${file.name}`,
      })
      setFiles((current) => {
        const next = { ...current }
        delete next[product.sku]
        return next
      })
      setNotice(`Foto ${product.sku} tersimpan dan link-nya sudah ditulis ke kolom W Google Sheets.`)
      await load()
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : `Gagal menyimpan foto SKU ${product.sku}.`)
    } finally {
      setBusySku('')
    }
  }

  return (
    <section className="pu-missing">
      <div className="pu-missing-heading">
        <div>
          <p className="pos-eyebrow">PEMERIKSAAN GOOGLE SHEETS</p>
          <h2>Produk yang belum memiliki foto</h2>
          <p>Daftar dibaca langsung dari master produk. Foto yang berhasil diunggah akan otomatis mengisi kolom W.</p>
        </div>
        <button type="button" className="sp-btn ghost" disabled={loading} onClick={refresh}>{loading ? 'Memuat...' : '↻ Muat ulang'}</button>
      </div>
      {error && <p className="pu-error" role="alert">{error}</p>}
      {notice && <p className="pu-success" role="status">{notice}</p>}
      {loading && <p className="pu-note">Memeriksa master produk Google Sheets...</p>}
      {!loading && products.length === 0 && <p className="pu-success">Semua produk di master sudah memiliki link foto.</p>}
      {products.length > 0 && (
        <div className="pu-missing-list">
          {products.map((product) => (
            <article className="pu-missing-row" key={`${product.sku}-${product.rowNumber}`}>
              <div><b>{product.name || product.sku}</b><small>SKU {product.sku} · {product.category || 'Tanpa kategori'} · Baris {product.rowNumber}</small></div>
              <input aria-label={`Pilih foto untuk ${product.sku}`} type="file" accept=".jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp" onChange={(event) => setFiles((current) => ({ ...current, [product.sku]: event.target.files?.[0] }))} />
              <button type="button" className="sf-primary" disabled={Boolean(busySku)} onClick={() => void upload(product)}>{busySku === product.sku ? 'Mengunggah...' : 'Upload foto'}</button>
            </article>
          ))}
        </div>
      )}
    </section>
  )
}
