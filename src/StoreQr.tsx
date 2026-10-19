import { useEffect, useRef } from 'react'
import QRCode from 'qrcode'
import { storeInfo } from './storeInfo'

export function StoreContact() {
  return (
    <div className="rc-store-contact">
      <p>{storeInfo.address}</p>
      <p>WA {storeInfo.whatsapp} · {storeInfo.email}</p>
      <p>{storeInfo.websiteLabel}</p>
      <p>IG {storeInfo.instagram} · Shopee {storeInfo.shopee}</p>
    </div>
  )
}

export function StoreQr() {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    if (canvasRef.current) {
      void QRCode.toCanvas(canvasRef.current, storeInfo.websiteUrl, { width: 120, margin: 1 })
    }
  }, [])

  return (
    <div className="rc-store-qr">
      <canvas ref={canvasRef} aria-label={`QR ${storeInfo.websiteLabel}`} />
      <p>{storeInfo.qrCaption}</p>
      <small>{storeInfo.websiteLabel}</small>
    </div>
  )
}
