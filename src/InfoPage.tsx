import { storeInfo } from './storeInfo'
import './InfoPage.css'

const waNumber = '6285176768067'
const instagramUser = storeInfo.instagram.replace('@', '')

const links = [
  { icon: '🛒', title: 'Belanja Online', note: 'Lihat semua produk & checkout', href: storeInfo.websiteUrl },
  {
    icon: '💬',
    title: 'Pesan via WhatsApp',
    note: storeInfo.whatsapp,
    href: `https://wa.me/${waNumber}?text=${encodeURIComponent('Halo 2GoFresh, saya mau pesan.')}`,
  },
  { icon: '🛍️', title: 'Toko Shopee', note: `shopee.co.id/${storeInfo.shopee}`, href: `https://shopee.co.id/${storeInfo.shopee}` },
  { icon: '🎫', title: 'Jadi Member VIP', note: 'Free ongkir 1 km & poin 1%', href: `${storeInfo.websiteUrl}/#vip` },
  { icon: '📸', title: 'Instagram', note: storeInfo.instagram, href: `https://instagram.com/${instagramUser}` },
  { icon: '✉️', title: 'Email', note: storeInfo.email, href: `mailto:${storeInfo.email}` },
  {
    icon: '📍',
    title: 'Lokasi Toko',
    note: storeInfo.address,
    href: 'https://www.google.com/maps?q=-7.974164,112.656634',
  },
]

function InfoPage() {
  return (
    <main className="info">
      <div className="info-card">
        <img className="info-logo" src="/brand/logo.png" alt="2GoFresh" />
        <img className="info-yubi" src="/brand/yubi2.png" alt="Yubi, maskot 2GoFresh" width="80" height="110" />
        <p className="info-tag">Sayur, buah &amp; kebutuhan segar harian</p>
        <nav className="info-links" aria-label="Tautan 2GoFresh">
          {links.map((link) => (
            <a key={link.title} href={link.href} target="_blank" rel="noreferrer">
              <span className="info-ic" aria-hidden="true">{link.icon}</span>
              <span className="info-tx"><b>{link.title}</b><small>{link.note}</small></span>
              <span aria-hidden="true">›</span>
            </a>
          ))}
        </nav>
        <footer>© 2GoFresh · Malang</footer>
      </div>
    </main>
  )
}

export default InfoPage
