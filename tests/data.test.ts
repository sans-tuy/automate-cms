import assert from 'node:assert/strict';
import { mkdtemp, rm, rmdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadResult, validateRecords } from '../src/data.js';

function item(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    nama_barang: '1 SEPEDA MOTOR YAMAHA JUPITER BIRU L-3466-QY',
    jumlah: 1,
    satuan: 'Unit',
    ...overrides,
  };
}

function record(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    'Nomer register perkara': 'PDM-001/TEST/2026',
    'Nomer register Barang Bukti': 'RB-001/TEST/2026',
    barang_bukti: [item()],
    ...overrides,
  };
}

test('preserves supplied evidence fields without requiring a category', () => {
  const result = validateRecords([record({
    nama_pribadi: 'Ignored metadata',
    barang_bukti: [item({ nama_barang: '  Barang utama + pelengkap  ', satuan: 'unit WEBSITE',
      disita_dari: '  Pemilik barang  ', tempat_simpan: 'Gudang B', kondisi: 'Rusak' })],
  })]);
  assert.deepEqual(result.ready, [{
    index: 1,
    caseNumber: 'PDM-001/TEST/2026',
    evidenceNumber: 'RB-001/TEST/2026',
    items: [{ nama_barang: '  Barang utama + pelengkap  ', jumlah: '1', satuan: 'unit WEBSITE',
      disita_dari: '  Pemilik barang  ', tempat_simpan: 'Gudang B', kondisi: 'Rusak' }],
  }]);
  assert.equal(result.entries[0]?.status, 'READY');
  assert.equal(result.totalItems, 1);
  assert.equal(JSON.stringify(result).includes('Ignored metadata'), false);
});

test('does not classify or infer units even for narcotics', () => {
  const result = validateRecords([record({ barang_bukti: [item({
    nama_barang: 'Sabu netto 0.25 gram', jumlah: 1, satuan: 'Bungkus',
  })] })]);
  assert.equal(result.ready[0]?.items[0]?.satuan, 'Bungkus');
  assert.equal(result.ready[0]?.items[0]?.jumlah, '1');
});

test('optional evidence fields default when missing, null, or blank', () => {
  for (const value of [undefined, null, '', ' \t\n']) {
    const result = validateRecords([record({ barang_bukti: [item({
      disita_dari: value, tempat_simpan: value, kondisi: value,
    })] })]);
    assert.equal(result.entries[0]?.status, 'READY');
    assert.deepEqual(result.ready[0]?.items[0], {
      nama_barang: item().nama_barang, jumlah: '1', satuan: 'Unit',
      disita_dari: '', tempat_simpan: '', kondisi: 'Baik',
    });
  }
});

test('legacy category is ignored regardless of its value', () => {
  for (const kategori of [undefined, null, '', 'Kendaraan', 42]) {
    const result = validateRecords([record({ barang_bukti: [item({ kategori })] })]);
    assert.equal(result.entries[0]?.status, 'READY');
    assert.equal(Object.hasOwn(result.ready[0]!.items[0]!, 'kategori'), false);
  }
});

test('invalid optional field types hold the case for review', () => {
  for (const field of ['disita_dari', 'tempat_simpan', 'kondisi']) {
    for (const value of [1, false, [], {}]) {
      const result = validateRecords([record({ barang_bukti: [item(), item({ [field]: value })] })]);
      assert.equal(result.ready.length, 0);
      assert.equal(result.entries[0]?.status, 'REVIEW');
      assert.ok(result.entries[0]?.issues.some((issue) => issue.includes(`barang_bukti[2].${field}:`)));
    }
  }
});

test('retains decimal string precision and formats tiny numeric quantities without exponent', () => {
  const values = ['0.2500', '9007199254740993', '0.0000000000000000000123400', 0.25, 1.25e-7, Number.MIN_VALUE];
  const result = validateRecords([record({ barang_bukti: values.map((jumlah) => item({ jumlah })) })]);
  assert.equal(result.ready.length, 1);
  assert.deepEqual(result.ready[0]?.items.map((entry) => entry.jumlah), [
    '0.2500', '9007199254740993', '0.0000000000000000000123400', '0.25', '0.000000125',
    `0.${'0'.repeat(323)}5`,
  ]);
});

test('rejects invalid, absent, nonpositive, and unsafe numeric quantities', () => {
  const invalid = [null, undefined, false, {}, [], 0, -1, NaN, Infinity, -Infinity,
    Number.MAX_SAFE_INTEGER + 1, '', '0', '0.000', '-1', '+1', '01', '.5', '1.', '0,25', '1e3', ' 1 ', 'Infinity'];
  for (const jumlah of invalid) {
    const result = validateRecords([record({ barang_bukti: [item({ jumlah })] })]);
    assert.equal(result.ready.length, 0, `unexpected READY: ${String(jumlah)}`);
    assert.equal(result.entries[0]?.status, 'REVIEW');
    assert.match(result.entries[0]?.issues.join('\n') ?? '', /Baris JSON 1\.barang_bukti\[1\]\.jumlah/u);
  }
  const unsafe = validateRecords([record({ barang_bukti: [item({ jumlah: Number.MAX_SAFE_INTEGER + 1 })] })]);
  assert.match(unsafe.entries[0]?.issues.join(' ') ?? '', /string desimal/u);
});

test('holds an entire case with an invalid item and retains a separate valid case', () => {
  const result = validateRecords([
    record({ barang_bukti: [item(), item({ jumlah: null })] }),
    record({ 'Nomer register perkara': 'PDM-002/TEST/2026' }),
  ]);
  assert.equal(result.ready.length, 1);
  assert.equal(result.ready[0]?.index, 2);
  assert.deepEqual(result.entries.map((entry) => entry.status), ['REVIEW', 'READY']);
  assert.equal(result.entries[0]?.itemCount, 2);
  assert.equal(result.totalItems, 3);
  assert.match(result.entries[0]?.issues.join(' ') ?? '', /Baris JSON 1\.barang_bukti\[2\]\.jumlah/u);
});

test('all duplicated case numbers are REVIEW after case and whitespace normalization', () => {
  const result = validateRecords([
    record(),
    record({ 'Nomer register perkara': '  pdm-001 / TEST /2026  ' }),
    record({ 'Nomer register perkara': 'PDM-002/TEST/2026' }),
    record({ 'Nomer register perkara': 'PDM-001/TEST/2026', barang_bukti: [item({ jumlah: null })] }),
  ]);
  assert.deepEqual(result.entries.map((entry) => entry.status), ['REVIEW', 'REVIEW', 'READY', 'REVIEW']);
  assert.deepEqual(result.ready.map((entry) => entry.index), [3]);
  for (const index of [0, 1, 3]) {
    assert.match(result.entries[index]?.issues.join(' ') ?? '', /duplikat.*1, 2, 4/u);
  }
});

test('shared evidence register across distinct cases is allowed', () => {
  const result = validateRecords([record(), record({ 'Nomer register perkara': 'PDM-002/TEST/2026' })]);
  assert.equal(result.ready.length, 2);
});

test('all required string fields must exist and contain non-whitespace text', () => {
  for (const field of ['nama_barang', 'satuan']) {
    for (const value of [null, undefined, '', ' \t\n', 1]) {
      const result = validateRecords([record({ barang_bukti: [item({ [field]: value })] })]);
      assert.equal(result.ready.length, 0);
      assert.match(result.entries[0]?.issues.join(' ') ?? '', new RegExp(`\\.${field}:`, 'u'));
    }
  }
  for (const field of ['Nomer register perkara', 'Nomer register Barang Bukti']) {
    for (const value of [null, undefined, '', ' ', 1]) {
      const result = validateRecords([record({ [field]: value })]);
      assert.equal(result.ready.length, 0);
      assert.equal(result.entries[0]?.issues.some((issue) => issue.includes(field)), true);
    }
  }
});

test('malformed rows and items report their 1-based location without aborting validation', () => {
  const result = validateRecords([null, [], 42, record({ barang_bukti: [false, item({ jumlah: null })] }),
    record({ 'Nomer register perkara': 'PDM-005/TEST/2026' })]);
  assert.equal(result.entries.length, 5);
  assert.deepEqual(result.ready.map((entry) => entry.index), [5]);
  assert.equal(result.totalItems, 3);
  assert.match(result.entries[3]?.issues.join(' ') ?? '', /Baris JSON 4\.barang_bukti\[1\]/u);
  assert.match(result.entries[3]?.issues.join(' ') ?? '', /Baris JSON 4\.barang_bukti\[2\]\.jumlah/u);
});

test('missing, non-array, and empty barang_bukti require review', () => {
  for (const barang_bukti of [undefined, null, {}, '', []]) {
    const result = validateRecords([record({ barang_bukti })]);
    assert.equal(result.ready.length, 0);
    assert.equal(result.entries[0]?.status, 'REVIEW');
    assert.equal(result.totalItems, 0);
    assert.match(result.entries[0]?.issues.join(' ') ?? '', /Baris JSON 1\.barang_bukti/u);
  }
});

test('rejects non-array roots clearly and accepts an empty array', () => {
  for (const root of [null, {}, { data: [] }, '[]', 1]) {
    assert.throws(() => validateRecords(root), /akar JSON harus berupa array/u);
  }
  assert.deepEqual(validateRecords([]), { ready: [], entries: [], totalItems: 0 });
});

test('validation does not mutate its input', () => {
  const input = [record({ barang_bukti: [item({ jumlah: '0.2500' })] })];
  const before = structuredClone(input);
  validateRecords(input);
  assert.deepEqual(input, before);
});

test('loads UTF-8 BOM JSON and reports malformed files and missing files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'otomasi-data-test-'));
  try {
    const path = join(directory, 'result.json');
    await writeFile(path, `\uFEFF${JSON.stringify([record()])}`, 'utf8');
    assert.equal((await loadResult(path)).ready.length, 1);
    await writeFile(path, '{invalid JSON', 'utf8');
    await assert.rejects(loadResult(path), /JSON tidak valid/u);
    await writeFile(path, '{}', 'utf8');
    await assert.rejects(loadResult(path), /akar JSON harus berupa array/u);
    await assert.rejects(loadResult(join(directory, 'missing.json')), /Tidak dapat membaca file JSON/u);
  } finally {
    await rm(join(directory, 'result.json'), { force: true });
    await rmdir(directory);
  }
});
