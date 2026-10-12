"""Intregrasi antrean perkara dan CLI; tidak menghubungi API atau website."""

import contextlib
import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from ai_client import AIServiceError
from klasifikasi import Classification, ReviewRequired
from run import analyze_rows, choose_option, load_rows, main
from test_klasifikasi import extraction, mapping


def result(description="1 SEPEDA MOTOR"):
    return Classification(description, "sepeda motor", "1", "unit", "Sepeda Motor", "Unit",
                          extraction(), mapping())


class RunTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)
        self.log = self.directory / "hasil.csv"
        self.cfg = self.directory / "config.json"
        self.cfg.write_text(json.dumps({"selectors": {"modal_category": None},
                                       "ai": {"model": "test-model"}}), encoding="utf-8")
        self.output = self.directory / "analysis.json"
        self.quiet = contextlib.redirect_stdout(io.StringIO())
        self.quiet.__enter__()
        self.addCleanup(self.quiet.__exit__, None, None, None)

    def test_one_uncertain_item_blocks_whole_case_but_not_next_case(self):
        classifier = Mock()
        classifier.analyze.side_effect = [result(), ReviewRequired("Jumlah tidak jelas"), result("motor lain")]
        rows = [(2, "CASE-1", [("1 SEPEDA MOTOR", "BB-1"), ("HP", "BB-1")]),
                (3, "CASE-2", [("motor lain", "BB-2")])]
        ready, report, aborted = analyze_rows(rows, classifier, self.log)
        self.assertFalse(aborted)
        self.assertEqual([row[1] for row in ready], ["CASE-2"])
        self.assertEqual([row["status"] for row in report], ["REVIEW", "READY"])
        self.assertEqual(report[0]["items"][0]["description"], "1 SEPEDA MOTOR")
        self.assertIn("Jumlah tidak jelas", self.log.read_text(encoding="utf-8-sig"))

    def test_api_failure_aborts_remaining_work(self):
        classifier = Mock()
        classifier.analyze.side_effect = [result(), AIServiceError("Gangguan API")]
        rows = [(2, "CASE-1", [("motor", "BB-1")]),
                (3, "CASE-2", [("HP", "BB-2"), ("kaos", "BB-2")]),
                (4, "CASE-3", [("STNK", "BB-3")])]
        _, report, aborted = analyze_rows(rows, classifier, self.log)
        self.assertTrue(aborted)
        self.assertEqual(classifier.analyze.call_count, 2)
        self.assertEqual(report[-1]["status"], "ERROR")

    def test_register_conflicts_do_not_trigger_ai(self):
        classifier = Mock()
        ready, report, _ = analyze_rows([(2, "CASE", [("motor", "BB1"), ("HP", "BB2")])], classifier, self.log)
        self.assertFalse(ready)
        self.assertEqual(report[0]["status"], "REVIEW")
        classifier.analyze.assert_not_called()

    def test_populated_excel_row_without_case_is_rejected_and_closed(self):
        workbook = Mock()
        workbook.active.iter_rows.return_value = iter([
            ("Nomer register perkara", "Barang bukti", "Nomer register Barang Bukti"),
            (None, "1 motor", "BB1"),
        ])
        with patch("run.load_workbook", return_value=workbook), self.assertRaisesRegex(ValueError, "perkara kosong"):
            list(load_rows("tidak_dibuka.xlsx"))
        workbook.close.assert_called_once()

    def test_text_dry_run_writes_analysis_and_never_launches_browser(self):
        with patch("run.SemanticClassifier") as factory, patch("run.sync_playwright") as browser:
            factory.return_value.analyze.return_value = result()
            code = main(["--text", "1 SEPEDA MOTOR", "--config", str(self.cfg),
                         "--analysis-output", str(self.output)])
        self.assertEqual(code, 0)
        browser.assert_not_called()
        report = json.loads(self.output.read_text(encoding="utf-8"))
        self.assertEqual(report["model"], "test-model")
        self.assertEqual(report["perkara"][0]["items"][0]["object_name"], "sepeda motor")
        self.assertIn("explanation", report["perkara"][0]["items"][0]["mapping"])

    def test_api_failure_is_reported_before_any_browser_write(self):
        self.cfg.write_text(json.dumps({"selectors": {"modal_category": "#category"}}), encoding="utf-8")
        with patch("run.SemanticClassifier") as factory, patch("run.sync_playwright") as browser, \
                patch("run.load_rows", return_value=[(2, "CASE", [("motor", "BB")])]), patch("run.append_log"):
            factory.return_value.analyze.side_effect = AIServiceError("Gangguan API")
            code = main(["contoh.xlsx", "--config", str(self.cfg), "--mode", "production",
                         "--analysis-output", str(self.output)])
        self.assertEqual(code, 1)
        browser.assert_not_called()
        self.assertTrue(json.loads(self.output.read_text(encoding="utf-8"))["aborted"])

    def test_review_exit_status_is_distinct_from_ready(self):
        with patch("run.SemanticClassifier") as factory, patch("run.append_log"):
            factory.return_value.analyze.side_effect = ReviewRequired("Jumlah tidak jelas")
            code = main(["--text", "HP iPhone 15", "--config", str(self.cfg),
                         "--analysis-output", str(self.output)])
        self.assertEqual(code, 2)
        self.assertEqual(json.loads(self.output.read_text(encoding="utf-8"))["perkara"][0]["status"], "REVIEW")

    def test_live_mode_requires_category_selector_before_ai_or_browser(self):
        with patch("run.SemanticClassifier") as factory, patch("run.sync_playwright") as browser, \
                contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as error:
            main(["contoh.xlsx", "--mode", "production", "--config", str(self.cfg)])
        self.assertEqual(error.exception.code, 2)
        factory.assert_not_called()
        browser.assert_not_called()

    def test_actual_website_options_still_validate_catalog_labels(self):
        page = Mock()
        control = page.locator.return_value
        control.locator.return_value.evaluate_all.return_value = [
            {"label": "Pilih", "value": ""}, {"label": "Unit", "value": "3"}]
        choose_option(page, "#unit", "Unit")
        control.select_option.assert_called_once_with(value="3")
        with self.assertRaises(ValueError):
            choose_option(page, "#unit", "Helai")


if __name__ == "__main__":
    unittest.main()
