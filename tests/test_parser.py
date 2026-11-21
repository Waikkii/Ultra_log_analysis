from datetime import datetime, timezone
from pathlib import Path
import tempfile
import unittest

from charge_analyzer.parser import parse_folder


class ParseFolderTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.folder = Path(self.directory.name)

    def write(self, filename, *lines, encoding="utf-8"):
        (self.folder / filename).write_text("\n".join(lines), encoding=encoding)

    def test_arbitrary_header_names_and_uneven_spacing(self):
        text = (
            "Time                   level  mode V1  C1  input  load  status\r\n"
            "2026-07-12 08:14:02 >  31     2    4120   702    13     22      4\r\n"
        )
        (self.folder / "charge-log.0").write_bytes(text.encode("utf-8"))

        result = parse_folder(self.folder)

        self.assertEqual(
            [column["name"] for column in result["columns"]],
            ["level", "mode", "V1", "C1", "input", "load", "status"],
        )
        self.assertEqual([row["values"] for row in result["rows"]], [[31, 2, 4120, 702, 13, 22, 4]])
        self.assertEqual(result["warnings"], [])
        self.assertEqual(result["source_contents"], {"charge-log.0": text})

    def test_rotated_files_and_changing_columns(self):
        self.write(
            "charge-log.0",
            "Time uiSOC flags status",
            "2026-11-18 15:37:17 > 42 0x1A idle",
            "2026-11-18 15:37:18 > +43 None charging",
            encoding="utf-8-sig",
        )
        self.write("charge-log.2", "2026-11-18 15:37:19 > 44 -0xA idle")
        self.write(
            "charge-log.10",
            "Time uiSOC temp status",
            "2026-11-18 15:37:20 > 46 -1.25e1 None",
        )
        self.write("charge-log.5.backup", "Time uiSOC discarded")
        (self.folder / "charge-log.3").mkdir()

        result = parse_folder(self.folder)

        self.assertEqual(result["files"], ["charge-log.0", "charge-log.2", "charge-log.10"])
        self.assertEqual(
            [(column["name"], column["kind"]) for column in result["columns"]],
            [("uiSOC", "number"), ("flags", "number"), ("status", "category"), ("temp", "number")],
        )
        self.assertEqual(result["columns"][2]["categories"], ["idle", "charging"])
        self.assertEqual(
            [row["values"] for row in result["rows"]],
            [[42, 26, "idle", None], [43, None, "charging", None], [44, -10, "idle", None], [46, None, None, -12.5]],
        )
        milliseconds = int(datetime(2026, 11, 18, 15, 37, 17, tzinfo=timezone.utc).timestamp() * 1000)
        self.assertEqual(result["rows"][0]["time"], milliseconds)
        self.assertEqual(result["warnings"], [])

    def test_tab_cells_include_leading_middle_and_trailing_blanks(self):
        self.write(
            "charge-log.0",
            "Time\tuiSOC\tstatus\tflags",
            "2026-11-18 15:37:17 >\t42\tfast charge\t",
            "2026-11-18 15:37:18 >\t\t\t0x01",
            "2026-11-18 15:37:19 >\t43\t   \t0x02",
        )

        result = parse_folder(self.folder)

        self.assertEqual(
            [row["values"] for row in result["rows"]],
            [[42, "fast charge", None], [None, None, 1], [43, None, 2]],
        )
        self.assertEqual(result["warnings"], [])

    def test_aligned_spaces_keep_values_in_their_columns(self):
        def line(stamp, soc, voltage, state):
            return f"{stamp:<22}{soc:<8}{voltage:>8}  {state:<12}"

        self.write(
            "charge-log.0",
            line("Time", "uiSOC", "voltage", "state"),
            line("2026-11-18 15:37:17 >", "4", "3982", "idle"),
            line("2026-11-18 15:37:18 >", "10", "4012", "charging"),
            line("2026-11-18 15:37:19 >", "", "8", "idle"),
            line("2026-11-18 15:37:20 >", "12", "", ""),
        )

        result = parse_folder(self.folder)

        self.assertEqual(
            [row["values"] for row in result["rows"]],
            [[4, 3982, "idle"], [10, 4012, "charging"], [None, 8, "idle"], [12, None, None]],
        )
        self.assertEqual(result["warnings"], [])

    def test_uniform_separators_take_precedence_over_coincidental_alignment(self):
        self.write(
            "charge-log.0",
            "Time uiSOC voltage state",
            "2026-11-18 15:37:17 > 42 3 low",
            "2026-11-18 15:37:18 >  4 low",
        )

        result = parse_folder(self.folder)

        self.assertEqual([row["values"] for row in result["rows"]], [[42, 3, "low"], [None, 4, "low"]])
        self.assertEqual(result["warnings"], [])

    def test_register_fields_preserve_internal_space_and_later_columns(self):
        self.write(
            "charge-log.0",
            "Time  uiSOC  R[0x 9f]  R[0x  7]  current",
            "2026-07-12 08:14:02 >  31  R[0x 1e]  R[0x  8]  702",
            "2026-07-12 08:14:03 >  32    R[0x  9]  710",
        )

        result = parse_folder(self.folder)

        self.assertEqual(
            [(column["name"], column["kind"]) for column in result["columns"]],
            [("uiSOC", "number"), ("R[0x 9f]", "category"), ("R[0x  7]", "category"), ("current", "number")],
        )
        self.assertEqual(
            [row["values"] for row in result["rows"]],
            [[31, "R[0x 1e]", "R[0x  8]", 702], [32, None, "R[0x  9]", 710]],
        )
        self.assertEqual(result["warnings"], [])

    def test_unrecoverable_row_is_a_gap_with_a_warning(self):
        self.write(
            "charge-log.0",
            "Time uiSOC volt state",
            "2026-11-18 15:37:17 > 42   4013  charging",
            "2026-11-18 15:37:18 > 43       discharge",
            "2026-11-18 15:37:19 > 44   4028  idle extra",
        )

        result = parse_folder(self.folder)

        self.assertEqual([row["values"] for row in result["rows"][1:]], [[None] * 3, [None] * 3])
        self.assertIn("charge-log.0:3 表头有 3 列，识别到 2 个值，空白列位置无法确定", result["warnings"][0])
        self.assertIn("charge-log.0:4 表头有 3 列，识别到 4 个值，值的数量超过表头列数", result["warnings"][1])

    def test_chronological_sort_keeps_columns_from_each_header(self):
        self.write(
            "charge-log.0",
            "Time uiSOC state",
            "2026-11-18 15:37:17.250 > 42 late",
            "2026-11-18 15:37:17.003 > 40 early",
        )
        self.write("charge-log.1", "Time uiSOC state", "2026-11-18 15:37:17.250 > 43 latest")

        result = parse_folder(self.folder)

        self.assertEqual([row["values"] for row in result["rows"]], [[40, "early"], [42, "late"], [43, "latest"]])
        self.assertEqual(result["rows"][1]["time"] - result["rows"][0]["time"], 247)
        self.assertEqual(result["columns"][1]["categories"], ["early", "late", "latest"])


if __name__ == "__main__":
    unittest.main()
