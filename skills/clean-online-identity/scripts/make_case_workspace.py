#!/usr/bin/env python3
"""Create a private local workspace for a supervised identity cleanup case."""

from __future__ import annotations

import argparse
import csv
import re
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path


DIR_MODE = 0o700
FILE_MODE = 0o600

TRACKER_FIELDS = [
    "item_id",
    "priority",
    "category",
    "site_or_org",
    "profile_or_result_url",
    "opt_out_or_request_url",
    "jurisdiction",
    "data_visible",
    "confidence",
    "request_type",
    "status",
    "deadline_basis",
    "submitted_date",
    "confirmation_needed",
    "follow_up_date",
    "last_checked_date",
    "approval_status",
    "approved_at",
    "submission_channel",
    "verification_method",
    "evidence_path",
    "notes",
]

APPROVAL_FIELDS = [
    "approval_id",
    "item_id",
    "action_type",
    "destination",
    "identifiers_approved",
    "data_to_disclose",
    "approval_status",
    "approved_at",
    "expires_at",
    "approval_note",
]

SOURCE_FIELDS = [
    "source_id",
    "checked_date",
    "source_name",
    "source_url",
    "topic",
    "current_finding",
    "used_for_item_id",
    "notes",
]

FOLLOWUP_FIELDS = [
    "followup_id",
    "item_id",
    "due_date",
    "reason",
    "channel",
    "status",
    "completed_date",
    "notes",
]


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def backup_stamp() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def slugify(value: str) -> str:
    slug = re.sub(r"[^a-zA-Z0-9._-]+", "-", value.strip()).strip("-._")
    slug = re.sub(r"-{2,}", "-", slug).lower()
    return slug or "identity-cleanup-case"


def ensure_private_dir(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)
    path.chmod(DIR_MODE)


def backup_existing(path: Path, root: Path, stamp: str) -> None:
    if not path.exists():
        return
    backup_root = root / "backups" / stamp
    ensure_private_dir(backup_root)
    backup_path = backup_root / path.relative_to(root)
    ensure_private_dir(backup_path.parent)
    shutil.copy2(path, backup_path)
    backup_path.chmod(FILE_MODE)


def write_text(path: Path, text: str, root: Path, force: bool, stamp: str) -> None:
    if path.exists():
        if not force:
            raise FileExistsError(f"{path} already exists; pass --force to back it up before rewriting")
        backup_existing(path, root, stamp)
    path.write_text(text, encoding="utf-8")
    path.chmod(FILE_MODE)


def write_csv(path: Path, fields: list[str], root: Path, force: bool, stamp: str) -> None:
    if path.exists():
        if not force:
            raise FileExistsError(f"{path} already exists; pass --force to back it up before rewriting")
        backup_existing(path, root, stamp)
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields)
        writer.writeheader()
    path.chmod(FILE_MODE)


def build_intake(case_name: str) -> str:
    return f"""# Identity Cleanup Intake

Case name: {case_name}
Created: {utc_now()}

## Authority

- Data subject or authorized requester:
- Authorization notes:
- Jurisdiction or residency:
- High-risk safety context:
- Explicit search approval required before using sensitive identifiers: yes

## Approved Search Identifiers

Use only identifiers the user has approved for search or submission.

- Names and aliases:
- Cities, states, or countries:
- Email addresses:
- Phone numbers:
- Current or prior addresses:
- Other approved matching details:

## Do Not Store Here

Do not store passwords, full Social Security numbers, full government ID numbers, payment details, recovery codes, or unredacted identity documents.
"""


def build_action_log() -> str:
    return f"""# Action Log

Created: {utc_now()}

Record actions in reverse chronological order. Include source URLs, request text paths, approval notes, and dates checked.

## Entries

"""


def build_risk_register() -> str:
    return f"""# Risk Register

Created: {utc_now()}

Use this for safety-sensitive findings and escalation planning. Keep details minimal and factual.

| Risk ID | Priority | Risk | Exposure | Mitigation | Owner | Status |
| --- | --- | --- | --- | --- | --- | --- |
"""


def planned_dirs(root: Path) -> list[Path]:
    return [
        root,
        root / "evidence",
        root / "evidence" / "profile-pages",
        root / "evidence" / "search-results",
        root / "evidence" / "confirmations",
        root / "requests",
        root / "exports",
        root / "backups",
    ]


def planned_files(root: Path) -> list[Path]:
    return [
        root / "intake.md",
        root / "tracker.csv",
        root / "approvals.csv",
        root / "sources_checked.csv",
        root / "followups.csv",
        root / "action_log.md",
        root / "risk_register.md",
    ]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Create a private identity cleanup case workspace.")
    parser.add_argument("--case-name", default="identity-cleanup-case", help="Neutral case label; avoid full legal names.")
    parser.add_argument("--output-dir", default=".", help="Parent directory for the case workspace.")
    parser.add_argument(
        "--force",
        action="store_true",
        help="Back up existing scaffold files to backups/<timestamp>/ before rewriting them.",
    )
    parser.add_argument("--dry-run", action="store_true", help="Print planned paths without writing files.")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    parent = Path(args.output_dir).expanduser().resolve()
    root = parent / slugify(args.case_name)
    stamp = backup_stamp()

    dirs = planned_dirs(root)
    files = planned_files(root)
    if args.dry_run:
        print("Would create private directories:")
        for path in dirs:
            print(f"{path} mode=0700")
        print("Would create private files:")
        for path in files:
            print(f"{path} mode=0600")
        if args.force:
            print(f"Existing scaffold files would be backed up under: {root / 'backups' / stamp}")
        return 0

    for directory in dirs:
        ensure_private_dir(directory)

    try:
        write_text(root / "intake.md", build_intake(args.case_name), root, args.force, stamp)
        write_csv(root / "tracker.csv", TRACKER_FIELDS, root, args.force, stamp)
        write_csv(root / "approvals.csv", APPROVAL_FIELDS, root, args.force, stamp)
        write_csv(root / "sources_checked.csv", SOURCE_FIELDS, root, args.force, stamp)
        write_csv(root / "followups.csv", FOLLOWUP_FIELDS, root, args.force, stamp)
        write_text(root / "action_log.md", build_action_log(), root, args.force, stamp)
        write_text(root / "risk_register.md", build_risk_register(), root, args.force, stamp)
    except FileExistsError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    print(f"Created private identity cleanup case workspace: {root}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
