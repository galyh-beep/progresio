/**
 * ============================================================================
 * PROGRESIO — Backend Cloudflare Workers (migrasi dari GAS Batch 2)
 * "Cerdas Mencatat, Fokus Melangkah Maju"
 * ============================================================================
 * Backend single-user (hanya Ardian) untuk PWA Progresio.
 * Menggantikan Code.gs (Google Apps Script) dengan kontrak API yang SAMA
 * PERSIS, supaya perubahan di PWA minimal: ganti base URL + ganti login
 * PIN menjadi "Masuk dengan Google" (ID token). GAS tetap jalan sebagai
 * fallback sampai Worker ini terbukti di akun Ardian.
 *
 * Arsitektur:
 *   PWA (origin allowlist) --HTTPS+JSON--> Worker ini --REST-->
 *   Google Sheets API (Progresio_DB) + Google Drive API (eviden)
 *   + Gemini API (otak AI server). Semua lewat service account.
 *
 * KEAMANAN — baca sebelum menyentuh file ini:
 *   - TIDAK ADA rahasia di file ini. Semua rahasia hidup sebagai Worker
 *     secrets (env): GEMINI_API_KEY, SA_CLIENT_EMAIL, SA_PRIVATE_KEY,
 *     SESSION_SECRET, TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET.
 *   - Nilai non-rahasia hidup sebagai [vars] di wrangler.toml:
 *     OWNER_EMAIL, GOOGLE_CLIENT_ID, SPREADSHEET_ID, DRIVE_ROOT_FOLDER_ID,
 *     ALLOWED_ORIGINS, MODEL_UTAMA, TELEGRAM_CHAT_ID.
 *   - Setiap request (kecuali ping & loginGoogle) wajib membawa token sesi
 *     di body JSON — token itu JWT HS256 yang diterbitkan Worker setelah
 *     verifikasi ID token Google (aud/iss/exp + email == OWNER_EMAIL).
 *   - CORS: hanya origin yang terdaftar di ALLOWED_ORIGINS yang di-echo.
 *     Tidak pernah "*".
 *   - PIN GAS TIDAK ADA di sini. Sesi 6 jam GAS diganti token sesi JWT 6 jam.
 *   - Log tidak pernah mencetak token, kunci, atau isi berkas.
 *
 * Batas paket Free (per docs Cloudflare 2026-11-25 — cek ulang saat deploy):
 *   100.000 request/hari · CPU 10 ms/request (fetch tidak dihitung) ·
 *   memori 128 MB · 50 subrequest/request · 6 koneksi simultan.
 *   Untuk single-user ini sangat longgar; yang mengikat adalah CPU 10 ms
 *   (jaga payload kecil) dan subrequest 50 (syncPush di-batch, lihat bawah).
 *
 * File pendamping: wrangler.toml, README.md (arsitektur + pemetaan aksi +
 * desain keamanan + rencana perubahan PWA), SETUP.md (checklist setup).
 * ============================================================================
 */
'use strict';

/* ============================ KONFIGURASI ================================= */
const NAMA_DB = 'Progresio_DB';
const NAMA_FOLDER_ROOT = 'Progresio_System';
// Urutan failover Gemini (keputusan Batch 1, 2026-11-22 — JANGAN diubah):
// utama paling lancar dulu; 3.8 terakhir (paling lambat & kuota paling kecil).
const AI_MODELS = ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-3.8-flash'];
const MAKS_SPLIT_KEGIATAN = 5;        // satu pesan bisa dipecah sampai 5 kegiatan
const MAKS_BERKAS_PER_ENTRI = 20;
const MAKS_UKURAN_BERKAS = 10 * 1024 * 1024; // 10 MB per berkas eviden
const MAKS_FOTO_KE_GEMINI = 2;        // foto sebagai petunjuk AI, maks 2 (≤4 MB)
const MAKS_AKUN_TEPECAYA = 10;
const SESI_JAM = 6;                   // token sesi berlaku 6 jam
const TIMEOUT_GEMINI_MS = 30000;
const TIMEOUT_GOOGLE_MS = 30000;
const ZONA_WAKTU = 'Asia/Jakarta';
const JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SHEETS_BASE = 'https://sheets.googleapis.com/v4/spreadsheets';
const DRIVE_BASE = 'https://www.googleapis.com/drive/v3/files';
const DRIVE_UPLOAD_BASE = 'https://www.googleapis.com/upload/drive/v3/files';
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
// Scope Drive PENUH (bukan drive.file): token SA harus bisa melihat pohon
// folder yang dibuat GAS atas nama pemilik — dengan drive.file, SA tidak
// melihat folder milik pengguna itu dan membangun pohon paralel sendiri
// (folder kegiatan jatuh di "Dibagikan kepada saya", bukan di Eviden_Kinerja).
// Ini TIDAK membuka seluruh Drive pemilik ke SA: SA tetap hanya bisa
// membuka berkas yang dibagikan kepadanya atau yang ia buat sendiri.
const SA_SCOPE = 'https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive';
// Batas verifikasi folder terbuka per panggilan (hemat subrequest).
const MAKS_CEK_FOLDER_TERBUKA = 40;
// Rate limit darurat per isolate (best-effort; lihat README soal binding).
const RATE_LIMIT_PER_MENIT = 120;

/* Nama sheet (tetap — jangan diganti, PWA & rumus bergantung padanya). */
const SHEET_PROFIL_ = 'Profil_Pegawai';
const SHEET_RHK_ = 'RHK_Config';
const SHEET_LOG_ = 'Log_Kerja';
const SHEET_DASH_ = 'Dashboard_Kalkulasi';
const SHEET_ARSIP_ = 'Arsip_Laporan';
const SHEET_SET_ = 'Pengaturan_Sistem';

const HEADER_PROFIL_ = ['Nama', 'NIP', 'Pangkat_Golongan', 'Jabatan',
  'Unit_Kerja', 'Nama_Atasan', 'NIP_Atasan', 'Jabatan_Atasan', 'Email',
  'Zona_Waktu', 'Diperbarui', 'Label_NIP', 'Unit_Organisasi'];
const HEADER_RHK_ = ['ID_RHK', 'Nama_RHK', 'Rencana_Aksi', 'Kata_Kunci',
  'Target_Kuantitas', 'Target_Waktu', 'Satuan', 'Aturan_Hitung',
  'Durasi_Standar_Menit', 'Akses_Eviden', 'Aktif', 'Diperbarui'];
/* Log_Kerja: kolom C–I adalah 7 kolom e-Kinerja PERSIS berurutan —
   Rencana Aksi | Tanggal | Jam Mulai | Jam Selesai | Uraian Pekerjaan |
   Realisasi | Link Bukti Dukung — siap salin ke e-Kinerja.
   Kolom A–B dan J–S adalah kolom internal Progresio. */
const HEADER_LOG_ = ['ID_Log', 'Timestamp', 'Rencana_Aksi', 'Tanggal',
  'Jam_Mulai', 'Jam_Selesai', 'Uraian_Pekerjaan', 'Realisasi',
  'Link_Bukti_Dukung', 'ID_RHK', 'Jumlah', 'Satuan', 'Durasi_Menit',
  'Folder_Eviden_ID', 'Folder_Eviden_URL', 'Akses_Eviden', 'Sumber',
  'Client_ID', 'Diperbarui'];
const KOL_LOG_ = {};
HEADER_LOG_.forEach((h, i) => { KOL_LOG_[h] = i + 1; });
const HEADER_ARSIP_ = ['ID_Arsip', 'Bulan_Tahun', 'Tipe_Laporan', 'Judul',
  'URL_Google_Doc', 'URL_PDF', 'Jumlah_Entri', 'Waktu_Generate', 'Dibuat_Oleh'];
const HEADER_SET_ = ['Kunci', 'Nilai', 'Keterangan'];
const BULAN_ID_ = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni',
  'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];
/* Nama folder bulan: "01 - Januari" ... "12 - Desember", supaya urutan
   abjad = urutan bulan. Folder lama bernama polos ("November") dipakai
   lagi (dan diganti namanya ke bentuk baru) bila sudah ada. */
function namaBulan_(i) { return String(i + 1).padStart(2, '0') + ' - ' + BULAN_ID_[i]; }
const TIPE_EVIDEN_BOLEH_ = ['image/', 'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'text/plain'];
const FOLDER_MIME_ = 'application/vnd.google-apps.folder';

/* ============================ UTILITAS UMUM =============================== */
const te_ = new TextEncoder();
const td_ = new TextDecoder();

function b64urlEncode_(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
function b64urlDecode_(str) {
  const s = String(str || '').replace(/-/g, '+').replace(/_/g, '/');
  const pad = s.length % 4 ? '='.repeat(4 - (s.length % 4)) : '';
  const bin = atob(s + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function b64urlJson_(obj) {
  return b64urlEncode_(te_.encode(JSON.stringify(obj)));
}
function jsonParseAman_(teks) {
  try { return JSON.parse(teks); } catch (e) { return null; }
}
function tidur_(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function stempel_() {
  // 'yyyy-MM-dd HH:mm:ss' Asia/Jakarta — tanpa library tanggal.
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: ZONA_WAKTU, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
  const p = {};
  f.formatToParts(new Date()).forEach((x) => { p[x.type] = x.value; });
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}
function pad2_(n) { return String(n).padStart(2, '0'); }
/* Terima tanggal "YYYY-MM-DD" (format PWA) atau Date; kembalikan Date lokal. */
function parseTanggal_(v) {
  if (v instanceof Date) return v;
  const s = String(v || '').trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}
function kunciTanggal_(v) {
  const d = parseTanggal_(v);
  if (!d) return '';
  return `${d.getFullYear()}-${pad2_(d.getMonth() + 1)}-${pad2_(d.getDate())}`;
}
/* Sel spreadsheet bisa berisi: string 'YYYY-MM-DD' (tulisan GAS/Worker),
   string 'DD/MM/YYYY' (tampilan lokal), atau nomor serial tanggal Sheets
   (bila selnya bertipe tanggal). Ketiganya dinormalisasi ke 'YYYY-MM-DD'. */
function parseTanggalSel_(v) {
  if (v === null || v === undefined || v === '') return '';
  if (typeof v === 'number' && isFinite(v) && v > 20000 && v < 80000) {
    // Serial Sheets: hari sejak 1899-12-30.
    const d = new Date(Math.round((v - 25569) * 86400 * 1000));
    return `${d.getUTCFullYear()}-${pad2_(d.getUTCMonth() + 1)}-${pad2_(d.getUTCDate())}`;
  }
  const s = String(v).trim();
  const mId = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (mId) return `${mId[3]}-${pad2_(mId[2])}-${pad2_(mId[1])}`;
  return kunciTanggal_(s);
}
function triwulanDari_(d) {
  const q = Math.floor(d.getMonth() / 3); // 0..3
  return { nomor: q + 1, romawi: ['I', 'II', 'III', 'IV'][q],
    folder: 'Triwulan ' + ['I', 'II', 'III', 'IV'][q] };
}
/* Jam diterima sebagai "HH:MM" atau "HH.MM" (format PWA); keluaran "HH:MM". */
function normalJam_(v) {
  if (v === null || v === undefined || v === '') return '';
  const s = String(v).trim().replace('.', ':');
  const m = s.match(/^(\d{1,2}):(\d{2})/);
  if (!m) return '';
  const h = Number(m[1]), mn = Number(m[2]);
  if (h > 23 || mn > 59) return '';
  return pad2_(h) + ':' + pad2_(mn);
}
function jamKeMenit_(jam) {
  const j = normalJam_(jam);
  if (!j) return null;
  const p = j.split(':');
  return Number(p[0]) * 60 + Number(p[1]);
}
/* Durasi SELALU dihitung ulang dari jam oleh kode — tidak pernah dipercaya
   dari AI maupun dari klien (aturan Batch 1). */
function hitungDurasiMenit_(mulai, selesai) {
  const a = jamKeMenit_(mulai), b = jamKeMenit_(selesai);
  if (a === null || b === null) return 0;
  return b > a ? b - a : 0;
}
function validasiJam_(mulai, selesai) {
  const a = jamKeMenit_(mulai), b = jamKeMenit_(selesai);
  if (a === null || b === null) return { ok: false, msg: 'Jam mulai & selesai wajib lengkap' };
  if (b <= a) return { ok: false, msg: 'Jam selesai harus setelah jam mulai' };
  if (b - a > 12 * 60) return { ok: false, msg: 'Durasi lebih dari 12 jam — periksa lagi jamnya' };
  return { ok: true, msg: '' };
}
function idBaru_(awalan) {
  return awalan + crypto.randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase();
}
function bersihTeks_(v, maks) {
  const s = String(v === null || v === undefined ? '' : v).trim();
  return maks ? s.slice(0, maks) : s;
}
/* USER_ENTERED menafsir "=..." sebagai rumus — netralkan teks yang diawali
   operator rumus dengan penanda teks Sheets (apostrof, bukan bagian nilai). */
function amanSel_(v) {
  if (typeof v === 'string' && /^[=+\-@]/.test(v)) return "'" + v;
  return v;
}
function kolomHuruf_(n) {
  let s = '';
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
}
function bandingWaktu_(a, b) { return a < b ? -1 : a > b ? 1 : 0; }

/* ====================== RESPON JSON + CORS ================================ */
/* CORS allowlist: env.ALLOWED_ORIGINS = daftar origin persis dipisah koma,
   mis. "https://galyh-beep.github.io,https://muse.ai". Hanya origin yang
   terdaftar yang di-echo; tidak pernah "*". Request tanpa header Origin
   (curl, server-ke-server) tidak butuh CORS dan tetap dilayani. */
function asalDiizinkan_(request, env) {
  const origin = request.headers.get('Origin') || '';
  if (!origin) return '';
  const daftar = String(env.ALLOWED_ORIGINS || '').split(',')
    .map((s) => s.trim()).filter(Boolean);
  return daftar.includes(origin) ? origin : '';
}
function headerCors_(request, env) {
  const h = { 'Vary': 'Origin' };
  const origin = asalDiizinkan_(request, env);
  if (origin) {
    h['Access-Control-Allow-Origin'] = origin;
    h['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS';
    h['Access-Control-Allow-Headers'] = 'Content-Type, Authorization';
    h['Access-Control-Max-Age'] = '86400';
  }
  return h;
}
function jsonOut_(obj, status, request, env) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...headerCors_(request, env) },
  });
}
function hasilOk_(data, request, env) {
  return jsonOut_({ ok: true, ...(data || {}) }, 200, request, env);
}
function hasilGagal_(pesan, kode, request, env, status) {
  return jsonOut_({ ok: false, error: String(pesan || 'Gagal'), kode: kode || 'ERROR' },
    status || 200, request, env);
}

/* ================= RATE LIMIT DARURAT (per isolate, best-effort) ========== */
/* Bukan akuntansi akurat lintas lokasi — hanya penahan penyalahgunaan kasar
   untuk single-user. Jalur yang akurat adalah binding [[ratelimits]]
   (lihat wrangler.toml — opsional, ketersediaan di Free belum terkonfirmasi). */
const emberRate_ = new Map(); // ip -> {sisa, reset}
function rateLimitLolos_(request) {
  const ip = request.headers.get('CF-Connecting-IP') || 'tanpa-ip';
  const kini = Date.now();
  let e = emberRate_.get(ip);
  if (!e || kini > e.reset) { e = { sisa: RATE_LIMIT_PER_MENIT, reset: kini + 60000 }; emberRate_.set(ip, e); }
  if (e.sisa <= 0) return false;
  e.sisa -= 1;
  if (emberRate_.size > 1000) emberRate_.clear();
  return true;
}

/* ==================== SESI: JWT HS256 BUATAN SENDIRI ===================== */
/* Menggantikan PIN + sesi server-side GAS. Setelah login Google berhasil,
   Worker menerbitkan token sesi JWT (HS256, rahasia SESSION_SECRET) yang
   berlaku 6 jam. Token dibawa klien di body JSON (field "token") — sama
   seperti kontrak GAS — dan diverifikasi di sini pada setiap action.
   Logout bersifat klien (buang token); server tidak bisa mencabut JWT yang
   sudah terbit sebelum kedaluwarsanya — mitigasinya: umur pendek (6 jam)
   dan SESSION_SECRET bisa dirotasi (semua sesi lama langsung mati). */
async function kunciHmac_(env) {
  const rahasia = String(env.SESSION_SECRET || '');
  if (!rahasia) throw new Error('SESSION_SECRET belum diisi (Worker secret).');
  return crypto.subtle.importKey('raw', te_.encode(rahasia),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}
async function buatTokenSesi_(env, email, sub) {
  const kini = Math.floor(Date.now() / 1000);
  const header = b64urlJson_({ alg: 'HS256', typ: 'JWT' });
  const payload = b64urlJson_({ email, sub, iat: kini, exp: kini + SESI_JAM * 3600 });
  const data = `${header}.${payload}`;
  const key = await kunciHmac_(env);
  const sig = await crypto.subtle.sign('HMAC', key, te_.encode(data));
  return { token: `${data}.${b64urlEncode_(sig)}`,
    berlakuSampai: new Date((kini + SESI_JAM * 3600) * 1000).toISOString() };
}
async function verifikasiTokenSesi_(env, token) {
  try {
    if (!token || typeof token !== 'string') return null;
    const bag = token.split('.');
    if (bag.length !== 3) return null;
    const key = await kunciHmac_(env);
    const ok = await crypto.subtle.verify('HMAC', key, b64urlDecode_(bag[2]),
      te_.encode(`${bag[0]}.${bag[1]}`));
    if (!ok) return null;
    const payload = JSON.parse(td_.decode(b64urlDecode_(bag[1])));
    if (!payload || !payload.email || !payload.exp) return null;
    if (payload.exp * 1000 <= Date.now()) return null; // kedaluwarsa
    const owner = String(env.OWNER_EMAIL || '').toLowerCase().trim();
    if (owner && String(payload.email).toLowerCase() !== owner) return null;
    if (env.OWNER_SUB && payload.sub !== env.OWNER_SUB) return null;
    return payload;
  } catch (e) { return null; }
}

/* ============ VERIFIKASI ID TOKEN GOOGLE ("Masuk dengan Google") ========== */
/* ID token adalah JWT RS256 dari Google. Verifikasi di server WAJIB:
   signature lewat JWKS resmi, lalu klaim aud/iss/exp, lalu email.
   Jangan pernah percaya payload JWT tanpa verifikasi signature — payload
   hanya base64 dan bisa dipalsukan siapa pun. Endpoint tokeninfo Google
   TIDAK dipakai (Google: hanya untuk debug, bisa di-throttle, tanpa SLA).
   Umur ID token Google ~1 jam; ID token BUKAN token sesi — ia hanya
   dipakai sekali saat login, lalu Worker menerbitkan token sesinya sendiri. */
let jwksCache_ = { keys: null, diambil: 0, maxAgeMs: 3600000 };
async function ambilJwks_() {
  const kini = Date.now();
  if (jwksCache_.keys && kini - jwksCache_.diambil < jwksCache_.maxAgeMs) return jwksCache_.keys;
  const resp = await fetch(JWKS_URL, { signal: AbortSignal.timeout(TIMEOUT_GOOGLE_MS) });
  if (!resp.ok) throw new Error('Gagal mengambil kunci publik Google (HTTP ' + resp.status + ').');
  const cc = resp.headers.get('Cache-Control') || '';
  const m = cc.match(/max-age=(\d+)/);
  const data = await resp.json();
  jwksCache_ = { keys: data.keys || [], diambil: kini,
    maxAgeMs: m ? Number(m[1]) * 1000 : 3600000 };
  return jwksCache_.keys;
}
async function verifikasiIdToken_(env, idToken) {
  if (!idToken || typeof idToken !== 'string') {
    throw new Error('ID token Google kosong.');
  }
  const bag = idToken.split('.');
  if (bag.length !== 3) throw new Error('Format ID token tidak dikenal.');
  const header = jsonParseAman_(td_.decode(b64urlDecode_(bag[0])));
  if (!header || header.alg !== 'RS256' || !header.kid) {
    throw new Error('ID token bukan RS256 / tanpa kid.');
  }
  const kunci = await ambilJwks_();
  let jwk = kunci.find((k) => k.kid === header.kid);
  if (!jwk) {
    // Rotasi kunci: ambil ulang sekali sebelum menolak (kid-miss).
    jwksCache_.diambil = 0;
    const kunciBaru = await ambilJwks_();
    jwk = kunciBaru.find((k) => k.kid === header.kid);
    if (!jwk) throw new Error('Kunci penanda ID token tidak dikenal (kid).');
  }
  const key = await crypto.subtle.importKey('jwk', jwk,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const sah = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key,
    b64urlDecode_(bag[2]), te_.encode(`${bag[0]}.${bag[1]}`));
  if (!sah) throw new Error('Tanda tangan ID token tidak sah.');
  const payload = jsonParseAman_(td_.decode(b64urlDecode_(bag[1])));
  if (!payload) throw new Error('Payload ID token tidak bisa dibaca.');
  const issSah = payload.iss === 'https://accounts.google.com' || payload.iss === 'accounts.google.com';
  if (!issSah) throw new Error('Penerbit ID token tidak dikenal (iss).');
  const clientId = String(env.GOOGLE_CLIENT_ID || '');
  if (!clientId) throw new Error('GOOGLE_CLIENT_ID belum diisi (Worker var).');
  if (payload.aud !== clientId) throw new Error('ID token bukan untuk aplikasi ini (aud).');
  const kini = Math.floor(Date.now() / 1000);
  if (!payload.exp || payload.exp <= kini - 120) {
    throw new Error('ID token sudah kedaluwarsa — masuk lagi dengan Google.');
  }
  const owner = String(env.OWNER_EMAIL || '').toLowerCase().trim();
  const email = String(payload.email || '').toLowerCase();
  if (!owner) throw new Error('OWNER_EMAIL belum diisi (Worker var).');
  if (email !== owner) throw new Error('Akun Google ini bukan pemilik Progresio.');
  if (payload.email_verified !== true) {
    throw new Error('Email Google belum terverifikasi.');
  }
  if (env.OWNER_SUB && payload.sub !== env.OWNER_SUB) {
    throw new Error('Identitas Google tidak cocok (sub).');
  }
  return { email, sub: payload.sub || '', nama: payload.name || '' };
}

/* ==================== SERVICE ACCOUNT: ACCESS TOKEN ======================= */
/* Pola zero-dependency (tanpa googleapis): JWT RS256 ditandatangani dengan
   Web Crypto, ditukar ke access token OAuth2, di-cache per isolate sampai
   mendekati kedaluwarsa. Kunci privat TIDAK PERNAH keluar dari Worker. */
let saTokenCache_ = { token: '', sampai: 0 };
function saPrivateKeyDer_(env) {
  const pem = String(env.SA_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  const isi = pem.replace(/-----BEGIN PRIVATE KEY-----/g, '')
    .replace(/-----END PRIVATE KEY-----/g, '').replace(/\s+/g, '');
  if (!isi) throw new Error('SA_PRIVATE_KEY belum diisi (Worker secret).');
  return b64urlDecode_(isi.replace(/-/g, '+').replace(/_/g, '/'));
}
async function tokenServiceAccount_(env, paksaBaru) {
  const kini = Math.floor(Date.now() / 1000);
  if (!paksaBaru && saTokenCache_.token && saTokenCache_.sampai > kini + 120) {
    return saTokenCache_.token;
  }
  const emailSa = String(env.SA_CLIENT_EMAIL || '').trim();
  if (!emailSa) throw new Error('SA_CLIENT_EMAIL belum diisi (Worker secret).');
  const der = saPrivateKeyDer_(env);
  const key = await crypto.subtle.importKey('pkcs8', der,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const header = b64urlJson_({ alg: 'RS256', typ: 'JWT' });
  const klaim = b64urlJson_({ iss: emailSa, scope: SA_SCOPE,
    aud: TOKEN_URL, iat: kini, exp: kini + 3600 });
  const data = `${header}.${klaim}`;
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, te_.encode(data));
  const jwt = `${data}.${b64urlEncode_(sig)}`;
  const resp = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=' + encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer') +
      '&assertion=' + encodeURIComponent(jwt),
    signal: AbortSignal.timeout(TIMEOUT_GOOGLE_MS),
  });
  const j = await resp.json().catch(() => ({}));
  if (!resp.ok || !j.access_token) {
    throw new Error('Gagal menukar token service account (HTTP ' + resp.status + ').');
  }
  saTokenCache_ = { token: j.access_token, sampai: kini + (j.expires_in || 3600) };
  return saTokenCache_.token;
}
/* Satu titik panggil API Google: Bearer token + retry sekali bila 401. */
async function gapiFetch_(env, url, opsi) {
  const o = opsi || {};
  const kirim = async (token) => fetch(url, {
    ...o,
    headers: { Authorization: 'Bearer ' + token, ...(o.headers || {}) },
    signal: AbortSignal.timeout(o.timeoutMs || TIMEOUT_GOOGLE_MS),
  });
  let token = await tokenServiceAccount_(env, false);
  let resp = await kirim(token);
  if (resp.status === 401) {
    token = await tokenServiceAccount_(env, true);
    resp = await kirim(token);
  }
  return resp;
}
async function gapiJson_(env, url, opsi) {
  const resp = await gapiFetch_(env, url, opsi);
  const teks = await resp.text();
  const j = jsonParseAman_(teks);
  if (!resp.ok) {
    const msg = (j && j.error && (j.error.message || j.error.status)) || ('HTTP ' + resp.status);
    const err = new Error('Google API: ' + msg);
    err.http = resp.status;
    throw err;
  }
  return j || {};
}

/* ==================== KLIEN SHEETS API v4 ================================= */
function spreadsheetId_(env) {
  const id = String(env.SPREADSHEET_ID || '').trim();
  if (!id) throw new Error('SPREADSHEET_ID belum diisi (Worker var).');
  return id;
}
function rangeEncode_(range) {
  return encodeURIComponent(range).replace(/%20/g, '%20');
}
async function sheetsValuesGet_(env, range) {
  const url = `${SHEETS_BASE}/${spreadsheetId_(env)}/values/${rangeEncode_(range)}`;
  return gapiJson_(env, url);
}
async function sheetsValuesAppend_(env, range, values) {
  const url = `${SHEETS_BASE}/${spreadsheetId_(env)}/values/${rangeEncode_(range)}:append` +
    '?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS';
  return gapiJson_(env, url, { method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ range, majorDimension: 'ROWS', values }) });
}
async function sheetsValuesUpdate_(env, range, values) {
  const url = `${SHEETS_BASE}/${spreadsheetId_(env)}/values/${rangeEncode_(range)}` +
    '?valueInputOption=USER_ENTERED';
  return gapiJson_(env, url, { method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ range, majorDimension: 'ROWS', values }) });
}
async function sheetsValuesBatchUpdate_(env, data) {
  const url = `${SHEETS_BASE}/${spreadsheetId_(env)}/values:batchUpdate`;
  return gapiJson_(env, url, { method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ valueInputOption: 'USER_ENTERED', data }) });
}
async function sheetsStrukturBatch_(env, requests) {
  const url = `${SHEETS_BASE}/${spreadsheetId_(env)}:batchUpdate`;
  return gapiJson_(env, url, { method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requests }) });
}
/* Baca satu sheet penuh menjadi objek {header, rows, lastRow}.
   rows[i]._baris = nomor baris spreadsheet (1-based, header = 1). */
async function muatTabel_(env, namaSheet, header) {
  const res = await sheetsValuesGet_(env, `${namaSheet}!A1:${kolomHuruf_(header.length)}`);
  const values = Array.isArray(res.values) ? res.values : [];
  const head = values.length && values[0].length ? values[0].map(String) : header.slice();
  const rows = [];
  for (let i = 1; i < values.length; i++) {
    const o = { _baris: i + 1 };
    head.forEach((h, j) => { o[h] = values[i][j] === undefined ? '' : values[i][j]; });
    rows.push(o);
  }
  return { header: head, rows, lastRow: values.length };
}
function tulisSatuBaris_(tabel, namaSheet, barisNo, nilai) {
  const col = kolomHuruf_(nilai.length);
  return { range: `${namaSheet}!A${barisNo}:${col}${barisNo}`, values: [nilai.map(amanSel_)] };
}

/* ==================== KLIEN DRIVE API v3 ================================== */
function driveQuery_(q, fields, pageSize) {
  const p = new URLSearchParams({ q, fields: fields || 'files(id,name,mimeType,webViewLink)',
    pageSize: String(pageSize || 100) });
  return `${DRIVE_BASE}?${p.toString()}`;
}
async function driveList_(env, q, fields, pageSize) {
  const j = await gapiJson_(env, driveQuery_(q, fields, pageSize));
  return Array.isArray(j.files) ? j.files : [];
}
async function driveGet_(env, fileId, fields) {
  const f = fields || 'id,name,mimeType,webViewLink';
  return gapiJson_(env, `${DRIVE_BASE}/${encodeURIComponent(fileId)}?fields=${encodeURIComponent(f)}`);
}
async function driveBuatFolder_(env, nama, indukId) {
  const j = await gapiJson_(env, DRIVE_BASE, { method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: nama, mimeType: FOLDER_MIME_,
      parents: indukId ? [indukId] : undefined }) });
  return j;
}
async function driveUbahNama_(env, fileId, nama) {
  return gapiJson_(env, `${DRIVE_BASE}/${encodeURIComponent(fileId)}`,
    { method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: nama }) });
}
async function driveCariFolder_(env, nama, indukId) {
  const aman = String(nama).replace(/'/g, "\\'");
  const q = `mimeType = '${FOLDER_MIME_}' and name = '${aman}' and ` +
    (indukId ? `'${indukId}' in parents` : `'root' in parents`) + ' and trashed = false';
  const hasil = await driveList_(env, q, 'files(id,name)', 10);
  return hasil.length ? hasil[0] : null;
}
async function driveFolderAnak_(env, indukId, nama) {
  const ada = await driveCariFolder_(env, nama, indukId);
  if (ada) return ada;
  return driveBuatFolder_(env, nama, indukId);
}
async function driveIzin_(env, fileId) {
  const j = await gapiJson_(env,
    `${DRIVE_BASE}/${encodeURIComponent(fileId)}/permissions?fields=permissions(id,type,role,emailAddress)`);
  return Array.isArray(j.permissions) ? j.permissions : [];
}
async function driveTambahIzin_(env, fileId, body) {
  return gapiJson_(env, `${DRIVE_BASE}/${encodeURIComponent(fileId)}/permissions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body) });
}
async function driveHapusIzin_(env, fileId, permissionId) {
  await gapiFetch_(env, `${DRIVE_BASE}/${encodeURIComponent(fileId)}/permissions/${encodeURIComponent(permissionId)}`,
    { method: 'DELETE' });
}
/* Terapkan aturan akses ke folder kegiatan (sama seperti GAS):
   - "link"  : siapa saja dengan link, hanya-lihat (untuk dicek e-Kinerja)
   - "privat": link publik ditutup; hanya pemilik + akun tepercaya. */
async function terapkanAksesFolder_(env, folderId, akses) {
  const izin = await driveIzin_(env, folderId);
  const adaLink = izin.find((p) => p.type === 'anyone');
  if (akses === 'privat') {
    if (adaLink) await driveHapusIzin_(env, folderId, adaLink.id);
    const tepercaya = await akunTepercaya_(env);
    for (const email of tepercaya) {
      const sudah = izin.some((p) => p.type === 'user' &&
        String(p.emailAddress || '').toLowerCase() === email.toLowerCase());
      if (!sudah) {
        try { await driveTambahIzin_(env, folderId, { type: 'user', role: 'reader', emailAddress: email }); } catch (e) { /* lewati */ }
      }
    }
  } else if (!adaLink) {
    await driveTambahIzin_(env, folderId, { type: 'anyone', role: 'reader' });
  }
  const f = await driveGet_(env, folderId, 'id,webViewLink');
  return f.webViewLink || '';
}
/* Pastikan akun pemilik (OWNER_EMAIL) bisa MENULIS ke folder kegiatan.
   Latar: folder dibuat oleh service account sehingga SA yang menjadi
   pemiliknya; akun pengguna tidak punya peran tulis eksplisit di folder
   itu (pewarisan dari folder induk tidak memberi peran tulis), sehingga
   unggah langsung dari aplikasi ditolak Drive dengan "Insufficient
   permissions for the specified parent". Memberi peran writer kepada
   pemilik membuat unggah langsung bisa berjalan, tanpa mengubah siapa
   pemilik folder dan tanpa membuka folder ke publik. Idempotent:
   tidak menambah izin bila pemilik sudah writer/owner. */
async function pastikanPenulisFolder_(env, folderId) {
  const pemilik = String(env.OWNER_EMAIL || '').trim().toLowerCase();
  if (!pemilik || !folderId) return;
  const izin = await driveIzin_(env, folderId);
  const sudah = izin.some((p) => p.type === 'user' &&
    String(p.emailAddress || '').toLowerCase() === pemilik &&
    (p.role === 'writer' || p.role === 'owner' || p.role === 'organizer'));
  if (sudah) return;
  try {
    await driveTambahIzin_(env, folderId,
      { type: 'user', role: 'writer', emailAddress: pemilik });
  } catch (e) {
    throw new Error('Gagal memberi akses tulis folder ke ' + pemilik + ': ' +
      (e.message || String(e)));
  }
}
async function tutupAksesFolder_(env, folderId) {
  const izin = await driveIzin_(env, folderId);
  for (const p of izin) {
    if (p.type === 'anyone') await driveHapusIzin_(env, folderId, p.id);
  }
}
/* Unggah berkas ke Drive.
   ≤5 MB: multipart sekali jalan. >5 MB: resumable, potongan 8 MiB
   (kelipatan 256 KiB, syarat Google). Mengembalikan metadata file. */
function gabungBytes_(bagian) {
  let total = 0;
  bagian.forEach((b) => { total += b.length; });
  const out = new Uint8Array(total);
  let off = 0;
  bagian.forEach((b) => { out.set(b, off); off += b.length; });
  return out;
}
async function driveUnggah_(env, folderId, nama, mime, bytes) {
  const metadata = { name: nama, parents: [folderId] };
  if (bytes.length <= 5 * 1024 * 1024) {
    const batas = 'progresio-' + crypto.randomUUID().slice(0, 8);
    const head = te_.encode(`--${batas}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
      JSON.stringify(metadata) + `\r\n--${batas}\r\nContent-Type: ${mime}\r\n\r\n`);
    const tail = te_.encode(`\r\n--${batas}--`);
    const body = gabungBytes_([head, bytes, tail]);
    const j = await gapiJson_(env, `${DRIVE_UPLOAD_BASE}?uploadType=multipart`, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/related; boundary=${batas}` },
      body,
      timeoutMs: 120000,
    });
    return { fileId: j.id, nama: j.name || nama, ukuran: Number(j.size) || bytes.length };
  }
  // Resumable.
  const sesi = await gapiFetch_(env, `${DRIVE_UPLOAD_BASE}?uploadType=resumable`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json',
      'X-Upload-Content-Type': mime,
      'X-Upload-Content-Length': String(bytes.length) },
    body: JSON.stringify(metadata),
    timeoutMs: 120000,
  });
  const lokasi = sesi.headers.get('Location');
  if (!sesi.ok || !lokasi) {
    throw new Error('Gagal memulai unggah resumable (HTTP ' + sesi.status + ').');
  }
  const CHUNK = 8 * 1024 * 1024;
  let fileJson = null;
  for (let awal = 0; awal < bytes.length; awal += CHUNK) {
    const akhir = Math.min(awal + CHUNK, bytes.length);
    const potong = bytes.slice(awal, akhir);
    const resp = await fetch(lokasi, {
      method: 'PUT',
      headers: { 'Content-Type': mime,
        'Content-Length': String(potong.length),
        'Content-Range': `bytes ${awal}-${akhir - 1}/${bytes.length}` },
      body: potong,
      signal: AbortSignal.timeout(120000),
    });
    if (resp.status === 308) continue; // lanjut potongan berikut
    if (!resp.ok) throw new Error('Unggah resumable gagal (HTTP ' + resp.status + ').');
    fileJson = await resp.json().catch(() => ({}));
  }
  if (!fileJson || !fileJson.id) throw new Error('Unggah resumable selesai tanpa metadata file.');
  return { fileId: fileJson.id, nama: fileJson.name || nama,
    ukuran: Number(fileJson.size) || bytes.length };
}

/* ================== PENGATURAN SISTEM (sheet, bukan properti) ============= */
/* GAS menyimpan non-rahasia di sheet Pengaturan_Sistem dan rahasia di Script
   Properties. Worker tidak punya Script Properties: semua non-rahasia di
   sheet ini; semua rahasia di Worker secrets. Akun tepercaya (dulu properti)
   kini juga di sheet ini sebagai JSON — transparan bagi PWA. */
async function ambilPengaturan_(env, kunci, bawaan) {
  try {
    const t = await muatTabel_(env, SHEET_SET_, HEADER_SET_);
    for (const r of t.rows) {
      if (String(r.Kunci) === kunci) return String(r.Nilai || '');
    }
  } catch (e) { /* abaikan */ }
  return bawaan || '';
}
async function tulisPengaturan_(env, kunci, nilai, keterangan) {
  const t = await muatTabel_(env, SHEET_SET_, HEADER_SET_);
  for (const r of t.rows) {
    if (String(r.Kunci) === kunci) {
      await sheetsValuesUpdate_(env, `${SHEET_SET_}!A${r._baris}:${kolomHuruf_(HEADER_SET_.length)}${r._baris}`,
        [[String(r.Kunci), String(nilai), String(r.Keterangan || keterangan || '')]]);
      return;
    }
  }
  await sheetsValuesAppend_(env, `${SHEET_SET_}!A1`,
    [[kunci, String(nilai), keterangan || '']]);
}
async function akunTepercaya_(env) {
  try {
    const arr = JSON.parse(await ambilPengaturan_(env, 'Akun_Tepercaya', '[]') || '[]');
    return Array.isArray(arr) ? arr.filter((e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(e)))
      .slice(0, MAKS_AKUN_TEPECAYA) : [];
  } catch (e) { return []; }
}
function modelUtama_(env, dariSheet) {
  const m = String(env.MODEL_UTAMA || dariSheet || '').trim();
  return AI_MODELS.includes(m) ? m : AI_MODELS[0];
}
function urutanModel_(env, dariSheet) {
  const utama = modelUtama_(env, dariSheet);
  return [utama].concat(AI_MODELS.filter((m) => m !== utama));
}

/* ====================== AKSES DRIVE: POHON FOLDER ========================= */
/* Ambil ID folder Drive dari tempelan pengguna: URL lengkap
   (.../drive/folders/<ID>...) atau ID polos. '' bila tak dikenali. */
function idFolderDari_(nilai) {
  const s = String(nilai || '').trim();
  if (!s) return '';
  const m = s.match(/\/folders\/([A-Za-z0-9_-]+)/);
  if (m) return m[1];
  if (/^[A-Za-z0-9_-]{10,}$/.test(s)) return s;
  return '';
}
/* Periksa satu folder Drive lewat service account: harus ada, berupa
   folder, dan bisa dibaca. Kembalikan {id, nama} atau lempar galat jelas. */
async function periksaFolderDrive_(env, mentah) {
  const id = idFolderDari_(mentah);
  if (!id) {
    throw new Error('Tempelan tidak dikenali sebagai URL/ID folder Drive. Tempel alamat folder dari address bar Drive, mis. https://drive.google.com/drive/folders/<ID>.');
  }
  let info;
  try {
    info = await driveGet_(env, id, 'id,name,mimeType');
  } catch (e) {
    throw new Error('Folder Drive itu tidak ditemukan / tidak bisa diakses oleh service account (ID: ' + id + '). Pastikan foldernya ada dan sudah dibagikan ke service account sebagai Editor.');
  }
  if (!info || info.mimeType !== FOLDER_MIME_) {
    throw new Error('ID itu bukan folder Drive. Tempel URL folder, bukan berkas.');
  }
  return { id: info.id, nama: info.name };
}
/* ID folder utama dari Pengaturan (ditempel pengguna) atau environment. */
async function idFolderDrive_(env) {
  const dariPengaturan = String(await ambilPengaturan_(env, 'DRIVE_ROOT_FOLDER_ID', '') || '').trim();
  if (dariPengaturan) return { id: dariPengaturan, sumber: 'pengaturan' };
  const dariEnv = String(env.DRIVE_ROOT_FOLDER_ID || '').trim();
  if (dariEnv) return { id: dariEnv, sumber: 'environment' };
  return null;
}
async function folderRoot_(env) {
  // 0) Tempelan dari aplikasi untuk request ini (paling diutamakan).
  const override = String(env._driveRootFolderId || '').trim();
  if (override) {
    try {
      return await driveGet_(env, override, 'id,name');
    } catch (e) {
      throw new Error('Folder Drive utama (tempelan aplikasi, ID: ' + override + ') tidak ditemukan / tidak bisa diakses. Periksa tempelan URL/ID folder di Pengaturan, dan pastikan folder itu dibagikan ke service account sebagai Editor.');
    }
  }
  const cfg = await idFolderDrive_(env);
  if (cfg) {
    // ID eksplisit (tempelan pengguna / environment): bila tak bisa
    // dibaca, gagal jujur — jangan diam-diam membangun pohon paralel
    // di Drive service account (itu yang membuat folder kegiatan jatuh
    // di "Dibagikan kepada saya").
    try {
      return await driveGet_(env, cfg.id, 'id,name');
    } catch (e) {
      throw new Error('Folder Drive utama (' + cfg.sumber + ', ID: ' + cfg.id + ') tidak ditemukan / tidak bisa diakses. Periksa tempelan URL/ID folder di Pengaturan, dan pastikan folder itu dibagikan ke service account sebagai Editor.');
    }
  }
  const ketemu = await driveCariFolder_(env, NAMA_FOLDER_ROOT, null);
  if (ketemu) return ketemu;
  return driveBuatFolder_(env, NAMA_FOLDER_ROOT, null);
}
async function folderEvidenInduk_(env) {
  const root = await folderRoot_(env);
  return driveFolderAnak_(env, root.id, 'Eviden_Kinerja');
}
async function folderBulanEviden_(env, tanggalDate) {
  const induk = await folderEvidenInduk_(env);
  const th = await driveFolderAnak_(env, induk.id, String(tanggalDate.getFullYear()));
  const tw = await driveFolderAnak_(env, th.id, triwulanDari_(tanggalDate).folder);
  const mi = tanggalDate.getMonth();
  const baru = namaBulan_(mi);
  const adaBaru = await driveCariFolder_(env, baru, tw.id);
  if (adaBaru) return adaBaru;
  // Folder lama bernama polos ("November") dipakai lagi dan diganti
  // namanya ke bentuk baru, supaya tidak tercipta duplikat.
  const adaLama = await driveCariFolder_(env, BULAN_ID_[mi], tw.id);
  if (adaLama) {
    try { await driveUbahNama_(env, adaLama.id, baru); adaLama.name = baru; } catch (e) {}
    return adaLama;
  }
  return driveBuatFolder_(env, baru, tw.id);
}
async function folderKegiatan_(env, idLog, tanggalDate) {
  const nama = kunciTanggal_(tanggalDate) + '_' + idLog;
  return driveFolderAnak_(env, (await folderBulanEviden_(env, tanggalDate)).id, nama);
}
async function jumlahBerkasFolder_(env, folderId) {
  const hasil = await driveList_(env,
    `'${folderId}' in parents and trashed = false`, 'files(id)', MAKS_BERKAS_PER_ENTRI + 1);
  return hasil.length;
}

/* ============================ PROFIL & RHK ================================ */
function bacaProfilDari_(rows) {
  if (!rows.length) return {};
  const r = rows[0];
  return { nama: String(r.Nama || ''), nip: String(r.NIP || ''),
    pangkat: String(r.Pangkat_Golongan || ''), jabatan: String(r.Jabatan || ''),
    unit: String(r.Unit_Kerja || ''), atasan: String(r.Nama_Atasan || ''),
    nipAtasan: String(r.NIP_Atasan || ''), jabatanAtasan: String(r.Jabatan_Atasan || ''),
    email: String(r.Email || ''), zonaWaktu: String(r.Zona_Waktu || ZONA_WAKTU),
    labelNip: String(r.Label_NIP || ''), unitOrganisasi: String(r.Unit_Organisasi || '') };
}
async function bacaProfil_(env) {
  const t = await muatTabel_(env, SHEET_PROFIL_, HEADER_PROFIL_);
  return bacaProfilDari_(t.rows);
}
async function tulisProfil_(env, p) {
  p = p || {};
  const nilai = [bersihTeks_(p.nama, 100), bersihTeks_(p.nip, 30), bersihTeks_(p.pangkat, 60),
    bersihTeks_(p.jabatan, 120), bersihTeks_(p.unit, 120), bersihTeks_(p.atasan, 100),
    bersihTeks_(p.nipAtasan, 30), bersihTeks_(p.jabatanAtasan, 120),
    bersihTeks_(p.email, 120), bersihTeks_(p.zonaWaktu, 40) || ZONA_WAKTU, stempel_(),
    bersihTeks_(p.labelNip, 10), bersihTeks_(p.unitOrganisasi, 120)];
  const t = await muatTabel_(env, SHEET_PROFIL_, HEADER_PROFIL_);
  if (JSON.stringify(t.header) !== JSON.stringify(HEADER_PROFIL_)) {
    await sheetsValuesUpdate_(env, `${SHEET_PROFIL_}!A1:${kolomHuruf_(HEADER_PROFIL_.length)}1`, [HEADER_PROFIL_]);
  }
  if (t.lastRow < 2) await sheetsValuesAppend_(env, `${SHEET_PROFIL_}!A1`, [nilai]);
  else await sheetsValuesUpdate_(env, `${SHEET_PROFIL_}!A2:${kolomHuruf_(nilai.length)}2`, [nilai]);
  return bacaProfil_(env);
}
function barisRhkKeObjek_(r) {
  const aksi = String(r.Rencana_Aksi || '').split(/\s*\|\s*|\n/).map((s) => s.trim()).filter(Boolean);
  const kw = String(r.Kata_Kunci || '').split(/\s*[,;]\s*/).map((s) => s.trim()).filter(Boolean);
  return { id: Number(r.ID_RHK) || 0, name: String(r.Nama_RHK || ''), aksi, kw,
    targetKuantitas: r.Target_Kuantitas === '' ? null : Number(r.Target_Kuantitas),
    targetWaktu: String(r.Target_Waktu || ''),
    satuan: String(r.Satuan || ''), aturan: String(r.Aturan_Hitung || ''),
    durasiStd: Number(r.Durasi_Standar_Menit) || 0,
    akses: String(r.Akses_Eviden || 'link') === 'privat' ? 'privat' : 'link',
    aktif: String(r.Aktif || 'YA') !== 'TIDAK' };
}
async function bacaSemuaRhk_(env) {
  const t = await muatTabel_(env, SHEET_RHK_, HEADER_RHK_);
  return t.rows.map(barisRhkKeObjek_).filter((r) => r.id > 0)
    .sort((a, b) => a.id - b.id);
}
function rhkDariDaftar_(daftar, id) {
  for (const r of daftar) if (r.id === Number(id)) return r;
  return null;
}
async function tulisSatuRhk_(env, r, tabelRhk) {
  if (!r || !(Number(r.id) > 0)) throw new Error('ID_RHK wajib angka > 0.');
  const nilai = [Number(r.id), bersihTeks_(r.name, 200),
    (Array.isArray(r.aksi) ? r.aksi : []).join(' | '),
    (Array.isArray(r.kw) ? r.kw : []).join(', '),
    r.targetKuantitas === null || r.targetKuantitas === undefined ? '' : Number(r.targetKuantitas),
    bersihTeks_(r.targetWaktu, 60), bersihTeks_(r.satuan, 40),
    bersihTeks_(r.aturan, 300), Number(r.durasiStd) || 0,
    r.akses === 'privat' ? 'privat' : 'link',
    r.aktif === false ? 'TIDAK' : 'YA', stempel_()];
  const t = tabelRhk || await muatTabel_(env, SHEET_RHK_, HEADER_RHK_);
  for (const row of t.rows) {
    if (Number(row.ID_RHK) === Number(r.id)) {
      await sheetsValuesUpdate_(env,
        `${SHEET_RHK_}!A${row._baris}:${kolomHuruf_(nilai.length)}${row._baris}`, [nilai]);
      return rhkDariDaftar_(await bacaSemuaRhk_(env), r.id);
    }
  }
  await sheetsValuesAppend_(env, `${SHEET_RHK_}!A1`, [nilai]);
  return rhkDariDaftar_(await bacaSemuaRhk_(env), r.id);
}

/* ============================ LOG KERJA =================================== */
function barisLogKeObjek_(r) {
  return { id: String(r.ID_Log || ''), timestamp: String(r.Timestamp || ''),
    aksi: String(r.Rencana_Aksi || ''), tanggal: parseTanggalSel_(r.Tanggal),
    jamMulai: normalJam_(r.Jam_Mulai), jamSelesai: normalJam_(r.Jam_Selesai),
    uraian: String(r.Uraian_Pekerjaan || ''), realisasi: String(r.Realisasi || ''),
    linkBukti: String(r.Link_Bukti_Dukung || ''), rhkId: Number(r.ID_RHK) || null,
    jumlah: r.Jumlah === '' || r.Jumlah === null ? null : Number(r.Jumlah),
    satuan: String(r.Satuan || ''), durasiMenit: Number(r.Durasi_Menit) || 0,
    folderEvidenId: String(r.Folder_Eviden_ID || ''),
    folderEvidenUrl: String(r.Folder_Eviden_URL || ''),
    akses: String(r.Akses_Eviden || 'link') === 'privat' ? 'privat' : 'link',
    sumber: String(r.Sumber || ''), clientId: String(r.Client_ID || ''),
    diperbarui: String(r.Diperbarui || '') };
}
function cariBarisLog_(rows, idLogAtauClient) {
  for (const r of rows) {
    if (String(r.ID_Log) === String(idLogAtauClient) ||
        String(r.Client_ID) === String(idLogAtauClient)) return r;
  }
  return null;
}
function idLogBerikutnya_(rows) {
  let maks = 0;
  rows.forEach((r) => {
    const m = String(r.ID_Log || '').match(/^LOG-(\d+)$/);
    if (m) maks = Math.max(maks, Number(m[1]));
  });
  return 'LOG-' + String(maks + 1).padStart(4, '0');
}
/* Validasi inti entri (dipakai simpan langsung, sinkronisasi, dan draf):
   - ID RHK karangan DITOLAK (harus ada di RHK_Config) — tidak ditebak.
   - Jam wajib lengkap & masuk akal; durasi dihitung ulang dari jam.
   - Rencana aksi harus salah satu aksi resmi RHK itu; bila teks bebas
     dikirim tanpa padanan, aksi resmi pertama dipakai hanya bila klien
     memang memilih RHK itu — selain itu entri ditandai belum terpetakan. */
function validasiEntri_(e, daftarRhk) {
  e = e || {};
  const tanggal = parseTanggal_(e.tanggal || e.date);
  if (!tanggal) return { ok: false, msg: 'Tanggal kegiatan tidak valid.' };
  const vJam = validasiJam_(e.jamMulai || e.start, e.jamSelesai || e.end);
  if (!vJam.ok) return { ok: false, msg: vJam.msg };
  let rhk = null, aksi = bersihTeks_(e.aksi, 300);
  const rhkId = (e.rhkId !== undefined ? e.rhkId : e.rhk);
  if (rhkId !== null && rhkId !== undefined && rhkId !== '') {
    rhk = rhkDariDaftar_(daftarRhk, rhkId);
    if (!rhk) return { ok: false, msg: 'ID RHK ' + rhkId + ' tidak dikenal — ditolak, tidak dikarang.' };
    if (aksi) {
      const cocok = rhk.aksi.filter((a) => a.toLowerCase() === aksi.toLowerCase())[0];
      if (!cocok && rhk.aksi.length) aksi = rhk.aksi[0];
      if (cocok) aksi = cocok;
    } else if (rhk.aksi.length) aksi = rhk.aksi[0];
  }
  return { ok: true, nilai: {
    tanggal, rhk, aksi,
    jamMulai: normalJam_(e.jamMulai || e.start), jamSelesai: normalJam_(e.jamSelesai || e.end),
    durasiMenit: hitungDurasiMenit_(e.jamMulai || e.start, e.jamSelesai || e.end),
    uraian: bersihTeks_(e.uraian, 1000), realisasi: bersihTeks_(e.realisasi, 500),
    jumlah: (e.jumlah === null || e.jumlah === undefined || e.jumlah === '') ? 1 : Math.max(0, Number(e.jumlah) || 0),
    akses: e.akses === 'privat' ? 'privat' : (rhk ? rhk.akses : 'link'),
    sumber: bersihTeks_(e.sumber || e.src, 20) || 'PWA',
    clientId: bersihTeks_(e.clientId || e.id, 80),
  } };
}
/* Tulis satu entri ke Log_Kerja. Dipakai simpan langsung, sinkronisasi, dan
   konfirmasi draf. Anti-ganda: clientId yang sudah ada DIPERBARUI, bukan
   diduplikat. Folder eviden dibuat/dipakai lagi; akses mengikuti penanda.
   Operasi tulis dikumpulkan (updates/appends) lalu di-flush sekaligus —
   hemat subrequest (batas Free: 50/request). */
async function tulisEntriKeLog_(env, ctx, e, opsi) {
  opsi = opsi || {};
  const v = validasiEntri_(e, ctx.rhks);
  if (!v.ok) throw new Error(v.msg);
  const n = v.nilai;
  const sudah = n.clientId ? cariBarisLog_(ctx.logRows, n.clientId)
    : (opsi.idLog ? cariBarisLog_(ctx.logRows, opsi.idLog) : null);
  const idLog = sudah ? String(sudah.ID_Log) : (opsi.idLog || idLogBerikutnya_(ctx.logRows));
  // Folder eviden per kegiatan dibuat/dipakai lagi; akses mengikuti penanda.
  // Entri yang sudah ada & foldernya sudah tercatat: jangan panggil Drive
  // lagi (hemat subrequest); hanya entri baru yang butuh folder+akses.
  let folderId = sudah ? String(sudah.Folder_Eviden_ID || '') : '';
  let folderUrl = sudah ? String(sudah.Folder_Eviden_URL || '') : '';
  let folderBaru = false;
  if (!folderId) {
    const folder = await folderKegiatan_(env, idLog, n.tanggal);
    folderId = folder.id;
    folderUrl = await terapkanAksesFolder_(env, folderId, n.akses);
    await pastikanPenulisFolder_(env, folderId);
    folderBaru = true;
  } else if (n.akses !== String(sudah.Akses_Eviden || 'link')) {
    folderUrl = await terapkanAksesFolder_(env, folderId, n.akses);
  }
  // Link Bukti Dukung = URL folder HANYA bila folder sudah berisi berkas.
  // Folder baru pasti kosong -> link kosong (jujur, bukan link semu).
  // Entri lama mempertahankan link yang sudah tercatat; hanya bila link
  // masih kosong dicek apakah folder sudah berisi berkas (mis. ditambah
  // manual di Drive).
  let linkBukti = sudah ? String(sudah.Link_Bukti_Dukung || '') : '';
  if (!folderBaru && !linkBukti && folderId) {
    if (await jumlahBerkasFolder_(env, folderId) > 0) linkBukti = folderUrl;
  }
  const nilai = [];
  nilai[KOL_LOG_.ID_Log - 1] = idLog;
  nilai[KOL_LOG_.Timestamp - 1] = sudah ? String(sudah.Timestamp) : stempel_();
  nilai[KOL_LOG_.Rencana_Aksi - 1] = n.aksi;
  nilai[KOL_LOG_.Tanggal - 1] = kunciTanggal_(n.tanggal);
  nilai[KOL_LOG_.Jam_Mulai - 1] = n.jamMulai;
  nilai[KOL_LOG_.Jam_Selesai - 1] = n.jamSelesai;
  nilai[KOL_LOG_.Uraian_Pekerjaan - 1] = n.uraian;
  nilai[KOL_LOG_.Realisasi - 1] = n.realisasi;
  nilai[KOL_LOG_.Link_Bukti_Dukung - 1] = linkBukti;
  nilai[KOL_LOG_.ID_RHK - 1] = n.rhk ? n.rhk.id : '';
  nilai[KOL_LOG_.Jumlah - 1] = n.jumlah;
  nilai[KOL_LOG_.Satuan - 1] = n.rhk ? n.rhk.satuan : '';
  nilai[KOL_LOG_.Durasi_Menit - 1] = n.durasiMenit;
  nilai[KOL_LOG_.Folder_Eviden_ID - 1] = folderId;
  nilai[KOL_LOG_.Folder_Eviden_URL - 1] = folderUrl;
  nilai[KOL_LOG_.Akses_Eviden - 1] = n.akses;
  nilai[KOL_LOG_.Sumber - 1] = n.sumber;
  nilai[KOL_LOG_.Client_ID - 1] = n.clientId;
  nilai[KOL_LOG_.Diperbarui - 1] = stempel_();
  if (sudah) ctx.updates.push({ baris: sudah._baris, nilai });
  else ctx.appends.push(nilai);
  // Catat ke cache lokal supaya entri berikutnya dalam batch yang sama
  // melihat baris ini (anti-ganda di dalam satu request).
  const barisObj = {};
  HEADER_LOG_.forEach((h, i) => { barisObj[h] = nilai[i]; });
  barisObj._baris = sudah ? sudah._baris : ctx.lastRow + ctx.appends.length;
  if (sudah) {
    const idx = ctx.logRows.indexOf(sudah);
    if (idx >= 0) ctx.logRows[idx] = barisObj;
  } else ctx.logRows.push(barisObj);
  return barisLogKeObjek_(barisObj);
}
async function flushLog_(env, ctx) {
  if (ctx.updates.length) {
    const data = ctx.updates.map((u) => tulisSatuBaris_(null, SHEET_LOG_, u.baris, u.nilai));
    await sheetsValuesBatchUpdate_(env, data);
  }
  if (ctx.appends.length) {
    await sheetsValuesAppend_(env, `${SHEET_LOG_}!A1`, ctx.appends.map((r) => r.map(amanSel_)));
  }
}
async function bacaEntri_(env, filter) {
  filter = filter || {};
  const t = await muatTabel_(env, SHEET_LOG_, HEADER_LOG_);
  let out = t.rows.map(barisLogKeObjek_);
  if (filter.dari) out = out.filter((e) => e.tanggal >= filter.dari);
  if (filter.sampai) out = out.filter((e) => e.tanggal <= filter.sampai);
  if (filter.rhkId) out = out.filter((e) => e.rhkId === Number(filter.rhkId));
  return out.sort((a, b) => bandingWaktu_(a.tanggal, b.tanggal) ||
    bandingWaktu_(a.jamMulai, b.jamMulai));
}
async function muatKonteksLog_(env) {
  const [tabelLog, rhks] = await Promise.all([
    muatTabel_(env, SHEET_LOG_, HEADER_LOG_),
    bacaSemuaRhk_(env),
  ]);
  return { logRows: tabelLog.rows, lastRow: tabelLog.lastRow, rhks, updates: [], appends: [] };
}

/* ====================== EVIDEN: UNGGAH & AKSES ============================ */
function tipeEvidenBoleh_(mime) {
  mime = String(mime || '');
  return TIPE_EVIDEN_BOLEH_.some((t) => t.endsWith('/') ? mime.indexOf(t) === 0 : mime === t);
}
/* Unggah satu berkas eviden (base64 dari PWA/Telegram) ke folder kegiatan
   entri. Maks 10 MB per berkas; folder induk tidak pernah ikut dibuka. */
async function unggahEviden_(env, idLog, berkas) {
  const t = await muatTabel_(env, SHEET_LOG_, HEADER_LOG_);
  const baris = cariBarisLog_(t.rows, idLog);
  if (!baris) throw new Error('Entri ' + idLog + ' tidak ditemukan.');
  berkas = berkas || {};
  const nama = bersihTeks_(berkas.nama || berkas.name, 180) || 'eviden';
  const mime = bersihTeks_(berkas.mime || berkas.type, 120) || 'application/octet-stream';
  if (!tipeEvidenBoleh_(mime)) throw new Error('Tipe berkas tidak didukung untuk eviden: ' + mime);
  if (!berkas.base64) throw new Error('Isi berkas (base64) kosong.');
  // base64 standar dari FileReader (PWA) — bisa mengandung spasi/baris baru.
  let data;
  try {
    const bin = atob(String(berkas.base64).replace(/\s+/g, ''));
    data = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) data[i] = bin.charCodeAt(i);
  } catch (e) {
    throw new Error('Isi berkas (base64) tidak bisa dibaca.');
  }
  if (data.length > MAKS_UKURAN_BERKAS) {
    throw new Error('Berkas "' + nama + '" melebihi 10 MB — ditolak.');
  }
  const folderId = String(baris.Folder_Eviden_ID);
  if (!folderId) throw new Error('Folder eviden entri ini belum dibuat.');
  const jumlahAda = await jumlahBerkasFolder_(env, folderId);
  if (jumlahAda >= MAKS_BERKAS_PER_ENTRI) {
    throw new Error('Folder kegiatan sudah berisi ' + MAKS_BERKAS_PER_ENTRI + ' berkas (batas maks).');
  }
  const file = await driveUnggah_(env, folderId, nama, mime, data);
  // Setelah berkas pertama masuk, Link Bukti Dukung = URL folder kegiatan.
  const akses = String(baris.Akses_Eviden || 'link') === 'privat' ? 'privat' : 'link';
  const folderUrl = await terapkanAksesFolder_(env, folderId, akses);
  await sheetsValuesBatchUpdate_(env, [
    { range: `${SHEET_LOG_}!${kolomHuruf_(KOL_LOG_.Link_Bukti_Dukung)}${baris._baris}`,
      values: [[folderUrl]] },
    { range: `${SHEET_LOG_}!${kolomHuruf_(KOL_LOG_.Diperbarui)}${baris._baris}`,
      values: [[stempel_()]] },
  ]);
  return { fileId: file.fileId, nama: file.nama, ukuran: file.ukuran,
    folderId, folderUrl, linkBukti: folderUrl };
}
/* Catat berkas eviden yang SUDAH diunggah langsung oleh PWA ke folder
   kegiatan memakai token OAuth akun pengguna (bukan service account).
   Latar: service account tidak punya kuota penyimpanan Drive sehingga
   unggah berkas apa pun lewat SA ditolak Google ("Service Accounts do
   not have storage quota"), padahal folder bisa dibuat SA karena folder
   tidak makan kuota.
   PENTING: SA TIDAK BISA memverifikasi berkas itu lewat Drive — berkas
   milik akun pengguna tidak terlihat oleh token SA (scope drive.file lama
   hanya melihat berkas yang dibuat SA sendiri; scope kini drive penuh,
   tapi verifikasi tetap tidak dilakukan — bukti sah adalah respons
   unggah), sehingga driveGet_ selalu gagal ("Berkas Drive tidak
   ditemukan"). Karena itu fungsi ini
   TIDAK membaca berkasnya: bukti bahwa berkas ada di folder yang benar
   adalah respons unggah langsung dari Drive ke PWA (fileId yang
   dikembalikan untuk parent folderId yang diminta). Yang diperiksa di
   sini hanya nilai yang dikirim PWA (mime diizinkan, ukuran ≤ 10 MB),
   lalu akses folder diterapkan dan Link Bukti Dukung ditulis — sama
   seperti unggahEviden_. Batas berkas per folder tidak bisa dihitung
   dari sisi SA (berkas pengguna tidak terlihat), jadi ditegakkan di
   sisi PWA. */
async function catatEviden_(env, idLog, berkas) {
  const t = await muatTabel_(env, SHEET_LOG_, HEADER_LOG_);
  const baris = cariBarisLog_(t.rows, idLog);
  if (!baris) throw new Error('Entri ' + idLog + ' tidak ditemukan.');
  berkas = berkas || {};
  const fileId = String(berkas.fileId || berkas.id || '').trim();
  if (!fileId) throw new Error('ID berkas Drive (fileId) wajib diisi.');
  const folderId = String(baris.Folder_Eviden_ID);
  if (!folderId) throw new Error('Folder eviden entri ini belum dibuat.');
  const nama = bersihTeks_(berkas.nama || berkas.name, 180) || 'eviden';
  const mime = bersihTeks_(berkas.mime || berkas.type, 120) || 'application/octet-stream';
  if (!tipeEvidenBoleh_(mime)) throw new Error('Tipe berkas tidak didukung untuk eviden: ' + mime);
  const ukuran = Number(berkas.ukuran) || 0;
  if (ukuran > MAKS_UKURAN_BERKAS) {
    throw new Error('Berkas "' + nama + '" melebihi 10 MB — ditolak.');
  }
  const akses = String(baris.Akses_Eviden || 'link') === 'privat' ? 'privat' : 'link';
  const folderUrl = await terapkanAksesFolder_(env, folderId, akses);
  await sheetsValuesBatchUpdate_(env, [
    { range: `${SHEET_LOG_}!${kolomHuruf_(KOL_LOG_.Link_Bukti_Dukung)}${baris._baris}`,
      values: [[folderUrl]] },
    { range: `${SHEET_LOG_}!${kolomHuruf_(KOL_LOG_.Diperbarui)}${baris._baris}`,
      values: [[stempel_()]] },
  ]);
  return { fileId, nama, ukuran, folderId, folderUrl, linkBukti: folderUrl };
}
/* Siapkan folder kegiatan agar bisa ditulis akun pengguna (untuk unggah
   langsung dari PWA). Memastikan folder ada (dibuat bila belum) dan
   akun pemilik sudah menjadi writer di folder itu. Dipanggil aplikasi
   sebelum mengunggah berkas langsung ke Drive. */
async function siapkanFolder_(env, idLog) {
  const t = await muatTabel_(env, SHEET_LOG_, HEADER_LOG_);
  const baris = cariBarisLog_(t.rows, idLog);
  if (!baris) throw new Error('Entri ' + idLog + ' tidak ditemukan.');
  let folderId = String(baris.Folder_Eviden_ID || '');
  let folderUrl = String(baris.Folder_Eviden_URL || '');
  if (!folderId) {
    const entri = barisLogKeObjek_(baris);
    const folder = await folderKegiatan_(env, entri.id, entri.tanggal);
    folderId = folder.id;
    const akses = String(baris.Akses_Eviden || 'link') === 'privat' ? 'privat' : 'link';
    folderUrl = await terapkanAksesFolder_(env, folderId, akses);
    await sheetsValuesBatchUpdate_(env, [
      { range: `${SHEET_LOG_}!${kolomHuruf_(KOL_LOG_.Folder_Eviden_ID)}${baris._baris}`,
        values: [[folderId]] },
      { range: `${SHEET_LOG_}!${kolomHuruf_(KOL_LOG_.Folder_Eviden_URL)}${baris._baris}`,
        values: [[folderUrl]] },
    ]);
  }
  await pastikanPenulisFolder_(env, folderId);
  if (!folderUrl) {
    folderUrl = await terapkanAksesFolder_(env, folderId,
      String(baris.Akses_Eviden || 'link') === 'privat' ? 'privat' : 'link');
  }
  return { folderId, folderUrl };
}
/* Daftar folder kegiatan yang sedang TERBUKA (anyone-with-link).
   Penanda sheet (Akses_Eviden='link') dipakai sebagai penyaring awal,
   lalu sharing dicek langsung ke Drive (maks 40 folder per panggilan). */
async function daftarFolderTerbuka_(env) {
  const t = await muatTabel_(env, SHEET_LOG_, HEADER_LOG_);
  const kandidat = t.rows.filter((r) => r.Folder_Eviden_ID &&
    String(r.Akses_Eviden || 'link') !== 'privat').slice(0, MAKS_CEK_FOLDER_TERBUKA);
  const out = [];
  for (const r of kandidat) {
    try {
      const f = await driveGet_(env, String(r.Folder_Eviden_ID),
        'id,name,webViewLink,permissions(type)');
      const terbuka = (f.permissions || []).some((p) => p.type === 'anyone');
      if (terbuka) {
        out.push({ idLog: String(r.ID_Log), folderId: f.id, nama: f.name,
          url: f.webViewLink || '', tanggal: parseTanggalSel_(r.Tanggal),
          aksesTercatat: String(r.Akses_Eviden || 'link') });
      }
    } catch (e) { /* folder hilang/izin berubah: lewati */ }
  }
  return out;
}
async function tutupAksesEntri_(env, idLog) {
  const t = await muatTabel_(env, SHEET_LOG_, HEADER_LOG_);
  const baris = cariBarisLog_(t.rows, idLog);
  if (!baris) throw new Error('Entri ' + idLog + ' tidak ditemukan.');
  const folderId = String(baris.Folder_Eviden_ID);
  await tutupAksesFolder_(env, folderId);
  const tepercaya = await akunTepercaya_(env);
  for (const email of tepercaya) {
    try { await driveTambahIzin_(env, folderId, { type: 'user', role: 'reader', emailAddress: email }); } catch (e) { /* lewati */ }
  }
  await sheetsValuesBatchUpdate_(env, [
    { range: `${SHEET_LOG_}!${kolomHuruf_(KOL_LOG_.Akses_Eviden)}${baris._baris}`, values: [['privat']] },
    { range: `${SHEET_LOG_}!${kolomHuruf_(KOL_LOG_.Diperbarui)}${baris._baris}`, values: [[stempel_()]] },
  ]);
  const f = await driveGet_(env, folderId, 'id,webViewLink');
  return { idLog, akses: 'privat', folderUrl: f.webViewLink || '' };
}
async function aturAksesEntri_(env, idLog, akses) {
  if (akses === 'privat') return tutupAksesEntri_(env, idLog);
  const t = await muatTabel_(env, SHEET_LOG_, HEADER_LOG_);
  const baris = cariBarisLog_(t.rows, idLog);
  if (!baris) throw new Error('Entri ' + idLog + ' tidak ditemukan.');
  const folderId = String(baris.Folder_Eviden_ID);
  const url = await terapkanAksesFolder_(env, folderId, 'link');
  const punyaBerkas = await jumlahBerkasFolder_(env, folderId) > 0;
  await sheetsValuesBatchUpdate_(env, [
    { range: `${SHEET_LOG_}!${kolomHuruf_(KOL_LOG_.Akses_Eviden)}${baris._baris}`, values: [['link']] },
    { range: `${SHEET_LOG_}!${kolomHuruf_(KOL_LOG_.Link_Bukti_Dukung)}${baris._baris}`,
      values: [[punyaBerkas ? url : String(baris.Link_Bukti_Dukung || '')]] },
    { range: `${SHEET_LOG_}!${kolomHuruf_(KOL_LOG_.Diperbarui)}${baris._baris}`, values: [[stempel_()]] },
  ]);
  return { idLog, akses: 'link', folderUrl: url };
}

/* ============================ ARSIP LAPORAN =============================== */
async function simpanArsipLaporan_(env, a) {
  a = a || {};
  const id = bersihTeks_(a.id, 40) || idBaru_('ARS-');
  const nilai = [id, bersihTeks_(a.bulanTahun, 20), bersihTeks_(a.tipe || a.tipeLaporan, 40) || 'Bulanan',
    bersihTeks_(a.judul, 200), bersihTeks_(a.urlDoc, 500), bersihTeks_(a.urlPdf, 500),
    Number(a.jumlahEntri) || 0, stempel_(), 'Ardian'];
  const t = await muatTabel_(env, SHEET_ARSIP_, HEADER_ARSIP_);
  for (const r of t.rows) {
    if (String(r.ID_Arsip) === id) {
      await sheetsValuesUpdate_(env,
        `${SHEET_ARSIP_}!A${r._baris}:${kolomHuruf_(nilai.length)}${r._baris}`, [nilai]);
      return { idArsip: id, status: 'diperbarui' };
    }
  }
  await sheetsValuesAppend_(env, `${SHEET_ARSIP_}!A1`, [nilai]);
  const root = await folderRoot_(env);
  const arsip = await driveFolderAnak_(env, root.id, 'Arsip_Laporan_Final');
  return { idArsip: id, status: 'tersimpan', folderArsipId: arsip.id };
}
async function bacaArsip_(env) {
  const t = await muatTabel_(env, SHEET_ARSIP_, HEADER_ARSIP_);
  return t.rows.map((r) => ({ id: String(r.ID_Arsip || ''), bulanTahun: String(r.Bulan_Tahun || ''),
    tipe: String(r.Tipe_Laporan || ''), judul: String(r.Judul || ''),
    urlDoc: String(r.URL_Google_Doc || ''), urlPdf: String(r.URL_PDF || ''),
    jumlahEntri: Number(r.Jumlah_Entri) || 0, waktuGenerate: String(r.Waktu_Generate || '') }));
}

/* ==================== GEMINI DI SERVER (ATURAN BATCH 1) =================== */
/* Failover: utama -> cadangan -> terakhir. 503 diulang SEKALI pada model
   yang sama; 429 TIDAK diulang; jaringan/kunci/kuota menghentikan failover
   karena sebabnya sama untuk semua model. Diagnosis panggilan terakhir
   disimpan di Pengaturan_Sistem (Diagnosis_AI_Terakhir). */
function kunciGemini_(env) {
  return String(env.GEMINI_API_KEY || '').replace(/\s+/g, '');
}
async function panggilGemini_(env, model, body, key) {
  const url = `${GEMINI_BASE}/${model}:generateContent`;
  const t0 = Date.now();
  let resp;
  try {
    resp = await fetch(url, { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_GEMINI_MS) });
  } catch (e) {
    const err = new Error('network'); err.kind = 'network'; err.ms = Date.now() - t0;
    throw err;
  }
  const http = resp.status;
  const teks = await resp.text();
  if (http < 200 || http >= 300) {
    let gmsg = '', gstatus = '';
    const j = jsonParseAman_(teks);
    if (j && j.error) { gmsg = j.error.message || ''; gstatus = j.error.status || ''; }
    const e2 = new Error('HTTP ' + http); e2.http = http; e2.ms = Date.now() - t0;
    e2.gmsg = gmsg; e2.gstatus = gstatus;
    e2.kind = http === 404 ? 'model' : http === 429 ? 'quota'
      : (http === 400 || http === 401 || http === 403) ? 'key'
      : http >= 500 ? 'server' : 'http';
    throw e2;
  }
  const data = JSON.parse(teks);
  data.__meta = { model, http, ms: Date.now() - t0 };
  return data;
}
async function catatDiagAi_(env, model, status, http, ms) {
  try {
    await tulisPengaturan_(env, 'Diagnosis_AI_Terakhir',
      JSON.stringify({ waktu: stempel_(), model, status, http: http || 0, ms: ms || 0 }),
      'Diagnosis panggilan Gemini terakhir (server)');
  } catch (e) { /* diagnosis tidak boleh menggagalkan panggilan */ }
}
async function geminiDenganFailover_(env, body) {
  const key = kunciGemini_(env);
  if (!key) {
    const e0 = new Error('GEMINI_API_KEY belum diisi (Worker secret).');
    e0.kind = 'key'; e0.kode = 'no-key'; throw e0;
  }
  const dariSheet = await ambilPengaturan_(env, 'Model_Utama', '');
  const urutan = urutanModel_(env, dariSheet);
  let lastErr = null;
  for (const model of urutan) {
    try {
      const data = await panggilGemini_(env, model, body, key);
      await catatDiagAi_(env, model, 'OK', data.__meta.http, data.__meta.ms);
      return data;
    } catch (err) {
      lastErr = err;
      await catatDiagAi_(env, model, 'Gagal: ' + (err.kind || 'http'), err.http || 0, err.ms || 0);
      if (err.kind === 'network' || err.kind === 'key' || err.kind === 'quota') break;
      if (err.http === 503) { // ulang sekali saja pada model yang sama
        try {
          await tidur_(1500);
          const ulang = await panggilGemini_(env, model, body, key);
          await catatDiagAi_(env, model, 'OK (ulang 503)', ulang.__meta.http, ulang.__meta.ms);
          return ulang;
        } catch (err2) {
          lastErr = err2;
          await catatDiagAi_(env, model, 'Gagal (ulang 503)', err2.http || 0, err2.ms || 0);
        }
      }
    }
  }
  throw lastErr || new Error('gemini-fail');
}
async function tesGeminiServer_(env) {
  const data = await geminiDenganFailover_(env, { contents: [{ parts: [{ text: 'Balas tepat satu kata: siap' }] }],
    generationConfig: { maxOutputTokens: 16 } });
  return data.__meta;
}

/* Pecah teks jadi maks 5 kegiatan (aturan Batch 1): per baris, atau penanda
   urutan "lalu / kemudian / setelah itu". */
function pecahKegiatan_(teks) {
  if (!teks) return [teks];
  let parts = String(teks).split(/\n+/).map((s) => s.trim()).filter(Boolean);
  if (parts.length < 2) {
    parts = String(teks).split(/\s+(?:lalu|kemudian|setelah itu)\s+/i)
      .map((s) => s.trim()).filter(Boolean);
  }
  parts = parts.filter((s) => s.length >= 8);
  return (parts.length >= 2 ? parts : [teks]).slice(0, MAKS_SPLIT_KEGIATAN);
}
/* Proses satu potongan teks dengan Gemini -> objek mentah AI.
   Prompt sama semangatnya dengan PWA Batch 1: AI hanya menentukan ANGKA
   realisasi (satuan dari RHK), jam tidak ditebak dari waktu kirim, RHK
   tidak dikarang. Validasi keras dilakukan kode di prosesJadiDraf_(). */
async function geminiProsesSatu_(env, teks, tanggalKunci, daftarRhk, berkas) {
  const daftar = daftarRhk.map((r) =>
    'RHK ' + r.id + ': ' + r.name + '\n   Rencana aksi: ' +
    r.aksi.map((a, i) => (i + 1) + '. ' + a).join(' | ') +
    '\n   Satuan: ' + (r.satuan || '-') + ' · Aturan hitung: ' + (r.aturan || '-') +
    ' · Durasi standar: ' + (r.durasiStd || 0) + ' menit per satuan').join('\n');
  const profil = await bacaProfil_(env);
  const prompt = 'Kamu adalah mesin pemrosesan catatan kinerja aplikasi Progresio untuk ASN Indonesia.\n\n' +
    'Catatan pengguna (bahasa sehari-hari, hasil ketik atau dikte suara):\n"""' +
    (teks || '(catatan kosong — hanya ada lampiran)') + '"""\n' +
    'Tanggal kegiatan: ' + tanggalKunci +
    (profil.jabatan ? '\nJabatan pengguna: ' + profil.jabatan + (profil.unit ? ' — ' + profil.unit : '') : '') +
    '\n\nDaftar RHK & rencana aksi pengguna:\n' + daftar + '\n\nTugasmu:\n' +
    '1. Rapikan catatan menjadi uraian pekerjaan yang jelas dan ringkas (maksimal sekitar 25 kata). Jangan menambah fakta yang tidak ada di catatan.\n' +
    '2. realisasi: hasil nyata yang dicapai menurut catatan. Kosongkan "" bila memang tidak disebutkan.\n' +
    '3. jumlah: ANGKA realisasi saja menurut Aturan Hitung RHK terpilih — kamu hanya menentukan angkanya, satuannya diambil dari kolom Satuan RHK, jangan menulis satuan di sini. Contoh: catatan menyebut 5 file PDF untuk 1 permohonan dengan aturan "1 permohonan = 1 layanan" -> jumlah = 1, bukan 5. Bila catatan tidak menyebut jumlah yang bisa dihitung, isi 1.\n' +
    '4. jamMulai & jamSelesai: format "HH:MM" 24 jam bila disebut di catatan — termasuk ungkapan lisan seperti "jam sepuluh" (10:00) atau "dua belas kurang seperempat" (11:45). Isi null bila tidak disebut. Jam kirim pesan BUKAN jam kegiatan — jangan menebak jam dari waktu pengiriman.\n' +
    '5. Cocokkan secara semantik ke SATU RHK dan SATU rencana aksi dari daftar yang paling sesuai, dan salin teks rencana aksinya PERSIS dari daftar. Bila tidak ada yang benar-benar sesuai, isi rhkId null dan aksi null — jangan mengarang.\n' +
    '6. keyakinan: angka 0-100, tingkat keyakinanmu pada pencocokan RHK.\n' +
    'Balas hanya JSON sesuai skema.';
  const parts = [{ text: prompt }];
  let imgN = 0;
  (berkas || []).forEach((f) => {
    if (imgN >= MAKS_FOTO_KE_GEMINI) return;
    if (f && f.base64 && String(f.type || f.mime || '').indexOf('image/') === 0) {
      const approx = Math.floor(String(f.base64).length * 3 / 4);
      if (approx <= 4 * 1024 * 1024) {
        parts.push({ inlineData: { mimeType: f.type || f.mime, data: f.base64 } });
        imgN++;
      }
    }
  });
  if (imgN) parts[0].text += '\nFoto kegiatan terlampir — pakai juga sebagai petunjuk uraian & pencocokan, hanya bila relevan.';
  const body = { contents: [{ parts }], generationConfig: {
    responseMimeType: 'application/json',
    responseSchema: { type: 'OBJECT', properties: {
      uraian: { type: 'STRING' }, realisasi: { type: 'STRING' },
      jumlah: { type: 'NUMBER', nullable: true },
      jamMulai: { type: 'STRING', nullable: true },
      jamSelesai: { type: 'STRING', nullable: true },
      rhkId: { type: 'INTEGER', nullable: true },
      aksi: { type: 'STRING', nullable: true },
      keyakinan: { type: 'NUMBER', nullable: true } },
      required: ['uraian', 'realisasi'] } } };
  const data = await geminiDenganFailover_(env, body);
  let raw = '';
  try {
    raw = data.candidates[0].content.parts.map((p) => p.text || '').join('');
  } catch (e) { /* abaikan */ }
  let j = null;
  try { j = JSON.parse(raw); } catch (e) {
    const m = raw.match(/\{[\s\S]*\}/);
    if (m) { try { j = JSON.parse(m[0]); } catch (e2) { /* abaikan */ } }
  }
  if (!j) { const ej = new Error('json-invalid'); ej.kind = 'parse'; throw ej; }
  j.__model = data.__meta.model;
  return j;
}

/* Validasi keras hasil AI oleh KODE (bukan percaya AI):
   - rhkId yang tidak ada di RHK_Config -> ditolak jadi "belum terpetakan".
   - aksi harus cocok persis (tanpa peka huruf) dengan aksi resmi RHK.
   - jam diformat ulang; durasi TIDAK diambil dari AI sama sekali.
   - norma Durasi_Standar_Menit x jumlah hanya jadi ESTIMASI BERLABEL. */
function validasiHasilAi_(j, daftarRhk) {
  let rhk = null, aksi = '';
  if (typeof j.rhkId === 'number') {
    for (const r of daftarRhk) if (r.id === j.rhkId) { rhk = r; break; }
  }
  if (rhk && j.aksi) {
    const cocok = rhk.aksi.filter((a) => a.toLowerCase() === String(j.aksi).toLowerCase())[0];
    aksi = cocok || '';
  }
  if (rhk && !aksi && rhk.aksi.length) aksi = rhk.aksi[0];
  const jumlah = (typeof j.jumlah === 'number' && isFinite(j.jumlah) && j.jumlah >= 0)
    ? Math.round(j.jumlah) : 1;
  const mulai = normalJam_(j.jamMulai), selesai = normalJam_(j.jamSelesai);
  const vJam = validasiJam_(mulai, selesai);
  const estimasi = rhk && rhk.durasiStd ? rhk.durasiStd * jumlah : 0;
  return { uraian: bersihTeks_(j.uraian, 1000), realisasi: bersihTeks_(j.realisasi, 500),
    jumlah, jamMulai: mulai, jamSelesai: selesai,
    durasiMenit: vJam.ok ? hitungDurasiMenit_(mulai, selesai) : 0,
    estimasiMenit: estimasi, estimasiLabel: estimasi
      ? 'Estimasi norma RHK: ±' + estimasi + ' mnt (' + rhk.durasiStd + ' mnt × ' + jumlah +
        ' ' + (rhk.satuan || 'satuan') + ') — jam tetap harus diisi, tidak dikarang.'
      : '',
    rhkId: rhk ? rhk.id : null, aksi,
    keyakinan: (typeof j.keyakinan === 'number') ? Math.round(j.keyakinan) : null,
    jamLengkap: vJam.ok, pesanJam: vJam.ok ? '' : vJam.msg,
    model: j.__model || '', via: 'gemini' };
}
/* Pencocokan lokal sederhana bila Gemini tidak terjangkau / tanpa kunci:
   skor kata kunci RHK; tanpa padanan kuat -> belum terpetakan (tidak ditebak). */
function cocokkanLokal_(teks, daftarRhk) {
  const t = ' ' + String(teks || '').toLowerCase() + ' ';
  let terbaik = null, skorT = 0;
  daftarRhk.forEach((r) => {
    let skor = 0;
    r.kw.forEach((k) => { if (k && t.indexOf(k.toLowerCase()) >= 0) skor += 2; });
    r.aksi.forEach((a) => {
      a.toLowerCase().split(/\s+/).forEach((w) => {
        if (w.length > 4 && t.indexOf(w) >= 0) skor += 1;
      });
    });
    if (skor > skorT) { skorT = skor; terbaik = r; }
  });
  if (!terbaik || skorT < 2) return { rhkId: null, aksi: '', keyakinan: null };
  return { rhkId: terbaik.id, aksi: terbaik.aksi[0] || '', keyakinan: null };
}

/* ============================== DRAF ====================================== */
/* Hasil proses AI TIDAK langsung masuk Log_Kerja. Ia menjadi DRAF dulu dan
   baru tertulis setelah konfirmasi eksplisit (action "konfirmasiDraf") —
   pola Simpan/Batal Batch 1. Tombol Simpan di klien hanya aktif bila jam
   lengkap; server menegakkan hal yang sama lewat validasiEntri_() saat
   konfirmasi.
   Penyimpanan draf: KV (binding PROGRESIO_KV, TTL 6 jam) bila tersedia.
   Bila KV belum dipasang, prosesAi tetap mengembalikan items ke klien dan
   konfirmasiDraf menerima items itu kembali di body (divalidasi ulang) —
   jadi alur tetap jalan tanpa KV. */
async function simpanDraf_(env, draf) {
  const id = idBaru_('DRF-');
  if (env.PROGRESIO_KV) {
    await env.PROGRESIO_KV.put('draf:' + id, JSON.stringify(draf), { expirationTtl: 6 * 3600 });
  }
  return id;
}
async function ambilDraf_(env, id) {
  if (!env.PROGRESIO_KV) return null;
  const raw = await env.PROGRESIO_KV.get('draf:' + id);
  return raw ? JSON.parse(raw) : null;
}
async function hapusDraf_(env, id) {
  if (env.PROGRESIO_KV) await env.PROGRESIO_KV.delete('draf:' + id);
}
async function prosesJadiDraf_(env, payload) {
  payload = payload || {};
  const teks = bersihTeks_(payload.teks || payload.text, 4000);
  const tanggalKunci = kunciTanggal_(payload.tanggal || payload.date) || kunciTanggal_(new Date());
  const daftarRhk = (await bacaSemuaRhk_(env)).filter((r) => r.aktif);
  if (!daftarRhk.length) throw new Error('RHK_Config kosong — isi RHK dulu lewat wizard/PWA.');
  const potongan = pecahKegiatan_(teks);
  const drafList = [];
  const pakaiGemini = !!kunciGemini_(env) && payload.paksaLokal !== true;
  for (let i = 0; i < potongan.length; i++) {
    let d = null;
    if (pakaiGemini) {
      try {
        const mentah = await geminiProsesSatu_(env, potongan[i], tanggalKunci, daftarRhk, payload.berkas);
        d = validasiHasilAi_(mentah, daftarRhk);
      } catch (e) {
        if (e.kind === 'key' && !kunciGemini_(env)) { d = null; }
        else if (i === 0 && potongan.length === 1) throw e; // gagal total: laporkan apa adanya
        else d = null; // potongan lain jatuh ke lokal, ditandai jelas
      }
    }
    if (!d) {
      const lok = cocokkanLokal_(potongan[i], daftarRhk);
      const rL = lok.rhkId ? daftarRhk.filter((r) => r.id === lok.rhkId)[0] : null;
      d = { uraian: potongan[i], realisasi: '', jumlah: 1, jamMulai: '', jamSelesai: '',
        durasiMenit: 0, estimasiMenit: rL ? rL.durasiStd : 0, estimasiLabel: '',
        rhkId: lok.rhkId, aksi: lok.aksi, keyakinan: null, jamLengkap: false,
        pesanJam: 'Jam mulai & selesai wajib lengkap', model: '', via: 'lokal' };
    }
    // Pilihan manual pengguna menimpa AI (aturan Batch 1).
    const manual = payload.rhkManual || payload.manualRhk;
    if (manual) {
      const rM = daftarRhk.filter((r) => r.id === Number(manual))[0];
      if (rM) { d.rhkId = rM.id; if (!d.aksi || rM.aksi.indexOf(d.aksi) < 0) d.aksi = rM.aksi[0] || ''; }
    }
    if (payload.jamMulaiManual) d.jamMulai = normalJam_(payload.jamMulaiManual);
    if (payload.jamSelesaiManual) d.jamSelesai = normalJam_(payload.jamSelesaiManual);
    const v = validasiJam_(d.jamMulai, d.jamSelesai);
    d.jamLengkap = v.ok; d.pesanJam = v.ok ? '' : v.msg;
    d.durasiMenit = v.ok ? hitungDurasiMenit_(d.jamMulai, d.jamSelesai) : 0;
    d.tanggal = tanggalKunci;
    d.sumber = bersihTeks_(payload.sumber, 20) || 'PWA';
    d.akses = payload.akses === 'privat' ? 'privat'
      : (d.rhkId ? ((daftarRhk.filter((r) => r.id === d.rhkId)[0] || {}).akses || 'link') : 'link');
    drafList.push(d);
  }
  const drafId = await simpanDraf_(env, { dibuat: stempel_(), tanggal: tanggalKunci, items: drafList,
    berkasMeta: (payload.berkas || []).map((f) => ({ nama: f.nama || f.name || '',
      mime: f.mime || f.type || '', ukuran: f.ukuran || f.size || 0 })) });
  return { drafId, jumlahDraf: drafList.length, items: drafList,
    catatan: 'Draf belum tercatat di Log_Kerja. Simpan hanya bisa bila jam mulai–selesai lengkap di semua draf.' };
}
async function konfirmasiDraf_(env, drafId, suntingan, itemsLangsung) {
  let draf = await ambilDraf_(env, drafId);
  if (!draf && Array.isArray(itemsLangsung) && itemsLangsung.length) {
    // Tanpa KV: klien mengirim kembali items draf yang diterimanya.
    draf = { tanggal: '', items: itemsLangsung };
  }
  if (!draf) throw new Error('Draf tidak ditemukan / sudah kedaluwarsa (maks 6 jam). Proses ulang catatannya.');
  const items = draf.items;
  // Suntingan dari kartu draf klien (uraian/jam/RHK/dst.) menimpa hasil AI.
  if (Array.isArray(suntingan)) {
    suntingan.forEach((s, i) => { if (items[i] && s) Object.assign(items[i], s); });
  }
  const ctx = await muatKonteksLog_(env);
  const tersimpan = [];
  for (const it of items) {
    tersimpan.push(await tulisEntriKeLog_(env, ctx, { tanggal: it.tanggal || draf.tanggal,
      rhkId: it.rhkId, aksi: it.aksi, jamMulai: it.jamMulai, jamSelesai: it.jamSelesai,
      uraian: it.uraian, realisasi: it.realisasi, jumlah: it.jumlah,
      akses: it.akses, sumber: it.sumber || 'PWA', clientId: it.clientId || '' }));
  }
  await flushLog_(env, ctx);
  await hapusDraf_(env, drafId);
  return { tersimpan: tersimpan.length, entri: tersimpan };
}

/* ==================== WEBHOOK TELEGRAM (FONDASI BATCH 3) ================== */
/* Worker ini MENYIAPKAN endpoint-nya (seperti GAS Batch 2): menerima update
   Telegram, memvalidasi secret + chat_id pemilik, lalu meneruskan
   teks/foto/dokumen ke pemrosesan yang SAMA (prosesJadiDraf_) dan membalas
   ringkasan draf. Bot Telegram-nya sendiri (perintah lengkap, voice note,
   pengingat H-3/H-1) adalah Batch 3. Bila token Telegram belum diisi,
   webhook menjawab ok tanpa mengirim apa pun. */
async function telegramKirim_(env, chatId, teks) {
  const token = String(env.TELEGRAM_BOT_TOKEN || '');
  if (!token) return false;
  try {
    await fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: teks }),
      signal: AbortSignal.timeout(15000) });
    return true;
  } catch (e) { return false; }
}
async function telegramUnduhBerkas_(env, fileId) {
  const token = String(env.TELEGRAM_BOT_TOKEN || '');
  if (!token) return null;
  const info = await fetch('https://api.telegram.org/bot' + token +
    '/getFile?file_id=' + encodeURIComponent(fileId),
    { signal: AbortSignal.timeout(15000) });
  const j = await info.json().catch(() => ({}));
  if (!j.ok || !j.result || !j.result.file_path) return null;
  const unduh = await fetch('https://api.telegram.org/file/bot' + token + '/' + j.result.file_path,
    { signal: AbortSignal.timeout(60000) });
  if (!unduh.ok) return null;
  const buf = new Uint8Array(await unduh.arrayBuffer());
  return { bytes: buf, ukuran: j.result.file_size || 0 };
}
async function tanganiUpdateTelegram_(env, update, secretHeader) {
  const secret = String(env.TELEGRAM_WEBHOOK_SECRET || '');
  if (secret && secretHeader && secretHeader !== secret) {
    throw new Error('Secret webhook Telegram tidak cocok.');
  }
  const msg = (update && (update.message || update.edited_message)) || null;
  if (!msg) return { telegram: 'diabaikan', alasan: 'bukan pesan' };
  const chatId = String((msg.chat && msg.chat.id) || '');
  const chatPemilik = String(env.TELEGRAM_CHAT_ID || '');
  if (chatPemilik && chatId !== chatPemilik) {
    return { telegram: 'ditolak', alasan: 'chat bukan pemilik' };
  }
  const teks = bersihTeks_(msg.text || msg.caption, 4000);
  const berkas = [];
  try {
    const lampiran = msg.document || (msg.photo && msg.photo.length ? msg.photo[msg.photo.length - 1] : null);
    if (lampiran && lampiran.file_id) {
      const dl = await telegramUnduhBerkas_(env, lampiran.file_id);
      if (dl && dl.ukuran <= MAKS_UKURAN_BERKAS) {
        let b64 = '';
        const bin = dl.bytes;
        let s = '';
        for (let i = 0; i < bin.length; i++) s += String.fromCharCode(bin[i]);
        b64 = btoa(s);
        berkas.push({ nama: lampiran.file_name || 'lampiran-telegram',
          mime: lampiran.mime_type || 'application/octet-stream',
          type: lampiran.mime_type || '',
          base64: b64 });
      }
    }
  } catch (e) { /* lampiran gagal diunduh: teks tetap diproses */ }
  if (!teks && !berkas.length) {
    return { telegram: 'diabaikan', alasan: 'pesan kosong (voice note diproses di Batch 3)' };
  }
  const draf = await prosesJadiDraf_(env, { teks, tanggal: kunciTanggal_(new Date()),
    sumber: 'Telegram', berkas });
  const ringkas = draf.items.map((d, i) =>
    (i + 1) + '. ' + (d.uraian || '-') + (d.rhkId ? ' — RHK ' + d.rhkId : ' — belum terpetakan') +
    (d.jamLengkap ? ' (' + d.jamMulai + '–' + d.jamSelesai + ')' : ' — jam belum lengkap')).join('\n');
  await telegramKirim_(env, chatId, 'Draf Progresio (' + draf.drafId + '):\n' + ringkas +
    '\n\nBalas SIMPAN ' + draf.drafId + ' untuk mencatat, atau abaikan untuk membatalkan. (Alur bot lengkap: Batch 3)');
  return { telegram: 'draf-dibuat', drafId: draf.drafId, jumlahDraf: draf.jumlahDraf };
}

/* ===================== SINKRONISASI PWA <-> WORKER ======================= */
/* Kontrak sinkronisasi (sama seperti GAS):
   syncPush  masuk : {profil?, rhks?: [...], entri: [{clientId, tanggal,
             rhkId, aksi, jamMulai, jamSelesai, uraian, realisasi, jumlah,
             akses, sumber}, ...]}
             keluar: {hasilEntri: [{clientId, id, status, error?}, ...],
                      rhks: [...tersimpan], profil}
             Entri yang clientId-nya sudah ada DIPERBARUI (idempoten) —
             kirim ulang tidak menggandakan baris Log_Kerja.
             Tulis baris di-batch (satu values:batchUpdate + satu append)
             supaya hemat subrequest.
   syncPull  masuk : {dari?, sampai?}
             keluar: {profil, rhks, entri, waktuServer} untuk menimpa /
             menggabungkan data lokal PWA. Server adalah sumber kebenaran. */
/* ==================== PENGATURAN JADWAL (WFH / Ramadan / libur) ============ */
/* Jadwal tersimpan di Pengaturan_Sistem sebagai JSON (satu kunci per bagian)
   + stempel diubahPada untuk last-write-wins antar perangkat. PWA mengirim
   jadwal pada syncPush dan membaca jadwal dari syncPull. */
async function bacaJadwal_(env) {
  const baca = async (kunci) => {
    try { const v = JSON.parse(await ambilPengaturan_(env, kunci, '') || 'null'); return Array.isArray(v) ? v : null; }
    catch (e) { return null; }
  };
  const wfh = await baca('JADWAL_WFH');
  const ramadan = await baca('JADWAL_RAMADAN');
  const libur = await baca('JADWAL_LIBUR');
  if (wfh === null && ramadan === null && libur === null) return null;
  return { wfh: wfh || [], ramadan: ramadan || [], libur: libur || [],
    diubahPada: String(await ambilPengaturan_(env, 'JADWAL_DIUBAH', '') || '') };
}
async function simpanJadwal_(env, j) {
  if (!j || typeof j !== 'object') return false;
  const stempelBaru = String(j.diubahPada || '');
  if (!stempelBaru) return false;
  const stempelLama = String(await ambilPengaturan_(env, 'JADWAL_DIUBAH', '') || '');
  if (stempelLama && stempelBaru <= stempelLama) return false;
  if (Array.isArray(j.wfh)) await tulisPengaturan_(env, 'JADWAL_WFH', JSON.stringify(j.wfh), 'Hari WFH rutin (pengaturan Jadwal)');
  if (Array.isArray(j.ramadan)) await tulisPengaturan_(env, 'JADWAL_RAMADAN', JSON.stringify(j.ramadan), 'Periode Ramadan (pengaturan Jadwal)');
  if (Array.isArray(j.libur)) await tulisPengaturan_(env, 'JADWAL_LIBUR', JSON.stringify(j.libur), 'Hari libur dan cuti (pengaturan Jadwal)');
  await tulisPengaturan_(env, 'JADWAL_DIUBAH', stempelBaru, 'Stempel perubahan pengaturan Jadwal (last-write-wins)');
  return true;
}
async function sinkronDorong_(env, body) {
  const ctx = await muatKonteksLog_(env);
  const hasilEntri = [];
  const daftar = Array.isArray(body.entri) ? body.entri
    : (Array.isArray(body.entries) ? body.entries : []);
  for (const e of daftar) {
    const cid = String((e && (e.clientId || e.id)) || '');
    try {
      const simpan = await tulisEntriKeLog_(env, ctx, e, {});
      hasilEntri.push({ clientId: cid, id: simpan.id, status: 'tersimpan' });
    } catch (err) {
      hasilEntri.push({ clientId: cid, id: '', status: 'gagal', error: err.message || String(err) });
    }
  }
  await flushLog_(env, ctx);
  let rhksOut = null;
  if (Array.isArray(body.rhks) && body.rhks.length) {
    rhksOut = [];
    const tabelRhk = await muatTabel_(env, SHEET_RHK_, HEADER_RHK_);
    for (const r of body.rhks) rhksOut.push(await tulisSatuRhk_(env, r, tabelRhk));
  }
  let profilOut = null;
  if (body.profil) profilOut = await tulisProfil_(env, body.profil);
  let jadwalDisimpan = false;
  try { jadwalDisimpan = await simpanJadwal_(env, body.jadwal); } catch (e) { /* jadwal gagal simpan tidak boleh menggagalkan sinkron */ }
  try {
    await sheetsValuesUpdate_(env, `${SHEET_DASH_}!B7`, [[stempel_()]]);
  } catch (e) { /* dashboard boleh belum ada */ }
  return { hasilEntri, rhks: rhksOut, profil: profilOut, jadwal: { disimpan: jadwalDisimpan },
    waktuServer: stempel_(),
    ringkasan: { diterima: daftar.length,
      berhasil: hasilEntri.filter((h) => h.status === 'tersimpan').length } };
}
async function sinkronTarik_(env, body) {
  body = body || {};
  const dariSheet = await ambilPengaturan_(env, 'Model_Utama', '');
  const [profil, rhks, entri, arsip] = await Promise.all([
    bacaProfil_(env), bacaSemuaRhk_(env),
    bacaEntri_(env, { dari: body.dari, sampai: body.sampai }), bacaArsip_(env),
  ]);
  const jadwal = await bacaJadwal_(env);
  return { profil, rhks, entri, arsip, jadwal, waktuServer: stempel_(),
    modelUrutan: urutanModel_(env, dariSheet) };
}

/* ==================== SETUP DATABASE (sekali saja) ======================== */
/* Padanan buatDatabase() GAS, dipanggil sebagai action "setupDatabase"
   (wajib sesi login Google). Bila SPREADSHEET_ID sudah diisi, ia hanya
   MELENGKAPI spreadsheet itu (sheet/header/folder yang kurang). Bila belum
   diisi dan body.buatBaru === true, ia MEMBUAT spreadsheet Progresio_DB
   baru — salin ID-nya ke SPREADSHEET_ID lalu deploy ulang.
   Folder bulan dibuat malas (lazy) saat entri pertama bulan itu ditulis —
   setup hanya membuat tahun + 4 triwulan (hemat subrequest). */
async function sheetId_(env, namaSheet) {
  const meta = await gapiJson_(env,
    `${SHEETS_BASE}/${spreadsheetId_(env)}?fields=sheets.properties`);
  const sh = (meta.sheets || []).find((s) => s.properties && s.properties.title === namaSheet);
  return sh ? sh.properties.sheetId : null;
}
async function setupDatabase_(env, body) {
  body = body || {};
  let spreadsheetId = String(env.SPREADSHEET_ID || '').trim();
  let baru = false;
  if (!spreadsheetId) {
    if (!body.buatBaru) {
      throw new Error('SPREADSHEET_ID belum diisi — kirim {"action":"setupDatabase","buatBaru":true} untuk membuat database baru.');
    }
    const dibuat = await gapiJson_(env, SHEETS_BASE, { method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ properties: { title: NAMA_DB } }) });
    spreadsheetId = dibuat.spreadsheetId;
    baru = true;
  }
  const e = { ...env, SPREADSHEET_ID: spreadsheetId };
  const meta = await gapiJson_(e,
    `${SHEETS_BASE}/${spreadsheetId}?fields=sheets.properties,spreadsheetUrl`);
  const ada = new Set((meta.sheets || []).map((s) => s.properties.title));
  const defs = [
    { nama: SHEET_PROFIL_, header: HEADER_PROFIL_ },
    { nama: SHEET_RHK_, header: HEADER_RHK_ },
    { nama: SHEET_LOG_, header: HEADER_LOG_ },
    { nama: SHEET_ARSIP_, header: HEADER_ARSIP_ },
    { nama: SHEET_SET_, header: HEADER_SET_ },
  ];
  const tambah = [];
  for (const d of defs) if (!ada.has(d.nama)) tambah.push({ addSheet: { properties: { title: d.nama } } });
  if (!ada.has(SHEET_DASH_)) tambah.push({ addSheet: { properties: { title: SHEET_DASH_ } } });
  let balasTambah = [];
  if (tambah.length) {
    const r = await sheetsStrukturBatch_(e, tambah);
    balasTambah = r.replies || [];
  }
  // Header semua sheet (ditulis ulang — aman, baris 1 selalu header).
  const dataHeader = defs.map((d) => ({ range: `${d.nama}!A1:${kolomHuruf_(d.header.length)}1`,
    values: [d.header] }));
  dataHeader.push({ range: `${SHEET_DASH_}!A1:D1`,
    values: [['Metrik', 'Nilai', 'Rumus', 'Keterangan']] });
  await sheetsValuesBatchUpdate_(e, dataHeader);
  // Dashboard: rumus rekap (sama seperti GAS) + stempel + sembunyikan.
  const barisDash = [
    ['Total_Entri', '=COUNTA(Log_Kerja!A2:A)', 'COUNTA(Log_Kerja!A2:A)', 'Semua entri tercatat'],
    ['Entri_Bulan_Ini', '=COUNTIFS(Log_Kerja!D2:D,">="&DATE(YEAR(TODAY()),MONTH(TODAY()),1),Log_Kerja!D2:D,"<"&EDATE(DATE(YEAR(TODAY()),MONTH(TODAY()),1),1))', 'COUNTIFS tanggal bulan berjalan', 'Entri pada bulan berjalan'],
    ['Total_Durasi_Menit', '=SUM(Log_Kerja!M2:M)', 'SUM(Log_Kerja!M2:M)', 'Durasi selalu hasil hitung ulang dari jam'],
    ['Entri_BerEviden', '=COUNTIF(Log_Kerja!I2:I,"http*")', 'COUNTIF link bukti terisi', 'Entri dengan Link Bukti Dukung'],
    ['Jumlah_RHK_Aktif', '=COUNTIF(RHK_Config!K2:K,"YA")', 'COUNTIF RHK aktif', 'RHK yang sedang dipakai'],
    ['Terakhir_Diperbarui', '', '', 'Diisi skrip setiap buatDatabase()/sinkronisasi'],
  ];
  await sheetsValuesUpdate_(e, `${SHEET_DASH_}!A2:D7`,
    barisDash.map((r) => r.map(amanSel_)));
  await sheetsValuesUpdate_(e, `${SHEET_DASH_}!B7`, [[stempel_()]]);
  try {
    let idDash = null;
    for (const rep of balasTambah) {
      if (rep.addSheet && rep.addSheet.properties.title === SHEET_DASH_) {
        idDash = rep.addSheet.properties.sheetId;
      }
    }
    if (idDash === null) idDash = await sheetId_(e, SHEET_DASH_);
    if (idDash !== null) {
      await sheetsStrukturBatch_(e, [{ updateSheetProperties: {
        properties: { sheetId: idDash, hidden: true }, fields: 'hidden' } }]);
    }
  } catch (err) { /* sembunyikan dashboard itu opsional */ }
  // Baris profil perdana bila kosong.
  const tProfil = await muatTabel_(e, SHEET_PROFIL_, HEADER_PROFIL_);
  if (tProfil.lastRow < 2) {
    await sheetsValuesAppend_(e, `${SHEET_PROFIL_}!A1`,
      [['Ardian', '', '', '', '', '', '', '', String(env.OWNER_EMAIL || ''), ZONA_WAKTU, stempel_(), '', '']]);
  }
  // Pengaturan non-rahasia (rahasia TIDAK di sini — di Worker secrets).
  const setAwal = [
    ['Versi_Schema', '2.0-workers', 'Versi skema database Progresio'],
    ['Model_Utama', AI_MODELS[0], 'Model Gemini utama; failover mengikuti urutan Batch 1'],
    ['Pengingat_H-3', 'YA', 'Pengingat tenggat H-3 (dipakai Batch 3)'],
    ['Pengingat_H-1', 'YA', 'Pengingat tenggat H-1 (dipakai Batch 3)'],
    ['Dibuat_Pada', stempel_(), 'Waktu setupDatabase() terakhir dijalankan'],
  ];
  for (const r of setAwal) {
    if (!await ambilPengaturan_(e, r[0], '')) await tulisPengaturan_(e, r[0], r[1], r[2]);
  }
  // Pohon folder Drive (bulan dibuat malas saat entri pertama).
  const root = await folderRoot_(e);
  const eviden = await driveFolderAnak_(e, root.id, 'Eviden_Kinerja');
  await driveFolderAnak_(e, root.id, 'Template_Sistem');
  await driveFolderAnak_(e, root.id, 'Arsip_Laporan_Final');
  const th = await driveFolderAnak_(e, eviden.id, String(new Date().getFullYear()));
  for (const tw of ['Triwulan I', 'Triwulan II', 'Triwulan III', 'Triwulan IV']) {
    await driveFolderAnak_(e, th.id, tw);
  }
  if (baru) {
    try {
      const meta2 = await gapiJson_(e,
        `${SHEETS_BASE}/${spreadsheetId}?fields=sheets.properties`);
      const s1 = (meta2.sheets || []).find((s) => s.properties.title === 'Sheet1');
      if (s1) {
        await sheetsStrukturBatch_(e, [{ deleteSheet: { sheetId: s1.properties.sheetId } }]);
      }
    } catch (err) { /* Sheet1 bawaan boleh tetap ada */ }
  }
  return { spreadsheetId, spreadsheetUrl: meta.spreadsheetUrl ||
    ('https://docs.google.com/spreadsheets/d/' + spreadsheetId + '/edit'),
    folderRootId: root.id, baru };
}

/* ============================ ROUTER API ================================== */
/* Protokol PWA <-> Worker (sama seperti GAS, kecuali login):
   - GET  tanpa parameter            -> info API JSON (Worker tidak menyajikan
                                         aplikasi; PWA dibuka dari hostingnya)
   - GET  ?action=ping | status       (tanpa sesi, tetap JSON)
   - POST JSON {action:"loginGoogle", idToken:"..."} -> {ok, token, berlakuSampai}
   - POST JSON {action:"...", token:"...", ...} untuk semua action lain.
   - POST update Telegram (update_id tanpa action) -> webhook Batch 3.
   Balasan API selalu JSON {ok:true,...} atau {ok:false,error,kode}.
   Token sesi dibawa di body JSON (bukan header Authorization) — sama
   seperti GAS, supaya gasCall PWA tidak berubah. */
async function bacaBodyJson_(request) {
  const teks = await request.text();
  if (!teks) return {};
  const j = jsonParseAman_(teks);
  return (j && typeof j === 'object') ? j : {};
}
async function statusPing_(env) {
  let dbSiap = false;
  try {
    await gapiJson_(env, `${SHEETS_BASE}/${spreadsheetId_(env)}?fields=spreadsheetId`);
    dbSiap = true;
  } catch (e) { dbSiap = false; }
  const dariSheet = await ambilPengaturan_(env, 'Model_Utama', '');
  let folderDrive = null;
  try {
    const cfg = await idFolderDrive_(env);
    if (cfg) {
      try {
        const f = await driveGet_(env, cfg.id, 'id,name');
        folderDrive = { id: f.id, nama: f.name, sumber: cfg.sumber };
      } catch (e) {
        folderDrive = { id: cfg.id, sumber: cfg.sumber, galat: 'tidak bisa diakses' };
      }
    }
  } catch (e) { /* abaikan */ }
  return { layanan: 'Progresio Workers Backend', batch: 'Batch 2 (Workers)',
    waktuServer: stempel_(), databaseSiap: dbSiap,
    loginGoogle: true, pinTerpasang: false,
    geminiTerisi: !!kunciGemini_(env),
    modelUrutan: urutanModel_(env, dariSheet),
    folderDrive: folderDrive,
    aplikasiTersaji: false,
    catatan: 'Backend Workers aktif. Buka aplikasi (PWA) dari hosting mandirinya; ?action=ping tetap JSON ini.' };
}
async function jalankanAction_(env, action, body) {
  switch (action) {
    case 'logout':
      // Sesi stateless (JWT): server tidak menyimpan apa pun — klien buang token.
      return { pesan: 'Sesi ditutup.' };
    case 'setModelUtama': {
      const m = String(body.model || '');
      if (!AI_MODELS.includes(m)) {
        throw new Error('Model tidak dikenal. Pilihan: ' + AI_MODELS.join(', '));
      }
      await tulisPengaturan_(env, 'Model_Utama', m, 'Model Gemini utama; failover mengikuti urutan Batch 1');
      return { modelUtama: m, urutan: urutanModel_(env, m) };
    }
    case 'getProfil': return { profil: await bacaProfil_(env) };
    case 'saveProfil': return { profil: await tulisProfil_(env, body.profil || body) };
    case 'getRhk': return { rhks: await bacaSemuaRhk_(env) };
    case 'saveRhk': return { rhk: await tulisSatuRhk_(env, body.rhk || body) };
    case 'saveSemuaRhk': {
      const out = [];
      const tabelRhk = await muatTabel_(env, SHEET_RHK_, HEADER_RHK_);
      for (const r of (body.rhks || [])) out.push(await tulisSatuRhk_(env, r, tabelRhk));
      return { rhks: out };
    }
    case 'simpanEntri': {
      const ctx = await muatKonteksLog_(env);
      const entri = await tulisEntriKeLog_(env, ctx, body.entri || body, {});
      await flushLog_(env, ctx);
      return { id: entri.id, entri, status: 'tersimpan' };
    }
    case 'updateEntri': {
      const ctx = await muatKonteksLog_(env);
      const upd = await tulisEntriKeLog_(env, ctx, body.entri || body,
        { idLog: body.id || (body.entri && body.entri.id) });
      await flushLog_(env, ctx);
      return { id: upd.id, entri: upd, status: 'diperbarui' };
    }
    case 'hapusEntri': {
      const t = await muatTabel_(env, SHEET_LOG_, HEADER_LOG_);
      const barisH = cariBarisLog_(t.rows, String(body.id || ''));
      if (!barisH) throw new Error('Entri tidak ditemukan.');
      const sid = await sheetId_(env, SHEET_LOG_);
      if (sid === null) throw new Error('Sheet Log_Kerja tidak ditemukan.');
      await sheetsStrukturBatch_(env, [{ deleteDimension: { range: {
        sheetId: sid, dimension: 'ROWS',
        startIndex: barisH._baris - 1, endIndex: barisH._baris } } }]);
      return { status: 'terhapus', id: String(body.id || '') };
    }
    case 'getEntri':
      return { entri: await bacaEntri_(env, { dari: body.dari, sampai: body.sampai, rhkId: body.rhkId }) };
    case 'prosesAi': // teks -> draf (BELUM masuk Log_Kerja)
      return await prosesJadiDraf_(env, body);
    case 'konfirmasiDraf': {
      const k = await konfirmasiDraf_(env, String(body.drafId || ''),
        body.items || null, body.drafItems || null);
      return k;
    }
    case 'batalDraf':
      await hapusDraf_(env, String(body.drafId || ''));
      return { status: 'dibatalkan' };
    case 'uploadEviden': {
      const up = await unggahEviden_(env, String(body.idLog || body.id || ''), body.berkas || body);
      return up;
    }
    case 'catatEviden': {
      const ct = await catatEviden_(env, String(body.idLog || body.id || ''), body.berkas || body);
      return ct;
    }
    case 'siapkanFolder': {
      const sf = await siapkanFolder_(env, String(body.idLog || body.id || ''));
      return sf;
    }
    case 'setAksesEntri':
      return await aturAksesEntri_(env, String(body.idLog || body.id || ''),
        String(body.akses || 'link') === 'privat' ? 'privat' : 'link');
    case 'tutupAkses':
      return await tutupAksesEntri_(env, String(body.idLog || body.id || ''));
    case 'listFolderTerbuka':
      return { folderTerbuka: await daftarFolderTerbuka_(env) };
    case 'getAkunTepercaya':
      return { akunTepercaya: await akunTepercaya_(env), maks: MAKS_AKUN_TEPECAYA };
    case 'setAkunTepercaya': {
      const daftar = (Array.isArray(body.akunTepercaya) ? body.akunTepercaya : [])
        .map((s) => String(s).toLowerCase().trim())
        .filter((s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s));
      if (daftar.length > MAKS_AKUN_TEPECAYA) {
        throw new Error('Akun tepercaya maksimal ' + MAKS_AKUN_TEPECAYA + '.');
      }
      await tulisPengaturan_(env, 'Akun_Tepercaya', JSON.stringify(daftar),
        'Email yang boleh melihat folder eviden Privat');
      return { akunTepercaya: daftar };
    }
    case 'tesFolderDrive': {
      // Baca-saja: periksa tempelan tanpa menyimpan.
      const info = await periksaFolderDrive_(env, body.folderUrl || body.folderId || body.nilai || '');
      return { folderDrive: info };
    }
    case 'simpanFolderDrive': {
      // Tempelan pengguna: URL folder Drive atau ID polos. Kosongkan
      // untuk kembali ke ID environment.
      const mentah = String(body.folderUrl || body.folderId || body.nilai || '');
      if (!mentah.trim()) {
        await tulisPengaturan_(env, 'DRIVE_ROOT_FOLDER_ID', '', 'Folder utama Progresio di Drive (ditempel pengguna; kosong = pakai ID environment)');
        return { folderDrive: null, pesan: 'Pengaturan folder Drive dikosongkan — kembali memakai ID environment.' };
      }
      const info = await periksaFolderDrive_(env, mentah);
      await tulisPengaturan_(env, 'DRIVE_ROOT_FOLDER_ID', info.id, 'Folder utama Progresio di Drive (ditempel pengguna)');
      return { folderDrive: info, pesan: 'Folder Drive disimpan: ' + info.nama };
    }
    case 'simpanArsip': return await simpanArsipLaporan_(env, body.arsip || body);
    case 'listArsip': return { arsip: await bacaArsip_(env) };
    case 'syncPush': return await sinkronDorong_(env, body);
    case 'syncPull': return await sinkronTarik_(env, body);
    case 'tesGemini': {
      const meta = await tesGeminiServer_(env);
      return { model: meta.model, ms: meta.ms, http: meta.http,
        pesan: 'Kunci aktif — Gemini menjawab lewat ' + meta.model + ' (' + meta.ms + ' md).' };
    }
    case 'setupDatabase': return await setupDatabase_(env, body);
    case 'statusServer': {
      let dbSiap = false;
      try {
        await gapiJson_(env, `${SHEETS_BASE}/${spreadsheetId_(env)}?fields=spreadsheetId`);
        dbSiap = true;
      } catch (e) { dbSiap = false; }
      const dariSheet = await ambilPengaturan_(env, 'Model_Utama', '');
      const t = await muatTabel_(env, SHEET_LOG_, HEADER_LOG_);
      const terbukaTercatat = t.rows.filter((r) => r.Folder_Eviden_ID &&
        String(r.Akses_Eviden || 'link') !== 'privat').length;
      return { databaseSiap: dbSiap, loginGoogle: true, pinTerpasang: false,
        geminiTerisi: !!kunciGemini_(env), modelUrutan: urutanModel_(env, dariSheet),
        diagnosisAi: await ambilPengaturan_(env, 'Diagnosis_AI_Terakhir', ''),
        folderTerbuka: terbukaTercatat, waktuServer: stempel_() };
    }
    default:
      throw new Error('Action tidak dikenal: ' + action);
  }
}
async function tanganiGet_(request, env, url) {
  const action = url.searchParams.get('action') || '';
  if (!action || action === 'app') {
    return hasilOk_({ layanan: 'Progresio Workers Backend',
      catatan: 'Worker ini hanya API JSON. Buka aplikasi Progresio (PWA) dari hosting mandirinya, lalu isi URL Worker ini di Pengaturan › Koneksi GAS.',
      ping: '?action=ping' }, request, env);
  }
  if (action === 'ping' || action === 'status') {
    return hasilOk_(await statusPing_(env), request, env);
  }
  const sesi = await verifikasiTokenSesi_(env, url.searchParams.get('token') || '');
  if (!sesi) {
    return hasilGagal_('Sesi tidak sah / sudah berakhir. Masuk lagi dengan Google.', 'SESI', request, env);
  }
  try {
    if (action === 'getProfil') return hasilOk_({ profil: await bacaProfil_(env) }, request, env);
    if (action === 'getRhk') return hasilOk_({ rhks: await bacaSemuaRhk_(env) }, request, env);
    if (action === 'getEntri') {
      return hasilOk_({ entri: await bacaEntri_(env, { dari: url.searchParams.get('dari'),
        sampai: url.searchParams.get('sampai'), rhkId: url.searchParams.get('rhkId') }) }, request, env);
    }
    if (action === 'listFolderTerbuka') {
      return hasilOk_({ folderTerbuka: await daftarFolderTerbuka_(env) }, request, env);
    }
    if (action === 'listArsip') return hasilOk_({ arsip: await bacaArsip_(env) }, request, env);
    if (action === 'getAkunTepercaya') {
      return hasilOk_({ akunTepercaya: await akunTepercaya_(env), maks: MAKS_AKUN_TEPECAYA }, request, env);
    }
    return hasilGagal_('Action GET tidak dikenal: ' + action, 'ACTION', request, env);
  } catch (err) {
    return hasilGagal_(err.message || String(err), 'SERVER', request, env);
  }
}
async function tanganiPost_(request, env, url) {
  const body = await bacaBodyJson_(request);
  // Folder utama dari aplikasi (tempelan pengguna, dikirim pada setiap
  // panggilan sebagai driveRootFolderId): dipakai folderRoot_ untuk
  // request ini saja. Selalu direset di sini supaya tidak ada sisa
  // dari request sebelumnya.
  env._driveRootFolderId = idFolderDari_(body && body.driveRootFolderId);
  // Webhook Telegram: update Telegram tidak punya field "action" kita,
  // tapi punya update_id + message.
  if (body && body.update_id !== undefined && !body.action) {
    const msgT = body.message;
    const teksT = msgT && msgT.text ? String(msgT.text).trim() : '';
    const cocokSimpan = teksT.match(/^SIMPAN\s+(\S+)$/i);
    if (cocokSimpan) {
      const chatPemilik = String(env.TELEGRAM_CHAT_ID || '');
      const chatIdT = String((msgT.chat && msgT.chat.id) || '');
      if (chatPemilik && chatIdT !== chatPemilik) return hasilOk_({ telegram: 'ditolak' }, request, env);
      const hasil = await konfirmasiDraf_(env, cocokSimpan[1], null, null);
      await telegramKirim_(env, chatIdT, 'Tersimpan: ' + hasil.tersimpan + ' entri masuk Log_Kerja.');
      return hasilOk_({ telegram: 'tersimpan', jumlah: hasil.tersimpan }, request, env);
    }
    const secretHeader = request.headers.get('X-Telegram-Bot-Api-Secret-Token') ||
      url.searchParams.get('secret') || '';
    try {
      const r = await tanganiUpdateTelegram_(env, body, secretHeader);
      return hasilOk_(r, request, env);
    } catch (e) {
      return hasilGagal_(e.message || String(e), 'WEBHOOK_SECRET', request, env);
    }
  }
  const action = String(body.action || '');
  if (!action) return hasilGagal_('Field "action" wajib ada.', 'ACTION', request, env);
  try {
    if (action === 'loginGoogle') {
      const info = await verifikasiIdToken_(env, body.idToken || body.id_token || '');
      const sesi = await buatTokenSesi_(env, info.email, info.sub);
      const profil = await bacaProfil_(env);
      return hasilOk_({ token: sesi.token, berlakuSampai: sesi.berlakuSampai,
        sesiJam: SESI_JAM, profil, email: info.email }, request, env);
    }
    // Login PIN GAS tidak ada di Worker — PIN dipensiunkan (keputusan 2026-11-26).
    if (action === 'login' || action === 'gantiPin') {
      return hasilGagal_('PIN sudah dipensiunkan — masuk memakai akun Google (action "loginGoogle").',
        'PIN_PENSIUN', request, env);
    }
    const sesi = await verifikasiTokenSesi_(env, body.token || '');
    if (!sesi) {
      return hasilGagal_('Sesi tidak sah / sudah berakhir. Masuk lagi dengan Google.', 'SESI', request, env);
    }
    const hasil = await jalankanAction_(env, action, body);
    return hasilOk_(hasil, request, env);
  } catch (err) {
    const kode = err.kode || (err.http === 429 ? 'KUOTA' : 'SERVER');
    return hasilGagal_(err.message || String(err), kode, request, env);
  }
}

export default {
  async fetch(request, env, ctx) {
    try {
      if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: headerCors_(request, env) });
      }
      if (!rateLimitLolos_(request)) {
        return hasilGagal_('Terlalu banyak permintaan — coba lagi sebentar lagi.',
          'RATE_LIMIT', request, env, 429);
      }
      const url = new URL(request.url);
      if (request.method === 'GET') return tanganiGet_(request, env, url);
      if (request.method === 'POST') return tanganiPost_(request, env, url);
      return hasilGagal_('Method tidak didukung.', 'METHOD', request, env, 405);
    } catch (err) {
      return hasilGagal_(err.message || String(err), 'SERVER', request, env);
    }
  },
};
