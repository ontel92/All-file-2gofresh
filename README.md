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