import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import type { Locator, Page, Response } from "playwright";
import type { AppConfig } from "./config.js";
import type { CaseRecord } from "./data.js";

// Normalisasi hanya untuk pembandingan teks; nilai asli JSON tetap diisi ke form.
const normalized = (value: string): string =>
  value.normalize("NFC").replace(/\s+/gu, " ").trim().toLocaleLowerCase("id");

/** Menolak sesi yang kembali ke login atau berpindah ke origin lain. */
function assertWebsite(page: Page, cfg: AppConfig): void {
  const current = new URL(page.url());
  if (
    current.origin !== new URL(cfg.base_url).origin ||
    current.pathname === cfg.login_path
  ) {
    throw new Error("Sesi website tidak aktif atau dialihkan ke halaman login");
  }
}

/** HTTP sukses saja belum membuktikan data tersimpan; pemeriksaan isi dilakukan terpisah. */
async function assertResponse(
  response: Response | null,
  context: string,
): Promise<void> {
  if (!response || response.status() >= 400)
    throw new Error(
      `${context}: respons website ${response?.status() ?? "tidak tersedia"}`,
    );
  const error = await response.finished();
  if (error)
    throw new Error(
      `${context}: respons website tidak selesai (${error.message})`,
    );
}

/** Tunggu perubahan tabel lewat polling singkat, bukan jeda tetap yang menebak durasi. */
async function until(
  check: () => Promise<boolean>,
  timeout: number,
  error: string,
): Promise<void> {
  const deadline = Date.now() + timeout;
  do {
    if (await check()) return;
    await pause(75);
  } while (Date.now() < deadline);
  throw new Error(error);
}

/** Login otomatis/manual, lalu buka halaman beranda setelah sesi aktif. */
export async function login(
  page: Page,
  cfg: AppConfig,
  credentials?: { username: string; password: string },
  manualLogin = false,
): Promise<void> {
  if (!manualLogin && (!credentials?.username || !credentials.password))
    throw new Error(
      "Isi BB_USERNAME dan BB_PASSWORD atau gunakan --manual-login",
    );
  page.setDefaultTimeout(cfg.timeout_ms);
  await assertResponse(
    await page.goto(new URL(cfg.login_path, cfg.base_url).href),
    "Membuka login",
  );
  const username = page.locator(cfg.selectors.login_username);
  if (manualLogin) {
    await username.waitFor({
      state: "hidden",
      timeout: cfg.manual_login_timeout_ms,
    });
  } else {
    await username.fill(credentials!.username);
    await page
      .locator(cfg.selectors.login_password)
      .fill(credentials!.password);
    await page.locator(cfg.selectors.login_submit).click();
  }
  await page.locator(cfg.selectors.home_link).waitFor({
    state: "visible",
    timeout: manualLogin ? cfg.manual_login_timeout_ms : cfg.timeout_ms,
  });
  assertWebsite(page, cfg);
  await page.locator(cfg.selectors.home_link).click();
  await page.waitForLoadState("domcontentloaded");
  assertWebsite(page, cfg);
}

/** Cari nomor perkara persis lewat data-id, kemudian buka form BA-5 perkara tersebut. */
export async function openCase(
  page: Page,
  cfg: AppConfig,
  record: CaseRecord,
): Promise<void> {
  page.setDefaultTimeout(cfg.timeout_ms);
  const indexUrl = new URL(cfg.case_index_path, cfg.base_url);
  await assertResponse(
    await page.goto(indexUrl.href),
    "Membuka daftar perkara",
  );
  assertWebsite(page, cfg);
  await page.locator(cfg.selectors.case_search).fill(record.caseNumber);
  const [searchResponse] = await Promise.all([
    page.waitForResponse(
      (response) => {
        const url = new URL(response.url());
        return (
          url.origin === indexUrl.origin && url.pathname === indexUrl.pathname
        );
      },
      { timeout: cfg.timeout_ms },
    ),
    page.locator(cfg.selectors.case_submit).click(),
  ]);
  await assertResponse(searchResponse, "Mencari perkara");
  assertWebsite(page, cfg);
  const caseRow = page.locator(`tbody tr[data-id="${record.caseNumber}"]`);
  // Tunggu satu baris agar hasil duplikat dapat ditangani oleh pemeriksaan count.
  await caseRow.first().waitFor({
    state: "visible",
    timeout: cfg.timeout_ms,
  });
  const count = await caseRow.count();
  if (count > 1) {
    throw new Error(`Hasil pencarian perkara tidak unik: ${record.caseNumber}`);
  }
  await caseRow.dblclick();
  await page.waitForURL(
    (url) =>
      url.origin === indexUrl.origin &&
      url.pathname === "/pidum/pdm-tahap-dua/update",
    { timeout: cfg.timeout_ms },
  );
  await page.locator(cfg.selectors.ba5_link).click();
  await page.waitForURL(
    (url) =>
      url.origin === indexUrl.origin &&
      url.pathname.startsWith("/pidum/pdm-ba5/"),
    { timeout: cfg.timeout_ms },
  );
  await page.locator(cfg.selectors.ba5_form).waitFor({ state: "visible" });
  assertWebsite(page, cfg);
}

interface Option {
  label: string;
  value: string;
  disabled: boolean;
}

// Ambil pilihan dari website, termasuk status disabled; jangan menebak kode satuan/kondisi.
async function options(control: Locator): Promise<Option[]> {
  if (
    (await control.count()) !== 1 ||
    !(await control.evaluate((element) => element.tagName === "SELECT"))
  ) {
    throw new Error(`Selector harus menunjuk tepat satu dropdown: ${control}`);
  }
  return control.locator("option").evaluateAll((elements) =>
    elements.map((element) => {
      const option = element as HTMLOptionElement;
      return {
        label: option.label.trim(),
        value: option.value,
        disabled:
          option.disabled ||
          (option.parentElement instanceof HTMLOptGroupElement &&
            option.parentElement.disabled),
      };
    }),
  );
}

// Cocokkan label secara utuh. Label/nilai yang ambigu ditolak agar pilihan tidak keliru.
function resolveOption(available: Option[], desired: string): Option {
  const matches = available.filter(
    (option) =>
      option.value.trim() &&
      !option.disabled &&
      normalized(option.label) === normalized(desired),
  );
  if (matches.length !== 1)
    throw new Error(
      `Opsi "${desired}" tidak tersedia atau tidak unik. Pilihan website: ${available
        .filter((option) => option.value.trim())
        .map((option) => option.label)
        .join(", ")}`,
    );
  if (
    available.filter((option) => option.value === matches[0]!.value).length !==
    1
  )
    throw new Error(`Nilai dropdown untuk "${desired}" tidak unik`);
  return matches[0]!;
}

/** Pilih berdasarkan label JSON, memakai value yang tersedia pada dropdown website. */
export async function chooseOption(
  control: Locator,
  desired: string,
): Promise<void> {
  const option = resolveOption(await options(control), desired);
  await control.selectOption({ value: option.value });
  if ((await control.inputValue()) !== option.value)
    throw new Error(`Website tidak mempertahankan pilihan "${desired}"`);
}

// Simpan daftar opsi untuk memverifikasi label maupun kode yang tampil setelah Save.
interface Catalog {
  units: Option[];
  conditions: Option[];
}

async function resolveControls(
  page: Page,
  cfg: AppConfig,
  record: CaseRecord,
): Promise<Catalog> {
  const units = await options(page.locator(cfg.selectors.modal_unit));
  const conditions = await options(page.locator(cfg.selectors.modal_condition));
  for (const item of record.items) {
    resolveOption(units, item.satuan);
    resolveOption(conditions, item.kondisi);
  }
  return { units, conditions };
}

// Saat membandingkan hasil, 0,25 dan 0.250 dianggap sama tanpa konversi ke Number.
const decimal = (value: string): string =>
  value
    .trim()
    .replace(",", ".")
    .replace(/^0+(?=\d)/u, "")
    .replace(/(\.\d*?)0+$/u, "$1")
    .replace(/\.$/u, "");

/** Memeriksa barang yang ditambahkan, baik sebelum maupun setelah form disimpan. */
async function verifyRows(
  page: Page,
  cfg: AppConfig,
  record: CaseRecord,
  catalog: Catalog,
  existingCount: number,
): Promise<void> {
  const rows = page.locator(cfg.selectors.evidence_rows);
  if ((await rows.count()) !== existingCount + record.items.length)
    throw new Error("Jumlah barang pada BA-5 berbeda dari result.json");
  const snapshots = await rows.evaluateAll((elements) =>
    elements.map((element) => ({
      headers: [
        ...(element
          .closest("table")
          ?.querySelectorAll(
            "thead tr:last-child th, thead tr:last-child td",
          ) ?? []),
      ].map((header) => header.textContent ?? ""),
      cells: [...element.querySelectorAll("td")].map(
        (cell) => cell.textContent ?? "",
      ),
      inputs: [...element.querySelectorAll("input,textarea")].map((element) => {
        const input = element as HTMLInputElement;
        return { identity: `${input.id} ${input.name}`, value: input.value };
      }),
    })),
  );
  // Barang baru diasumsikan ditambahkan di akhir tabel; lewati baris barang lama.
  // Sesuaikan bagian ini jika website kelak mengurutkan ulang tabel setelah Save.
  snapshots.splice(0, existingCount);
  for (const item of record.items) {
    const index = snapshots.findIndex((row) =>
      [...row.cells, ...row.inputs.map((input) => input.value)].some(
        (value) => normalized(value) === normalized(item.nama_barang),
      ),
    );
    if (index < 0)
      throw new Error(
        `Nama barang tidak terverifikasi pada BA-5: ${item.nama_barang}`,
      );
    const row = snapshots[index]!;
    const quantityInputs = row.inputs.filter((input) =>
      /(?:^|[\W_])(?:jml|jumlah)(?:[\W_]|$)/iu.test(input.identity),
    );
    const quantities = quantityInputs.length
      ? quantityInputs.map((input) => input.value)
      : row.cells.filter((cell) => /^\s*\d+(?:[.,]\d+)?\s*$/u.test(cell));
    // Template tabel dapat berbeda: periksa jumlah dan label jika datanya tersedia.
    if (
      quantities.length &&
      !quantities.some((value) => decimal(value) === decimal(item.jumlah))
    )
      throw new Error(
        `Jumlah barang tidak tersimpan sesuai result.json: ${item.nama_barang}`,
      );
    // Utamakan input tersembunyi; jika tidak ada, baca kolom berdasarkan judul tabel.
    const fieldValues = (pattern: RegExp): string[] => {
      const inputs = row.inputs.filter((input) => pattern.test(input.identity));
      return inputs.length
        ? inputs.map((input) => input.value)
        : row.cells.filter((_, index) =>
            pattern.test(row.headers[index] ?? ""),
          );
    };
    for (const [available, expected, field, pattern] of [
      [catalog.units, item.satuan, "Satuan", /(?:^|[\W_])satuan(?:[\W_]|$)/iu],
      [
        catalog.conditions,
        item.kondisi,
        "Kondisi",
        /(?:^|[\W_])kondisi(?:[\W_]|$)/iu,
      ],
    ] as const) {
      const identified = fieldValues(pattern);
      const displayed = identified.length
        ? identified
        : row.cells.filter((cell) =>
            available.some(
              (option) => normalized(option.label) === normalized(cell),
            ),
          );
      const expectedOption = resolveOption(available, expected);
      if (
        displayed.length &&
        !displayed.some(
          (value) =>
            normalized(value) === normalized(expected) ||
            (identified.length > 0 && value === expectedOption.value),
        )
      )
        throw new Error(
          `${field} barang tidak tersimpan sesuai result.json: ${item.nama_barang}`,
        );
    }
    for (const [pattern, expected, field] of [
      [
        /(?:^|[\W_])(?:sita|disita)(?:[\W_]|$)/iu,
        item.disita_dari,
        "Disita dari",
      ],
      [
        /(?:^|[\W_])(?:tmpt|tempat)[\W_]+simpan(?:[\W_]|$)/iu,
        item.tempat_simpan,
        "Tempat simpan",
      ],
    ] as const) {
      const values = fieldValues(pattern);
      if (
        values.length &&
        !values.some((value) => normalized(value) === normalized(expected))
      ) {
        throw new Error(
          `${field} barang tidak tersimpan sesuai result.json: ${item.nama_barang}`,
        );
      }
    }
    snapshots.splice(index, 1);
  }
}

/**
 * Tambah barang lewat modal -> Save barang -> tunggu form register -> screenshot
 * -> isi dan Save register -> buka ulang perkara untuk membuktikan data tersimpan.
 * Barang yang sudah ada tetap dipertahankan; menjalankan ulang dapat menambah duplikat.
 */
export async function fillCase(
  page: Page,
  cfg: AppConfig,
  record: CaseRecord,
): Promise<void> {
  page.setDefaultTimeout(cfg.timeout_ms);
  assertWebsite(page, cfg);
  await page.locator(cfg.selectors.ba5_form).waitFor({ state: "visible" });
  if (!record.items.length)
    throw new Error("Perkara tidak memiliki barang bukti");
  // Hitungan awal menjadi dasar jumlah baris yang diharapkan setelah setiap penambahan.
  const existingCount = await page.locator(cfg.selectors.evidence_rows).count();

  // Periksa semua pilihan sebelum menambahkan barang pertama.
  await page.locator(cfg.selectors.add_button).click();
  await page.locator(cfg.selectors.modal_name).waitFor({ state: "visible" });
  const catalog = await resolveControls(page, cfg, record);
  for (const [index, item] of record.items.entries()) {
    if (index > 0) {
      await page.locator(cfg.selectors.add_button).click();
      await page
        .locator(cfg.selectors.modal_name)
        .waitFor({ state: "visible" });
    }
    const textFields = [
      [cfg.selectors.modal_name, item.nama_barang, "Nama barang"],
      [cfg.selectors.modal_quantity, item.jumlah, "Jumlah"],
      [cfg.selectors.modal_seized_from, item.disita_dari, "Disita dari"],
      [cfg.selectors.modal_storage, item.tempat_simpan, "Tempat simpan"],
    ] as const;
    for (const [selector, value] of textFields) {
      await page.locator(selector).fill(value);
    }
    const dropdowns = [
      [cfg.selectors.modal_unit, item.satuan],
      [cfg.selectors.modal_condition, item.kondisi],
    ] as const;
    for (const [selector, desired] of dropdowns) {
      await chooseOption(page.locator(selector), desired);
    }
    // Event change pada dropdown bisa mengubah field lain; cek setelah semuanya diisi.
    for (const [selector, value, field] of textFields) {
      if ((await page.locator(selector).inputValue()) !== value) {
        throw new Error(
          `${field} berubah sebelum disimpan: ${item.nama_barang}`,
        );
      }
    }
    for (const [selector, desired] of dropdowns) {
      const selected = await page
        .locator(selector)
        .evaluate((element) =>
          [...(element as HTMLSelectElement).selectedOptions].map(
            (option) => option.label,
          ),
        );
      if (
        selected.length !== 1 ||
        normalized(selected[0]!) !== normalized(desired)
      ) {
        throw new Error(
          `Website mengubah pilihan dropdown "${desired}" sebelum disimpan`,
        );
      }
    }
    await page.locator(cfg.selectors.modal_save).click();
    // Modal tertutup belum tentu berarti baris sudah muncul; tunggu pembaruan tabel juga.
    await page.locator(cfg.selectors.modal).waitFor({ state: "hidden" });
    await until(
      async () => {
        const count = await page.locator(cfg.selectors.evidence_rows).count();
        if (count > existingCount + index + 1)
          throw new Error(
            "Website menambahkan baris barang yang tidak diharapkan",
          );
        return count === existingCount + index + 1;
      },
      cfg.timeout_ms,
      `Barang ke-${index + 1} belum muncul pada tabel BA-5`,
    );
  }
  await verifyRows(page, cfg, record, catalog, existingCount);
  // Save barang terlebih dahulu; website baru menampilkan form register setelahnya.
  await page.locator(cfg.selectors.form_submit).click({ noWaitAfter: false });
  await page.waitForLoadState("domcontentloaded");
  assertWebsite(page, cfg);
  await page.locator(cfg.selectors.register_bb).waitFor({ state: "visible" });
  // Path relatif terhadap folder tempat perintah dijalankan. ID unik mencegah tertimpa
  // ketika perkara yang sama diproses ulang. Screenshot ditunggu sebelum register diisi.
  const screenshotDirectory = resolve("screenshots");
  await mkdir(screenshotDirectory, { recursive: true });
  const screenshotPath = resolve(
    screenshotDirectory,
    `barang_bukti_${record.index}_${Date.now()}_${randomUUID()}.png`,
  );
  await page.screenshot({ path: screenshotPath, fullPage: true });
  console.log(`Screenshot sebelum input nomor register: ${screenshotPath}`);
  await page.locator(cfg.selectors.register_bb).fill(record.evidenceNumber);
  if (
    (await page.locator(cfg.selectors.register_bb).inputValue()) !==
    record.evidenceNumber
  )
    throw new Error("Website mengubah nomor register barang bukti");
  // Form register bisa terpisah dari form barang; ambil action dari induk field register.
  const action = new URL(
    (await page
      .locator(cfg.selectors.register_bb)
      .evaluate(
        (element) => element.closest("form")?.getAttribute("action") ?? null,
      )) || page.url(),
    page.url(),
  );
  if (action.origin !== new URL(cfg.base_url).origin)
    throw new Error("Form BA-5 mengarah ke luar website");
  // Pasang penantian respons sebelum klik agar respons cepat tidak terlewat.
  // Pengiriman AJAX tidak memerlukan navigasi; pengiriman form biasa menunggu halaman baru.
  const [saveResponse] = await Promise.all([
    page.waitForResponse(
      (response) => {
        const url = new URL(response.url());
        return (
          url.origin === action.origin &&
          url.pathname === action.pathname &&
          ["POST", "PUT", "PATCH"].includes(response.request().method())
        );
      },
      { timeout: cfg.timeout_ms },
    ),
    page.locator(cfg.selectors.register_submit).click({ noWaitAfter: false }),
  ]);
  await assertResponse(saveResponse, "Menyimpan BA-5");
  if (saveResponse.request().isNavigationRequest()) {
    await page.waitForLoadState("domcontentloaded");
    let finalRequest = saveResponse.request();
    while (finalRequest.redirectedTo())
      finalRequest = finalRequest.redirectedTo()!;
    await assertResponse(
      await finalRequest.response(),
      "Halaman setelah penyimpanan BA-5",
    );
    assertWebsite(page, cfg);
    if (!new URL(page.url()).pathname.startsWith("/pidum/pdm-ba5/"))
      throw new Error(
        "Penyimpanan BA-5 dialihkan ke halaman yang tidak diharapkan",
      );
  }
  // Buka ulang perkara: respons POST sukses belum membuktikan data benar-benar tersimpan.
  await openCase(page, cfg, record);
  if (
    (await page.locator(cfg.selectors.register_bb).inputValue()) !==
    record.evidenceNumber
  )
    throw new Error(
      "Nomor register barang bukti tidak tersimpan sesuai result.json",
    );
  await verifyRows(page, cfg, record, catalog, existingCount);
}
