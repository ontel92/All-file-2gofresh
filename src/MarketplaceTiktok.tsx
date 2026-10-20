import './ShopeePanel.css'

// Placeholder until the TikTok Shop Partner Center app is approved and its API keys exist.
export default function MarketplaceTiktok() {
  return (
    <div className="sp tt">
      <div className="sp-head">
        <div>
          <strong>Tokopedia / TikTok Shop</strong>
          <span>Belum terhubung</span>
        </div>
        <nav aria-label="Menu TikTok">
          {['Pesanan', 'Produk', 'Pengembalian'].map((label) => (
            <button key={label} type="button" disabled>{label}</button>
          ))}
        </nav>
      </div>
      <section className="sp-connect">
        <h2>Segera hadir</h2>
        <p>Panel ini akan memakai tampilan yang sama dengan Marketplace Shopee: daftar pesanan per status, notifikasi + suara pesanan masuk, rincian pesanan untuk pengemasan, dan cetak label.</p>
        <p>Untuk mengaktifkan, daftarkan aplikasi di TikTok Shop Partner Center (Tokopedia kini satu sistem dengan TikTok Shop), lalu kirim App Key dan App Secret lewat secret Firebase, bukan lewat chat.</p>
      </section>
    </div>
  )
}
