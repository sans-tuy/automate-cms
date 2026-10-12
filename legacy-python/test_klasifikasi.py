"""Uji kontrak/validasi pipeline dengan respons simulasi, bukan akurasi model AI."""

import copy
import json
import unittest
from pathlib import Path
from unittest.mock import Mock

from ai_client import AIServiceError
from klasifikasi import ReviewRequired, SemanticClassifier, classify


def extraction(**changes):
    result = {
        "narcotic_form": "not_applicable",
        "object_name": "sepeda motor", "object_evidence": "SEPEDA MOTOR",
        "quantity": "1", "quantity_basis": "explicit", "quantity_evidence": "1",
        "unit": "unit", "unit_basis": "inferred", "unit_evidence": None,
        "companions": [], "single_main_item": True,
        "explanation": "Uraian menyebut satu sepeda motor; satuan disimpulkan unit.",
        "requires_review": False, "review_reason": None,
    }
    result.update(changes)
    return result


def mapping(**changes):
    result = {"category": "Sepeda Motor", "unit": "Unit", "preserves_quantity": True,
              "explanation": "Kategori dan satuan yang setara tersedia pada katalog.",
              "requires_review": False, "review_reason": None}
    result.update(changes)
    return result


class SemanticClassificationTests(unittest.TestCase):
    def setUp(self):
        self.cfg = {
            "category_keywords": {"Sepeda Motor": [], "Elektronik": ["ponsel"], "Dokumen": ["surat"],
                                  "pakaian": "Pakaian yang dikenakan", "Narkotika": [], "Uang": []},
            "unit_aliases": {"unit": "Unit", "buah": "Buah", "lembar": "Lembar",
                             "bungkus": "Bungkus", "gr": "Gram", "gram": "Gram", "kg": "Kg", "butir": "Butir"},
            "fractional_units": ["Gram", "Kg"],
            "base_url": "http://rahasia.internal", "password": "tidak-boleh-dikirim",
        }
        self.item = "1 SEPEDA MOTOR YAMAHA JUPITER BIRU L-3466-QY + STNK + BPKB"

    def classifier(self, *responses):
        client = Mock()
        client.complete.side_effect = responses
        return SemanticClassifier(self.cfg, client=client), client

    def test_two_stages_keep_original_description_and_minimize_data(self):
        classifier, client = self.classifier(extraction(companions=["STNK", "BPKB"]), mapping())
        result = classifier.analyze(self.item)
        self.assertEqual((result.object_name, result.quantity, result.unit, result.category),
                         ("sepeda motor", "1", "Unit", "Sepeda Motor"))
        self.assertEqual(result.description, self.item)
        first, second = [call.kwargs for call in client.complete.call_args_list]
        self.assertEqual(first["payload"], {"description": self.item})
        self.assertEqual(set(second["payload"]), {"description", "extraction", "measurement", "category_keywords", "unit_aliases"})
        self.assertEqual(second["payload"]["extraction"], result.extraction)
        self.assertNotIn("rahasia.internal", json.dumps(client.complete.call_args_list, default=str))
        self.assertNotIn("tidak-boleh-dikirim", json.dumps(client.complete.call_args_list, default=str))
        self.assertEqual(second["schema"]["properties"]["category"]["enum"], [*self.cfg["category_keywords"], None])
        self.assertEqual(second["schema"]["properties"]["unit"]["enum"].count("Gram"), 1)

    def test_no_keyword_match_is_required_to_accept_semantic_result(self):
        classifier, _ = self.classifier(
            extraction(object_name="telepon genggam", object_evidence="iPhone 15 Pro",
                       quantity_basis="linguistic", quantity_evidence="sebuah", unit="buah",
                       unit_basis="explicit", unit_evidence="sebuah"),
            mapping(category="Elektronik", unit="Buah"))
        result = classifier.analyze("sebuah iPhone 15 Pro")
        self.assertEqual(result.object_name, "telepon genggam")
        self.assertEqual(result.category, "Elektronik")

    def test_semantic_unit_can_map_to_available_equivalent(self):
        classifier, _ = self.classifier(
            extraction(object_name="kaos", object_evidence="KAOS", unit="helai"),
            mapping(category="pakaian", unit="Buah"))
        result = classifier.analyze("1 KAOS BERKERAH BIRU")
        self.assertEqual((result.semantic_unit, result.unit), ("helai", "Buah"))

    def test_packaging_quantity_does_not_change_to_content_weight(self):
        classifier, _ = self.classifier(
            extraction(object_name="kaos", object_evidence="kaos", unit="bungkus",
                       unit_basis="explicit", unit_evidence="bungkus"),
            mapping(category="pakaian", unit="Bungkus"))
        result = classifier.analyze("1 bungkus kaos berat 250 gram")
        self.assertEqual((result.quantity, result.unit), ("1", "Bungkus"))

    def test_narcotic_uses_net_weight_instead_of_packaging_or_gross_weight(self):
        classifier, client = self.classifier(
            extraction(narcotic_form="non_pill", object_name="sabu", object_evidence="sabu",
                       quantity="0.75", quantity_evidence="netto 0,75 gram", unit="gram",
                       unit_basis="explicit", unit_evidence="gram"),
            mapping(category="Narkotika", unit="Gram"))
        result = classifier.analyze("2 bungkus sabu bruto 1,20 gram netto 0,75 gram")
        self.assertEqual((result.quantity, result.unit), ("0.75", "Gram"))
        self.assertEqual(client.complete.call_args.kwargs["payload"]["measurement"]["quantity"], "0.75")

    def test_narcotic_source_mass_is_converted_to_grams_by_code(self):
        for quantity, unit, expected in (("0.5", "kg", "500"), ("250", "mg", "0.25")):
            with self.subTest(unit=unit):
                classifier, client = self.classifier(
                    extraction(narcotic_form="non_pill", object_name="sabu", object_evidence="sabu",
                               quantity=quantity, quantity_evidence=f"{quantity} {unit}", unit=unit,
                               unit_basis="explicit", unit_evidence=unit),
                    mapping(category="Narkotika", unit="Gram"))
                result = classifier.analyze(f"1 bungkus sabu netto {quantity} {unit}")
                self.assertEqual((result.quantity, result.unit), (expected, "Gram"))
                self.assertEqual(result.extraction["quantity"], quantity)
                self.assertEqual(result.measurement["source_unit"], unit)
                self.assertEqual(client.complete.call_args.kwargs["payload"]["measurement"]["quantity"], expected)

    def test_pills_use_count_instead_of_strip_weight_or_dosage(self):
        classifier, _ = self.classifier(
            extraction(narcotic_form="pill", object_name="pil logo Y", object_evidence="pil logo Y",
                       quantity="10", quantity_evidence="10 butir", unit="butir",
                       unit_basis="explicit", unit_evidence="butir"),
            mapping(category="Narkotika", unit="Butir"))
        result = classifier.analyze("1 strip pil logo Y berisi 10 butir dosis 500 mg berat total 2 gram")
        self.assertEqual((result.quantity, result.unit), ("10", "Butir"))

    def test_narcotic_packaging_or_invented_measurements_require_review(self):
        cases = [
            ("non_pill", "bungkus", "explicit", "bungkus", "1 bungkus sabu"),
            ("non_pill", "gram", "inferred", None, "1 bungkus sabu"),
            ("pill", "strip", "explicit", "strip", "1 strip pil"),
            ("pill", "gram", "explicit", "gram", "1 gram pil"),
            ("unknown", "gram", "explicit", "gram", "1 gram zat"),
        ]
        for form, unit, basis, quote, item in cases:
            with self.subTest(item=item, unit=unit):
                classifier, client = self.classifier(extraction(
                    narcotic_form=form, object_evidence=item.split()[-1], unit=unit,
                    unit_basis=basis, unit_evidence=quote))
                with self.assertRaises(ReviewRequired):
                    classifier.analyze(item)
                self.assertEqual(client.complete.call_count, 1)

    def test_fractional_pills_are_rejected_even_if_configuration_allows_them(self):
        self.cfg["fractional_units"].append("Butir")
        classifier, client = self.classifier(extraction(
            narcotic_form="pill", object_evidence="pil", quantity="1.5", quantity_evidence="1.5 butir",
            unit="butir", unit_basis="explicit", unit_evidence="butir"))
        with self.assertRaisesRegex(ReviewRequired, "bilangan bulat"):
            classifier.analyze("1.5 butir pil")
        self.assertEqual(client.complete.call_count, 1)

    def test_missing_gram_option_cannot_fall_back_to_kg(self):
        self.cfg["unit_aliases"].pop("gram")
        self.cfg["unit_aliases"].pop("gr")
        self.cfg["fractional_units"] = ["Kg"]
        classifier, _ = self.classifier(
            extraction(narcotic_form="non_pill", object_evidence="sabu", unit="gram",
                       unit_basis="explicit", unit_evidence="gram"),
            mapping(category="Narkotika", unit="Kg"))
        with self.assertRaisesRegex(ReviewRequired, "Satuan narkotika harus gram"):
            classifier.analyze("1 gram sabu")

    def test_model_unit_conversion_cannot_override_existing_label(self):
        classifier, _ = self.classifier(
            extraction(narcotic_form="non_pill", object_name="sabu", object_evidence="sabu", quantity="1500", quantity_evidence="1500",
                       unit="gram", unit_basis="explicit", unit_evidence="gram"),
            mapping(category="Narkotika", unit="Kg"))
        with self.assertRaisesRegex(ReviewRequired, "Satuan narkotika harus gram"):
            classifier.analyze("1500 gram sabu")

    def test_conversion_flag_requires_review_even_for_allowed_labels(self):
        classifier, _ = self.classifier(extraction(), mapping(preserves_quantity=False))
        with self.assertRaisesRegex(ReviewRequired, "konversi"):
            classifier.analyze(self.item)

    def test_uncertain_or_multiple_items_do_not_reach_mapping(self):
        for changes in ({"requires_review": True, "review_reason": "Jumlah tidak pasti"},
                        {"single_main_item": False}, {"quantity_basis": "unknown"},
                        {"quantity": None}, {"unit_basis": "unknown"}, {"object_name": None},
                        {"review_reason": "Masih ragu"}):
            with self.subTest(changes=changes):
                classifier, client = self.classifier(extraction(**changes))
                with self.assertRaises(ReviewRequired) as error:
                    classifier.analyze(self.item)
                self.assertEqual(client.complete.call_count, 1)
                self.assertIsNotNone(error.exception.details["extraction"])

    def test_quotes_must_be_grounded_in_source(self):
        for changes in ({"object_evidence": "mobil"}, {"quantity_evidence": "dua"},
                        {"unit_basis": "explicit", "unit_evidence": "unit"}):
            with self.subTest(changes=changes):
                classifier, _ = self.classifier(extraction(**changes))
                with self.assertRaisesRegex(ReviewRequired, "Kutipan"):
                    classifier.analyze(self.item)

    def test_numeric_fragments_of_models_and_plates_are_not_grounding(self):
        for item in ("iPhone 15 Pro", "iPhone IMEI 123456", "iPhone kode L-1-QY"):
            with self.subTest(item=item):
                classifier, _ = self.classifier(extraction(object_evidence="iPhone"), mapping())
                with self.assertRaisesRegex(ReviewRequired, "Kutipan"):
                    classifier.analyze(item)

    def test_invalid_numeric_results_are_rejected(self):
        for quantity in ("0", "-1", "NaN", "Infinity", "1e3", "1,5", "1.000.000", "", True, 1, " 1", ".5"):
            with self.subTest(quantity=quantity):
                classifier, _ = self.classifier(extraction(quantity=quantity))
                with self.assertRaises(ReviewRequired):
                    classifier.analyze(self.item)

    def test_fractional_and_long_decimal_quantities(self):
        classifier, _ = self.classifier(
            extraction(narcotic_form="non_pill", object_name="sabu", object_evidence="sabu", quantity="1.500", quantity_evidence="1,500",
                       unit="gram", unit_basis="explicit", unit_evidence="gram"),
            mapping(category="Narkotika", unit="Gram"))
        self.assertEqual(classifier.analyze("1,500 gram sabu").quantity, "1.5")
        classifier, _ = self.classifier(extraction(quantity="1.5"), mapping())
        with self.assertRaisesRegex(ReviewRequired, "pecahan"):
            classifier.analyze(self.item)
        large = "1234567890123456789012345678901"
        classifier, _ = self.classifier(extraction(quantity=large, quantity_evidence=large), mapping())
        self.assertEqual(classifier.analyze(large + " SEPEDA MOTOR").quantity, large)

    def test_unsupported_labels_and_incomplete_mapping_require_review(self):
        for changes in ({"category": "Kendaraan tidak terdaftar"}, {"unit": "Helai"},
                        {"category": None}, {"unit": None}, {"explanation": ""},
                        {"requires_review": True, "review_reason": "Tidak ada kategori setara"},
                        {"review_reason": "Ragu"}, {"preserves_quantity": "true"}):
            with self.subTest(changes=changes):
                classifier, _ = self.classifier(extraction(), mapping(**changes))
                with self.assertRaises(ReviewRequired):
                    classifier.analyze(self.item)

    def test_malformed_structure_requires_review(self):
        invalid = extraction()
        del invalid["quantity_basis"]
        for response in (invalid, {**extraction(), "invented": "field"}, [], None,
                         extraction(requires_review="false"), extraction(companions=[42])):
            with self.subTest(response=response):
                classifier, _ = self.classifier(response)
                with self.assertRaises(ReviewRequired):
                    classifier.analyze(self.item)

    def test_api_failure_never_falls_back_to_old_parser(self):
        classifier, client = self.classifier(AIServiceError("Layanan tidak tersedia"))
        with self.assertRaises(AIServiceError):
            classifier.analyze(self.item)
        self.assertEqual(client.complete.call_count, 1)

    def test_compatibility_tuple_uses_ai_client(self):
        client = Mock()
        client.complete.side_effect = [extraction(), mapping()]
        self.assertEqual(classify(self.item, self.cfg, client=client), ("1", "Unit", "Sepeda Motor"))

    def test_bad_catalogs_fail_before_any_api_call(self):
        for key, value in (("category_keywords", {}), ("unit_aliases", {}),
                           ("category_keywords", {"A": 1}), ("unit_aliases", {"u": ""}),
                           ("unit_aliases", {"a": "Unit", "b": "unit"}),
                           ("unit_aliases", {"gr": "Gram", " GR ": "Kg"}),
                           ("unit_aliases", {"gram": "Kg", "g": "Gram"}),
                           ("fractional_units", ["satuan tidak ada"])):
            with self.subTest(key=key, value=value):
                cfg = copy.deepcopy(self.cfg)
                cfg[key] = value
                client = Mock()
                with self.assertRaises(ValueError):
                    SemanticClassifier(cfg, client=client)
                client.complete.assert_not_called()

    def test_repository_catalogs_are_usable_without_editing_labels(self):
        for filename in ("konfigurasi.json", "contoh_konfigurasi.json"):
            cfg = json.loads(Path(__file__).with_name(filename).read_text(encoding="utf-8"))
            classifier = SemanticClassifier(cfg, client=Mock())
            self.assertEqual(set(classifier.categories), set(cfg["category_keywords"]))
            self.assertEqual(set(classifier.units), set(cfg["unit_aliases"].values()))


if __name__ == "__main__":
    unittest.main()
