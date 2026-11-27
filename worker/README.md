# Progresio — Backend Cloudflare Workers

Migrasi dapur Progresio dari Google Apps Script (GAS, `Code.gs` Batch 2) ke
**Cloudflare Workers**. Database (Google Sheets `Progresio_DB`) dan gudang
eviden (Google Drive `Progresio_System`) **tetap di Google**. Yang pindah
hanya dapurnya — supaya dikte suara instan dan sinkron jalan dari mana saja,
tanpa sandbox iframe GAS dan tanpa ritual deploy GAS tiap update.

**Status: kode selesai, BELUM di-deploy.** Deploy butuh akun Ardian (lihat
`SETUP.md`). **GAS tetap jalan sebagai fallback** sampai Worker ini terbukti
di akun Ardian. PWA **belum** disambungkan — penyambungan dilakukan setelah
Worker terbukti (lihat "Rencana perubahan PWA" di bawah).

## Isi paket ini

| File | Isi |
|---|---|
| `worker.js` | Backend lengkap (1.904 baris, ES module, tanpa dependensi) |
| `wrangler.toml` | Konfigurasi deploy + nilai non-rahasia |
| `README.md` | Dokumen ini: arsitektur, pemetaan aksi, keamanan, rencana PWA |
| `SETUP.md` | Checklist setup langkah-demi-langkah untuk Ardian |

## Arsitektur

```
PWA Progresio (hosting mandiri)
   │  HTTPS + JSON, token sesi di body (kontrak sama seperti GAS)
   ▼
Cloudflare Worker  https://progresio-api.<subdomain>.workers.dev
   │  1) verifikasi ID token Google (JWKS) → terbitkan token sesi HS256 6 jam
   │  2) service account JWT RS256 (Web Crypto) → access token Google
   ▼
Google Sheets API (Progresio_DB)  +  Google Drive API (eviden)
   +  Gemini API (otak AI server, failover 3 model)
```

**Kenapa tanpa library (`googleapis`)?** Runtime Workers bukan Node — library
resmi Google terbukti bermasalah di-bundle ke Workers (dependensi Node
`fs`/`http2` dll.). Pola yang dipakai di sini — REST murni + `fetch` +
Web Crypto — adalah pola yang direkomendasikan komunitas dan terbukti untuk
GA4/Firestore/Drive di Workers. Bundle akhir < 30 KB (batas Free 64 MiB).

**Kenapa service account, bukan OAuth user?** Data milik Ardian diakses
server-ke-server tanpa campur tangan pengguna tiap panggilan. Service account
diberi akses lewat **share** (spreadsheet + folder root sebagai Editor) —
tanpa domain-wide delegation, tanpa peran admin Workspace.

## Pemetaan aksi GAS → Worker

Kontrak dijaga **sama persis** supaya `gasCall` PWA tidak berubah (kecuali
login). Envelope selalu `{ok:true,...}` atau `{ok:false,error,kode}`.

| Aksi GAS | Worker | Catatan |
|---|---|---|
| `ping` (GET `?action=ping`) | ✅ sama | Field: `layanan, batch, waktuServer, databaseSiap, geminiTerisi, modelUrutan, aplikasiTersaji:false` + `loginGoogle:true, pinTerpasang:false` |
| `login` (PIN) | ❌ **dihapus** | PIN dipensiunkan (keputusan 2026-11-26). PWA lama yang memanggilnya mendapat `{kode:'PIN_PENSIUN'}` |
| `loginGoogle` (baru) | ✅ baru | POST `{action:'loginGoogle', idToken}` → `{token, berlakuSampai, sesiJam:6, profil, email}` |
| `gantiPin` | ❌ **dihapus** | Sama seperti `login` → `PIN_PENSIUN` |
| `logout` | ✅ sama | Stateless: klien buang token; server tidak menyimpan sesi |
| `tesGemini` | ✅ sama, **kini wajib sesi** | Di GAS boleh sebelum login; di Worker wajib login (menghabiskan kuota Gemini) |
| `getProfil` / `saveProfil` | ✅ sama | GET + POST |
| `getRhk` / `saveRhk` / `saveSemuaRhk` | ✅ sama |  |
| `simpanEntri` / `updateEntri` / `hapusEntri` | ✅ sama | Hapus memakai `deleteDimension` Sheets API |
| `getEntri` | ✅ sama | Filter `dari/sampai/rhkId` |
| `prosesAi` / `konfirmasiDraf` / `batalDraf` | ✅ sama | Draf di KV (TTL 6 jam) bila KV dipasang; tanpa KV, `konfirmasiDraf` menerima `drafItems` di body |
| `uploadEviden` | ✅ sama | Multipart ≤5 MB, resumable >5 MB (potongan 8 MiB) |
| `setAksesEntri` / `tutupAkses` | ✅ sama |  |
| `listFolderTerbuka` | ✅ sama | Dibatasi 40 folder/panggilan (hemat subrequest) |
| `getAkunTepercaya` / `setAkunTepercaya` | ✅ sama | Disimpan di sheet Pengaturan_Sistem (dulu Script Properties) |
| `simpanArsip` / `listArsip` | ✅ sama |  |
| `syncPush` / `syncPull` | ✅ sama | Tulis baris di-batch (1× `values:batchUpdate` + 1× append) |
| `statusServer` | ✅ sama | `folderTerbuka` dihitung dari penanda sheet (bukan cek live Drive) |
| `setModelUtama` | ✅ sama | Disimpan di sheet Pengaturan_Sistem |
| `setupDatabase` (baru) | ✅ baru | Padanan `buatDatabase()` GAS — lengkapi/buat DB + folder (lihat bawah) |
| Webhook Telegram (`update_id`, `SIMPAN <drafId>`) | ✅ fondasi sama | Batch 3 belum dibangun; token kosong = webhook diam |
| Sajian aplikasi (`doGet` tanpa action → Index.html) | ❌ **tidak ada** | Worker hanya API JSON. PWA dibuka dari hosting mandirinya |

**Aksi yang dipakai PWA hari ini** (jalur kritis, wajib lolos uji deploy):
`ping, loginGoogle, syncPush, syncPull, uploadEviden, listFolderTerbuka,
tutupAkses, setAksesEntri` (+ `logout`). Sisanya adalah paritas penuh
dengan GAS untuk masa depan (AI server, Telegram Batch 3).

## Desain keamanan

Prioritas Ardian: **keamanan data + pemakaian jangka panjang.** Lapisan
keamanan Worker, dari luar ke dalam:

1. **CORS allowlist, bukan `*`.** `ALLOWED_ORIGINS` (var) berisi origin
   persis PWA. Origin lain tidak mendapat header CORS — browser menolak
   membaca respons. Request tanpa `Origin` (curl/server) tetap dilayani
   karena CORS hanya urusan browser.
2. **Login "Masuk dengan Google" (GIS ID token).** Klien memakai tombol
   Google Identity Services; server memverifikasi ID token: signature
   RS256 lewat JWKS resmi (`googleapis.com/oauth2/v3/certs`, cache ikut
   `Cache-Control`, refresh saat `kid` tidak dikenal), lalu `iss`
   (`accounts.google.com`), `aud` == `GOOGLE_CLIENT_ID`, `exp` belum lewat
   (toleransi 120 dtk), `email_verified === true`, dan
   `email == OWNER_EMAIL` (huruf kecil). Opsional: `sub == OWNER_SUB`.
   ID token berumur ~1 jam dan **bukan** token sesi — ia hanya dipakai
   sekali saat login.
3. **Token sesi HS256 6 jam.** Setelah login berhasil, Worker menerbitkan
   JWT HS256 (`SESSION_SECRET`, secret) berisi `{email, sub, iat, exp}`.
   Setiap action memverifikasi signature + `exp` + email pemilik. Token
   dibawa di body JSON (`token`), sama seperti GAS. Logout bersifat klien
   (buang token); pencabutan server dilakukan dengan rotasi
   `SESSION_SECRET` (semua sesi lama langsung mati).
4. **Service account berhak minimal.** Scope JWT hanya
   `spreadsheets` + `drive` (penuh — dinaikkan dari `drive.file` pada
   2026-11-27 karena `drive.file` tidak melihat pohon folder yang dibuat
   GAS atas nama pemilik; lihat "Hal yang belum bisa dipastikan", butir 1).
   Akses ke data hanya lewat share
   (spreadsheet + folder root sebagai Editor) — tanpa domain-wide
   delegation, tanpa peran admin. Kunci privat service account hanya ada
   sebagai Worker secret; tidak pernah dikirim ke browser, tidak pernah
   masuk log, tidak pernah masuk file ini.
5. **Rahasia hanya di secrets.** `GEMINI_API_KEY`, `SA_CLIENT_EMAIL`,
   `SA_PRIVATE_KEY`, `SESSION_SECRET`, (Batch 3) token Telegram — semuanya
   `wrangler secret put`. Tidak ada nilai rahasia di `worker.js` maupun
   `wrangler.toml` (sudah diperiksa dengan grep).
6. **Validasi server yang sama seperti GAS.** ID RHK karangan ditolak;
   jam wajib lengkap & masuk akal; durasi selalu dihitung ulang dari jam;
   aksi harus cocok dengan aksi resmi RHK; satu pesan maks 5 kegiatan;
   eviden maks 10 MB/berkas, maks 20 berkas/entri, tipe MIME di-allowlist;
   akun tepercaya maks 10, format email divalidasi.
7. **Link bukti jujur.** Kolom 7 (`Link_Bukti_Dukung`) hanya berisi URL
   folder Drive asli — dan hanya setelah folder berisi berkas. Tidak ada
   link semu di mana pun.
8. **Rate limit darurat.** 120 req/menit per IP (per isolate, best-effort)
   → HTTP 429. Jalur akurat (binding `[[ratelimits]]`) dicantumkan
   komentar di `wrangler.toml` — ketersediaan di Free belum terkonfirmasi.
9. **Log bersih.** Worker tidak pernah mencatat token, kunci, isi berkas,
   atau isi catatan. Yang dicatat hanya nama action + kode galat.

**Batas akses data (penting):** siapa pun yang memegang URL Worker tetap
tidak bisa membaca data tanpa login Google sebagai pemilik — semua action
selain `ping` dan `loginGoogle` menolak tanpa token sesi yang sah. Dan
service account hanya bisa menyentuh file yang di-share kepadanya.

## Perbedaan perilaku vs GAS (sengaja, terdokumentasi)

1. **Login PIN → login Google; PIN pensiun.** Tidak ada kode PIN di Worker.
2. **`tesGemini` kini wajib sesi** (di GAS boleh sebelum login).
3. **Akun tepercaya** disimpan di sheet Pengaturan_Sistem (dulu Script
   Properties). Isi dan batas (maks 10) sama.
4. **`Model_Utama`** dibaca dari var `MODEL_UTAMA` dulu, lalu sheet (dulu
   Script Properties dulu, lalu sheet). `setModelUtama` menulis ke sheet.
5. **Draf AI** disimpan di KV bila dipasang; tanpa KV, klien mengirim
   kembali `drafItems` saat konfirmasi. Di GAS draf selalu di CacheService.
6. **`listFolderTerbuka`** dibatasi 40 folder/panggilan (GAS tanpa batas).
7. **`statusServer.folderTerbuka`** dihitung dari penanda sheet, bukan cek
   live Drive (hemat subrequest).
8. **`setupDatabase`**: folder bulan dibuat malas (lazy) saat entri pertama
   bulan itu — GAS membuat 48 folder bulan di muka. Isi pohon sama.
9. **Tanggal di sheet** dibaca toleran: string `YYYY-MM-DD`, string
   `DD/MM/YYYY`, atau nomor serial tanggal Sheets — ketiganya dinormalisasi.
   Tulis memakai `USER_ENTERED` (sama seperti `setValues` GAS) supaya sel
   tanggal tetap tanggal (rumus Dashboard mengandalkannya).
10. **Worker tidak menyajikan aplikasi.** `GET` tanpa action mengembalikan
    JSON info, bukan HTML.

## Rencana perubahan PWA (JANGAN dieksekusi sebelum Worker terbukti)

Perubahan minimal di `progresio.html` (artifact slug `progresio`), lalu
ekspor HTML disinkronkan seperti biasa:

1. **`SETTINGS.gasUrl` → URL Worker** (`https://progresio-api.<subdomain>.workers.dev`).
   Label kartu "Koneksi GAS" → "Koneksi Worker". Regex validasi URL di
   `gasPing` (saat ini hanya menerima `script.google.com/.../exec`) harus
   menerima URL `*.workers.dev`.
2. **Login PIN → tombol "Masuk dengan Google".** Muat library GIS
   (`https://accounts.google.com/gsi/client`), `google.accounts.id.initialize`
   + `renderButton` di panel login; callback mengirim
   `gasCall({action:'loginGoogle', idToken})` lalu menyimpan
   `r.token`/`r.berlakuSampai` ke `SETTINGS.gasToken`/`gasSesiSampai`
   (kunci localStorage **tetap sama** — sesi & riwayat sinkron tidak hilang).
3. **Hapus/sembunyikan UI Ganti PIN** (form PIN lama/baru + tombolnya).
   Panel login tetap menampilkan chip status sesi 6 jam.
4. **`gasPing`**: baca `d.loginGoogle` untuk chip "Login Google aktif"
   (pengganti chip "PIN terpasang"); `d.aplikasiTersaji` akan `false` —
   tampilkan apa adanya, bukan sebagai galat.
5. **Tidak berubah:** `gasCall` (POST JSON `text/plain`, token di body,
   timeout 60 dtk / upload 120 dtk), semua aksi sync/upload/folder,
   envelope `ok/error/kode` (kode `SESI` tetap menghapus sesi lokal),
   anti-ganda `clientId`, penjaga mode contoh, auto-sync setelah simpan.
6. **Jembatan `google.script.run` tidak relevan** untuk Worker (Worker
   mengirim header CORS yang benar) — jembatan itu hanya aktif saat halaman
   disajikan GAS; di hosting mandiri ia tidak berjalan.

**Urutan uji setelah deploy (di akun Ardian):** `?action=ping` di browser →
login Google dari PWA → `syncPush` 1 entri percobaan → cek Log_Kerja →
`uploadEviden` 1 foto → cek folder Drive + kolom 7 → `syncPull` dari
perangkat kedua → `tutupAkses`. Bila semua lolos, GAS boleh dipensiunkan;
bila ada yang gagal, PWA kembali ke URL GAS (fallback) tanpa kehilangan data.

## Kesesuaian paket Free

| Kebutuhan Progresio | Pemakaian | Batas Free |
|---|---|---|
| Request API | < 1.000/hari (single-user) | 100.000/hari |
| CPU/request | JSON kecil + kripto native (di bawah 10 ms) | 10 ms |
| Subrequest/request | Sync kecil ~5–15; syncPush besar di-batch | 50 |
| Memori | Base64 eviden 10 MB ≈ 25 MB puncak | 128 MB |
| KV (draf) | Beberapa tulis/hari | 1.000 tulis/hari |
| Ukuran Worker | < 30 KB | 64 MiB |

Satu-satunya yang perlu diwaspadai: **syncPush pertama dari HP** (banyak
entri sekaligus) — tulis baris sudah di-batch, tapi pembuatan folder +
sharing per entri baru tetap 2–3 subrequest/entri. Bila mendekati batas 50,
PWA harus mengirim dalam beberapa batch kecil (sudah ada pola retry di
`gasCall` — perlu dipastikan saat penyambungan PWA).

## Hal yang belum bisa dipastikan dari riset

1. **Scope `drive.file` vs folder yang di-share — TERJAWAB 2026-11-27.**
   `drive.file` ternyata TIDAK cukup: SA tidak melihat pohon folder yang
   dibuat GAS atas nama Ardian, sehingga membangun pohon paralel sendiri
   dan folder kegiatan jatuh di "Dibagikan kepada saya", bukan di
   `Eviden_Kinerja`. Scope JWT dinaikkan ke
   `https://www.googleapis.com/auth/drive` (Restricted) di `worker.js`
   (konstanta `SA_SCOPE`). Ini TIDAK membuka seluruh Drive pemilik ke SA:
   SA tetap hanya bisa membuka berkas yang dibagikan kepadanya atau yang
   ia buat sendiri; yang berubah hanya saringan "dibuat/dibuka aplikasi".
2. **Rate Limiting binding di Free** belum terkonfirmasi ketersediaannya.
   Penahan aktif adalah rate limit darurat di kode.
3. **`google-auth-library` di Workers** belum terverifikasi — tidak dipakai
   di sini (verifikasi ID token manual dengan Web Crypto).
4. **Angka batas Cloudflare** (CPU 10 ms, ukuran Worker) mengikuti docs
   per 2026-11-25/26 — cek ulang saat deploy.
5. **Penagihan kuota Google "later in 2026"** — Sheets/Drive menyatakan
   kelebihan kuota akan dikenakan biaya setelah pemberitahuan 90 hari.
   Untuk single-user, kuota (Sheets 300/menit, Drive 1 juta units/menit)
   jauh di atas kebutuhan.
6. **Perilaku One Tap/FedCM di PWA terinstal** belum terverifikasi —
   tombol `renderButton` adalah jalur yang pasti jalan (dipakai di rencana PWA).
