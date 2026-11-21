import json
import re
import unittest

from charge_analyzer.report import LARGE_SOURCE_BYTES, SOURCE_CHUNK_ROWS, render_report


def json_script(html: str, script_id: str):
    match = re.search(rf'<script type="application/json" id="{script_id}">(.*?)</script>', html, re.DOTALL)
    return json.loads(match[1])


class ReportTests(unittest.TestCase):
    def test_large_files_are_encoded_in_separate_chunks(self):
        rows = [[str(index), "文字"] for index in range(SOURCE_CHUNK_ROWS)]
        rows.append(["last", "</script><img src=x>"])
        large = {"headers": ["Time", "state"], "rows": rows, "start": 1, "end": 2}
        small = {"headers": ["Time"], "rows": [["small"]]}
        tables = {"charge-log.0": large, "charge-log.1": small}
        html = render_report({
            "source_tables": tables,
            "source_sizes": {"charge-log.0": LARGE_SOURCE_BYTES + 1, "charge-log.1": LARGE_SOURCE_BYTES},
        })

        report_tables = json_script(html, "log-data")["source_tables"]
        self.assertEqual(report_tables["charge-log.1"], small)
        metadata = report_tables["charge-log.0"]
        self.assertNotIn("rows", metadata)
        self.assertEqual(metadata["row_count"], len(rows))
        self.assertEqual(metadata["chunk_size"], SOURCE_CHUNK_ROWS)
        self.assertEqual(metadata["chunk_ids"], [0, 1])
        self.assertEqual(metadata["widths"][1], len(rows[-1][1]))
        self.assertEqual((metadata["start"], metadata["end"]), (1, 2))
        self.assertEqual(json_script(html, "source-chunk-0"), rows[:-1])
        self.assertEqual(json_script(html, "source-chunk-1"), rows[-1:])
        self.assertNotIn("</script><img src=x>", html)
        self.assertEqual(tables["charge-log.0"]["rows"], rows)
