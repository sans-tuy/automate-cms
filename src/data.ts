import { readFile } from "node:fs/promises";

/** Barang tervalidasi; field opsional dari JSON sudah memiliki nilai default. */
export interface EvidenceItem {
  nama_barang: string;
  jumlah: string;
  satuan: string;
  disita_dari: string;
  tempat_simpan: string;
  kondisi: string;
}

/** Data perkara yang sudah aman digunakan oleh otomasi browser. */
export interface CaseRecord {
  /** Posisi kasus pada array JSON, dimulai dari 1. */
  index: number;
  caseNumber: string;
  evidenceNumber: string;
  items: EvidenceItem[];
}

/** Satu entri laporan; issues berisi lokasi field dan alasan perlunya REVIEW. */
export interface ValidationEntry {
  index: number;
  caseNumber: string | null;
  evidenceNumber: string | null;
  status: "READY" | "REVIEW";
  issues: string[];
  itemCount: number;
}

export interface ValidationResult {
  ready: CaseRecord[];
  entries: ValidationEntry[];
  /** Semua elemen barang_bukti, termasuk kasus yang berstatus REVIEW. */
  totalItems: number;
}

// Nama kunci harus mengikuti JSON sumber, termasuk ejaan "Nomer".
const CASE_NUMBER = "Nomer register perkara";
const EVIDENCE_NUMBER = "Nomer register Barang Bukti";
const DECIMAL = /^(?:0|[1-9]\d*)(?:\.\d+)?$/u;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonemptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** Mengubah representasi eksponen JS menjadi desimal untuk isian website. */
function numberAsDecimal(value: number): string {
  const representation = String(value);
  const [coefficient = "", exponentText] = representation
    .toLowerCase()
    .split("e");
  if (exponentText === undefined) return representation;

  const [integerPart = "", fractionalPart = ""] = coefficient.split(".");
  const digits = integerPart + fractionalPart;
  const decimalPosition = integerPart.length + Number(exponentText);
  if (decimalPosition <= 0) return `0.${"0".repeat(-decimalPosition)}${digits}`;
  if (decimalPosition >= digits.length) {
    return digits + "0".repeat(decimalPosition - digits.length);
  }
  return `${digits.slice(0, decimalPosition)}.${digits.slice(decimalPosition)}`;
}

/** Menghasilkan teks jumlah untuk form, atau null sambil menambahkan alasan review. */
function quantity(
  value: unknown,
  path: string,
  issues: string[],
): string | null {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) {
      issues.push(`${path}: jumlah harus positif dan berhingga.`);
      return null;
    }
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
      issues.push(
        `${path}: angka bulat melampaui presisi aman JSON; tulis sebagai string desimal.`,
      );
      return null;
    }
    return numberAsDecimal(value);
  }

  if (
    typeof value === "string" &&
    DECIMAL.test(value) &&
    /[1-9]/u.test(value)
  ) {
    // Jangan konversikan ke Number: digit dan nol desimal sumber harus tetap utuh.
    return value;
  }

  issues.push(
    `${path}: isi jumlah dengan angka positif atau string desimal positif (contoh "0.25"); ` +
      "null, koma desimal, tanda, spasi, dan eksponen tidak diterima.",
  );
  return null;
}

function requiredString(
  value: unknown,
  path: string,
  issues: string[],
): string | null {
  if (nonemptyString(value)) return value;
  issues.push(`${path}: wajib berupa string yang tidak kosong.`);
  return null;
}

// Default hanya untuk nilai hilang/null/kosong; tipe yang salah tetap perlu REVIEW.
function optionalString(
  value: unknown,
  fallback: string,
  path: string,
  issues: string[],
): string | null {
  if (value === undefined || value === null) return fallback;
  if (typeof value === "string") return value.trim() ? value : fallback;
  issues.push(`${path}: harus berupa string jika diisi.`);
  return null;
}

/**
 * Memvalidasi result.json dan menerapkan default field opsional, tanpa
 * mengubah nama barang atau satuan. Satu barang tidak valid
 * menahan seluruh kasus agar pengisian tidak menyimpan kasus yang tidak lengkap.
 */
export function validateRecords(input: unknown): ValidationResult {
  if (!Array.isArray(input)) {
    throw new Error(
      "Format result.json tidak valid: akar JSON harus berupa array kasus.",
    );
  }

  const entries: ValidationEntry[] = [];
  const candidates: CaseRecord[] = [];
  const caseGroups = new Map<string, ValidationEntry[]>();
  let totalItems = 0;

  for (const [offset, value] of input.entries()) {
    const index = offset + 1;
    const rowPath = `Baris JSON ${index}`;
    const issues: string[] = [];
    const entry: ValidationEntry = {
      index,
      caseNumber: null,
      evidenceNumber: null,
      status: "REVIEW",
      issues,
      itemCount: 0,
    };
    entries.push(entry);

    if (!isObject(value)) {
      issues.push(`${rowPath}: kasus harus berupa objek.`);
      continue;
    }

    entry.caseNumber = requiredString(
      value[CASE_NUMBER],
      `${rowPath}["${CASE_NUMBER}"]`,
      issues,
    );
    entry.evidenceNumber = requiredString(
      value[EVIDENCE_NUMBER],
      `${rowPath}["${EVIDENCE_NUMBER}"]`,
      issues,
    );

    // Normalisasi hanya untuk mendeteksi duplikasi, bukan mengubah nomor yang diinput.
    if (entry.caseNumber !== null) {
      const normalized = entry.caseNumber.replace(/\s+/gu, "").toLowerCase();
      const group = caseGroups.get(normalized) ?? [];
      group.push(entry);
      caseGroups.set(normalized, group);
    }

    const items: EvidenceItem[] = [];
    if (!Array.isArray(value.barang_bukti)) {
      issues.push(`${rowPath}.barang_bukti: wajib berupa array barang.`);
    } else {
      entry.itemCount = value.barang_bukti.length;
      totalItems += entry.itemCount;
      if (entry.itemCount === 0)
        issues.push(
          `${rowPath}.barang_bukti: wajib berisi minimal satu barang.`,
        );

      for (const [itemOffset, item] of value.barang_bukti.entries()) {
        const itemPath = `${rowPath}.barang_bukti[${itemOffset + 1}]`;
        if (!isObject(item)) {
          issues.push(`${itemPath}: barang harus berupa objek.`);
          continue;
        }
        const nama_barang = requiredString(
          item.nama_barang,
          `${itemPath}.nama_barang`,
          issues,
        );
        const jumlah = quantity(item.jumlah, `${itemPath}.jumlah`, issues);
        const satuan = requiredString(
          item.satuan,
          `${itemPath}.satuan`,
          issues,
        );
        // Ubah fallback di sini jika kebijakan isian bawaan kantor berubah.
        // Nilai eksplisit dari JSON tetap dipertahankan.
        const disita_dari = optionalString(
          item.disita_dari,
          "Terdakwa / Saksi",
          `${itemPath}.disita_dari`,
          issues,
        );
        const tempat_simpan = optionalString(
          item.tempat_simpan,
          "Gudang Barang Bukti Kejaksaan Negeri Surabaya",
          `${itemPath}.tempat_simpan`,
          issues,
        );
        const kondisi = optionalString(
          item.kondisi,
          "Baik",
          `${itemPath}.kondisi`,
          issues,
        );
        if (
          nama_barang !== null &&
          jumlah !== null &&
          satuan !== null &&
          disita_dari !== null &&
          tempat_simpan !== null &&
          kondisi !== null
        ) {
          items.push({
            nama_barang,
            jumlah,
            satuan,
            disita_dari,
            tempat_simpan,
            kondisi,
          });
        }
      }
    }

    if (
      issues.length === 0 &&
      entry.caseNumber !== null &&
      entry.evidenceNumber !== null
    ) {
      entry.status = "READY";
      candidates.push({
        index,
        caseNumber: entry.caseNumber,
        evidenceNumber: entry.evidenceNumber,
        items,
      });
    }
  }

  // Pemeriksaan duplikasi dilakukan setelah semua baris dibaca agar setiap entri
  // dengan nomor perkara yang sama ditahan, termasuk kandidat READY sebelumnya.
  for (const group of caseGroups.values()) {
    if (group.length < 2) continue;
    const rows = group.map((entry) => entry.index).join(", ");
    for (const entry of group) {
      entry.status = "REVIEW";
      entry.issues.push(
        `Baris JSON ${entry.index}["${CASE_NUMBER}"]: nomor perkara duplikat pada baris JSON ${rows}; ` +
          "gabungkan atau perbaiki kasus sebelum pengisian.",
      );
    }
  }

  const readyIndexes = new Set(
    entries
      .filter((entry) => entry.status === "READY")
      .map((entry) => entry.index),
  );
  return {
    ready: candidates.filter((record) => readyIndexes.has(record.index)),
    entries,
    totalItems,
  };
}

/** Membaca dan memvalidasi input tanpa menulis atau mengubah file JSON sumber. */
export async function loadResult(path: string): Promise<ValidationResult> {
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    throw new Error(`Tidak dapat membaca file JSON: ${path}`, { cause: error });
  }

  let input: unknown;
  try {
    input = JSON.parse(content.replace(/^\uFEFF/u, "")) as unknown;
  } catch (error) {
    throw new Error(
      `JSON tidak valid pada file: ${path}. Periksa sintaks JSON.`,
      { cause: error },
    );
  }
  return validateRecords(input);
}
