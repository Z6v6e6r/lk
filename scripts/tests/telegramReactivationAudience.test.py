import datetime as dt
import csv
import importlib.util
import tempfile
import unittest
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

spec = importlib.util.spec_from_file_location("audience", Path(__file__).parents[1] / "telegram_reactivation/prepare_audience.py")
audience = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audience)


def synthetic_phone(prefix, suffix):
    # Generated test keys only; never copy telephone numbers from a real export.
    return prefix + "0" * 9 + suffix


def fixture(directory):
    rows = [("1001", ""), ("1001", ""), ("1002", ""), ("1002", synthetic_phone("8", "2")),
            ("1003", synthetic_phone("7", "3")), ("1004", "44" + "0" * 9 + "4"),
            ("1005", synthetic_phone("7", "5")), ("1006", synthetic_phone("7", "6")), ("1007", synthetic_phone("7", "7"))]
    csv_path = directory / "source.csv"
    with csv_path.open("w", newline="") as out:
        writer = csv.DictWriter(out, fieldnames=["_id", "chatId", "phone"])
        writer.writeheader()
        for i, (chat, phone) in enumerate(rows):
            writer.writerow({"_id": f"{i + 1:024x}", "chatId": chat, "phone": phone})
    ns = audience.NS["s"]
    def sheet(headers, body):
        root = ET.Element(f"{{{ns}}}worksheet")
        data = ET.SubElement(root, f"{{{ns}}}sheetData")
        for i, values in enumerate([headers] + body, 1):
            row = ET.SubElement(data, f"{{{ns}}}row", r=str(i))
            for j, value in enumerate(values):
                cell = ET.SubElement(row, f"{{{ns}}}c", r=f"{chr(65 + j)}{i}", t="inlineStr" if isinstance(value, str) else "n")
                if isinstance(value, str):
                    if value:  # Include empty inlineStr without <is>, as in supplied workbook.
                        ET.SubElement(ET.SubElement(cell, f"{{{ns}}}is"), f"{{{ns}}}t").text = value
                else:
                    ET.SubElement(cell, f"{{{ns}}}v").text = str(value)
        return ET.tostring(root)
    snapshot = dt.date(2026, 9, 30)
    serial = lambda age: (snapshot - dt.timedelta(days=age) - dt.date(1899, 12, 30)).days
    phone_rows = [["1002", synthetic_phone("7", "2"), serial(30), 30], ["1003", synthetic_phone("7", "3"), "", ""],
                  ["1005", synthetic_phone("7", "5"), serial(180), 180], ["1006", synthetic_phone("7", "6"), serial(181), 181],
                  ["1007", synthetic_phone("7", "7"), serial(31), 31]]
    xlsx_path = directory / "source.xlsx"
    with zipfile.ZipFile(xlsx_path, "w") as archive:
        archive.writestr("xl/workbook.xml", f'<workbook xmlns="{ns}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="G" r:id="r1"/><sheet name="Visits" r:id="r2"/></sheets></workbook>')
        archive.writestr("xl/_rels/workbook.xml.rels", '<Relationships><Relationship Id="r1" Target="worksheets/sheet1.xml"/><Relationship Id="r2" Target="worksheets/sheet2.xml"/></Relationships>')
        archive.writestr("xl/worksheets/sheet1.xml", sheet(["chatId"], [["1001"], ["1001"], ["1002"], ["1004"]]))
        archive.writestr("xl/worksheets/sheet2.xml", sheet(["chatId", "Телефон", "Последний визит", "Дней без визитов"], phone_rows))
    return csv_path, xlsx_path


class CohortBoundaries(unittest.TestCase):
    def test_non_overlapping_cutoffs(self):
        expected = {0: "active", 30: "active", 31: "friendship", 90: "friendship",
                    91: "group", 180: "group", 181: "return", 999: "return"}
        for age, segment in expected.items():
            self.assertEqual(audience.choose_campaign(age), segment)

    def test_phone_is_only_join_key_with_endpoint_not_person_identity(self):
        self.assertEqual(audience.phone_key("8 (000) " + "000-00-01"), synthetic_phone("7", "1"))
        self.assertEqual(audience.phone_key("+44 0000 000000"), "440000000000")
        self.assertEqual(audience.phone_key(""), "")

    def test_expected_snapshot_date_is_calendar_date(self):
        snapshot = dt.date(2026, 9, 30)
        self.assertEqual((snapshot - dt.date(2026, 4, 3)).days, 180)
        self.assertEqual((snapshot - dt.date(2026, 4, 2)).days, 181)

    def test_export_deduplicates_endpoint_and_active_overrides_blank_phone(self):
        with tempfile.TemporaryDirectory() as directory:
            csv_path, xlsx_path = fixture(Path(directory))
            manifest, exclusions, summary = audience.build_audience(csv_path, xlsx_path, dt.date(2026, 9, 30))
            self.assertEqual(summary["campaigns"], {"academy": 1, "friendship": 1, "group": 1, "return": 1})
            self.assertEqual(summary["exclusions"], {"active": 1, "unknown_visit": 1, "phone_present_unclassified": 1})
            self.assertEqual(summary["duplicateRows"], 2)
            self.assertEqual(len(manifest["campaigns"][0]["recipients"][0]["sourceRefs"]), 2)
            self.assertEqual(len(exclusions), 3)
            self.assertNotIn("phone", str(manifest))
            _, _, included = audience.build_audience(csv_path, xlsx_path, dt.date(2026, 9, 30), "return")
            self.assertEqual(included["campaigns"]["return"], 2)

    def test_snapshot_mismatch_is_rejected_instead_of_silently_resegmenting(self):
        with tempfile.TemporaryDirectory() as directory:
            paths = fixture(Path(directory))
            with self.assertRaisesRegex(ValueError, "visit_snapshot_mismatch"):
                audience.build_audience(*paths, dt.date(2026, 10, 6))


if __name__ == "__main__":
    unittest.main()
