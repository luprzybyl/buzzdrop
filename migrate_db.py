#!/usr/bin/env python3
"""
One-off migration from the legacy TinyDB store (db.json) to the SQLite
document store (buzzdrop.db) introduced with the SQLite migration.

Reads a TinyDB dump — {"<table>": {"<doc_id>": {...}}} — and re-inserts
each document, preserving document ids so api_tokens keep their numeric
token ids.

Usage:
    python migrate_db.py [--source db.json] [--target buzzdrop.db]
"""
import argparse
import json
import os
import sys

from db import Database


def migrate(source_path: str, target_path: str) -> int:
    if not os.path.exists(source_path):
        print(f'source file not found: {source_path}')
        return 1
    if os.path.exists(target_path) and os.path.getsize(target_path) > 0:
        print(f'target database already exists and is not empty: {target_path}')
        return 1

    with open(source_path, 'r', encoding='utf-8') as handle:
        payload = json.load(handle)

    database = Database(target_path)
    total = 0
    for table_name, documents in payload.items():
        if not isinstance(documents, dict):
            print(f'skipping {table_name}: unexpected structure')
            continue
        table = database.table(table_name)
        for doc_id, doc in sorted(documents.items(), key=lambda item: int(item[0])):
            table.insert(doc, doc_id=int(doc_id))
            total += 1
        print(f'{table_name}: migrated {len(documents)} document(s)')
    database.close()
    print(f'done: {total} document(s) written to {target_path}')
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description='Migrate db.json (TinyDB) to buzzdrop.db (SQLite)')
    parser.add_argument('--source', default='db.json', help='path to the legacy db.json file')
    parser.add_argument('--target', default='buzzdrop.db', help='path to the SQLite database to create')
    args = parser.parse_args()
    return migrate(args.source, args.target)


if __name__ == '__main__':
    sys.exit(main())
