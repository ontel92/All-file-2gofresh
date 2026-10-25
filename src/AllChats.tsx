import { useState } from 'react'
import LiveChat from './LiveChat'
import type { StoreChat } from './LiveChat'
import { ShopeeChat } from './MarketplaceShopee'
import { useOps } from './opsStore'
import './ShopeePanel.css'

type Props = {
  chats: StoreChat[]
  soundOn: boolean
  onEnableSound: () => void
  staffName: string
  storeUnread: number
}

// One place for every inbox: store live chat, Shopee, and (later) TikTok / Tokopedia.
export default function AllChats({ chats, soundOn, onEnableSound, staffName, storeUnread }: Props) {
  const [source, setSource] = useState<'store' | 'shopee' | 'freshstock' | 'tiktok'>('store')
  const { shopeeUnreadChats, freshstockUnreadChats } = useOps()
  const tabs = [
    { id: 'shopee', label: 'Shopee 2goFresh', count: shopeeUnreadChats },
    { id: 'freshstock', label: 'Shopee Freshstock', count: freshstockUnreadChats },
    { id: 'store', label: 'Live Chat Store', count: storeUnread },
    { id: 'tiktok', label: 'Tokopedia / TikTok', count: 0 },
  ] as const

  return (
    <div className="sp all-chats">
      <div className="sp-head">
        <div>
          <strong>Semua Chat</strong>
          <span>Satu tempat untuk semua pesan masuk</span>
        </div>
        <nav aria-label="Sumber chat">
          {tabs.map((tab) => (
            <button key={tab.id} type="button" className={source === tab.id ? 'on' : ''} onClick={() => setSource(tab.id)}>
              {tab.label}
              {tab.count > 0 && <b className="sp-count">{tab.count}</b>}
            </button>
          ))}
        </nav>
      </div>
      {source === 'store' && <LiveChat chats={chats} soundOn={soundOn} onEnableSound={onEnableSound} staffName={staffName} />}
      {source === 'shopee' && <ShopeeChat />}
      {source === 'freshstock' && <ShopeeChat store="freshstock" />}
      {source === 'tiktok' && (
        <section className="sp-connect">
          <h2>Chat Tokopedia / TikTok Shop</h2>
          <p>Segera hadir. Chat akan muncul di sini setelah toko TikTok Shop dihubungkan.</p>
        </section>
      )}
    </div>
  )
}
