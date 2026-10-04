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

from db import create_backend

# TinyDB table name -> Backend store
_STORES = {'files': 'files', 'api_tokens': 'tokens'}


def migrate(source_path: str, target_path: str) -> int:
    if not os.path.exists(source_path):
        print(f'source file not found: {source_path}')
        return 1
    if os.path.exists(target_path) and os.path.getsize(target_path) > 0:
        print(f'target database already exists and is not empty: {target_path}')
        return 1

    with open(source_path, 'r', encoding='utf-8') as handle:
        payload = json.load(handle)

    # Validate everything BEFORE touching the target: all TinyDB doc keys
    # must be numeric and files.id values must be unique (the column is
    # UNIQUE in the new schema).
    for table_name, documents in payload.items():
        if not isinstance(documents, dict):
            print(f'skipping {table_name}: unexpected structure')
            continue
        seen_file_ids = set()
        for doc_id, doc in documents.items():
            if not str(doc_id).isdigit():
                print(f'error: {table_name} has non-numeric doc_id {doc_id!r}')
                return 1
            if table_name == 'files' and isinstance(doc, dict):
                file_id = doc.get('id')
                # NULL ids are allowed by the UNIQUE column; only reject
                # real duplicates.
                if file_id is not None:
                    if file_id in seen_file_ids:
                        print(f'error: duplicate files.id {file_id!r} in source')
                        return 1
                    seen_file_ids.add(file_id)

    backend = create_backend(f'sqlite:///{target_path}')
    total = 0
    try:
        # One transaction: the import is all-or-nothing.
        with backend.transaction():
            for table_name, documents in payload.items():
                store = getattr(backend, _STORES.get(table_name, ''), None)
                if store is None or not isinstance(documents, dict):
                    print(f'skipping {table_name}: unexpected structure')
                    continue
                for doc_id, doc in sorted(
                        documents.items(), key=lambda item: int(item[0])):
                    store.insert(doc, doc_id=int(doc_id))
                    total += 1
                print(f'{table_name}: migrated {len(documents)} document(s)')
    except Exception as exc:
        backend.close()
        # Don't leave a half-written target behind.
        for suffix in ('', '-wal', '-shm'):
            sidecar = target_path + suffix
            if os.path.exists(sidecar):
                os.unlink(sidecar)
        print(f'error: migration failed ({exc}); removed {target_path}')
        return 1
    backend.close()
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
