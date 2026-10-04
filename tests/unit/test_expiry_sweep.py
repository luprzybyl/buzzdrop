"""Unit tests for the expiry sweep (issue #126).

Expiry must be enforced even when nobody ever touches the link:
``sweep_expired_files`` walks every active drop and lets
``check_and_handle_expiry`` do the destruction — blob from storage,
key share from file_keys, status flipped to 'expired'.
"""
import os
import secrets
import time
import uuid
from datetime import datetime, timedelta

from app import (
    sweep_expired_files,
    start_expiry_sweep_thread,
    storage,
)


def _insert_file(files_store, file_id=None, expiry_at=None, status='active',
                 path=None):
    """Insert a files row directly, bypassing the upload routes."""
    file_id = file_id or str(uuid.uuid4())
    files_store.insert({
        'id': file_id,
        'original_name': 'drop.bin',
        'path': path or f'/nonexistent/{file_id}',
        'created_at': datetime.now().isoformat(),
        'downloaded_at': None,
        'uploaded_by': 'testuser',
        'expiry_at': expiry_at,
        'status': status,
        'type': 'file',
    })
    return file_id


def test_sweep_expires_past_due_drop(files_store):
    """An expired drop nobody opened is destroyed: blob + share + status."""
    file_id = _insert_file(
        files_store,
        expiry_at=(datetime.now() - timedelta(minutes=1)).isoformat(),
    )
    path = storage.save(file_id, b'ciphertext')
    files_store.update_fields(file_id, {'path': path})
    files_store.create_key_share(
        file_id, secrets.token_hex(32), created_by='testuser')

    removed = sweep_expired_files()

    assert removed == 1
    file_info = files_store.get_by_id(file_id)
    assert file_info['status'] == 'expired'
    # ciphertext is gone from storage
    assert not os.path.exists(path)
    # the key share was burned — H must not outlive the file
    assert files_store.get_key_share(file_id) is None


def test_sweep_leaves_unexpired_drop_alone(files_store):
    file_id = _insert_file(
        files_store,
        expiry_at=(datetime.now() + timedelta(hours=1)).isoformat(),
    )
    path = storage.save(file_id, b'ciphertext')
    files_store.update_fields(file_id, {'path': path})

    try:
        assert sweep_expired_files() == 0
        file_info = files_store.get_by_id(file_id)
        assert file_info['status'] == 'active'
        assert os.path.exists(path)
    finally:
        storage.delete(path)


def test_sweep_ignores_drop_without_expiry(files_store):
    file_id = _insert_file(files_store, expiry_at=None)

    assert sweep_expired_files() == 0
    assert files_store.get_by_id(file_id)['status'] == 'active'


def test_sweep_does_not_recount_already_expired(files_store):
    _insert_file(
        files_store,
        expiry_at=(datetime.now() - timedelta(minutes=1)).isoformat(),
        status='expired',
    )

    assert sweep_expired_files() == 0


def test_sweep_counts_each_expired_drop_once(files_store):
    past = (datetime.now() - timedelta(minutes=1)).isoformat()
    _insert_file(files_store, expiry_at=past)
    _insert_file(files_store, expiry_at=past)

    assert sweep_expired_files() == 2
    # a second pass finds nothing left to expire
    assert sweep_expired_files() == 0


def test_sweep_survives_one_bad_row(files_store):
    """A row whose expiry handling explodes must not stop the sweep."""
    good_id = _insert_file(
        files_store,
        expiry_at=(datetime.now() - timedelta(minutes=1)).isoformat(),
    )
    bad_id = _insert_file(
        files_store,
        expiry_at=(datetime.now() - timedelta(minutes=1)).isoformat(),
    )
    files_store.update_fields(bad_id, {'path': None})

    import app as app_module
    original = app_module.check_and_handle_expiry
    try:
        def _exploding(file_info):
            if file_info.get('id') == bad_id:
                raise RuntimeError('boom')
            return original(file_info)
        app_module.check_and_handle_expiry = _exploding
        assert sweep_expired_files() == 1
    finally:
        app_module.check_and_handle_expiry = original

    assert files_store.get_by_id(good_id)['status'] == 'expired'


def test_sweep_thread_disabled_returns_none():
    assert start_expiry_sweep_thread(0) is None
    assert start_expiry_sweep_thread(-5) is None


def test_sweep_thread_expires_drop_on_interval(files_store):
    """The daemon thread actually re-sweeps while the app is running."""
    file_id = _insert_file(
        files_store,
        expiry_at=(datetime.now() - timedelta(minutes=1)).isoformat(),
    )
    thread = start_expiry_sweep_thread(0.05)
    assert thread is not None and thread.daemon
    try:
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            if files_store.get_by_id(file_id)['status'] == 'expired':
                break
            time.sleep(0.05)
        assert files_store.get_by_id(file_id)['status'] == 'expired'
    finally:
        # stop the sweeper so it can't race the rest of the suite
        thread.sweep_stop.set()
        thread.join(timeout=5)
