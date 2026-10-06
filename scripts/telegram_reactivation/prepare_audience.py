"""Read-only source extraction. Produces private send manifests, never contacts a server.

Uses only Python's standard library. Names, usernames and phone numbers are not
copied into outputs. Phone+chat endpoint matching validates provenance; it does
not link or merge customer identities.
"""
import argparse
import csv
import datetime as dt
import hashlib
import json
import os
import re
import zipfile
from collections import Counter, defaultdict
from pathlib import Path
from xml.etree import ElementTree as ET

NS = {"s": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
REL = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id"
CAMPAIGNS = ("academy", "friendship", "group", "return")


def phone_key(value):
    digits = re.sub(r"\D", "", str(value or ""))
    return "7" + digits[1:] if len(digits) == 11 and digits.startswith("8") else digits


def sheet_rows(filename):
    with zipfile.ZipFile(filename) as archive:
        workbook = ET.fromstring(archive.read("xl/workbook.xml"))
        props = workbook.find("s:workbookPr", NS)
        if props is not None and props.get("date1904") in ("1", "true"):
            raise ValueError("unsupported_date1904")
        relationships = ET.fromstring(archive.read("xl/_rels/workbook.xml.rels"))
        paths = {r.get("Id"): r.get("Target") for r in relationships}
        shared = []
        if "xl/sharedStrings.xml" in archive.namelist():
            shared = ["".join(n.itertext()) for n in ET.fromstring(archive.read("xl/sharedStrings.xml"))]
        for sheet in workbook.findall("s:sheets/s:sheet", NS):
            target = paths[sheet.get(REL)]
            target = target.lstrip("/") if target.startswith("/") else "xl/" + target
            parsed = []
            for row in ET.fromstring(archive.read(target)).findall("s:sheetData/s:row", NS):
                values = {}
                for cell in row.findall("s:c", NS):
                    column = re.sub(r"\d", "", cell.get("r"))
                    if cell.get("t") == "inlineStr":
                        text = cell.find("s:is", NS)
                        value = "".join(text.itertext()) if text is not None else ""
                    else:
                        value = cell.findtext("s:v", "", NS)
                        if cell.get("t") == "s":
                            value = shared[int(value)]
                    values[column] = value
                parsed.append((int(row.get("r")), values))
            if not parsed:
                continue
            headers = parsed[0][1]
            yield sheet.get("name"), [(rownum, {headers[col]: value for col, value in values.items() if col in headers})
                                      for rownum, values in parsed[1:]]


def choose_campaign(age):
    if age <= 30:
        return "active"
    if age <= 90:
        return "friendship"
    if age <= 180:
        return "group"
    return "return"


def build_audience(csv_path, xlsx_path, snapshot, unknown_policy="exclude"):
    with Path(csv_path).open(encoding="utf-8-sig", newline="") as source:
        source_rows = list(csv.DictReader(source))
    endpoints = defaultdict(list)
    exact = defaultdict(list)
    seen_refs = set()
    for row in source_rows:
        chat = row["chatId"].strip()
        ref = row["_id"].strip()
        if not re.fullmatch(r"[1-9][0-9]{0,15}", chat) or int(chat) > 9007199254740991 or not re.fullmatch(r"[a-f0-9]{24}", ref):
            raise ValueError("invalid_source_identifier")
        if ref in seen_refs:
            raise ValueError("duplicate_source_id")
        seen_refs.add(ref)
        endpoints[chat].append(row)
        exact[(chat, phone_key(row["phone"]))].append(row)
    classified = defaultdict(list)
    xlsx_count = 0
    phone_matches = 0
    date_rows = 0
    active_rows = 0
    for sheet, rows in sheet_rows(xlsx_path):
        if not rows or "chatId" not in rows[0][1]:
            continue
        xlsx_count += len(rows)
        for rownum, row in rows:
            chat = row["chatId"].strip()
            if chat not in endpoints:
                raise ValueError("xlsx_endpoint_missing_in_csv")
            if "Телефон" not in row:
                continue  # CSV owns absent-phone status; G contains nonempty foreign phones too.
            candidates = exact[(chat, phone_key(row["Телефон"]))]
            if len(candidates) != 1 or not candidates[0]["phone"].strip():
                raise ValueError("phone_endpoint_match_not_unique")
            phone_matches += 1
            raw_date, raw_age = row.get("Последний визит", ""), row.get("Дней без визитов", "")
            if bool(raw_date) != bool(raw_age):
                raise ValueError("incomplete_visit_data")
            if raw_date:
                last_visit = (dt.datetime(1899, 12, 30) + dt.timedelta(days=float(raw_date))).date()
                age = int(float(raw_age))
                if age < 0 or age != float(raw_age) or (snapshot - last_visit).days != age:
                    raise ValueError("visit_snapshot_mismatch")
                date_rows += 1
                category = choose_campaign(age)
                active_rows += category == "active"
            else:
                age, last_visit = None, None
                category = "return" if unknown_policy == "return" else "unknown_visit"
            classified[chat].append({"category": category, "sourceSheet": sheet, "sourceRow": rownum,
                                     "hiatusDays": age, "lastVisit": str(last_visit) if last_visit else None})
    if xlsx_count != len(source_rows):
        raise ValueError("source_row_count_mismatch")
    result = {c: [] for c in CAMPAIGNS}
    exclusions = []
    for chat, records in sorted(endpoints.items()):
        refs = sorted(r["_id"] for r in records)
        matches = classified[chat]
        if any(m["category"] == "active" for m in matches):
            reason = "active"
        elif matches:
            categories = {m["category"] for m in matches}
            if len(categories) != 1 or len(matches) != 1:
                reason = "conflicting_endpoint"
            else:
                reason = next(iter(categories))
        elif all(not r["phone"].strip() for r in records):
            reason = "academy"
        else:
            reason = "phone_present_unclassified"
        if reason in CAMPAIGNS:
            provenance = matches[0] if matches else {"hiatusDays": None, "lastVisit": None}
            result[reason].append({"chatId": chat, "sourceRefs": refs, **{k: v for k, v in provenance.items() if k != "category"}})
        else:
            exclusions.append({"chatId": chat, "reason": reason, "sourceRefs": refs})
    summary = {"schemaVersion": 1, "audienceSnapshotDate": str(snapshot), "unknownVisitPolicy": unknown_policy,
               "sourceRows": len(source_rows), "uniqueEndpoints": len(endpoints),
               "duplicateRows": len(source_rows) - len(endpoints), "phoneMatches": phone_matches,
               "datedRows": date_rows, "activeSourceRows": active_rows,
               "campaigns": {c: len(result[c]) for c in CAMPAIGNS},
               "exclusions": dict(Counter(r["reason"] for r in exclusions)),
               "inputSha256": {"csv": hashlib.sha256(Path(csv_path).read_bytes()).hexdigest(),
                               "xlsx": hashlib.sha256(Path(xlsx_path).read_bytes()).hexdigest()}}
    if sum(summary["campaigns"].values()) + sum(summary["exclusions"].values()) != len(endpoints):
        raise ValueError("audience_reconciliation_failed")
    manifest = {"schemaVersion": 1, "batchId": "reactivation-20260930-v1", "audienceSnapshotDate": str(snapshot),
                "unknownVisitPolicy": unknown_policy,
                "campaigns": [{"campaignId": c, "recipients": result[c]} for c in CAMPAIGNS]}
    return manifest, exclusions, summary


def write_private(path, value):
    with os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w", encoding="utf-8") as out:
        json.dump(value, out, ensure_ascii=False, indent=2)
        out.write("\n")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--csv", required=True)
    parser.add_argument("--xlsx", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--snapshot", default="2026-09-30")
    parser.add_argument("--unknown-visits", choices=("exclude", "return"), default="exclude")
    args = parser.parse_args()
    destination = Path(args.output_dir)
    if not destination.is_absolute() or destination.exists():
        raise ValueError("new_absolute_output_directory_required")
    manifest, exclusions, summary = build_audience(args.csv, args.xlsx, dt.date.fromisoformat(args.snapshot), args.unknown_visits)
    destination.mkdir(mode=0o700, parents=True)
    write_private(destination / "recipients.private.json", manifest)
    write_private(destination / "exclusions.private.json", exclusions)
    write_private(destination / "summary.json", summary)
    print(json.dumps(summary, ensure_ascii=False))  # Aggregates only.


if __name__ == "__main__":
    main()
