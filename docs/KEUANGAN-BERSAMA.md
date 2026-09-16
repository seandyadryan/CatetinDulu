# Keuangan keluarga dan tim melalui satu bot
Setiap orang mengirim chat pribadi ke **nomor bot yang sama**. Mereka menjadi anggota ruang bersama melalui kode undangan. Pesan di grup WhatsApp belum diproses.

## Mulai dari WhatsApp
1. Pemilik mengirim `/ruang buat keluarga Keluarga Nugraha` atau `/ruang buat tim Tim Kantor`. Ruang baru langsung aktif untuk pembuatnya.
2. Pemilik mengirim `/ruang undang`. Bot membalas perintah `/ruang gabung KODE`.
3. Bagikan perintah itu secara pribadi kepada satu anggota. Anggota mengirimnya ke bot dari WhatsApp miliknya. Ruang tersebut langsung aktif untuk anggota itu.
4. Buat undangan baru untuk anggota berikutnya. Setiap kode hanya dapat dipakai sekali dan berlaku 24 jam.
5. Semua anggota dapat mengirim `beli nasi padang di shopeefood 45.820`, `belanja sayur 60rb pakai GoPay`, atau foto satu struk. Balasan menampilkan ruang dan pencatat.
6. Kirim `laporan bulan ini`, `pengeluaran hari ini`, `daftar transaksi`, atau `saldo` untuk data gabungan seluruh anggota ruang aktif.

Contoh: Ayah mencatat Rp45.820 dan Ibu mencatat Rp60.000 di ruang yang sama. Laporan pengeluaran ruang menjadi **Rp105.820**. Catatan pribadi keduanya tidak ikut.

## Pindah dan mengelola ruang

| Perintah | Hasil |
| --- | --- |
| `/ruang` | Ruang aktif dan bantuan |
| `/ruang daftar` | Ruang milik Anda serta ID untuk berpindah |
| `/ruang pakai ID_RUANG` | Mengaktifkan ruang yang sudah Anda ikuti |
| `/ruang pribadi` | Kembali ke buku pribadi |
| `/ruang anggota` | Nama, peran, dan ID anggota ruang aktif |
| `/ruang undang` | Undangan baru, khusus pemilik keluarga/tim |
| `/ruang keluarkan ID_ANGGOTA` | Mengeluarkan anggota, khusus pemilik; seluruh undangan ruang yang belum digunakan dibatalkan |
| `/ruang keluar` | Anggota keluar dan kembali ke pribadi; pemilik tidak dapat keluar |

Hanya satu ruang aktif per orang. Semua teks dan foto struk masuk ke ruang itu sampai orang tersebut berpindah. Konfirmasi selalu menampilkan nama ruang. Setelah berpindah, pertanyaan transaksi yang belum selesai dibatalkan untuk mencegah pencatatan di ruang yang salah.

Semua anggota melihat saldo, laporan, daftar transaksi, dan pencatat. Anggota hanya boleh mengubah atau menghapus catatan sendiri. Pemilik dapat mengubah atau menghapus catatan anggota dengan ID transaksi. `transaksi terakhir` selalu berarti **transaksi terakhir milik pengirim di ruang aktif**, termasuk untuk pemilik. Keluar atau dikeluarkan tidak menghapus catatan lama.

Akun **Cash, BCA, GoPay, dan seterusnya adalah saldo bersama dalam ruang**. Saldo ini bukan saldo rekening masing-masing anggota. Fitur ini belum membagi tagihan atau menghitung utang antaranggota. Gunakan ruang pribadi untuk rekening pribadi. Pemasukan saldo awal dan transfer antarakun didukung seperti sebelumnya.

## Database
Tidak perlu insert manual. Perintah WhatsApp memanggil fungsi database tetap, menggunakan identitas pengirim yang diterima gateway. Model AI tidak menentukan keanggotaan atau hak akses.

| Tabel / kolom | Fungsi |
| --- | --- |
| `users` | Identitas setiap pengirim; `active_workspace_id` menentukan ruang aktif |
| `workspaces` | Buku pribadi, keluarga, atau tim; nama dan pemilik |
| `workspace_members` | Anggota dan peran `owner` / `member` |
| `workspace_invites` | Hash kode undangan, waktu kedaluwarsa, dan pemakai |
| `transactions.workspace_id` | Ruang tempat transaksi dicatat |
| `transactions.user_id` | Orang yang mencatat; tetap sama ketika pemilik mengedit |
| `accounts.workspace_id` | Daftar akun ruang bersama |
| `ledger_movements.workspace_id` | Perubahan saldo ruang, konsisten dengan transaksi |
| `chat_messages.workspace_id` | Ruang asal pesan, konteks, dan perlindungan duplikat |

Contoh query Navicat untuk melihat catatan beserta ruang dan pencatat:

```sql
SELECT w.name AS ruang, w.kind AS jenis_ruang,
       coalesce(nullif(u.sender_name, ''), u.whatsapp_number) AS pencatat,
       t.type, t.amount, t.description, t.transaction_date, a.name AS akun
FROM transactions t
JOIN workspaces w ON w.id = t.workspace_id
JOIN users u ON u.id = t.user_id
JOIN accounts a ON a.id = t.account_id
ORDER BY t.created_at DESC;
```

## Migrasi dan pengujian
Instalasi baru otomatis menjalankan `db/schema.sql` lalu `db/migrations/002_shared_workspaces.sql`. Instalasi lama menerapkan file migrasi dengan `psql -v ON_ERROR_STOP=1` setelah membuat backup. Migrasi atomik dan dapat diulang. Data lama ditempatkan di ruang Pribadi milik pencatat aslinya; tidak otomatis dibagikan.

Jangan menjalankan kembali `db/schema.sql` sendirian pada database yang sudah dimigrasikan karena file itu berisi fungsi versi lama. `deploy/update.sh` memakai migrasi.

Tes PostgreSQL harus menggunakan database terpisah berakhiran `_test`. `test/database.mjs` mencakup perilaku pribadi; `test/shared-database.mjs` mencakup migrasi, akses antaranggota, pemisahan ruang, saldo, struk pada lapisan database, undangan serentak, pencatatan serentak, serta pencabutan akses saat pesan sedang diproses.

Bila `WA_ALLOWED_NUMBERS` diaktifkan, setiap anggota juga harus diizinkan oleh gateway; keanggotaan ruang tidak melewati whitelist tersebut. Nomor bot harus digunakan sebagai bot khusus karena pesan yang dikirim akun bot sendiri tidak diproses.
