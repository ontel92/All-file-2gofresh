# 2goFresh

2goFresh is a React/Vite storefront and private POS backed by Firebase. The storefront reads a public product catalog from Firestore; stock and staff data are restricted to authenticated staff.

## Local development

```sh
npm install
npm run dev
```

The public storefront is at `/`. The POS login is at `/kasir`. The POS bundle is loaded only for that route or a `kasir.*` host.

## Catalog data flow

The restricted Google Sheet (`1Z3GxcqyB2DxGmfJcMuWvjDFKRRv7jceAlHPvfQ_zHR8`) is the source of product data. The scheduled `syncCatalogFromSheets` Cloud Function runs every five minutes and syncs to the public Firestore collection `catalogProducts`.

The published fields are limited to:

- A: minimum purchase quantity (`minQty`)
- B: SKU (`sku`)
- C: category (`category`)
- D: product name (`name`)
- E: unit (`unit`)
- K: retail price (`retailPrice`)

HPP, shrinkage, margins, and B2B prices are not published. The function validates the complete sheet before writing; missing or duplicate SKUs block that sync instead of publishing a partial catalog. Unchanged sheet data is detected by a private hash document in `catalogSyncState/sheets`, avoiding a full catalog scan every five minutes.

## POS access and stock

The owner and supervisors use Firebase Email/Password accounts. The five cashier accounts use an ID plus password and do not need email addresses.

1. In Firebase Console for project `gofresh-3f2f3`, enable **Authentication → Sign-in method → Email/Password**.
2. Create email/password users for the owner (`2gofreshofficial@gmail.com`) and supervisors (`onnyhermawan22@gmail.com`, `lilisanggaratih@gmail.com`). Google Sign-In is not used by the POS.
3. In Firestore, create a `staff/{AUTH_UID}` document for each of these accounts. Use the Firebase Authentication UID as the document ID:

   ```json
   { "role": "owner", "active": true, "email": "2gofreshofficial@gmail.com" }
   ```

   Set the two supervisor documents to `"role": "supervisor"` and `"active": true`. Keep the owner role only for the owner account. Staff document writes are intentionally unavailable from the client, so create or change these role records in the Firebase Console.

4. Deploy the latest Functions and Firestore rules. Sign in as the owner, open the **Akun kasir** panel, then select **Siapkan akun kasir**. This creates the no-email accounts for Dinda (`dinda`), Nopal (`nopal`), Keple (`keple`), Selo (`selo`), and Lutfi (`lutfi`). The one-time temporary passwords are displayed only to the signed-in owner. Give each password directly to its cashier; every cashier must choose a new password of at least 12 characters at first login.

The POS dashboard has a left navigation like the planned Cloud POS layout. **Stok Produk** opens the implemented inventory screen; **Anggota Kasir** opens account setup/reset for owners and supervisors. Other screenshot menu entries are visible but explicitly marked **Segera Hadir** until those features are implemented. Shift status and printer pairing are not operational yet.

Owner and supervisors can view stock, record stock counts, add quantities to selected products in bulk, and reset a cashier password. In stock-add mode, select individual products or all products currently shown by the search, enter one quantity to add to every selected product, and confirm. Products using `KG` trigger an extra confirmation; the entered amount is interpreted in each product's own unit. Every addition is recorded in `stockMovements`. Bulk writes use chunks of at most 200 products per idempotent transaction, so retrying a request does not add stock twice. The separate stock-count mode sets the counted stock level and skips blank rows.

A password reset generates a new one-time temporary password that is shown to the authorized staff member performing the reset; give it to the cashier privately. Existing cashier sessions are invalidated by the reset. Supervisors cannot change staff roles or initialize accounts; those actions remain owner-only. Cashiers can view stock but cannot change it.

Cashier password hashes use salted scrypt and are stored in the private `staffCredentials` collection, which Firestore clients cannot read or write. Login attempts are rate-limited per cashier ID. Temporary passwords are never emailed or logged and must not be shared in chat. If a password was exposed, reset it before use.

The callable Functions create Firebase custom tokens. Before login can work, grant the runtime service account (`catalog-sync-runtime@gofresh-3f2f3.iam.gserviceaccount.com`) permission to sign tokens (`iam.serviceAccounts.signBlob`, typically `roles/iam.serviceAccountTokenCreator` on that service account). Then deploy the Functions and Firestore rules. Single-item stock changes go through `setOpeningStock`; mass counts go through `setOpeningStockBatch`; bulk additions go through `addStockBatch`. All are recorded in `stockMovements`. Fractional stock is currently allowed for `KG`; other units use whole quantities. Online checkout and POS sales/stock deduction have not been implemented yet.

## Build and deploy

```sh
npm run lint
npm run build
npm --prefix functions run build
firebase deploy --only firestore:rules,functions
```

Firebase Hosting is configured to serve the production build from `dist`, but has not yet been deployed or connected to Cloudflare custom domains. When ready to publish:

```sh
npm run build
firebase deploy --only hosting
```

The Firebase project uses the `asia-southeast2` region. Scheduled Functions and Firestore use the linked Blaze billing account.

## Website toko, checkout, dan integrasi (ringkas)

- **Rute**: `/` toko online, `/kasir` (atau host `kasir.*`) POS, `/info` (atau host `*.2gofresh.info`) halaman tautan Instagram.
- **Checkout**: tamu atau akun. Pembayaran Midtrans (otomatis valid) atau QRIS toko manual (wajib bukti, status "Butuh dicek", dikonfirmasi kasir di panel Web Order). Ongkir dihitung server (estimasi kurir instan; konstanta di `functions/src/webstore.ts` dan `src/shipping.ts`). VIP: free ongkir radius 1 km dengan belanja minimal Rp50.000, poin 1% (1 poin = Rp1 potongan).
- **Printer**: Bluetooth (Chrome Android/PC, perlu HTTPS) atau Serial. Bila printer tidak terhubung/tidak didukung (mis. iPad), struk dicetak lewat dialog cetak browser.
- **Secret** (jangan taruh di chat/kode): isi lewat terminal, lalu deploy ulang fungsi terkait.

  ```sh
  firebase functions:secrets:set MIDTRANS_SERVER_KEY
  firebase functions:secrets:set SHOPEE_PARTNER_ID
  firebase functions:secrets:set SHOPEE_PARTNER_KEY
  firebase deploy --only functions
  ```

  Webhook Midtrans: `https://asia-southeast2-gofresh-3f2f3.cloudfunctions.net/midtransNotification`. Redirect Shopee: `https://asia-southeast2-gofresh-3f2f3.cloudfunctions.net/shopeeCallback`. Host Shopee diatur lewat env `SHOPEE_HOST` (default produksi) (sandbox: `https://openplatform.sandbox.test-stable.shopee.sg`).
- **Auth**: aktifkan provider Anonymous dan Email/Password di Firebase Authentication.

## Laporan closing, pembayaran tertunda, label Shopee

- Closing shift membuat laporan teks (disimpan di `shifts/{id}.reportText`), dikirim via email ke supervisor lewat Gmail SMTP, dan dikirim ke WhatsApp +6281231678067 lewat tautan wa.me (kasir wajib menekan tombolnya sebelum "Keluar").
- Secret email: `npx firebase functions:secrets:set REPORT_SMTP_USER` (alamat Gmail) dan `REPORT_SMTP_PASS` (Gmail App Password), lalu deploy ulang `functions:closeShift`. Selama masih `PLACEHOLDER`, email tidak dikirim.
- Jika kasir login di beberapa perangkat, perangkat lain otomatis logout setelah shift ditutup.
- Web Order hanya menampilkan pesanan `paid` / `needs-check`. Keranjang Midtrans yang belum dibayar tersimpan 58 menit (banner lanjutkan/tambah/batalkan); setelah itu pesanan dibatalkan dan stok dikembalikan. Penyapu server (`expireStaleMidtransOrders`) berjalan tiap 15 menit.
- Panel Marketplace Shopee: jumlah pesanan per tab dan cetak resi Bluetooth 80mm (barcode CODE128 + QR). Hubungkan printer lebih dulu; tanpa printer, resi PDF dibuka.

## Upload master produk dan margin Shopee

- **Upload Produk** tersedia untuk Owner/Supervisor. Form menulis seluruh 23 kolom A:W ke Google Sheets master setelah foto diunggah ke Firebase Storage. Sinkronisasi katalog berjalan maksimal tiap 5 menit.
- Bagikan Google Sheets sebagai **Editor** ke `catalog-sync-runtime@gofresh-3f2f3.iam.gserviceaccount.com`; fungsi sinkronisasi sebelumnya hanya memerlukan akses baca.
- Nama file foto wajib sama persis dengan SKU (`SKU.jpg`, `.jpeg`, `.png`, atau `.webp`); foto disimpan di `product-images/` dan dibatasi sampai 5 MB. SKU duplikat ditolak.
- Di bawah form upload, bagian **Produk yang belum memiliki foto** membaca langsung kolom W master Sheets untuk menampilkan SKU tanpa URL foto. Upload menulis tautan Storage kembali ke kolom W; foto yang sudah ada dengan metadata SKU yang cocok dapat ditautkan tanpa mengunggah ulang.
- Upload Produk dapat secara opsional membuat listing Shopee langsung: kategori leaf, atribut kategori wajib, merek, harga master, deskripsi, berat/dimensi, dan jasa kirim aktif dimuat/divalidasi memakai Shopee Open Platform. Foto untuk listing Shopee harus JPG/PNG; status tayang mengikuti pemeriksaan Shopee.
- Fitur ini hanya tersedia untuk Owner/Supervisor dan memerlukan izin Open Platform untuk product listing, attribute/category, logistics, serta media upload. Bila Shopee menolak akses, aktifkan izin API terkait lalu hubungkan ulang toko.
- Upload Shopee saat ini membuat satu listing per SKU tanpa variasi. Form mencatat stok awal ke inventory POS (tanpa menimpa stok positif yang sudah ada), lalu Shopee memakai stok POS tersebut dan membulatkan ke bawah karena stok listing berupa unit bulat. Perubahan inventory berikutnya belum disinkronkan otomatis ke Shopee. Jika pembuatan listing gagal setelah produk master berhasil ditulis, data master tetap tersimpan. Jika hasil API tidak pasti, periksa Shopee sebelum mencoba kembali agar tidak membuat listing ganda.
- **Margin Marketplace** memisahkan order dengan payout yang sudah dilepas dari order yang masih menunggu pelepasan dana, mulai 1 Oktober 2026. Laporan harian, 7 hari, dan bulanan membaca cache Firebase, bukan Shopee API secara langsung; cache diperbarui terjadwal setiap 10 menit. Riwayat awal dimuat bertahap per hari untuk membatasi beban API. Payout dilepas memakai nilai aktual Shopee; daftar pending memakai status order aktif dan menampilkan nilai bruto `total_amount`, bukan estimasi payout bersih. Mapping SKU/ID variasi dan HPP awal diambil dari `revisi.xlsx` (Data Shopee Master + Review Upload Shopee); refresh mapping tersebut jika data berubah. Item yang tidak termapping tidak diberi angka untung/rugi rekaan.
- **Produk belum diupload**: tab *Belum Diupload* di Marketplace Shopee membandingkan master Google Sheets (`Master Data 2gofresh`) dengan semua listing toko terpilih (SKU induk atau kode variasi; SKU varian `-<gram>G` dihitung ke SKU induknya). Tombol *Sync dengan Google Sheets* (owner/supervisor) menarik daftar listing dari Shopee dan menyimpan hasilnya di `shopeeCatalogSync/{toko}`, jadi panel terbuka cepat tanpa memanggil API Shopee. Listing yang SKU-nya belum cocok master ditampilkan terpisah untuk dirapikan.
- Closing shift memakai memori 512 MiB (sebelumnya 256 MiB sering dimatikan OOM setelah shift tertutup sehingga layar WhatsApp tidak muncul). Jika respons terputus, aplikasi mengambil laporan tersimpan lewat `closedShiftReport`. Layar closing juga punya tombol *Salin laporan lengkap* untuk pesan yang terlalu panjang bagi tautan WhatsApp.
- Kategori/jasa kirim Shopee untuk form upload di-cache selama 6 jam; atribut/merek per kategori di-cache selama 24 jam untuk membatasi frekuensi API. Listing hanya dikirim ke Shopee saat petugas menekan tombol unggah.
- **Toko Shopee kedua (Freshstock)** memakai aplikasi Open Platform, token, dan callback sendiri. Secret Firebase: `SHOPEE_FRESHSTOCK_PARTNER_ID` dan `SHOPEE_FRESHSTOCK_PARTNER_KEY` (isi lewat `firebase functions:secrets:set`, jangan di kode atau chat). Redirect URL aplikasi Freshstock di Open Platform: `https://kasir.2gofresh.com/shopee/callback-freshstock`. Token disimpan di `shopeeAuth/freshstock`, terpisah dari `shopeeAuth/current` (2goFresh). Panel Marketplace Shopee punya pilihan toko: Pesanan, Produk (harga/stok), Pengembalian, cetak resi, chat di Semua Chat, serta notifikasi pesanan/chat per toko. Fitur yang hanya untuk 2goFresh: Varian dari Master, Margin Marketplace, upload produk ke Shopee, dan batas harga minimum master saat ubah harga (mapping SKU/HPP khusus 2goFresh).
- Biaya operasional toko yang tidak tercatat dalam payout Shopee (misalnya kemasan, tenaga kerja, sewa) belum termasuk; order pending menampilkan nilai bruto dan tidak dicampur dengan payout aktual atau laba settlement.