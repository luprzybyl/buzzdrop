from datetime import datetime, timedelta

from tinydb import TinyDB
from tinydb.storages import MemoryStorage

import app as app_module
from models import FileRepository


def make_repo():
    db = TinyDB(storage=MemoryStorage)
    return FileRepository(db.table("files"))


def test_create_and_get_file(monkeypatch):
    repo = make_repo()
    monkeypatch.setattr("models.uuid.uuid4", lambda: "generated-id")

    created_id = repo.create(
        {
            "original_name": "a.txt",
            "path": "/tmp/a",
            "uploaded_by": "alice",
        }
    )
    assert created_id == "generated-id"

    row = repo.get_by_id(created_id)
    assert row["status"] == "active"
    assert row["type"] == "file"
    assert row["shared_with"] == []
    assert row["downloaded_at"] is None


def test_create_with_explicit_id_and_repository_queries():
    repo = make_repo()
    repo.create(
        {
            "original_name": "shared.txt",
            "path": "/tmp/shared",
            "uploaded_by": "owner",
            "shared_with": ["bob"],
            "type": "text",
        },
        file_id="fixed-id",
    )
    repo.create(
        {
            "original_name": "own.txt",
            "path": "/tmp/own",
            "uploaded_by": "bob",
            "shared_with": ["bob"],
        },
        file_id="bob-id",
    )

    assert repo.get_by_id("fixed-id")["id"] == "fixed-id"
    assert len(repo.get_user_files("owner")) == 1
    assert len(repo.get_shared_files("bob")) == 1
    assert repo.get_shared_files("bob")[0]["id"] == "fixed-id"
    assert len(repo.get_all_active()) == 2
    assert len(repo.get_all()) == 2


def test_mark_downloaded_expired_decryption_and_delete():
    repo = make_repo()
    repo.create(
        {
            "original_name": "x.txt",
            "path": "/tmp/x",
            "uploaded_by": "u",
        },
        file_id="id1",
    )

    repo.mark_downloaded("id1", "1.2.3.4")
    row = repo.get_by_id("id1")
    assert row["downloaded_by_ip"] == "1.2.3.4"
    assert row["downloaded_at"] is not None

    repo.mark_expired("id1")
    assert repo.get_by_id("id1")["status"] == "expired"

    repo.update_decryption_status("id1", True)
    assert repo.get_by_id("id1")["decryption_success"] is True

    repo.delete("id1")
    assert repo.get_by_id("id1") is None


def test_get_downloaded_before_filters_correctly():
    repo = make_repo()
    now = datetime.now()
    old_dt = (now - timedelta(days=2)).isoformat()
    new_dt = (now - timedelta(minutes=1)).isoformat()
    cutoff = now - timedelta(hours=1)

    repo.table.insert({"id": "old", "downloaded_at": old_dt})
    repo.table.insert({"id": "new", "downloaded_at": new_dt})
    repo.table.insert({"id": "none", "downloaded_at": None})

    results = repo.get_downloaded_before(cutoff)
    assert [r["id"] for r in results] == ["old"]


def test_repository_table_property_uses_app_get_files_table(monkeypatch):
    sentinel_table = make_repo().table
    monkeypatch.setattr(app_module, "get_files_table", lambda: sentinel_table)

    repo = FileRepository()
    assert repo.table is sentinel_table
