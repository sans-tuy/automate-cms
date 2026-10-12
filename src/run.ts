import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { chromium, type Browser, type Page } from "playwright";
import { loadConfig } from "./config.js";
import { loadResult, type ValidationEntry } from "./data.js";
import { fillCase, login, openCase } from "./browser.js";

// Alur utama: baca opsi -> validasi JSON -> login -> proses perkara -> tulis hasil.
// Mode test tetap menyimpan ke website; dry-run berhenti sebelum browser dibuka.
type Mode = "dry-run" | "test" | "production";
export interface CliOptions {
  input: string;
  config: string;
  mode: Mode;
  limit: number;
  report: string;
  log: string;
  artifacts: string;
  manualLogin: boolean;
  headless: boolean;
  help: boolean;
}

/** Mengolah argumen setelah `npm start --` dan menolak opsi/path yang keliru. */
export function parseCliArgs(args: string[]): CliOptions {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: {
      input: { type: "string" },
      config: { type: "string", default: "konfigurasi.json" },
      mode: { type: "string", default: "production" },
      limit: { type: "string", default: "2" },
      report: { type: "string", default: "hasil_validasi.json" },
      log: { type: "string", default: "hasil_input_ts.csv" },
      artifacts: { type: "string", default: "artifacts" },
      "manual-login": { type: "boolean", default: false },
      headless: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (positionals.length > 1 || (positionals.length > 0 && values.input))
    throw new Error("Pilih satu file input JSON");
  if (!["dry-run", "test", "production"].includes(values.mode!))
    throw new Error("Mode harus dry-run, test, atau production");
  if (
    !/^\d+$/.test(values.limit!) ||
    !Number.isSafeInteger(Number(values.limit)) ||
    Number(values.limit) <= 0
  ) {
    throw new Error("--limit harus bilangan bulat positif");
  }
  const options: CliOptions = {
    input: values.input ?? positionals[0] ?? "result.json",
    config: values.config!,
    mode: values.mode as Mode,
    limit: Number(values.limit),
    report: values.report!,
    log: values.log!,
    artifacts: values.artifacts!,
    manualLogin: values["manual-login"]!,
    headless: values.headless!,
    help: values.help!,
  };
  // Laporan/log tidak boleh menimpa sumber data, konfigurasi, atau satu sama lain.
  const paths = [
    options.input,
    options.config,
    options.report,
    options.log,
  ].map((path) => resolve(path).toLowerCase());
  if (new Set(paths).size !== paths.length)
    throw new Error("Path input, config, report, dan log harus berbeda");
  return options;
}

// READY/REVIEW berasal dari validasi; status lainnya menunjukkan hasil otomasi.
// NOT_PROCESSED berarti perkara belum dijalankan karena limit atau proses berhenti.
interface ExecutionEntry extends Omit<ValidationEntry, "status"> {
  status: ValidationEntry["status"] | "SUCCESS" | "ERROR" | "NOT_PROCESSED";
  detail?: string;
}

export const HELP = `Otomasi barang bukti dari result.json (tanpa Excel/AI)

npm start -- [result.json] [opsi]
  --input FILE        Sumber JSON (default result.json)
  --config FILE       Konfigurasi website (default konfigurasi.json)
  --mode MODE         dry-run (validasi saja), test, production
  --limit N           Batas jumlah entri JSON pada mode test (default 2)
  --manual-login      Login sendiri di browser yang dibuka program
  --headless          Jalankan browser tanpa jendela
  --report FILE       Laporan validasi/pengisian (default hasil_validasi.json)
  --log FILE          Log CSV terpisah (default hasil_input_ts.csv)
  --artifacts DIR     Direktori screenshot kegagalan (default artifacts)

Mode test dan production benar-benar menyimpan website.
Login otomatis memakai admin/password secara default; BB_USERNAME dan BB_PASSWORD
dapat mengganti kredensial tersebut. Mode dry-run tidak perlu login.
`;

/** Menulis ulang laporan JSON dengan status terakhir seluruh perkara. */
async function saveReport(file: string, data: unknown): Promise<void> {
  await mkdir(dirname(resolve(file)), { recursive: true });
  await writeFile(file, JSON.stringify(data, null, 2) + "\n", "utf8");
}

/** Menambahkan riwayat ke CSV; hasil eksekusi sebelumnya tetap dipertahankan. */
async function appendLog(
  file: string,
  entry: ExecutionEntry,
  detail: string,
): Promise<void> {
  await mkdir(dirname(resolve(file)), { recursive: true });
  // Header hanya ditulis pada berkas baru; log Python lama memakai berkas berbeda.
  try {
    await writeFile(
      file,
      "\uFEFFwaktu,index_json,nomor_perkara,nomor_bb,status,keterangan\n",
      { flag: "wx" },
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  // Kutip setiap kolom dan gandakan tanda kutip agar koma/newline tidak merusak CSV.
  const csv = (value: unknown) =>
    '"' + String(value ?? "").replaceAll('"', '""') + '"';
  await appendFile(
    file,
    [
      new Date().toISOString(),
      entry.index,
      entry.caseNumber,
      entry.evidenceNumber,
      entry.status,
      detail,
    ]
      .map(csv)
      .join(",") + "\n",
    "utf8",
  );
}

/** Kode keluar: 0 berhasil, 2 data/opsi perlu diperiksa, 1 proses website gagal. */
export async function run(args = process.argv.slice(2)): Promise<number> {
  let options: CliOptions;
  try {
    options = parseCliArgs(args);
  } catch (error) {
    console.error(`Konfigurasi: ${(error as Error).message}`);
    return 2;
  }
  if (options.help) {
    console.log(HELP);
    return 0;
  }

  let config: Awaited<ReturnType<typeof loadConfig>>;
  let validation: Awaited<ReturnType<typeof loadResult>>;
  try {
    [config, validation] = await Promise.all([
      loadConfig(options.config),
      loadResult(options.input),
    ]);
  } catch (error) {
    console.error(`Data/konfigurasi: ${(error as Error).message}`);
    return 2;
  }

  // Salin hasil validasi agar status eksekusi dapat berubah tanpa mengubah sumbernya.
  const entries: ExecutionEntry[] = validation.entries.map((entry) => ({
    ...entry,
    issues: [...entry.issues],
  }));
  // Limit berlaku pada urutan entri JSON, termasuk entri REVIEW, bukan hanya READY.
  const selected =
    options.mode === "test" ? entries.slice(0, options.limit) : entries;
  const selectedIndexes = new Set(selected.map((entry) => entry.index));
  const ready = validation.ready.filter((record) =>
    selectedIndexes.has(record.index),
  );
  const review = selected.filter((entry) => entry.status === "REVIEW");
  const report = {
    generated_at: new Date().toISOString(),
    source: resolve(options.input),
    mode: options.mode,
    total_cases: entries.length,
    total_items: validation.totalItems,
    selected_cases: selected.length,
    entries,
  };
  if (options.mode === "test") {
    for (const entry of entries)
      if (!selectedIndexes.has(entry.index) && entry.status === "READY")
        entry.status = "NOT_PROCESSED";
  }
  console.log(
    `${entries.length} perkara, ${validation.totalItems} barang dari ${options.input}`,
  );
  console.log(
    `Dalam cakupan: ${ready.length} perkara siap, ${review.length} perkara REVIEW`,
  );
  for (const entry of review)
    console.log(`REVIEW entri ${entry.index}: ${entry.issues.join("; ")}`);
  await saveReport(options.report, report);
  console.log(`Laporan: ${options.report}`);
  // Simpan laporan sebelum keluar; dry-run tidak melakukan login atau penyimpanan.
  if (options.mode === "dry-run") return review.length > 0 ? 2 : 0;
  if (ready.length === 0) return review.length > 0 ? 2 : 0;
  // Akun default dipakai jika environment kosong; login manual dipilih lewat CLI.
  const credentials = {
    username: process.env.BB_USERNAME || "admin",
    password: process.env.BB_PASSWORD || "password",
  };
  config.headless = options.headless || config.headless;
  if (options.manualLogin && config.headless) {
    console.error("Login manual memerlukan headless=false");
    return 2;
  }

  let browser: Browser | undefined;
  let page: Page | undefined;
  let current: ExecutionEntry | undefined;
  try {
    for (const entry of review)
      await appendLog(options.log, entry, entry.issues.join("; "));
    browser = await chromium.launch({ headless: config.headless });
    page = await browser.newPage();
    page.setDefaultTimeout(config.timeout_ms);
    page.setDefaultNavigationTimeout(config.timeout_ms);
    if (options.manualLogin)
      console.log(
        "Silakan login pada browser yang dibuka. Program melanjutkan setelah login berhasil.",
      );
    await login(
      page,
      config,
      options.manualLogin ? undefined : credentials,
      options.manualLogin,
    );
    // Proses berurutan memakai satu sesi. fillCase memeriksa ulang hasil penyimpanan
    // sebelum perkara diberi status SUCCESS dan antrean dilanjutkan.
    for (const record of ready) {
      current = entries.find((entry) => entry.index === record.index)!;
      console.log(
        `Mengisi entri ${record.index}: ${record.items.length} barang`,
      );
      await openCase(page, config, record);
      await fillCase(page, config, record);
      current.status = "SUCCESS";
      current.detail = "Penyimpanan dan pemeriksaan ulang data berhasil";
      await appendLog(options.log, current, current.detail);
      await saveReport(options.report, report);
      console.log(`SUCCESS entri ${record.index}`);
      current = undefined;
    }
    return review.length > 0 ? 2 : 0;
  } catch (error) {
    // Hentikan antrean saat gagal: website mungkin sudah menyimpan sebagian data.
    // Catat perkara aktif sebagai ERROR dan sisanya sebagai NOT_PROCESSED.
    let message = error instanceof Error ? error.message : String(error);
    if (credentials)
      message = message.replaceAll(credentials.password, "[disembunyikan]");
    console.error(`Pengisian dihentikan: ${message}`);
    if (current) {
      current.status = "ERROR";
      current.detail = message;
      await appendLog(options.log, current, message);
    }
    for (const entry of selected)
      if (entry.status === "READY") entry.status = "NOT_PROCESSED";
    await saveReport(options.report, { ...report, error: message });
    if (page) {
      try {
        await mkdir(options.artifacts, { recursive: true });
        await page.screenshot({
          path: resolve(
            options.artifacts,
            `gagal_${current?.index ?? "login"}_${Date.now()}.png`,
          ),
          fullPage: true,
        });
      } catch {
        console.error("Screenshot kegagalan tidak dapat dibuat");
      }
    }
    return 1;
  } finally {
    // Tutup browser baik saat sukses maupun saat terjadi kegagalan.
    await browser?.close();
  }
}

// Jalankan hanya saat file ini menjadi entry point; impor dari tes tidak memulai otomasi.
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  run()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(`Gagal menjalankan program: ${(error as Error).message}`);
      process.exitCode = 1;
    });
}
