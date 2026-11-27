# SETUP — Cloudflare Workers untuk Progresio

Checklist langkah-demi-langkah. Kerjakan berurutan; jangan loncat. Setiap
langkah berakhir dengan **"cek:"** — bila cek itu gagal, berhenti dan kabari
Nyx, jangan lanjut ke langkah berikut.

**Yang kamu butuhkan sebelum mulai:** laptop/PC, akun Google (Gmail) yang
sama dengan yang dipakai Progresio, dan kunci Gemini (yang sudah dipakai di
GAS — bila lupa, ambil lagi di AI Studio lewat tombol Copy key; **jangan
pernah kirim/tempel kunci itu di chat** — semua penempelan kunci di bawah
ini dilakukan langsung di terminal/layar Cloudflare, bukan di chat).

**Yang TIDAK akan berubah:** spreadsheet `Progresio_DB` dan folder Drive
`Progresio_System` tetap seperti sekarang — tidak dibuat ulang, datanya
tidak disentuh. GAS tetap jalan sebagai fallback.

---

## Langkah 1 — Akun Cloudflare (gratis)

1. Buka https://dash.cloudflare.com/sign-up — daftar dengan email (boleh
   email apa saja; tidak harus Gmail).
2. Pilih paket **Free** (Rp 0). Tidak perlu kartu kredit untuk Workers Free.
3. Setelah masuk dashboard, catat **subdomain Workers** kamu: di menu kiri
   **Workers & Pages** → terlihat alamat seperti `<nama>.workers.dev`.

**Cek:** kamu bisa membuka dashboard Cloudflare dan melihat menu
Workers & Pages.

## Langkah 2 — Node.js + Wrangler (di laptop)

1. Pasang **Node.js LTS** dari https://nodejs.org (tombol hijau LTS).
   Setelah terpasang, buka terminal (Windows: PowerShell; Mac: Terminal)
   dan jalankan:
   ```
   node --version
   ```
   Harus muncul `v20` atau lebih baru.
2. Pasang Wrangler (perkakas resmi Cloudflare):
   ```
   npm install -g wrangler
   ```
3. Login Wrangler ke akun Cloudflare:
   ```
   npx wrangler login
   ```
   Browser terbuka → klik **Allow** (izinkan Wrangler mengakses akunmu).

**Cek:** `npx wrangler whoami` menampilkan email akun Cloudflare-mu.

## Langkah 3 — Proyek Google Cloud + aktifkan API

1. Buka https://console.cloud.google.com — masuk dengan **Gmail yang sama
   dengan Progresio**.
2. Buat proyek baru: menu proyek di atas → **New Project** → nama
   `Progresio Workers` → **Create**. Tunggu sampai proyek aktif (nama
   proyek tampil di bar atas).
3. Aktifkan dua API: menu **APIs & Services → Library**, cari dan klik
   **Enable** pada masing-masing:
   - `Google Sheets API`
   - `Google Drive API`

**Cek:** di **APIs & Services → Enabled APIs** ada Sheets API dan
Drive API.

## Langkah 4 — Service account + kunci

1. Masih di proyek yang sama: **APIs & Services → Credentials** →
   **Create Credentials → Service account**.
2. Nama: `progresio-worker` → **Create and Continue** → di langkah peran,
   **tidak perlu memilih peran apa pun** (klik Continue tanpa peran) →
   **Done**.
3. Klik service account yang baru dibuat → tab **Keys** → **Add Key →
   Create new key → JSON → Create**. File `.json` terunduh ke laptopmu.
4. Buka file JSON itu (Notepad). Catat dua isinya (untuk langkah 7):
   - `client_email` — bentuknya `...@progresio-workers.iam.gserviceaccount.com`
   - `private_key` — teks panjang berawalan `-----BEGIN PRIVATE KEY-----`
5. **Simpan file JSON ini di tempat aman di laptop (jangan dibagikan ke
   siapa pun, jangan diunggah ke mana pun).** Ini kunci dapur barumu.

**Cek:** kamu punya `client_email` dan `private_key` dari file JSON.

## Langkah 5 — Bagikan spreadsheet & folder ke service account

Ini langkah yang memberi Worker akses ke datamu (tanpa ini Worker buta):

1. Buka spreadsheet **Progresio_DB** → tombol **Share** → tempel
   `client_email` dari langkah 4 → pilih peran **Editor** → **hilangkan
   centang "Notify people"** → **Share**.
2. Buka Google Drive → folder **Progresio_System** → klik kanan →
   **Share** → tempel `client_email` yang sama → **Editor** → hilangkan
   centang "Notify people" → **Share**.

**Cek:** di Share spreadsheet dan folder, email service account tercantum
sebagai Editor.

## Langkah 6 — OAuth client untuk "Masuk dengan Google"

1. Di Google Cloud Console (proyek yang sama): **APIs & Services →
   Credentials → Create Credentials → OAuth client ID**.
2. Bila diminta mengisi **OAuth consent screen** dulu: pilih **External**,
   isi App name `Progresio`, User support email = Gmail-mu, Developer
   contact = Gmail-mu → Save. (Tidak perlu verifikasi Google — pemakaian
   pribadi single-user.)
3. Application type: **Web application**, nama `Progresio PWA`.
4. **Authorized JavaScript origins** — klik **Add URI**, isi origin persis
   tempat PWA Progresio dibuka (hanya skema + host, tanpa garis miring di
   akhir). Bila PWA dibuka dari dua tempat, tambahkan keduanya, satu per
   baris. Contoh:
   - `https://galyh-beep.github.io` (bila PWA di GitHub Pages)
   - origin dari Muse (salin dari address bar saat PWA terbuka)
   
   **Authorized redirect URIs: tidak perlu diisi** (login memakai popup,
   tanpa redirect).
5. Klik **Create** → salin **Client ID** yang muncul (bentuknya
   `....apps.googleusercontent.com`). Ini pengenal publik, bukan rahasia.

**Cek:** kamu punya Client ID; origin PWA terdaftar.

## Langkah 7 — Siapkan file Worker

1. Buat folder di laptop, mis. `progresio-worker`, dan salin ke dalamnya
   tiga file dari paket ini: `worker.js`, `wrangler.toml`, `SETUP.md`
   (dan `README.md` untuk dibaca).
2. Buka `wrangler.toml` (Notepad) dan isi tiga nilai ini:
   - `OWNER_EMAIL` → Gmail-mu (yang sama dengan Progresio).
   - `GOOGLE_CLIENT_ID` → Client ID dari langkah 6.
   - `ALLOWED_ORIGINS` → origin PWA dari langkah 6, dipisah koma bila
     lebih dari satu. Contoh: `"https://galyh-beep.github.io"`.
   - Periksa `SPREADSHEET_ID` dan `DRIVE_ROOT_FOLDER_ID` sudah sesuai
     dengan spreadsheet/folder-mu (sudah terisi dari data yang ada).
3. Simpan file itu.

**Cek:** tidak ada lagi tulisan `ISI_` di `wrangler.toml` (kecuali
`ISI_ID_KV` yang memang opsional).

## Langkah 8 — Isi secrets (rahasia) Worker

Di terminal, di dalam folder `progresio-worker`, jalankan satu per satu.
Setiap perintah akan meminta kamu menempel nilainya — **tempel langsung di
terminal, jangan di chat**:

```
npx wrangler secret put GEMINI_API_KEY
```
Tempel kunci Gemini (dari AI Studio, tombol Copy key), Enter.

```
npx wrangler secret put SA_CLIENT_EMAIL
```
Tempel `client_email` dari file JSON langkah 4, Enter.

```
npx wrangler secret put SA_PRIVATE_KEY
```
Tempel **seluruh** `private_key` dari file JSON (termasuk baris
`-----BEGIN PRIVATE KEY-----` dan `-----END PRIVATE KEY-----`), Enter.

```
npx wrangler secret put SESSION_SECRET
```
Tempel rahasia acak untuk token sesi. Buat dulu dengan perintah ini:
```
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```
Salin hasilnya, lalu tempel sebagai SESSION_SECRET.

**Cek:** `npx wrangler secret list` menampilkan keempat nama secret
(nilai tidak ditampilkan — itu normal dan memang begitu seharusnya).

> Telegram (Batch 3) dilewati dulu: `TELEGRAM_BOT_TOKEN` dan
> `TELEGRAM_WEBHOOK_SECRET` baru diisi nanti.

## Langkah 9 — (Opsional, boleh dilewati dulu) KV untuk draf AI

Draf AI (hasil proses Gemini sebelum ditekan Simpan) disimpan di KV.
Tanpa KV alur tetap jalan lewat jalur cadangan — jadi langkah ini boleh
dilewati dan dikerjakan nanti (wajib sebelum Batch 3 Telegram):

```
npx wrangler kv namespace create PROGRESIO_KV
```

Salin `id` yang muncul, buka `wrangler.toml`, hapus tanda `#` pada tiga
baris `[[kv_namespaces]]`, isi `id` itu.

## Langkah 10 — Deploy

Di terminal, di folder `progresio-worker`:

```
npx wrangler deploy
```

Bila berhasil, terminal menampilkan URL Worker, bentuknya:

```
https://progresio-api.<subdomain-kamu>.workers.dev
```

**Catat URL itu** — inilah alamat dapur baru Progresio.

**Cek:** buka URL itu di browser. Harus muncul JSON `{"ok":true,
"layanan":"Progresio Workers Backend", ...}` (bukan halaman error).
Lalu buka `<URL>?action=ping` — harus muncul `databaseSiap`, `loginGoogle`
dan `geminiTerisi`. Bila `databaseSiap` false, periksa lagi langkah 5
(share) dan `SPREADSHEET_ID` di `wrangler.toml`.

## Langkah 11 — Uji (bersama Nyx)

Jangan dulu mengubah PWA. Uji dari terminal/browser bersama Nyx:

1. `?action=ping` sudah lolos (langkah 10).
2. Login Google dari PWA (setelah PWA disambungkan — langkah terpisah
   bersama Nyx).
3. Sinkron 1 entri percobaan → cek Log_Kerja di spreadsheet.
4. Unggah 1 foto eviden → cek folder Drive + kolom 7 terisi link asli.
5. Sinkron dari perangkat kedua → data ikut muncul.
6. Tutup akses 1 folder → cek folder jadi privat.

**Bila ada langkah gagal:** PWA tetap memakai URL GAS lama (fallback) —
datamu aman, tidak ada yang hilang. Kabari Nyx dengan pesan galat yang
muncul.

## Langkah 12 — Checklist keamanan (sekali, setelah deploy)

- [ ] File JSON service account hanya ada di laptopmu (tidak dibagikan).
- [ ] Tidak ada kunci (Gemini/service account) yang tertempel di
      `wrangler.toml`, `worker.js`, atau di chat.
- [ ] `wrangler secret list` hanya menampilkan nama secret, tanpa nilai.
- [ ] Share spreadsheet & folder hanya ke: kamu (Owner) + service account
      (Editor). Tidak ada "Anyone with link" di level spreadsheet/folder induk.
- [ ] Folder eviden per kegiatan tetap "siapa saja dengan link,
      hanya-lihat" **hanya** untuk folder kegiatan (bukan folder induk) —
      itu yang dicek e-Kinerja. Folder bertanda Privat tetap privat.
- [ ] `ALLOWED_ORIGINS` hanya berisi origin PWA-mu (bukan `*`).
- [ ] Akun Cloudflare memakai password kuat + verifikasi dua langkah
      (di dashboard Cloudflare → Profile → Two-Factor Authentication).

## Mengubah sesuatu nanti

- **Ganti kunci Gemini:** `npx wrangler secret put GEMINI_API_KEY` (langsung
  aktif, tanpa deploy ulang).
- **Rotasi SESSION_SECRET** (mematikan semua sesi login yang aktif):
  `npx wrangler secret put SESSION_SECRET` dengan nilai acak baru.
- **Ubah nilai [vars]** (mis. tambah origin PWA): edit `wrangler.toml`,
  lalu `npx wrangler deploy` lagi.
- **Ubah kode Worker:** edit `worker.js`, lalu `npx wrangler deploy`.
- **Kembali ke GAS (fallback):** di PWA, Pengaturan → Koneksi GAS, ganti
  URL Worker kembali ke URL `.exec` GAS, login PIN seperti dulu. Data di
  Sheets/Drive tidak berubah — kedua dapur membaca database yang sama.
