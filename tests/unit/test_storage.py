"""Storage backend prefix reads and sizes — the envelope salt and the
download Content-Length come from these."""
import os
from unittest.mock import MagicMock

import pytest

from storage import LocalStorage, S3Storage, StorageError


@pytest.fixture
def local(tmp_path):
    return LocalStorage(str(tmp_path))


def _write(local, name='blob.bin', data=b'BKV3-salt-and-ciphertext'):
    path = os.path.join(local.upload_folder, name)
    with open(path, 'wb') as f:
        f.write(data)
    return path


def test_local_read_prefix(local):
    path = _write(local)
    assert local.read_prefix(path, 20) == b'BKV3-salt-and-cipher'


def test_local_read_prefix_shorter_than_prefix(local):
    path = _write(local, data=b'BKV3')
    assert local.read_prefix(path, 20) == b'BKV3'


def test_local_read_prefix_missing(local):
    with pytest.raises(StorageError):
        local.read_prefix(os.path.join(local.upload_folder, 'gone'), 20)


def test_local_size(local):
    path = _write(local)
    assert local.size(path) == len(b'BKV3-salt-and-ciphertext')


def test_local_size_missing(local):
    with pytest.raises(StorageError):
        local.size(os.path.join(local.upload_folder, 'gone'))


def test_s3_read_prefix_uses_a_range_get():
    client = MagicMock()
    body = MagicMock()
    body.read.return_value = b'BKV3-salt'
    client.get_object.return_value = {'Body': body}
    storage = S3Storage('bucket', 'key', 'secret')
    storage.client = client

    result = storage.read_prefix('uploads/uuid', 20)

    client.get_object.assert_called_once_with(
        Bucket='bucket', Key='uploads/uuid', Range='bytes=0-19')
    assert result == b'BKV3-salt'


def test_s3_size_reads_content_length():
    client = MagicMock()
    client.head_object.return_value = {'ContentLength': 512}
    storage = S3Storage('bucket', 'key', 'secret')
    storage.client = client

    assert storage.size('uploads/uuid') == 512
    client.head_object.assert_called_once_with(Bucket='bucket', Key='uploads/uuid')
