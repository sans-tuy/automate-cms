import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseCliArgs, run } from '../src/run.js';
import { parseConfig } from '../src/config.js';

test('default CLI memakai result.json dan login otomatis pada mode production', () => {
  const options = parseCliArgs([]);
  assert.equal(options.input, 'result.json');
  assert.equal(options.mode, 'production');
  assert.equal(options.manualLogin, false);
  assert.equal(parseCliArgs(['--manual-login']).manualLogin, true);
});

test('CLI menolak argumen keliru dan output yang menimpa input', () => {
  for (const args of [ ['a.json', '--input', 'b.json'], ['--mode', 'ai'], ['--limit', '0'],
    ['--limit', '1.5'], ['--report', 'result.json'], ['--log', 'konfigurasi.json'] ]) {
    assert.throws(() => parseCliArgs(args));
  }
});

test('konfigurasi website memvalidasi URL, selector, dan durasi', () => {
  const config = parseConfig({ base_url: 'http://10.16.1.101:4111/user/login' });
  assert.equal(config.base_url, 'http://10.16.1.101:4111');
  assert.equal(config.login_path, '/user/login');
  assert.equal(Object.hasOwn(config.selectors, 'modal_category'), false);
  assert.equal(config.selectors.modal_condition, '#m_barbuk #kondisi_barbuk');
  const custom = parseConfig({ base_url: 'http://localhost', selectors: {
    modal_seized_from: '#disita', modal_storage: '#gudang', modal_condition: '#kondisi',
  } });
  assert.equal(custom.selectors.modal_seized_from, '#disita');
  assert.equal(custom.selectors.modal_storage, '#gudang');
  assert.equal(custom.selectors.modal_condition, '#kondisi');
  for (const raw of [null, { base_url: 'ftp://localhost' }, { base_url: 'http://localhost', timeout_ms: -1 },
    { base_url: 'http://localhost', selectors: { modal_condition: '' } },
    { base_url: 'http://localhost', login_path: '//other.example' },
    { base_url: 'http://localhost', headless: 'true' }]) assert.throws(() => parseConfig(raw));
});

test('dry-run menulis REVIEW untuk jumlah null dan mempertahankan input asli', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'otomasi-json-test-'));
  const input = join(directory, 'result.json');
  const config = join(directory, 'config.json');
  const report = join(directory, 'report.json');
  const source = JSON.stringify([
    { 'Nomer register perkara': 'CASE-1', 'Nomer register Barang Bukti': 'BB-1',
      barang_bukti: [{ nama_barang: '1 bungkus pil', jumlah: 1, satuan: 'Buah', kondisi: 'Baik', disita_dari: 'Pemilik', tempat_simpan: 'Gudang' }] },
    { 'Nomer register perkara': 'CASE-2', 'Nomer register Barang Bukti': 'BB-2',
      barang_bukti: [{ nama_barang: 'Buku', jumlah: null, satuan: 'Buah' }] },
  ]);
  try {
    await writeFile(input, source);
    await writeFile(config, JSON.stringify({ base_url: 'http://website-yang-tidak-diakses.invalid' }));
    assert.equal(await run(['--mode', 'dry-run', '--input', input, '--config', config, '--report', report]), 2);
    assert.equal(await readFile(input, 'utf8'), source);
    const output = JSON.parse(await readFile(report, 'utf8'));
    assert.equal(output.total_cases, 2);
    assert.equal(output.entries[0].status, 'READY');
    assert.equal(output.entries[1].status, 'REVIEW');
    assert.equal(output.source, resolve(input));
  } finally {
    // Hapus hanya direktori sementara yang baru dibuat oleh tes ini.
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + '\\') || resolve(directory).startsWith(resolve(tmpdir()) + '/'));
    assert.ok(directory.includes('otomasi-json-test-'));
    await rm(directory, { recursive: true, force: true });
  }
});
