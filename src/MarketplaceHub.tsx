import { useState } from 'react'
import MarketplaceMargin from './MarketplaceMargin'
import MarketplaceShopee from './MarketplaceShopee'
import MarketplaceSync from './MarketplaceSync'
import MarketplaceTiktok from './MarketplaceTiktok'

type Tab = 'shopee' | 'tiktok' | 'sync-shopee' | 'sync-tiktok' | 'margin'

const tabs: { id: Tab; label: string; icon: string }[] = [
  { id: 'shopee', label: 'Shopee', icon: '🟧' },
  { id: 'tiktok', label: 'TikTok / Tokopedia', icon: '🎵' },
  { id: 'sync-shopee', label: 'Master ↔ Shopee', icon: '🔄' },
  { id: 'sync-tiktok', label: 'Master ↔ TikTok', icon: '🔄' },
  { id: 'margin', label: 'Margin', icon: '📈' },
]

// Pusat kendali multi-marketplace (khusus owner): satu tempat untuk pesanan, produk, harga, stok, upload, dan margin.
export default function MarketplaceHub() {
  const [tab, setTab] = useState<Tab>('shopee')
  return (
    <div className="sp">
      <header className="sp-top">
        <div className="sp-store-switch" style={{ gridTemplateColumns: '1fr' }}>
          <div className="sp-store-text" style={{ padding: '0.4rem 0.6rem' }}>
            <b>Pusat Marketplace (Owner)</b>
            <small>Master database adalah SKU induk; Shopee dan TikTok disinkronkan dari sini.</small>
          </div>
        </div>
        <nav className="sp-main-tabs" aria-label="Pusat Marketplace">
          {tabs.map((entry) => (
            <button key={entry.id} type="button" className={tab === entry.id ? 'on' : ''} onClick={() => setTab(entry.id)}>
              <span aria-hidden="true">{entry.icon}</span> {entry.label}
            </button>
          ))}
        </nav>
      </header>
      {tab === 'shopee' && <MarketplaceShopee />}
      {tab === 'tiktok' && <MarketplaceTiktok canManage isOwner />}
      {tab === 'sync-shopee' && <MarketplaceSync isOwner />}
      {tab === 'sync-tiktok' && <MarketplaceSync platform="tiktok" isOwner />}
      {tab === 'margin' && <MarketplaceMargin />}
    </div>
  )
}
