# VAL / Instalock

GUI web **lokal dan ringan** untuk memilih agent VALORANT. Python + HTML/CSS/JavaScript vanilla; tanpa Electron, React, Node, database, atau proses build. Backend memakai server bawaan Python, dan `requests` hanya diperlukan untuk mode live.

> Proyek komunitas, tidak berafiliasi dengan Riot Games. Lock tidak dijamin berhasil. Gunakan dengan mempertimbangkan aturan game dan kenyamanan sesama pemain.

## Jalankan di Windows

1. Pasang **Python 3.10 atau lebih baru** dari [python.org](https://www.python.org/downloads/). Saat instalasi, centang **Add Python to PATH**.
2. Buka folder proyek di Terminal/Command Prompt:

   ```bat
   python -m pip install -r requirements.txt
   python val.py
   ```

3. Browser terbuka di `http://127.0.0.1:8765`. Buka VALORANT dan login sampai lobby.
4. Pilih agent, pilih region akun (**AP** untuk Asia Pacific), lalu klik **Mulai instalock**.
5. Masuk queue seperti biasa. Aplikasi menunggu fase pemilihan agent, lalu mengirim satu permintaan lock.
6. Klik **Hentikan proses** untuk berhenti menunggu. `Ctrl+C` di terminal menutup aplikasi.

Alternatif: klik dua kali `run.bat`. Script memeriksa Python dan memasang dependency bila belum tersedia.

**Mode live membutuhkan Windows dan Riot Client yang sedang login.** Tidak ada input password. Kredensial dari lockfile dipakai di memori untuk permintaan ke client lokal, tidak dikirim ke browser atau ditulis ke log.

### Coba tanpa VALORANT

```bash
python val.py --demo
```

Mode demo tidak memerlukan dependency pihak ketiga. Semua status diberi label demo; **tidak pernah menghubungi Riot atau mengunci agent sungguhan**. Tombol Perbarui dalam demo hanya memuat ulang katalog lokal.

Untuk port lain:

```bash
python val.py --port 8888
python val.py --demo --no-browser
```

Live mode sengaja dibatasi ke loopback (`127.0.0.1`), bukan server publik. Preview jaringan hanya diizinkan untuk demo eksplisit dengan `--demo --host 0.0.0.0`.

## Fitur

- 30 agent dengan potret WebP lokal, role, dan UUID tervalidasi.
- Agent baru: **Hush, Miks, Veto**, serta agent lama yang sebelumnya hilang: Waylay, Tejo, Vyse, Iso, Clove.
- Pencarian tidak peka huruf besar/kecil atau tanda baca; alias `KAYO` dan salah ketik lama `Pheonix` tetap dikenali.
- Filter role, urutan pilihan/terbaru/nama, favorit, dan preferensi tersimpan di browser.
- Pemilihan region, status langsung, log aktivitas, serta mulai/berhenti yang tidak memblokir GUI.
- Katalog offline-first; tombol **Perbarui** di live mode mengambil roster publik terbaru dari VALORANT API.
- Data refresh divalidasi sebelum disimpan secara atomik. Jika API gagal, katalog lama tetap dipakai.
- UUID tidak lagi ditebak atau digandakan di kode GUI.
- Layout responsif, navigasi keyboard, fokus terlihat, dan dukungan reduced motion.
- Aset dan font disajikan lokal; tidak ada CDN/framework JavaScript saat aplikasi digunakan.

### Batasan perilaku live

- Satu percobaan lock per match per sesi proses. Lock yang sudah dikirim **tidak bisa dibatalkan** dengan tombol Stop.
- Jika agent sudah di-lock teman, aplikasi berhenti dan meminta pilihan lain; tidak menimpa lock teman.
- Agent yang belum dibuka, sudah diambil, atau fase pemilihan yang sudah berakhir dapat menyebabkan penolakan.
- Timeout/error menghentikan proses, bukan spam POST ulang. Hasil lock harus dikonfirmasi dari respons Riot.
- Tombol Stop menghentikan permintaan baru; permintaan yang telanjur berjalan dapat selesai setelah tombol ditekan.
- Adapter memakai endpoint client yang bisa berubah mengikuti patch. Kompatibilitas patch terbaru tidak berarti lock dijamin berhasil.

## Daftar agent dan sumber

Katalog bawaan: `agents.json`, diperiksa **1 November 2026**, mencakup **30 agent playable** sampai Hush (patch 13.09). Format baru menyimpan `id`, `name`, `uuid`, `role`, dan `release_date`. Loader juga bisa membaca format lama nama → UUID.

Urutan dan UUID baru diverifikasi silang dengan [katalog VALORANT Utils](https://github.com/Nanda070/VALORANT-Utils/blob/aa25072e4a09e1ca2f55c3e2199bb58df5192ddc/web/json/agents.json). Nama roster dan sumber potret diperiksa terhadap [arsip aset komunitas](https://github.com/rudnik275/valorant-community-bot/tree/f5a7f423690ec09f25787e9b5f9b6ee09a6837f5/src/assets/agents).

Saat refresh live, aplikasi memakai endpoint publik:

```text
https://valorant-api.com/v1/agents?isPlayableCharacter=true&language=en-US
```

Agent dari respons yang tidak lengkap tidak menghapus roster bawaan. Hanya URL gambar dari domain media VALORANT API yang diterima. Agent baru yang belum memiliki aset lokal memakai potret dari sumber tersebut; jika offline, inisial nama menjadi fallback.

## Struktur proyek

```text
val.py                    Entry point GUI
run.bat                   Peluncur Windows
agents.json               Katalog lokal tervalidasi
requirements.txt          Dependency live mode saja
val_instalock/
  catalog.py              Validasi, merge, refresh atomik
  gateway.py              Adapter Riot berbatas waktu + demo gateway
  service.py              Worker latar dan state machine
  server.py               Server loopback dan JSON API ber-CSRF
static/
  index.html              GUI bahasa Indonesia
  styles.css              Tema responsif
  app.js                  Interaksi browser tanpa framework
  assets/agents/          30 potret WebP lokal (~1,5 MB total)
  assets/fonts/           Font lokal dan lisensi SIL OFL
tests/                    Unit/integration test tanpa akun Riot
```

API browser: `GET /api/bootstrap`, `GET /api/status`, `GET /api/catalog`, serta `POST /api/start`, `/api/stop`, `/api/refresh`. Semua POST memerlukan token CSRF dari bootstrap dan origin yang sesuai. Token ini bukan kredensial Riot.

## Pengujian

Tidak perlu menginstal dependency atau memiliki akun VALORANT untuk menjalankan test:

```bash
python -m unittest discover -v
python -m compileall -q val_instalock val.py
```

Test memakai fake gateway: tidak ada lock sungguhan atau permintaan jaringan Riot. mencakup validasi UUID, refresh gagal/atomik, CSRF/origin, pembatalan worker, penghentian retry, serta agent yang sudah diambil.

## Credits

- [valclient.py](https://github.com/colinhartigan/valclient.py) oleh Colin Hartigan: referensi protokol client proyek awal. Adapter sekarang memakai request berbatas waktu dan tidak bergantung pada paket `valclient` yang sudah tidak aktif.
- [VALORANT API](https://valorant-api.com): data konten publik komunitas, bukan API resmi Riot untuk aplikasi ini.
- Riot Games: pemilik karakter dan artwork VALORANT. Potret digunakan sebagai referensi visual proyek komunitas; tidak ada klaim kepemilikan.
- Barlow Condensed dan DM Sans: SIL Open Font License; salinan lisensi ada di `static/assets/fonts/`.
