export const storeLocation = { lat: -7.974164, lng: 112.656634 }

export const vipFreeShippingKm = 1
export const vipMinimumPurchase = 50_000
export const maxDeliveryKm = 15
export const vipCardSku = 'vip-card-01'

// Harus sama dengan perhitungan di functions/src/webstore.ts (server yang menentukan nominal akhir).
const shippingBase = 10_000
const shippingBaseKm = 3
const shippingPerKm = 2_500
const roadFactor = 1.3

export function distanceKm(lat: number, lng: number): number {
  const rad = (degrees: number) => (degrees * Math.PI) / 180
  const dLat = rad(lat - storeLocation.lat)
  const dLng = rad(lng - storeLocation.lng)
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(storeLocation.lat)) * Math.cos(rad(lat)) * Math.sin(dLng / 2) ** 2
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

export function shippingFeeFor(km: number): number {
  const raw = shippingBase + Math.max(0, Math.ceil(km * roadFactor - shippingBaseKm)) * shippingPerKm
  return Math.ceil(raw / 500) * 500
}

export function quoteShipping(km: number, vip: boolean, subtotal: number) {
  const free = vip && km <= vipFreeShippingKm && subtotal >= vipMinimumPurchase
  return { fee: free ? 0 : shippingFeeFor(km), free }
}
