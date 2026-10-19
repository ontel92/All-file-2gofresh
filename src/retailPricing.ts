export type RetailProduct = {
  sku: string
  name: string
  unit: string
  retailPrice: number
}

export type CartLine = { sku: string; mode: 'quantity' | 'nominal'; input: string }

// Harus sama dengan aturan di Cloud Function createRetailSale.
const retailSurchargeRate = 0.1
const retailPriceStep = 500

export function retailPerKg(wholesalePerKg: number) {
  return Math.ceil((wholesalePerKg * (1 + retailSurchargeRate)) / retailPriceStep) * retailPriceStep
}

export function parseNumber(value: string) {
  const parsed = Number(value.trim().replace(/\./g, '').replace(',', '.'))
  return Number.isFinite(parsed) ? parsed : NaN
}

export function parseDecimal(value: string) {
  const parsed = Number(value.trim().replace(',', '.'))
  return Number.isFinite(parsed) ? parsed : NaN
}

export function priceLine(product: RetailProduct, line: CartLine) {
  const isKg = product.unit.toUpperCase() === 'KG'
  if (!isKg) {
    const quantity = parseDecimal(line.input)
    if (!Number.isInteger(quantity) || quantity < 1) return null
    return { quantity, total: product.retailPrice * quantity }
  }
  const ecerPrice = retailPerKg(product.retailPrice)
  if (line.mode === 'nominal') {
    const amount = parseNumber(line.input)
    if (!Number.isInteger(amount) || amount < 100) return null
    const rate = amount >= product.retailPrice ? product.retailPrice : ecerPrice
    const quantity = Math.floor((amount / rate) * 1000) / 1000
    return quantity > 0 ? { quantity, total: amount } : null
  }
  const raw = parseDecimal(line.input)
  if (!(raw > 0)) return null
  const quantity = Math.round(raw * 1000) / 1000
  if (quantity <= 0) return null
  const total =
    quantity >= 1
      ? Math.round(product.retailPrice * quantity)
      : Math.max(100, Math.round((ecerPrice * quantity) / 100) * 100)
  return { quantity, total }
}

export function priceB2bLine(product: RetailProduct, line: CartLine) {
  const quantity = parseDecimal(line.input)
  if (!(quantity > 0)) return null
  if (product.unit.toUpperCase() !== 'KG') {
    return Number.isInteger(quantity) ? { quantity, total: product.retailPrice * quantity } : null
  }
  const rounded = Math.round(quantity * 1000) / 1000
  return rounded > 0 ? { quantity: rounded, total: Math.round(product.retailPrice * rounded) } : null
}

// Menghasilkan 62xxxxxxxxxx dari 08xx, +62xx, atau 62xx; null kalau bentuknya tidak valid.
export function normalizePhone(value: string): string | null {
  const digits = value.replace(/[\s()+-]/g, '')
  if (!/^\d+$/.test(digits)) return null
  const normalized = digits.startsWith('0')
    ? `62${digits.slice(1)}`
    : digits.startsWith('62')
      ? digits
      : digits.startsWith('8')
        ? `62${digits}`
        : ''
  return /^628\d{7,12}$/.test(normalized) ? normalized : null
}