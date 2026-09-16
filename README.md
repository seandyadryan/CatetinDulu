# Catetin Dulu

Pencatatan keuangan pribadi berbahasa Indonesia lewat WhatsApp. Node.js 22, whatsapp-web.js, n8n, Groq, dan PostgreSQL 16. Data produksi dimulai kosong; tidak ada seed transaksi atau saldo buatan.

## Arsitektur

WhatsApp → gateway `server.js` → authenticated n8n webhook → PostgreSQL user/duplicate/context → Groq → JSON validation → Switch Intent → fixed PostgreSQL business functions → response → `message.reply()`.

LLM **tidak menghasilkan atau menjalankan SQL**. Semua query tetap, parameterized, dieksekusi node PostgreSQL n8n. Fungsi database menangani operasi atomik, kepemilikan transaksi, dan ledger. Account default tanpa penyebutan adalah Cash. Nominal adalah rupiah bulat, maksimum Rp9 triliun per transaksi. Saldo awal 0; saldo awal nyata dapat dicatat sebagai pemasukan dengan deskripsi saldo awal (akan muncul dalam laporan pemasukan).

## Isi proyek

| Lokasi | Isi |
| --- | --- |
| `server.js`, `src/gateway.js` | LocalAuth persisten, antrean per pengguna, timeout/retry, authenticated status/QR, graceful shutdown |
| `src/validate-parser.cjs` | Kontrak keluaran LLM dan validasi semantik |
| `db/schema.sql` | users, accounts, categories, transactions, chat_messages, ledger_movements, fungsi atomik |
| `db/examples.sql` | Query expense/income/transfer/laporan/saldo/duplikasi |
| `prompts/groq-system.txt` | System prompt dengan nominal informal dan konteks |
| `n8n/finance-message.json` | Workflow siap impor, bukan hanya diagram |
| `scripts/build-workflow.mjs` | Generator workflow dari prompt dan validator |
| `Dockerfile`, `docker-compose.yml` | Chromium ARM64/AMD64, PostgreSQL, n8n, gateway |
| `deploy/` | Bootstrap dan contoh reverse proxy |
| `public/` | Halaman koneksi WhatsApp dengan QR berautentikasi |
| `test/` | Tes unit dan integrasi database terpisah |

## Menjalankan

1. Pasang Docker Engine + Compose, Node.js 22+ untuk persiapan lokal.
2. `npm ci` (set `PUPPETEER_SKIP_DOWNLOAD=true` jika Chromium hanya berjalan di container).
3. Salin `.env.example` menjadi `.env`, isi `GROQ_API_KEY`, buat password/secret acak kuat. Alternatif: set env `GROQ_API_KEY`, lalu `node scripts/init-secrets.mjs` akan membuat `.env` dan secret acak bila file belum ada.
4. `node scripts/init-secrets.mjs` menyiapkan credentials n8n di folder `secrets/` yang diabaikan Git.
5. `npm run workflow` setelah mengubah prompt/validator.
6. Pada Ubuntu: `bash deploy/bootstrap.sh`. Script mengimpor credentials, workflow, mempublikasikannya, dan menjalankan layanan.
7. Tambahkan host Caddy sesuai `deploy/Caddyfile.example`; hubungkan gateway ke jaringan Caddy. DNS A `catetindulu` → IP server. Caddy menerbitkan HTTPS otomatis.

PostgreSQL hanya bind `127.0.0.1:25432`; n8n `127.0.0.1:25678`; gateway `127.0.0.1:23000`. Publik hanya halaman koneksi lewat HTTPS. Webhook internal tetap memerlukan `x-webhook-secret`. Editor n8n tidak dipublikasikan.

Untuk mengakses editor dari komputer lokal:

```powershell
ssh -N -L 25678:127.0.0.1:25678 -i D:\KEYSTORE\ai-chat-vm.key ubuntu@168.110.194.144
```

Buka `http://localhost:25678`. Buat akun pemilik n8n pada akses pertama. Cookie nonsecure hanya untuk akses editor melalui localhost SSH tunnel.

## QR authentication

Buka `https://catetindulu.amarlo.online`, masukkan `ADMIN_TOKEN` dari `.env` privat. Di WhatsApp nomor bot: Setelan → Perangkat tertaut → Tautkan perangkat → pindai QR. Tunggu status **WhatsApp terhubung**. Kirim pesan **dari nomor lain** ke nomor bot. Pesan sendiri, grup, status, dan media tidak diproses. Session tersimpan di volume `whatsapp_auth`; restart tidak memerlukan scan ulang selama sesi masih valid. Token hanya disimpan dalam memori halaman, bukan localStorage. QR tidak dicetak di log.

`WA_ALLOWED_NUMBERS` dapat diisi nomor tanpa +, dipisah koma, untuk membatasi pengguna. Kosong berarti semua pengirim chat langsung dapat menggunakan bot; tiap pengirim punya data terisolasi. WhatsApp kadang menggunakan ID `@lid`; whitelist harus sesuai ID pengirim yang digunakan WhatsApp.

## Input / output webhook

`POST http://n8n:5678/webhook/finance-message`, header `x-webhook-secret: <N8N_WEBHOOK_SECRET>`:

```json
{"message_id":"false_628123456789@c.us_ABC","from":"628123456789@c.us","sender_name":"User Name","text":"makan 35rb","timestamp":1789534800,"is_group":false}
```

```json
{"success":true,"reply":"✅ Pengeluaran dicatat\n\n🍜 Makanan\nnasi padang\nCash\nRp35.000\n16 Sep 2026\nID: ..."}
```

Duplikat: `{"success":true,"reply":"Pesan ini sudah tercatat sebelumnya."}`. Error operasional workflow: `{"success":false,"reply":"..."}`. Auth gagal menghasilkan HTTP 403 dari n8n; gateway juga menangani HTTP non-2xx, timeout, HTML/error tak terduga, dan shape JSON tidak valid. Gateway mencoba ulang maksimal tiga kali dengan message ID yang sama.

## Intent dan konteks

- `makan 35rb`, `beli bensin 100 ribu`, `bayar listrik 350 ribu`: expense.
- `beli nasi padang di shopeefood 45.820`: expense Rp45.820, category food, description nasi padang via ShopeeFood. Dots are Indonesian thousand separators; a delivery platform does not imply ShopeePay.
- Foto struk/order screenshot: kirim satu foto JPG, PNG, atau WebP (maks. 5 MB), dengan caption opsional seperti `pakai GoPay`. OCR memakai model vision Groq dan mencatat **total akhir yang dibayar** (sesudah diskon, ongkir, pajak, dan biaya). Subtotal, kembalian, harga satuan, dan nomor kartu tidak dicatat. Foto buram, terpotong, lebih dari satu struk, atau total ambigu meminta foto/nominal ulang.
- `gaji masuk 8 juta`: income.
- `transfer 500rb dari BCA ke GoPay`: satu transaksi, dua ledger movement; total kekayaan tetap.
- `saldo saya`: saldo berdasarkan ledger, bisa negatif.
- `pengeluaran hari ini`, `pengeluaran makanan bulan ini`, `laporan bulan ini`: aggregate tanpa transfer.
- `daftar transaksi`: 20 transaksi terbaru dalam periode.
- `ubah transaksi terakhir menjadi 50 ribu`, `hapus transaksi terakhir`: target berdasarkan waktu pencatatan; ID UUID juga didukung.
- `bayar listrik` → pertanyaan nominal → `250 ribu`: pending context menyimpan deskripsi/kategori/tanggal; kedaluwarsa 30 menit. `batal` menghapus pending.

Periode: hari ini, kemarin, minggu ini (mulai Senin), bulan ini, bulan lalu, tahun ini, seluruh waktu. Tanggal transaksi dapat absolut atau relatif. Rentang laporan khusus dan beberapa transaksi sekaligus dalam satu pesan meminta klarifikasi. Mata uang selain IDR meminta klarifikasi. Edit mempertahankan field yang tidak disebut.

Duplicate protection memakai UNIQUE `(user_id, source_message_id)` dan UNIQUE pesan `(user_id,message_id)`, ditambah advisory lock dan lease 90 detik per pengguna. Mutasi, ledger, penutupan pesan, dan konteks berada dalam satu transaksi. Transfer/edit/delete otomatis memperbarui ledger. Pesan gagal boleh dicoba lagi; hasil sukses tidak dieksekusi dua kali. Pengiriman balasan WhatsApp sendiri bukan exactly-once; bila koneksi terputus setelah database commit, retry mengembalikan notifikasi duplikat.

## Navicat

Koneksi `Catetin Dulu Oracle DB`: PostgreSQL host `127.0.0.1`, port `25432`, database/user `catetindulu`; password dari `POSTGRES_PASSWORD` di `.env`. SSH host `168.110.194.144`, port `22`, user `ubuntu`, private key `D:\KEYSTORE\ai-chat-vm.key`. Database tidak dibuka ke internet. Pada komputer ini entry koneksi dibuat di konfigurasi Navicat; restart Navicat bila belum terlihat. Password perlu dimasukkan pada koneksi pertama.

## Operasi dan pengujian

```bash
docker compose ps
docker compose logs --tail=100 gateway n8n
docker compose restart gateway
npm test
node scripts/test-groq.mjs
# Database tes wajib berakhiran _test, terpisah dari produksi:
TEST_DATABASE_URL=postgres://user:password@localhost:25432/catetindulu_test node test/database.mjs
```

Schema pertama otomatis dijalankan ketika volume PostgreSQL baru dibuat. Untuk pembaruan fungsi/schema, terapkan `db/schema.sql` lewat psql (idempotent CREATE/REPLACE); jangan menghapus volume produksi. Perubahan struktural berikutnya perlu migration berversi.

Backup database dengan `pg_dump -Fc`, simpan backup terenkripsi di luar server. Backup volume session WhatsApp dan kunci enkripsi n8n secara privat; jangan masukkan ke Git. Hindari `docker compose down -v` pada produksi. Masa retensi data keuangan/pesan belum otomatis dibatasi; pemilik mengelolanya sesuai kebutuhan.

Sumber integrasi: [whatsapp-web.js LocalAuth](https://wwebjs.dev/guide/creating-your-bot/authentication), [Groq JSON output](https://console.groq.com/docs/structured-outputs), [n8n CLI](https://docs.n8n.io/deploy/host-n8n/configure-n8n/use-the-command-line). Model dapat diganti lewat `GROQ_MODEL`; deployment memverifikasi model yang tersedia dari API akun.
