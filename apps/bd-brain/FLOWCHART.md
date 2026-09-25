# Business Development Acquisition Flow by AI Agent — MCNASIA 2026

Analisa whiteboard Canva **"FLOWCART BD AKUSISI BY AI AGENT MCNASIA 2026"**
Sumber: https://www.canva.com/design/DAHPRPHlIV0/pRGRITwEaWYdjIATpvlE2A/view
*(link tanpa `/view` menghasilkan 404)*

---

## 1. Model Inti: Tiga Keadaan

Seluruh whiteboard — dua layer, puluhan node — sebenarnya hanya satu mesin dengan
**tiga keadaan**:

| Keadaan | Artinya | Arah |
|---|---|---|
| ✅ **ACCEPTANCE** | Brand bersedia meeting | → jadwalkan → `END` |
| ❌ **REJECTION** | Brand menolak | → satu penyelamatan → `STOP` |
| 🔁 **FOLLOW-UP** | Brand diam atau menunda | → tunggu timer → tanya lagi |

**Kunci pemahamannya:** *follow-up bukan hasil akhir — follow-up adalah penundaan.*
Hanya ada **dua pintu keluar**: acceptance dan rejection. Follow-up adalah loop yang
menunggu, lalu mengulang pertanyaan accept/reject yang sama.

```
                 ┌─────────────────────────┐
                 │   Pertanyaan yang sama  │
                 │  "Mau meeting nggak?"   │
                 └────────────┬────────────┘
                              │
        ┌─────────────────────┼─────────────────────┐
        ↓                     ↓                     ↓
   ACCEPTANCE            FOLLOW-UP              REJECTION
        │                     │                     │
        ↓                     │ tunggu timer        ↓
   SETUP GMEET                │                 company profile
        ↓                     └────────┐            ↓
     MEETING                           │        promo H+5
        ↓                              │            ↓
       END                             └──────→   STOP
                                    (balik ke atas)
```

Tiga konsekuensi dari model ini, dan semuanya terlihat di board:

1. **"Closing gadget" berulang 6×** — itu bukan 6 cabang berbeda, itu percabangan
   accept/reject itu sendiri. Setiap intent akhirnya harus kembali ke sana.
2. **Hanya 2 dari 9 jalur berakhir STOP** — board sengaja enggan menyebut sesuatu
   sebagai penolakan. Diam, menunda, "saya pelajari dulu" semuanya dibaca *belum*,
   bukan *tidak*.
3. **Loop tidak pernah berhenti** — tidak ada aturan yang mengubah follow-up menjadi
   rejection setelah N kali. Ini bug utama board ini. Lihat §6.1.

---

## 2. 🔁 FOLLOW-UP — Mesin Penundaan

Ini bagian terbesar board, dan satu-satunya yang punya timer. Ada **empat track
follow-up terpisah**, masing-masing untuk situasi berbeda. Jangan disatukan jadi satu
counter global.

### 2.1 Track A — Cold ladder (belum pernah balas sama sekali)

Satu-satunya track yang **punya aturan decay yang benar**: tiga anak tangga, lalu menyerah.

```
BLASTING
   ↓
CLIENT RESPON? ──YES──┐
   │ NO               │
FOLOW UP-KE1          │   max 4 jam after blasting, hari yg sama
   ↓                  │
CLIENT RESPON? ──YES──┤
   │ NO               │
FOLOW UP-KE2          │   H+1
   ↓                  │
CLIENT RESPON? ──YES──┤
   │ NO               │
FOLOW UP-KE3          │   H+5
   ↓                  │
CLIENT RESPON? ──YES──┘
   │ NO               ↓
 STOP ❌     TANYA JAWAB DENGAN CLIENT
   (rejection)         (acceptance ke fase tanya jawab)
```

Semua cabang YES konvergen ke **satu node `YES`**. Begitu brand membalas di tahap
manapun, ladder dibatalkan dan counter tidak dilanjutkan.

> 🐞 Anotasi KE-2 dan KE-3 dua-duanya tertulis *"jika belum respon di followup ke 1"*.
> Untuk KE-3 hampir pasti maksudnya "followup ke-2". Interpretasi paling masuk akal:
> H+1 dan H+5 dihitung dari **blasting**.

### 2.2 Track B — Cold, layer Knowledge (`NO RESPONS`)

Versi isi-pesan dari Track A. Hanya dua langkah, lalu masuk ke closing gadget:

```
NO RESPONS
   ↓
Followup (H0 – Pukul 16.00)   📎 PDF: Company Profile McnAsia.Biz
   ↓                              angle: EMPATI — "memahami jika Kakak sedang sibuk"
Followup D3
   ↓                              angle: SOCIAL PROOF — "kami telah membantu berbagai brand…"
Respon Brand → [closing gadget §3.1]
```

### 2.3 Track C — Warm stall (sudah pernah balas, lalu berhenti)

Dipakai oleh semua intent yang sifatnya menunda. Nadanya berbeda dari Track A/B —
selalu mereferensi percakapan sebelumnya.

```
FOLLOWUP-D2  →  FOLLOWUP-D5  →  Respon Brand  →  [closing gadget §3.1]
```

| Tahap | Angle |
|---|---|
| `FOLLOWUP-D2` | Mendesak — tindak lanjut price list / koordinasi tim, ajak meeting 15–30 menit, **terbuka untuk penyesuaian paket & budget**, minta feedback hari ini |
| `FOLLOWUP-D5` | Melepas tekanan — "apakah sudah sempat diskusi dengan tim?", "jika masih review, tidak masalah" |

> Urutan ini terbalik dari intuisi (mendesak dulu, melunak kemudian) — kemungkinan
> disengaja agar tidak terkesan memaksa di akhir.

### 2.4 Track D — Menunda meeting & no-show

Dua sub-track di layer atas, keduanya berakhir `STOP` bila habis:

```
AJAK METING? → MENUNDA
   ↓
FOLOW H+1  → CLIENT RESPON? ──YES──→ SETUJU UNTUK MEETING? ┈┈→ SETUJU ✅
   │ NO
FOLOW UP H+3 → CLIENT RESPON? ──YES──→ SETUJU ✅
   │ NO
 STOP ❌
```

```
HARI H → CLIENT JOIN MEETING? ──YES──→ MEETING BERJALAN → END ✅
   │ NO
FOLOW UP 1  → CLIENT RESPON? ──YES──┐
   │ NO                             │
FOLOW UP 2  → CLIENT RESPON? ──YES──┤
   │ NO                             └┈┈→ SETUJU (reschedule) ✅
 STOP ❌
```

No-show yang akhirnya membalas **tidak diperlakukan sebagai prospek baru** — dia masuk
kembali ke mesin penjadwalan yang sama lewat loop-back garis putus-putus.

### 2.5 Semua timer dalam satu tabel

| Timer | Delay | Dihitung dari | Track |
|---|---|---|---|
| `FU_KE1` | 4 jam (hari sama) | blasting | A |
| `FU_KE2` | H+1 | blasting | A |
| `FU_KE3` | H+5 | blasting | A |
| `NORESP_H0` | hari sama, 16:00 | blasting | B |
| `NORESP_D3` | H+3 | H0 | B |
| `FU_D2` | H+2 | respon terakhir | C |
| `FU_D5` | H+5 | D2 | C |
| `MENUNDA_H1` | H+1 | respon terakhir | D |
| `MENUNDA_H3` | H+3 | followup terakhir | D |
| `NOSHOW_1` | H+1 | respon terakhir | D |
| `NOSHOW_2` | H+2 | followup terakhir | D |
| `REMINDER` | T−30 menit | jadwal meeting | — |

---

## 3. ✅ ACCEPTANCE — Jalur Menuju Meeting

### 3.1 Titik keputusan: closing gadget

Pola ini muncul **6× identik** di layer Knowledge. Ini adalah percabangan
accept/reject yang sesungguhnya — tulis **satu** fungsi, bukan enam.

```
Respon BD: "Agar lebih detail, jika berkenan kita bisa diskusi singkat 20–30 menit…"
        │
        ├── "Ok baik ak"    ✅ → SETUP GMEET → [Meet invite] → REMINDER 30 menit
        │
        └── "Nanti aja kak" 🔁 → FOLLOWUP-D2 → FOLLOWUP-D5 → Respon Brand ─┐
                                                                           │
                        └──────────── balik ke Respon BD ──────────────────┘
```

Diverifikasi identik pada: `BRAND RESPON KE-1`, `BRAND RESPON KE-2`, `RESPON KE-2`,
jalur `Respon Brand` dari Track B, Track C, dan cabang `Followup H+1`.

### 3.2 Semua jalur yang bermuara ke SETUP GMEET

```
Boleh ───────────────────────────────────────→ SETUP GMEET
Sistem nya bagaimana? → Brand Respon KE-1/2 → [gadget] → SETUP GMEET
Harganya berapa? → BD-1 → BD-2 → Brand Respon → [gadget] → SETUP GMEET
Teruskan ke team → D2 → D5 → Respon Brand → [gadget] → SETUP GMEET
Pelajari dulu → RESPON KE-2 → D2 → D5 → [gadget] → SETUP GMEET
Terimakasih penawarannya → H+1 → Respon Brand → [gadget] → SETUP GMEET
NO RESPONS → H0 → D3 → Respon Brand → [gadget] → SETUP GMEET
```

Tidak ada jalur yang closing penjualan lewat chat. Harga disebut, paket dijelaskan,
tapi setiap cabang positif selalu berakhir di meeting. **Chat = alat kualifikasi
menuju meeting, bukan alat closing.**

### 3.3 Mesin penjadwalan (dipakai bersama semua jalur)

```
                    SETUJU
                      │
         ┌────────────┴────────────┐
         ↓                         ↓
CLIEN MENENTUKAN JADWAL   BD - CONFIRMASI JADWAL
         └────────────┬────────────┘
                      ↓
        ┌─────────────────────────────┐
        │  CEK GOOGLE CALENDER        │   ← selalu dilakukan, apapun cabangnya
        │  TAWARKAN 2 OPSI WAKTU      │   09:00 atau 13:00 (ex)
        │  POSSIBLE JAM 15:00         │   cadangan
        └─────────────┬───────────────┘
                      ↓
              KONFIRMASI JADWAL
                      ↓
             INPUT GOOGLE CALENDER
                      ↓
             GENERATE GOOGLE MEET
                      ↓
              KIRIM INVITE MEETING
                      ↓
        ┌─────────────┴─────────────┐        ← paralel
        ↓                           ↓
SHARE & CONFIRM KE CLIENT    SHARE KE GROUP BD
        └─────────────┬─────────────┘
                      ↓
                   HARI H
                      ↓
      REMINDER 30 MENIT SEBELUM JADWAL MEET
                      ↓
              CLIENT JOIN MEETING?  → §2.4
```

Kedua cabang penjadwalan **bertemu di grup box yang sama** — cek kalender bukan milik
salah satu cabang saja. Fan-out ke klien dan ke group BD berjalan bersamaan.

---

## 4. ❌ REJECTION — Jalur Menuju STOP

Hanya **2 dari 9 intent** yang diklasifikasi sebagai penolakan, dan keduanya tetap
diberi satu percobaan penyelamatan sebelum ditutup:

```
"gak dulu kak?"        → Respon BD: "Tidak apa-apa" + company profile ─┐
"Maaf belum Tertarik"  → Respon BD: "Semoga di lain kesempatan"  ──────┤
                                                                       ↓
                                                          Followup H+5 (PROMO)
                                                          100 creator / Rp10jt
                                                          "kuota terbatas"
                                                                       ↓
                                                                    STOP ❌
```

Perhatikan pergeseran nada: dari *consultative* menjadi *discount-led*. Promo dipakai
sebagai **last-resort re-engagement**, bukan pembuka.

Jalur rejection lain (kehabisan follow-up) ada di §2.1 dan §2.4.

---

## 5. Knowledge & Behaviour — Isi Pesan

### 5.1 Pesan pembuka (Blasting)

> Siang kak kenalin aku Grrece dari Business Development MCNAsia.biz, Official Partner
> TikTok & shopee yang menghandle akun official brand Besar, Menengah, dan UMKM.
>
> Saat ini kami handel brand besar seperti Unilever, Mondelez, Ultramilk, Anker,
> Kintakun, dan GAGA, dengan rata-rata GMV di 1–2 milliar rupiah perbulan.
>
> Serta memiliki pengalaman di kategori F&B, Beauty, Mom & Kids, Home Living, Fashion,
> Healty dan lainnya.
>
> Aku ingin menawarkan kerja sama Campaign Affiliate untuk membantu meningkatkan
> awareness dan penjualan brand kakak. Detail penawaran kami sudah aku lampirkan dalam
> proposal beserta laporan perkembangan affiliate GAGA ya ka.
>
> Jika berkenan, boleh aku arrange online meeting untuk diskusi lebih lanjut ya kak? 😊

Struktur retoris: **kredensial → social proof (brand besar + angka GMV) → jangkauan
kategori → penawaran → ajakan meeting**. Ajakan meeting sudah ada di pesan pertama.

### 5.2 Delapan intent, dipetakan ke tiga keadaan

| # | Intent brand | Keadaan | Next |
|---|---|---|---|
| 1 | "Boleh" | ✅ | SETUP GMEET |
| 2 | "Sistem nya Bagaimana?" | 🔁 | penjelasan model → Brand Respon KE-1/2 → gadget |
| 3 | "Harganya berapa yah?" | 🔁 | BD-1 → BD-2 → gadget |
| 4 | "Ok kak, aku teruskan ke team" | 🔁 | FOLLOWUP-D2 → D5 |
| 5 | "Nanti aja kak, saya pelajari dulu" | 🔁 | RESPON KE-2 → D2 → D5 |
| 6 | "Terimakasih Penawarannya.." | 🔁 | Followup H+1 → Respon Brand → gadget |
| 7 | "gak dulu kak?" | ❌ | Followup H+5 → STOP |
| 8 | "Maaf belum Tertarik" | ❌ | Followup H+5 → STOP |

Intent #3 adalah **satu-satunya yang bertanya balik**. Semua intent lain langsung
diarahkan; hanya di pertanyaan harga agent melakukan kualifikasi sebelum
merekomendasikan paket.

`Followup H+1` (intent #6) berisi menu kebutuhan: Affiliate Campaign / Ads Management
(TikTok & Meta) / koneksi Mega Creator & KOL / layanan digital commerce lain.
**Catatan: ini bukan bagian dari track NO RESPONS.**

### 5.3 Eskalasi harga dua tingkat

- **Respon BD-1** — *anchor kabur*: "mulai dari Rp15 jutaan", + pertanyaan kualifikasi
  (awareness, sales, atau keduanya?). Price list belum dibuka.
- **Respon BD-2** — *price list penuh*, baru dikirim jika brand tetap menekan.

| Paket | Harga / bulan | Akun affiliate | Min. video |
|---|---|---|---|
| **Basic** | Rp 15.000.000 | 150 | 150 |
| **Growth** | Rp 25.000.000 | 300 | 300 |
| **Massive** | Rp 45.000.000 | 500 | 500 |
| *Promo (rejection only)* | *Rp 10.000.000* | *100* | *100* |

Semua paket konsisten **Rp100.000 per akun affiliate** — termasuk promo. Jadi promo
bukan diskon unit, melainkan **paket entry yang lebih kecil**.

**Diferensiasi vs agensi lain (disebut di BD-2):**
- Filter affiliate sesuai kebutuhan brand
- Monitoring harian status sample (on delivery / sudah diterima affiliate)
- Follow up affiliate agar segera upload konten
- Monitoring harian view, like, komen, GMV
- Bantu penulisan script & storyboard bila brand belum punya
- Pengelolaan akun aktif untuk affiliate berperforma tinggi
- Affiliate berperforma bagus diajak kerja sama lagi bulan berikutnya

### 5.4 Template operasional

- **SETUP GMEET** — *"Berikut ya ka untuk link meeting nya, see you ka 🙏🤗"*,
  disertai screenshot Google Calendar berisi detail Meet
- **REMINDER** — dikirim **30 menit sebelum** jadwal
- **Company Profile PDF** — dipakai di H0 dan di semua cabang rejection sebagai
  "hadiah perpisahan"

---

## 6. Celah & Risiko

### 6.1 🔴 Follow-up tidak pernah menjadi rejection

Ini konsekuensi langsung dari model §1: hanya acceptance dan rejection yang menjadi
pintu keluar, tapi **closing gadget tidak punya aturan decay**.

`Nanti aja` → D2 → D5 → Respon Brand → Respon BD → `Nanti aja` → … tak terbatas.

Track A punya aturan ini dengan benar (3 anak tangga lalu STOP). Layer Knowledge tidak.
**Perbaikan: terapkan aturan yang sama — max 2 putaran gadget, lalu paksa `STOP`.**

### 6.2 🟠 Tidak ada fallback untuk intent tak dikenal

Hanya 8 intent yang dipetakan. Balasan nyata seperti *"kirim proposal dulu"*,
*"nomor ini siapa?"*, *"STOP"*, atau pertanyaan teknis tidak punya jalur.
Perlu default: eskalasi ke manusia.

### 6.3 🟠 Tidak ada jalur handover ke manusia

Tidak ada node "serahkan ke BD manusia" di manapun. Untuk bot yang menyentuh brand
sekelas Unilever, ini biasanya wajib.

### 6.4 🟡 Nama hardcoded

Template blasting menyebut **"Grrece"** (kemungkinan typo dari "Grace"); satu template
FOLLOWUP-D2 menyebut **"Kak Cika"** — nama penerima spesifik yang harus jadi variabel.

### 6.5 🟡 Anotasi timer KE-2/KE-3 bertentangan

Lihat §2.1. Perlu konfirmasi ke pemilik proses.

### 6.6 🟡 Tidak ada jam kerja / rate limit

Semua timer berbasis hari. Tidak ada aturan "jangan kirim akhir pekan / malam", dan
tidak ada batas volume blasting — padahal WhatsApp memblokir nomor yang blasting agresif.

---

## 7. Implementasi

### 7.1 Komponen

| Komponen | Tanggung jawab |
|---|---|
| **State machine** | 3 keadaan (§1) + node transisi. Simpan `current_state` & `current_node` per kontak. |
| **Scheduler** | 12 timer di §2.5 |
| **Intent classifier** | 8 intent (§5.2) → acceptance / rejection / follow-up + fallback |
| **Template renderer** | Bank pesan dengan slot `{nama}` |
| **Google Calendar + Meet** | Cek slot, buat event, generate link |
| **Notifier internal** | Broadcast invite ke group BD |
| **Asset store** | PDF Company Profile |

### 7.2 Invariant

1. **Balasan apapun membatalkan semua timer pending** untuk kontak itu.
2. **Counter follow-up reset** setiap brand merespon.
3. **Setiap track follow-up punya batas maksimum** lalu decay ke rejection — termasuk
   closing gadget (§6.1).
4. `SETUP GMEET` hanya dieksekusi setelah slot kalender terverifikasi kosong.
5. Empat track follow-up (§2) **dihitung terpisah**, jangan pakai satu counter global.

---

## 8. Penilaian

**Kuat sebagai playbook sales:** funnel koheren dengan satu tujuan jelas (meeting),
satu subroutine closing yang dipakai ulang, pemisahan cold vs warm follow-up yang tepat,
eskalasi harga dua tingkat yang cerdas, dan penolakan tetap diberi satu penyelamatan.

**Belum siap sebagai spesifikasi teknis:** follow-up tidak pernah decay ke rejection,
tidak ada fallback intent, tidak ada handover manusia, tidak ada aturan jam kirim.
Perlu satu lapisan keputusan teknis sebelum bisa dijadikan bot.
