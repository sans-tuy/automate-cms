# Otomasi input barang bukti Pidum

Program membaca uraian barang bukti, meminta AI menentukan maknanya, lalu memetakan hasilnya ke kategori dan satuan yang tersedia di website. Setelah diperiksa, barang dimasukkan melalui modal dan form BA-5 disimpan sekali untuk setiap perkara. Uraian asli tetap dipakai pada field nama barang di website; nama objek hasil analisis tersimpan dalam laporan.

## Cara analisis bekerja

Ada dua tahap panggilan API untuk setiap barang yang berhasil dianalisis:

1. **Ekstraksi makna:** AI membaca uraian tanpa melihat katalog website untuk menentukan jenis barang utama, jumlah, satuan yang sesuai, dan kelengkapan pendamping. Hasil menyertakan kutipan pendukung jumlah/objek dan alasan singkat. Satuan boleh disimpulkan dari jenis benda; jumlah harus memiliki dasar dalam uraian.
2. **Pemetaan ke website:** AI menerima hasil ekstraksi, pasangan jumlah/satuan yang sudah divalidasi program, dan katalog konfigurasi, lalu memilih label kategori serta satuan yang tersedia. Pilihan dibatasi melalui schema respons dan divalidasi kembali oleh program.

Jika tahap pertama belum jelas, barang langsung mendapat status `REVIEW` dan tahap pemetaan tidak dijalankan. Tidak ada fallback klasifikasi memakai regex, pencocokan kata kunci, atau nilai bawaan ketika API gagal.

Contoh hasil yang diharapkan dengan katalog saat ini:

| Uraian | Objek | Satuan website | Kategori | Jumlah |
|---|---|---|---|---|
| 1 SEPEDA MOTOR YAMAHA JUPITER BIRU L-3466-QY | sepeda motor | Unit | Sepeda Motor | 1 |
| 1 SEPEDA MOTOR YAMAHA JUPITER BIRU L-3466-QY + STNK + BPKB TP KONTAK | sepeda motor | Unit | Sepeda Motor | 1 |
| 1 KAOS BERKERAH BIRU | kaos | Buah | pakaian | 1 |
| dua unit HP Samsung | telepon genggam | Unit | Elektronik | 2 |
| 1 (satu) lembar STNK sepeda motor | surat tanda nomor kendaraan | Lembar | Dokumen | 1 |
| 1 bungkus sabu netto 0,25 gram | sabu | Gram | narkotika/psykotropika | 0.25 |
| 2 bungkus ganja netto 0,5 kg | ganja | Gram | narkotika/psykotropika | 500 |
| 1 strip pil logo Y berisi 10 butir | pil logo Y | Butir | narkotika/psykotropika | 10 |

Pada contoh kaos, satuan hasil ekstraksi bisa berupa `helai`. Karena konfigurasi saat ini tidak menyediakan `Helai`, AI dapat memilih `Buah` dengan jumlah tetap 1. Tahap pemetaan tidak mengubah jumlah: jika hanya tersedia `Kg` untuk uraian `1,5 gram sabu`, hasil masuk `REVIEW` karena kebijakan narkotika memerlukan Gram.

**Khusus narkotika/psikotropika:** AI menentukan bentuk zat secara semantik. Narkotika bukan pil memakai berat zat dalam **Gram**, dengan berat netto diutamakan dibanding bruto. Jika berat sumber ditulis dalam kg atau mg, program mengonversi angka dan satuannya menggunakan `Decimal` sebelum pemetaan website. Pil memakai jumlah **Butir**, bukan strip, bungkus, berat, atau dosis. Jika berat zat/jumlah pil tidak disebutkan atau meragukan, hasil masuk `REVIEW`; jumlah kemasan tidak dijadikan berat/jumlah pil. Barang nonnarkotika tetap mengikuti satuan barang/kemasan yang dijelaskan. Laporan menyimpan pengukuran sumber dan hasil normalisasi dalam `measurement` agar konversi bisa diperiksa.

Jumlah yang hilang, bertentangan, atau tidak jelas menghasilkan `REVIEW`. Angka pelat, model, tahun, nomor dokumen, dan pecahan uang tidak boleh dipakai sebagai jumlah. Barang mandiri yang masing-masing memiliki jumlah, seperti `1 motor dan 2 HP`, harus dipisah dengan `;`. Kelengkapan motor seperti STNK/BPKB dapat tetap menjadi pendamping dalam satu uraian jika tidak dihitung sebagai barang mandiri.

## Konfigurasi kategori dan satuan

Sesuaikan `konfigurasi.json` dengan pilihan yang benar-benar tersedia di website:

- **`category_keywords`:** key adalah label kategori website; value berisi contoh jenis barang atau deskripsi kategori. Contoh bukan daftar tertutup: AI boleh memahami barang lain yang secara makna termasuk kategori tersebut.
- **`unit_aliases`:** key adalah alias satuan; value adalah label satuan website. Daftar pilihan yang diizinkan berasal dari semua value unik.
- **`fractional_units`:** label satuan website yang mengizinkan pecahan, misalnya `Gram` dan `Kg`. Semua label ini harus ada pada `unit_aliases`.

Pengaturan satuan/kategori bawaan lama tidak digunakan lagi. Jika kategori atau satuan yang setara tidak tersedia, program meminta `REVIEW`. Saat mengisi website, label juga diperiksa terhadap pilihan aktual; label yang tidak tersedia atau ambigu akan menghentikan pengisian.

**`selectors.modal_category` wajib diisi untuk mode `test` dan `production`.** Nilainya saat ini `null`: periksa HTML modal `/pidum/pdm-ba5/barbuk` dan isi selector field kategori yang sebenarnya. Isi modal dimuat terpisah dan tidak ada pada HTML halaman utama yang tersedia; selector field modal lain juga perlu diverifikasi sebelum pengisian nyata.

## Pemasangan dan API key

Jalankan dari folder proyek:

```powershell
python -m pip install -r requirements.txt
python -m playwright install chromium
```

Gunakan `konfigurasi.json` yang ada, atau salin `contoh_konfigurasi.json` lalu sesuaikan URL website, katalog, dan selector. Website kantor membutuhkan akses VPN/LAN yang sesuai; API AI membutuhkan akses internet.

Bagian `ai` memakai OpenAI Responses API dengan respons JSON terstruktur:

```json
{
  "provider": "openai",
  "base_url": "https://api.openai.com/v1",
  "model": "gpt-4.1-mini",
  "api_key_env": "OPENAI_API_KEY",
  "timeout_seconds": 60,
  "max_retries": 2
}
```

Endpoint API harus memakai HTTPS. Kunci dibaca dari environment variable yang ditunjuk `api_key_env`, bukan disimpan di JSON. `max_retries` mengatur pengulangan untuk kegagalan sementara; kegagalan permanen tetap menghentikan proses.

Di PowerShell, isi API key pada sesi terminal yang akan menjalankan program:

```powershell
$env:OPENAI_API_KEY = "ISI_API_KEY_ANDA"
```

Uraian barang dan katalog dikirim ke penyedia API untuk analisis. Nomor pelat, nama, atau pengenal lain yang ada di dalam uraian ikut terkirim. Nomor register pada kolom Excel terpisah dan kredensial login website tidak dimasukkan ke payload analisis. **`dry-run` juga memanggil API eksternal dan menggunakan biaya API**, tetapi tidak membuka atau mengisi website.

Rujukan API: [Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs) dan [GPT-4.1 mini](https://developers.openai.com/api/docs/models/gpt-4.1-mini).

## Menguji satu uraian

```powershell
python run.py --text "1 SEPEDA MOTOR YAMAHA JUPITER BIRU L-3466-QY"
```

`--text` hanya tersedia untuk `dry-run`, yang menjadi mode bawaan. Terminal menampilkan objek, jumlah, satuan, kategori, serta alasan ekstraksi dan pemetaan. Periksa hasil sebelum menjalankan pengisian nyata.

## Format Excel dan pengisian website

Satu baris Excel mewakili satu perkara. Pisahkan barang dengan `;` dan isi tepat satu No Register Barang Bukti untuk form BA-5 perkara tersebut:

| Nomer register perkara | Barang bukti | Nomer register Barang Bukti |
|---|---|---|
| PDM-001/SBY/2026 | 2 unit HP Samsung; 5 lembar STNK | BB-001 |

Simpan nomor perkara dan nomor BB sebagai teks agar nol di depan tidak hilang. Jalankan analisis Excel terlebih dahulu:

```powershell
python run.py data.xlsx --mode dry-run
```

Setelah memeriksa hasil dan melengkapi selector kategori, atur kredensial website pada sesi terminal:

```powershell
$env:BB_USERNAME = "ISI_USERNAME_ANDA"
$env:BB_PASSWORD = "ISI_PASSWORD_ANDA"
python run.py data.xlsx --mode test --limit 2
python run.py data.xlsx --mode production
```

**Mode `test` benar-benar mengisi dan menyimpan website**, tetapi membatasi jumlah perkara yang diproses; `--limit` hanya berlaku dalam mode ini. Mode `production` memproses seluruh baris. Kedua mode membaca `BB_USERNAME` dan `BB_PASSWORD` untuk login.

Seluruh barang dalam perkara dinilai sebelum pengisian website dimulai. Jika satu barang mendapat `REVIEW`, seluruh perkara dilewati; perkara lain yang siap dapat diproses. Kegagalan API menghentikan proses sebelum browser dibuka. Jika proses web gagal, bot berhenti agar penyimpanan parsial tidak diteruskan. Periksa website dan log sebelum mengulang; BA-5 yang sudah berisi barang juga ditolak untuk mencegah duplikasi.

## Laporan dan pemeriksaan

Hasil analisis disimpan ke **`hasil_analisis.json`**, termasuk uraian asli, jenis barang, jumlah, satuan hasil ekstraksi, pilihan website, alasan kedua tahap, serta detail `REVIEW`/`ERROR`. File ini ditimpa setiap kali analisis dijalankan. Gunakan nama lain jika ingin menyimpan setiap hasil:

```powershell
python run.py data.xlsx --mode dry-run --analysis-output hasil_analisis_2026-09-26.json
```

`hasil_input.csv` menambahkan catatan review, kegagalan, dan keberhasilan input website. Status `READY` pada JSON menunjukkan hasil analisis siap dipakai; keberhasilan penyimpanan website dicatat sebagai `SUCCESS` pada CSV.

Kode keluar program:

| Kode | Arti |
|---|---|
| 0 | Analisis siap, atau pengisian selesai tanpa review/kegagalan |
| 2 | Ada perkara yang perlu review, atau argumen/konfigurasi belum valid |
| 1 | Kegagalan API atau proses browser |

Pengujian otomatis dapat dijalankan tanpa API key maupun browser:

```powershell
python -m unittest -v
```

Tes menggunakan respons API tiruan untuk memeriksa kontrak JSON, validasi, dan alur program. Pada saat implementasi ini, `OPENAI_API_KEY` belum tersedia sehingga akurasi model terhadap uraian nyata **belum diverifikasi melalui panggilan API langsung**. Contoh hasil di atas adalah perilaku yang diharapkan, bukan hasil evaluasi model langsung.
