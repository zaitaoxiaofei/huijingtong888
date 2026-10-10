#!/usr/bin/env python3
"""Convert Ozon's China tariff workbook to an immutable, versioned rFBS snapshot.

Usage: python3 scripts/import-ozon-rfbs-tariff.py /path/to/Tarifs_CN_*.xlsx
Requires openpyxl. Review the generated file before committing it.
"""
import hashlib
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

from openpyxl import load_workbook

source = Path(sys.argv[1]).resolve()
workbook = load_workbook(source, read_only=True, data_only=True)
sheet = workbook["Full ChinaHK"]
header = next(sheet.values)
match = re.search(r"(\d{2})/(\d{2})/(\d{4})", str(header[9]))
if not match:
    raise SystemExit("Cannot find effective date in Full ChinaHK!J1")
day, month, year = match.groups()
effective_date = f"{year}-{month}-{day}"
rows = []
for excel_row, row in enumerate(sheet.values, 1):
    if excel_row < 3:
        continue
    if any(row[index] is None for index in (0, 1, 3, 4, 6, 7, 9, 10, 11, 12)):
        raise SystemExit(f"Missing rFBS data at Excel row {excel_row}")
    rates = [float(row[index]) * 100 for index in (10, 11, 12)]
    if any(rate <= 0 or rate > 100 for rate in rates):
        raise SystemExit(f"Invalid rFBS rate at Excel row {excel_row}")
    rows.append([str(row[index]).strip() for index in (1, 4, 7)] +
                [str(row[index]).strip() for index in (0, 3, 6)] +
                [str(row[9]).strip()] + [round(rate, 4) for rate in rates])
digest = hashlib.sha256(source.read_bytes()).hexdigest()
output_dir = Path(__file__).resolve().parents[1] / "data" / "ozon-rfbs-tariffs"
output_dir.mkdir(parents=True, exist_ok=True)
output = output_dir / f"{effective_date}-{digest[:12]}.json"
if output.exists():
    raise SystemExit(f"Version already exists: {output}")
payload = {"effectiveDate": effective_date, "importedAt": datetime.now(timezone.utc).isoformat(),
           "sourceFile": source.name, "sourceSha256": digest, "sheet": sheet.title,
           "priceBandsRub": [[0, 1500], [1500.01, 5000], [5000.01, None]],
           "columns": ["typeZh", "categoryZh", "marketplaceZh", "typeRu", "categoryRu", "marketplaceRu", "brand", "rate0", "rate1", "rate2"],
           "rows": rows}
output.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
print(f"{output}: {len(rows)} rows, sha256={digest}")
