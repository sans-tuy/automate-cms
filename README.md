# Otomasi input barang bukti — TypeScript

Program mengambil data dari `result.json`, lalu mengisi website Pidum menggunakan Playwright. Tidak ada pembacaan Excel, klasifikasi barang, konversi satuan, atau panggilan API AI. Nilai `nama_barang`, `jumlah`, `satuan`, `disita_dari`, `tempat_simpan`, dan `kondisi` di JSON menjadi sumber pengisian. Kategori tidak lagi digunakan.

## Persiapan

Gunakan Node.js 22 atau lebih baru. Dari folder proyek:

```powershell
npm install
npm run browser:install
npm run build
```

Website dikonfigurasi ke `http://10.16.1.101:4111`, dengan halaman login `/user/login`. Komputer perlu tersambung ke jaringan/VPN website tersebut. API key AI tidak diperlukan.

## Bentuk result.json

```json
[
  {
    "Nomer register perkara": "PDM-001/2026",
    "Nomer register Barang Bukti": "BB-001",
    "barang_bukti": [
      {
        "nama_barang": "1 SEPEDA MOTOR YAMAHA JUPITER BIRU L-3466-QY",
        "jumlah": 1,
        "satuan": "Unit",
        "disita_dari": "Pemilik barang",
        "tempat_simpan": "Gudang barang bukti",
        "kondisi": "Baik"
      },
      {
        "nama_barang": "SISA LABFOR SS 0,25 GRAM",
        "jumlah": "0.25",
        "satuan": "Gram",
        "disita_dari": "",
        "tempat_simpan": "Lemari barang bukti",
        "kondisi": "Baik"
      }
    ]
  }
]
```

Nama field register harus sama dengan contoh. Kolom tambahan seperti tanggal, identitas, JPU, dan pasal diabaikan. Nomor perkara dan nomor BB harus berupa string agar nol awal tidak hilang. Jumlah menerima angka JSON positif atau string desimal positif dengan titik, seperti `"0.25"`; gunakan string untuk angka sangat panjang yang harus mempertahankan presisi.

Field `nama_barang`, `jumlah`, dan `satuan` wajib diisi. Field `disita_dari`, `tempat_simpan`, dan `kondisi` opsional: jika tidak ada, `null`, atau hanya berisi spasi/string kosong, defaultnya masing-masing `""`, `""`, dan `"Baik"`. Jika diisi, ketiganya harus berupa string. Field `kategori` dari input lama diabaikan.

Program tidak menebak jumlah `null`, membaca angka dari nama barang, atau mengubah satuan. Misalnya, apabila JSON menyebut pil dengan satuan `Buah`, program tetap memilih `Buah`. Koreksi keputusan tersebut langsung di sumber JSON jika diperlukan.

Satu barang dengan field wajib tidak lengkap atau nilai tidak valid membuat seluruh perkara berstatus `REVIEW`. Semua entri dengan nomor perkara duplikat juga `REVIEW`; program tidak menggabungkannya otomatis. Nomor BB yang sama pada perkara berbeda tidak otomatis ditolak.

## Validasi sebelum pengisian

```powershell
npm run dry-run
# Setara dengan:
npm start -- --input result.json --mode dry-run
```

`dry-run` hanya membaca dan memvalidasi berkas lokal; tidak membuka browser atau mengakses website. Ringkasan dan lokasi field yang harus diperbaiki tersimpan dalam `hasil_validasi.json`. Berkas `result.json` tidak diubah. Untuk memakai berkas/laporan lain:

```powershell
npm start -- --mode dry-run --input hasil_lain.json --report laporan_lain.json
```

## Mengisi website

`npm run start` langsung login otomatis dengan username `admin` dan password `password`, lalu memproses data pada mode production. Untuk menggunakan akun lain, atur `BB_USERNAME` dan `BB_PASSWORD` seperti contoh berikut.

Login otomatis dengan environment variable PowerShell:

```powershell
$env:BB_USERNAME = "USERNAME_ANDA"
$env:BB_PASSWORD = "PASSWORD_ANDA"
npm start -- --mode test --limit 1
```

Atau login sendiri di browser yang dibuka program:

```powershell
npm start -- --mode test --limit 1 --manual-login
```

Program menunggu login manual hingga 5 menit sesuai konfigurasi. Jangan memakai `--headless` untuk login manual.

**Mode `test` benar-benar menyimpan data ke website.** `--limit 1` membatasi proses pada entri pertama dalam array JSON, termasuk bila entri itu perlu review; program tidak menggantinya dengan perkara lain. Untuk seluruh data:

```powershell
npm start -- --mode production
# Atau dengan login manual:
npm start -- --mode production --manual-login
```

Perkara `REVIEW` dilewati. Untuk perkara siap, program mencari nomor perkara secara persis, membuka BA-5, memeriksa semua pilihan satuan/kondisi, lalu mengisi dan menyimpan setiap barang dari modal ke tabel. BA-5 yang sudah mempunyai barang tetap diproses dengan menambahkan barang dari JSON. Setelah seluruh barang masuk ke tabel, program menekan Save terlebih dahulu, menunggu form nomor register barang bukti muncul, lalu mengisi nomor register dan menyimpannya. Setelah disimpan, program membuka kembali perkara untuk memeriksa data yang tersimpan. Kegagalan website menghentikan antrean; periksa hasil penyimpanan sebelum mengulang karena suatu perkara bisa sudah tersimpan sebagian.

## Konfigurasi website

`konfigurasi.json` hanya menyimpan URL, pengaturan browser, dan selector. `headless: false` menampilkan browser; `--headless` mengaktifkan mode tanpa jendela untuk login otomatis. Selector bawaan tersedia di `src/config.ts` dan dapat diganti melalui objek `selectors`.

Field baru memakai selector `modal_seized_from` (`#m_barbuk #sita_barbuk`), `modal_storage` (`#m_barbuk #tmpt_simpan_barbuk`), dan `modal_condition` (`#m_barbuk #kondisi_barbuk`). Kondisi dan satuan dipilih berdasarkan label dropdown website. Selector `form_submit` digunakan untuk Save barang sebelum form register muncul; `register_submit` digunakan untuk menyimpan nomor register dan dapat diganti jika tombolnya berada pada form terpisah. Hapus `selectors.modal_category` dari konfigurasi lama; selector tersebut sudah tidak digunakan.

Nama pilihan website harus cocok dengan label JSON setelah normalisasi huruf besar/kecil dan spasi. Tidak ada `category_keywords` atau `unit_aliases` untuk menafsirkan ulang data. Selector login sudah diperiksa pada halaman website; form setelah login tetap perlu diverifikasi pada lingkungan kantor.

## Hasil dan pengujian

- `hasil_validasi.json`: laporan terbaru, ditimpa setiap kali dijalankan; berisi `READY`, `REVIEW`, `SUCCESS`, `ERROR`, atau `NOT_PROCESSED`.
- `hasil_input_ts.csv`: log pengisian dan review yang ditambahkan setiap proses website. Log lama `hasil_input.csv` tetap terpisah.
- `artifacts/`: screenshot jika proses website gagal.
- `screenshots/`: screenshot seluruh halaman setelah semua barang bukti diinput dan Save ditekan, saat form nomor register muncul sebelum diisi. Folder dibuat otomatis; nama PNG berisi indeks perkara, waktu, dan ID unik agar hasil tidak tertimpa.

Kode keluar: `0` berhasil, `2` ada review atau konfigurasi/data belum valid, `1` kegagalan proses website atau I/O. Status `READY` hanya menyatakan validasi lokal berhasil, bukan bukti bahwa data sudah disimpan di website.

```powershell
npm test
npm start -- --help
```

Tes mencakup validasi JSON serta otomasi form menggunakan halaman simulasi lokal, tanpa mengirim data ke website kantor. Implementasi Python lama dan konfigurasinya disimpan di `legacy-python/` sebagai arsip; entry point aktif adalah `src/run.ts`.
