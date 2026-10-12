import argparse
import csv
import json
import os
from datetime import datetime
from pathlib import Path

from openpyxl import load_workbook
from playwright.sync_api import expect, sync_playwright

from ai_client import AIServiceError
from klasifikasi import ReviewRequired, SemanticClassifier, norm


def load_rows(path):
    workbook = load_workbook(path, read_only=True, data_only=True)
    try:
        values = workbook.active.iter_rows(values_only=True)
        headers = [norm(x) for x in next(values, ())]
        required = ["nomer register perkara", "barang bukti", "nomer register barang bukti"]
        missing = [x for x in required if x not in headers]
        if missing:
            raise ValueError(f"Kolom Excel belum ada: {', '.join(missing)}")
        for index, cells in enumerate(values, start=2):
            row = dict(zip(headers, cells))
            if not norm(row.get("nomer register perkara")):
                if norm(row.get("barang bukti")) or norm(row.get("nomer register barang bukti")):
                    raise ValueError(f"Baris {index}: nomor register perkara kosong padahal data barang bukti ada")
                continue
            items = [x.strip() for x in str(row.get("barang bukti") or "").split(";") if x.strip()]
            numbers = [x.strip() for x in str(row.get("nomer register barang bukti") or "").split(";") if x.strip()]
            if not items or len(numbers) != 1:
                raise ValueError(f"Baris {index}: isi barang bukti dan tepat satu No Register Barang Bukti")
            yield index, str(row["nomer register perkara"]).strip(), [(item, numbers[0]) for item in items]
    finally:
        workbook.close()


def selector(cfg, key, **parts):
    return cfg["selectors"][key].format(**parts)


def choose_option(page, css, desired):
    control = page.locator(css)
    options = control.locator("option").evaluate_all("els => els.map(e => ({label:e.textContent.trim(),value:e.value}))")
    matches = [x for x in options if norm(x["label"]) == norm(desired) and x["value"]]
    if len(matches) != 1:
        raise ValueError(f"Opsi {desired!r} tidak unik/tidak tersedia pada {css}: {[x['label'] for x in options]}")
    control.select_option(value=matches[0]["value"])


def append_log(path, row, case, item, number, status, detail):
    exists = path.exists()
    with path.open("a", encoding="utf-8-sig", newline="") as stream:
        writer = csv.writer(stream)
        if not exists:
            writer.writerow(["waktu", "baris_excel", "nomer register perkara", "barang bukti", "nomer register barang bukti", "status", "keterangan"])
        writer.writerow([datetime.now().isoformat(timespec="seconds"), row, case, item, number, status, detail])


def analyze_rows(rows, classifier, log):
    """Selesaikan penilaian satu perkara sebelum memasukkannya ke antrean web."""
    ready, report = [], []
    for row, case, pairs in rows:
        record = {"baris_excel": row, "nomer_register_perkara": case,
                  "status": "READY", "items": []}
        report.append(record)
        numbers = {number for _, number in pairs}
        if len(numbers) != 1 or not pairs:
            detail = "Isi barang bukti dan tepat satu nomor register BA-5 per perkara"
            record.update(status="REVIEW", detail=detail)
            append_log(log, row, case, " ; ".join(item for item, _ in pairs), "", "REVIEW", detail)
            continue
        number = numbers.pop()
        record["nomer_register_barang_bukti"] = number
        items = []
        for item, _ in pairs:
            print(f"Menilai barang: {item}", flush=True)
            try:
                result = classifier.analyze(item)
                record["items"].append({"status": "READY", **result.as_dict()})
                items.append(result)
                print(f"  Objek: {result.object_name} | jumlah={result.quantity} | "
                      f"satuan={result.unit} | kategori={result.category}")
                print(f"  Penilaian: {result.extraction['explanation']}")
                print(f"  Pemetaan: {result.mapping['explanation']}")
            except ReviewRequired as error:
                record["status"] = "REVIEW"
                record["items"].append({"status": "REVIEW", "description": item,
                                        "detail": str(error), **error.details})
                append_log(log, row, case, item, number, "REVIEW", str(error))
                print(f"  REVIEW: {error}")
            except AIServiceError as error:
                record["status"] = "ERROR"
                record["items"].append({"status": "ERROR", "description": item, "detail": str(error)})
                append_log(log, row, case, item, number, "ERROR", str(error))
                print(f"  ERROR: {error}")
                return ready, report, True
        if record["status"] == "READY":
            ready.append((row, case, number, items))
            print(f"Baris {row}: {len(items)} barang siap; nomor register: {number}")
        else:
            print(f"REVIEW baris {row}: seluruh perkara dilewati sampai datanya jelas")
    return ready, report, False


def open_case(page, case):
    page.goto(page.url.split("/pidum/")[0] + "/pidum/pdm-tahap-dua/index")
    page.locator("#pdmgridtahap2search-no_register_perkara").fill(case)
    page.locator("button.cari_tahap2").click()
    result = page.locator("#pdm-tahap-dua-pjax tbody tr[data-id]").filter(
        has=page.locator("td[data-col-seq='3']").filter(has_text=case)
    )
    result.first.wait_for(state="visible")
    if result.count() != 1 or norm(result.get_attribute("data-id")) != norm(case):
        raise ValueError(f"Hasil pencarian tidak unik atau nomor perkara berbeda: {case}")
    result.locator("td[data-col-seq='3']").dblclick()
    page.wait_for_url("**/pidum/pdm-tahap-dua/update?**")
    page.locator(".sidebar-menu li[data-id='341'] a").click()
    page.wait_for_url("**/pidum/pdm-ba5/**")
    page.locator("#pdm-ba5-form").wait_for(state="visible")


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("excel", type=Path, nargs="?")
    parser.add_argument("--text", help="Uji satu uraian dengan AI tanpa Excel/browser")
    parser.add_argument("--config", type=Path, default=Path("konfigurasi.json"))
    parser.add_argument("--mode", choices=["dry-run", "test", "production"], default="dry-run")
    parser.add_argument("--limit", type=int, default=2)
    parser.add_argument("--analysis-output", type=Path, default=Path("hasil_analisis.json"))
    args = parser.parse_args(argv)
    if (args.excel is None) == (args.text is None):
        parser.error("Pilih berkas Excel atau --text")
    if args.text is not None and args.mode != "dry-run":
        parser.error("--text hanya tersedia dalam mode dry-run")
    if args.limit <= 0:
        parser.error("--limit harus lebih dari nol")
    try:
        cfg = json.loads(args.config.read_text(encoding="utf-8"))
        if not isinstance(cfg, dict):
            raise ValueError("Konfigurasi harus berupa objek JSON")
        if args.mode != "dry-run" and not cfg.get("selectors", {}).get("modal_category"):
            raise ValueError("Isi selectors.modal_category agar kategori hasil AI dapat dipilih di website")
        classifier = SemanticClassifier(cfg)
        rows = [(0, "UJI-TEKS", [(args.text, "UJI-TEKS")])] if args.text is not None else list(load_rows(args.excel))
    except (ValueError, OSError) as error:
        parser.error(str(error))
    if args.mode == "test":
        rows = rows[:args.limit]
    log = Path("hasil_input.csv")
    ready, report, service_failed = analyze_rows(rows, classifier, log)
    args.analysis_output.write_text(json.dumps({
        "waktu": datetime.now().isoformat(timespec="seconds"),
        "mode": args.mode, "model": cfg.get("ai", {}).get("model", "gpt-4.1-mini"),
        "aborted": service_failed, "perkara": report,
    }, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Rincian penilaian tersimpan: {args.analysis_output}")
    if service_failed:
        return 1
    has_review = any(row["status"] != "READY" for row in report)
    if args.mode == "dry-run":
        return 2 if has_review else 0
    if not ready:
        print("Tidak ada perkara yang siap diinput")
        return 2 if has_review else 0
    username = os.environ.get("BB_USERNAME")
    password = os.environ.get("BB_PASSWORD")
    if not username or not password:
        parser.error("Isi BB_USERNAME dan BB_PASSWORD pada terminal")
    web_failed = False
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=False)
        page = browser.new_page()
        page.set_default_timeout(15000)
        page.goto(cfg["base_url"])
        page.locator("#login-form-login").first.fill(username)
        page.locator("#login-form-password").first.fill(password)
        page.locator("#login-form button[name='login-button']").first.click()
        page.locator("a[href='/pidum/home/index']").click()
        for row, case, number, items in ready:
            stage = "cari perkara"
            try:
                open_case(page, case)
                if page.locator("#table_barbuk tbody tr").count():
                    raise ValueError("BA-5 sudah berisi barang; periksa manual agar tidak terduplikasi")
                for expected_count, result in enumerate(items, start=1):
                    stage = f"tambah barang: {result.description}"
                    page.locator("a.tambahBarbuk").click()
                    page.locator("#m_barbuk #nm_barbuk").wait_for(state="visible")
                    page.locator("#m_barbuk #nm_barbuk").fill(result.description)
                    page.locator("#m_barbuk #jml_barbuk").fill(result.quantity)
                    choose_option(page, "#m_barbuk #satuan_barbuk", result.unit)
                    choose_option(page, cfg["selectors"]["modal_category"], result.category)
                    # Kolom lain pada modal perlu diverifikasi dari HTML respons /pidum/pdm-ba5/barbuk.
                    page.locator("#m_barbuk #simpan-barbuk").click()
                    expect(page.locator("#table_barbuk tbody tr")).to_have_count(expected_count, timeout=15000)
                if page.locator("#table_barbuk tbody tr").count() != len(items):
                    raise ValueError("Jumlah baris barang pada tabel berbeda dari Excel")
                page.locator("#pdmba5-no_reg_bukti").fill(number)
                stage = "simpan BA-5"
                page.locator("#pdm-ba5-form button[type='submit']").click()
                # Keberhasilan hanya dicatat setelah pindah dari halaman update.
                page.wait_for_url(lambda url: "/pidum/pdm-ba5/update" not in url, timeout=15000)
                append_log(log, row, case, " ; ".join(x.description for x in items), number, "SUCCESS", "")
            except Exception as error:
                web_failed = True
                page.screenshot(path=f"gagal_baris_{row}.png", full_page=True)
                append_log(log, row, case, " ; ".join(x.description for x in items), number, "REVIEW", f"Tahap {stage}: {error}")
                print(f"Berhenti pada baris {row}, {case}: {error}")
                break
        browser.close()
    return 1 if web_failed else (2 if has_review else 0)


if __name__ == "__main__":
    raise SystemExit(main())
