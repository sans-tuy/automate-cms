import { readFile } from "node:fs/promises";

// Selector adalah alamat elemen HTML yang digunakan Playwright.
// Jika tampilan website berubah, override lewat selectors di konfigurasi.json.
export const DEFAULT_SELECTORS = {
  // Login dan navigasi menuju daftar perkara.
  login_username: "#login-form-login",
  login_password: "#login-form-password",
  login_submit: '#login-form button[name="login-button"]',
  home_link: 'a[href="/pidum/home/index"]',
  case_search: "#pdmgridtahap2search-no_register_perkara",
  case_submit: "button.cari_tahap2",
  case_rows: "#pdm-tahap-dua-pjax tbody tr[data-id]",
  case_cell: 'td[data-col-seq="3"]',
  ba5_link: '.sidebar-menu li[data-id="341"] a',
  // Tabel BA-5 dan isian pada modal tambah barang bukti.
  ba5_form: "#pdm-ba5-form",
  evidence_rows: "#table_barbuk tbody tr",
  add_button: "a.tambahBarbuk",
  modal: "#m_barbuk .modal-content",
  modal_name: "#m_barbuk #nm_barbuk",
  modal_quantity: "#m_barbuk #jml_barbuk",
  modal_unit: "#m_barbuk #satuan_barbuk",
  modal_seized_from: "#m_barbuk #sita_barbuk",
  modal_storage: "#m_barbuk #tmpt_simpan_barbuk",
  modal_condition: "#m_barbuk #kondisi_barbuk",
  modal_save: "#m_barbuk #simpan-barbuk",
  register_bb: "#pdmba5-no_reg_bukti",
  // Dua tahap Save: barang terlebih dahulu, kemudian nomor register.
  // Override register_submit jika tombol kedua berada di form/modal terpisah.
  form_submit: '#pdm-ba5-form button[type="submit"]',
  register_submit: '#pdm-ba5-form button[type="submit"]',
};

export type Selectors = typeof DEFAULT_SELECTORS;
export interface AppConfig {
  base_url: string;
  login_path: string;
  case_index_path: string;
  timeout_ms: number;
  manual_login_timeout_ms: number;
  headless: boolean;
  selectors: Selectors;
}

/** Memvalidasi konfigurasi dan melengkapi field yang tidak diisi dengan default. */
export function parseConfig(raw: unknown): AppConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new Error("Konfigurasi harus objek JSON");
  const data = raw as Record<string, unknown>;
  if (typeof data.base_url !== "string")
    throw new Error("Isi base_url website");
  let url: URL;
  try {
    url = new URL(data.base_url);
  } catch {
    throw new Error("base_url tidak valid");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "base_url harus URL HTTP/HTTPS tanpa kredensial, query, atau fragment",
    );
  }
  // Path navigasi harus tetap berada pada origin website yang dikonfigurasi.
  const path = (key: string, fallback: string): string => {
    const value = data[key] ?? fallback;
    if (
      typeof value !== "string" ||
      !value.startsWith("/") ||
      value.startsWith("//") ||
      new URL(value, url).origin !== url.origin
    ) {
      throw new Error(`${key} harus path website yang diawali '/'`);
    }
    return value;
  };
  // Semua timeout memakai milidetik; batasi nilainya agar penantian tetap terukur.
  const duration = (key: string, fallback: number): number => {
    const value = data[key] ?? fallback;
    if (
      typeof value !== "number" ||
      !Number.isSafeInteger(value) ||
      value <= 0 ||
      value > 600_000
    ) {
      throw new Error(`${key} harus bilangan bulat 1..600000`);
    }
    return value;
  };
  if (data.headless !== undefined && typeof data.headless !== "boolean")
    throw new Error("headless harus boolean");
  const custom = data.selectors ?? {};
  if (!custom || typeof custom !== "object" || Array.isArray(custom))
    throw new Error("selectors harus objek JSON");
  // Gabungkan override per field; salah ketik nama selector langsung menjadi error.
  const selectors: Selectors = { ...DEFAULT_SELECTORS };
  for (const [key, value] of Object.entries(custom)) {
    if (!Object.hasOwn(selectors, key))
      throw new Error(`Selector tidak dikenal: ${key}`);
    if (typeof value !== "string" || !value.trim())
      throw new Error(`Selector ${key} tidak boleh kosong`);
    (selectors as Record<string, string>)[key] = value;
  }
  return {
    base_url: url.origin,
    login_path: path("login_path", "/user/login"),
    case_index_path: path("case_index_path", "/pidum/pdm-tahap-dua/index"),
    timeout_ms: duration("timeout_ms", 30000),
    manual_login_timeout_ms: duration("manual_login_timeout_ms", 300000),
    headless: (data.headless as boolean | undefined) ?? false,
    selectors,
  };
}

/** Membaca JSON UTF-8; BOM dari editor Windows dibuang sebelum parsing. */
export async function loadConfig(file: string): Promise<AppConfig> {
  const text = await readFile(file, "utf8");
  return parseConfig(JSON.parse(text.replace(/^\uFEFF/, "")) as unknown);
}
