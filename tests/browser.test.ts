import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright';
import { chooseOption, fillCase, login, openCase } from '../src/browser.js';
import { parseConfig } from '../src/config.js';
import { validateRecords, type CaseRecord, type EvidenceItem } from '../src/data.js';

let browser: Browser;
before(async () => { browser = await chromium.launch({ headless: true }); });
after(async () => { await browser?.close(); });

const cfg = parseConfig({ base_url: 'http://fixture.local', timeout_ms: 5000 });
const record: CaseRecord = {
  index: 1, caseNumber: 'PDM-123/2026', evidenceNumber: 'BB-51/2026', items: [
    { nama_barang: 'Sabu netto 0,25 gram', jumlah: '0.25', satuan: 'Gram', disita_dari: 'Pemilik A', tempat_simpan: 'Gudang A', kondisi: 'Rusak' },
    { nama_barang: 'Sepuluh pil dalam plastik', jumlah: '10', satuan: 'Butir', disita_dari: '', tempat_simpan: '', kondisi: 'Baik' },
  ],
};
const html = (value: string): string => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
interface Settings {
  units?: string[];
  conditions?: string[];
  populated?: boolean;
  discardSave?: boolean;
  wrongRegister?: boolean;
  wrongQuantity?: boolean;
  wrongFields?: Partial<EvidenceItem>;
  changeStorageOnCondition?: boolean;
  hiddenDetails?: boolean;
  ajaxSave?: boolean;
  redirectLogin?: boolean;
  searchRows?: { id: string; cell: string }[];
  searchColumn?: string;
}

async function fixture(settings: Settings = {}): Promise<{
  page: Page; state: { saves: number; items: EvidenceItem[]; events: string[]; register: string; visits: number };
}> {
  const page = await browser.newPage();
  const state = { saves: 0, items: settings.populated ? record.items.slice(0, 1) : [] as EvidenceItem[], events: [] as string[], register: '', visits: 0 };
  await page.route('http://fixture.local/**', async route => {
    const url = new URL(route.request().url());
    const respond = (body: string) => route.fulfill({ contentType: 'text/html', body });
    if (url.pathname === '/user/login') return respond('<form id="login-form"><input id="login-form-login"><input id="login-form-password"><button name="login-button">Login</button></form>');
    if (url.pathname === '/pidum/pdm-tahap-dua/index') {
      if (url.searchParams.has('search')) return route.fulfill({ contentType: 'application/json', body: JSON.stringify(settings.searchRows ?? [{ id: record.caseNumber, cell: record.caseNumber }]) });
      return respond(`<input id="pdmgridtahap2search-no_register_perkara"><button class="cari_tahap2">Cari</button>
        <div id="pdm-tahap-dua-pjax"><table><tbody></tbody></table></div>
        <script>
        document.querySelector('button').onclick = async () => {
          const result = await fetch('/pidum/pdm-tahap-dua/index?search=' + encodeURIComponent(document.querySelector('input').value)).then(r => r.json());
          const tbody = document.querySelector('tbody'); tbody.replaceChildren();
          for (const row of result) {
            const tr = document.createElement('tr'); tr.dataset.id = row.id;
            const td = document.createElement('td'); td.dataset.colSeq = ${JSON.stringify(settings.searchColumn ?? '3')}; td.textContent = row.cell;
            tr.ondblclick = () => location.href = '/pidum/pdm-tahap-dua/update?id=' + encodeURIComponent(row.id);
            tr.append(td); tbody.append(tr);
          }
        };
        </script>`);
    }
    if (url.pathname === '/pidum/pdm-tahap-dua/update') return respond('<ul class="sidebar-menu"><li data-id="341"><a href="/pidum/pdm-ba5/update?id=1">BA5</a></li></ul>');
    if (url.pathname === '/pidum/pdm-ba5/update' && route.request().method() === 'POST') {
      state.saves += 1;
      const form = new URLSearchParams(route.request().postData() ?? '');
      state.events = JSON.parse(form.get('events') ?? '[]') as string[];
      state.items = settings.discardSave ? [] : JSON.parse(form.get('items') ?? '[]') as EvidenceItem[];
      if (settings.wrongQuantity && state.items[0]) state.items[0].jumlah = '0';
      if (state.items[0]) Object.assign(state.items[0], settings.wrongFields);
      state.register = settings.wrongRegister ? 'SALAH' : form.get('register') ?? '';
      // Playwright page.route handles only the first URL of HTTP redirects, so
      // fixture document POSTs return a 200 page and never hit a real hostname.
      return respond('<p>Disimpan</p>');
    }
    if (url.pathname === '/pidum/pdm-ba5/index') return respond('<p>Disimpan</p>');
    if (url.pathname === '/pidum/pdm-ba5/update') {
      state.visits += 1;
      const select = (id: string, values: string[]) => `<select id="${id}"><option value="">Pilih</option>${values.map((value, index) => `<option value="v${index}">${html(value)}</option>`).join('')}</select>`;
      const itemRow = (item: EvidenceItem) => settings.hiddenDetails
        ? `<tr><td>${html(item.nama_barang)}
          <input type="hidden" name="sita_barbuk[]" value="${html(item.disita_dari)}">
          <input type="hidden" name="tmpt_simpan_barbuk[]" value="${html(item.tempat_simpan)}">
          <input type="hidden" name="kondisi_barbuk[]" value="v${(settings.conditions ?? ['Baik', 'Rusak']).indexOf(item.kondisi)}">
          </td><td>${item.jumlah}</td><td>${html(item.satuan)}</td></tr>`
        : `<tr>${Object.values(item).map(value => `<td>${html(value)}</td>`).join('')}</tr>`;
      return respond(`<form id="pdm-ba5-form" method="post" action="${settings.redirectLogin ? '/user/login' : '/pidum/pdm-ba5/update?id=1'}">
        <input name="register" id="pdmba5-no_reg_bukti" value="${html(state.register)}" ${state.saves ? '' : 'hidden disabled'}>
        <input type="hidden" name="items"><input type="hidden" name="events">
        <table id="table_barbuk"><thead><tr><th>Nama barang</th><th>Jumlah</th><th>Satuan</th><th>Disita dari</th><th>Tempat simpan</th><th>Kondisi</th></tr></thead>
        <tbody>${state.items.map(itemRow).join('')}</tbody></table>
        <a href="#" class="tambahBarbuk">Tambah</a><button type="submit">Simpan BA5</button>
        </form>
        <div id="m_barbuk" hidden><div class="modal-content"><input id="nm_barbuk"><input id="jml_barbuk">
        ${select('satuan_barbuk', settings.units ?? ['Gram', 'Butir'])}
        <input id="sita_barbuk"><input id="tmpt_simpan_barbuk">
        ${select('kondisi_barbuk', settings.conditions ?? ['Baik', 'Rusak'])}
        <button id="simpan-barbuk">Simpan barang</button></div></div>
        <script>
        const items = ${JSON.stringify(state.items).replaceAll('<', '\\u003c')};
        const events = [];
        document.querySelector('#pdmba5-no_reg_bukti').oninput = () => events.push('register');
        const modal = document.querySelector('#m_barbuk');
        document.querySelector('.tambahBarbuk').onclick = event => {
          event.preventDefault(); events.push('open'); modal.hidden = false;
          document.querySelector('#nm_barbuk').value = ''; document.querySelector('#jml_barbuk').value = '';
        };
        document.querySelector('#simpan-barbuk').onclick = () => {
          const unit = document.querySelector('#satuan_barbuk'), condition = document.querySelector('#kondisi_barbuk');
          const item = { nama_barang: document.querySelector('#nm_barbuk').value, jumlah: document.querySelector('#jml_barbuk').value,
            satuan: unit.selectedOptions[0].textContent, disita_dari: document.querySelector('#sita_barbuk').value,
            tempat_simpan: document.querySelector('#tmpt_simpan_barbuk').value, kondisi: condition.selectedOptions[0].textContent };
          events.push('item:' + item.nama_barang); modal.hidden = true;
          setTimeout(() => {
            items.push(item); const tr = document.createElement('tr');
            for (const value of Object.values(item)) { const td = document.createElement('td'); td.textContent = value; tr.append(td); }
            document.querySelector('#table_barbuk tbody').append(tr);
          }, 40);
        };
        if (${Boolean(settings.changeStorageOnCondition)}) {
          document.querySelector('#kondisi_barbuk').onchange = () => document.querySelector('#tmpt_simpan_barbuk').value = 'Gudang lain';
        }
        document.querySelector('form').onsubmit = event => {
          const register = document.querySelector('#pdmba5-no_reg_bukti');
          if (register.hidden) {
            event.preventDefault(); events.push('save-items');
            setTimeout(() => { register.hidden = false; register.disabled = false; }, 80);
            return;
          }
          events.push('submit'); document.querySelector('[name=items]').value = JSON.stringify(items);
          document.querySelector('[name=events]').value = JSON.stringify(events);
          if (${Boolean(settings.ajaxSave)}) {
            event.preventDefault();
            fetch(event.target.action, { method: 'POST', body: new URLSearchParams(new FormData(event.target)) });
          }
        };
        </script>`);
    }
    return route.fulfill({ status: 404, body: 'Unknown fixture route' });
  });
  await page.goto('http://fixture.local/pidum/pdm-ba5/update?id=1');
  return { page, state };
}

test('dropdown uses exact normalized labels and rejects unavailable, disabled, or duplicate labels', async () => {
  const page = await browser.newPage();
  try {
    await page.setContent('<select><option value="">Pilih</option><option value="g">  GRAM </option><option value="kg">Kilogram</option><option disabled value="b">Butir</option></select>');
    const select = page.locator('select');
    await chooseOption(select, 'gram');
    assert.equal(await select.inputValue(), 'g');
    await assert.rejects(chooseOption(select, 'ram'), /tidak tersedia/);
    await assert.rejects(chooseOption(select, 'Butir'), /tidak tersedia/);
    await page.setContent('<select><option value="a">Gram</option><option value="b"> gram </option></select>');
    await assert.rejects(chooseOption(select, 'Gram'), /tidak unik/);
  } finally { await page.close(); }
});

test('all units are checked before adding the first item', async () => {
  const { page, state } = await fixture({ units: ['Gram'] });
  try {
    await assert.rejects(fillCase(page, cfg, record), /Butir/);
    assert.equal(await page.locator(cfg.selectors.evidence_rows).count(), 0);
    assert.equal(await page.locator(cfg.selectors.modal_name).inputValue(), '');
    assert.equal(state.saves, 0);
  } finally { await page.close(); }
});

test('all conditions are checked before adding the first item', async () => {
  const { page, state } = await fixture({ conditions: ['Rusak'] });
  try {
    await assert.rejects(fillCase(page, cfg, record), /Baik/);
    assert.equal(await page.locator(cfg.selectors.evidence_rows).count(), 0);
    assert.equal(await page.locator(cfg.selectors.modal_name).inputValue(), '');
    assert.equal(state.saves, 0);
  } finally { await page.close(); }
});

test('ambiguous conditions are rejected before any item is added', async () => {
  const { page, state } = await fixture({ conditions: ['Baik', 'Rusak', ' rusak '] });
  try {
    await assert.rejects(fillCase(page, cfg, record), /tidak unik/);
    assert.equal(await page.locator(cfg.selectors.evidence_rows).count(), 0);
    assert.equal(state.saves, 0);
  } finally { await page.close(); }
});

test('existing BA5 items are retained while new items are added and saved', async () => {
  const { page, state } = await fixture({ populated: true });
  try {
    await fillCase(page, cfg, record);
    assert.deepEqual(state.items, [record.items[0], ...record.items]);
    assert.equal(state.register, record.evidenceNumber);
    assert.equal(state.saves, 1);
  } finally { await page.close(); }
});

test('saves items before the register field appears, then saves and verifies persisted data', async () => {
  const { page, state } = await fixture();
  try {
    assert.equal(await page.locator(cfg.selectors.register_bb).isVisible(), false);
    assert.equal(await page.locator(cfg.selectors.register_bb).isEnabled(), false);
    await fillCase(page, cfg, record);
    assert.deepEqual(state.items, record.items);
    assert.equal(state.register, record.evidenceNumber);
    assert.equal(state.saves, 1);
    assert.equal(state.visits, 2);
    assert.deepEqual(state.events, ['open', `item:${record.items[0]!.nama_barang}`, 'open', `item:${record.items[1]!.nama_barang}`, 'save-items', 'register', 'submit']);
  } finally { await page.close(); }
});

test('register can appear in a separate form after saving items', async () => {
  const { page, state } = await fixture();
  try {
    await page.evaluate(() => {
      const form = document.querySelector<HTMLFormElement>('#pdm-ba5-form')!;
      form.addEventListener('submit', () => {
        const register = document.querySelector<HTMLInputElement>('#pdmba5-no_reg_bukti')!;
        if (!register.hidden) return;
        const next = document.createElement('form');
        next.id = 'register-form'; next.method = 'post'; next.action = form.action;
        next.onsubmit = form.onsubmit;
        next.append(register, form.querySelector('[name=items]')!, form.querySelector('[name=events]')!);
        const button = document.createElement('button'); button.type = 'submit'; button.textContent = 'Save register';
        next.append(button); document.body.append(next);
      });
    });
    await fillCase(page, {
      ...cfg, selectors: { ...cfg.selectors, register_submit: '#register-form button' },
    }, record);
    assert.equal(state.register, record.evidenceNumber);
    assert.deepEqual(state.items, record.items);
  } finally { await page.close(); }
});

test('optional fields from JSON reach the form with their defaults', async () => {
  const { page, state } = await fixture();
  try {
    const validation = validateRecords([{
      'Nomer register perkara': record.caseNumber,
      'Nomer register Barang Bukti': record.evidenceNumber,
      barang_bukti: [{ nama_barang: 'Barang', jumlah: 1, satuan: 'Gram' }],
    }]);
    await fillCase(page, cfg, validation.ready[0]!);
    assert.deepEqual(state.items, [{ nama_barang: 'Barang', jumlah: '1', satuan: 'Gram',
      disita_dari: '', tempat_simpan: '', kondisi: 'Baik' }]);
    assert.deepEqual(state.events, ['open', 'item:Barang', 'save-items', 'register', 'submit']);
  } finally { await page.close(); }
});

test('persisted hidden details support condition option values', async () => {
  const { page, state } = await fixture({ hiddenDetails: true });
  try {
    await fillCase(page, cfg, record);
    assert.deepEqual(state.items, record.items);
    assert.equal(state.visits, 2);
  } finally { await page.close(); }
});

test('a change to storage after filling is caught before the item is saved', async () => {
  const { page, state } = await fixture({ changeStorageOnCondition: true });
  try {
    await assert.rejects(fillCase(page, cfg, record), /Tempat simpan berubah sebelum disimpan/);
    assert.equal(await page.locator(cfg.selectors.evidence_rows).count(), 0);
    assert.equal(state.saves, 0);
  } finally { await page.close(); }
});

for (const hiddenDetails of [false, true]) {
test(`persisted ${hiddenDetails ? 'hidden' : 'visible'} condition, seizure source, and storage must match JSON`, async () => {
  for (const [wrongFields, message] of [
    [{ kondisi: 'Baik' }, /Kondisi barang tidak tersimpan/],
    [{ disita_dari: '' }, /Disita dari barang tidak tersimpan/],
    [{ tempat_simpan: '' }, /Tempat simpan barang tidak tersimpan/],
  ] as const) {
    const { page, state } = await fixture({ wrongFields, hiddenDetails });
    try {
      await assert.rejects(fillCase(page, cfg, record), message);
      assert.equal(state.saves, 1);
    } finally { await page.close(); }
  }
});
}

test('AJAX save also verifies persistence without requiring a navigation', async () => {
  const { page, state } = await fixture({ ajaxSave: true });
  try {
    await fillCase(page, cfg, record);
    assert.deepEqual(state.items, record.items);
    assert.equal(state.saves, 1);
    assert.equal(state.visits, 2);
  } finally { await page.close(); }
});

test('HTTP success cannot report success when the saved items were discarded', async () => {
  const { page, state } = await fixture({ discardSave: true });
  try {
    await assert.rejects(fillCase(page, cfg, record), /Jumlah barang pada BA-5 berbeda/);
    assert.equal(state.saves, 1);
  } finally { await page.close(); }
});

test('persisted register must match exactly', async () => {
  const { page } = await fixture({ wrongRegister: true });
  try { await assert.rejects(fillCase(page, cfg, record), /Nomor register barang bukti tidak tersimpan/); }
  finally { await page.close(); }
});

test('a login navigation after save is an error', async () => {
  const { page } = await fixture({ redirectLogin: true });
  try { await assert.rejects(fillCase(page, cfg, record), /halaman login/); }
  finally { await page.close(); }
});

test('persisted decimal quantity cannot silently become zero', async () => {
  const { page } = await fixture({ wrongQuantity: true });
  try { await assert.rejects(fillCase(page, cfg, record), /Jumlah barang tidak tersimpan/); }
  finally { await page.close(); }
});

test('case search opens the row by data-id independently of cell text or column', async () => {
  const { page, state } = await fixture({
    searchColumn: '9',
    searchRows: [{ id: record.caseNumber, cell: 'Detail perkara' }, { id: 'OTHER', cell: record.caseNumber }],
  });
  try {
    await openCase(page, cfg, record);
    assert.equal(new URL(page.url()).pathname, '/pidum/pdm-ba5/update');
    assert.equal(state.visits, 2);
  } finally { await page.close(); }
});

test('case search rejects partial data-id matches even when cell text matches', async () => {
  const { page } = await fixture({ searchRows: [{ id: `${record.caseNumber}0`, cell: record.caseNumber }, { id: 'OTHER', cell: record.caseNumber }] });
  try { await assert.rejects(openCase(page, { ...cfg, timeout_ms: 300 }, record), { name: 'TimeoutError' }); }
  finally { await page.close(); }
});

test('case search rejects duplicate exact results', async () => {
  const row = { id: record.caseNumber, cell: record.caseNumber };
  const { page } = await fixture({ searchRows: [row, row] });
  try { await assert.rejects(openCase(page, cfg, record), /tidak unik/); }
  finally { await page.close(); }
});

test('automatic login requires credentials before opening the website', async () => {
  const page = await browser.newPage();
  try {
    await assert.rejects(login(page, cfg), /BB_USERNAME/);
    assert.equal(page.url(), 'about:blank');
  } finally { await page.close(); }
});
