from __future__ import annotations

import argparse
import json
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--log", default="logs/translations.jsonl")
    parser.add_argument("--limit", type=int, default=80)
    args = parser.parse_args()

    path = Path(args.log)
    if not path.exists():
        print(f"Log not found: {path}")
        return 1

    lines = path.read_text(encoding="utf-8").splitlines()
    rows = []
    for line in lines[-args.limit :]:
        if not line.strip():
            continue
        rows.append(json.loads(line))

    for index, row in enumerate(rows, 1):
        print(f"\n#{index} {row.get('ts')} model={row.get('model')} latency={row.get('latency_ms')}ms cached={row.get('cached')}")
        print(f"EN: {row.get('text', '')}")
        print(f"RU: {row.get('translation', '')}")
        if row.get("error"):
            print(f"ERROR: {row['error']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
