import os
from io import BytesIO
from unittest.mock import MagicMock, patch

import pytest
from botocore.exceptions import ClientError

from storage import (
    LocalStorage,
    S3Storage,
    StorageError,
    get_storage_backend,
    print_backend_info,
)


def make_client_error(code="NoSuchKey"):
    return ClientError({"Error": {"Code": code, "Message": "Simulated error"}}, "TestOperation")


def test_local_storage_save_retrieve_exists_delete_and_list(tmp_path):
    storage = LocalStorage(str(tmp_path))
    saved_path = storage.save("file1", b"hello world")

    assert storage.backend_type == "local"
    assert os.path.exists(saved_path)
    assert storage.exists(saved_path)
    assert b"".join(storage.retrieve(saved_path)) == b"hello world"
    assert "file1" in storage.list_files()

    storage.delete(saved_path)
    assert not storage.exists(saved_path)


def test_local_storage_save_file_like_object(tmp_path):
    class DummyFile:
        def save(self, path):
            with open(path, "wb") as f:
                f.write(b"from-dummy")

    storage = LocalStorage(str(tmp_path))
    saved_path = storage.save("file2", DummyFile())

    with open(saved_path, "rb") as f:
        assert f.read() == b"from-dummy"


def test_local_storage_errors(tmp_path, monkeypatch):
    storage = LocalStorage(str(tmp_path))

    with pytest.raises(StorageError):
        list(storage.retrieve(str(tmp_path / "missing")))

    with patch("builtins.open", side_effect=OSError("denied")):
        with pytest.raises(StorageError):
            storage.save("file3", b"x")

    monkeypatch.setattr("os.listdir", lambda _: (_ for _ in ()).throw(OSError("bad")))
    assert storage.list_files() == []


@patch("storage.boto3.client")
def test_s3_storage_save_retrieve_exists_delete_and_connection(mock_boto_client):
    client = MagicMock()
    mock_boto_client.return_value = client
    storage = S3Storage("bucket", "key", "secret")

    assert storage.backend_type == "s3"
    assert storage._get_s3_key("abc") == "uploads/abc"

    key = storage.save("abc", b"content")
    assert key == "uploads/abc"
    client.upload_fileobj.assert_called()

    file_obj = BytesIO(b"stream")
    storage.save("def", file_obj)

    body = MagicMock()
    body.read.side_effect = [b"chunk1", b"chunk2", b""]
    client.get_object.return_value = {"Body": body}
    assert b"".join(storage.retrieve("uploads/abc")) == b"chunk1chunk2"

    client.head_object.return_value = {}
    assert storage.exists("uploads/abc") is True
    client.head_object.side_effect = make_client_error("404")
    assert storage.exists("uploads/missing") is False

    storage.delete("uploads/abc")
    client.delete_object.assert_called_once()

    client.list_buckets.return_value = {}
    assert storage.test_connection() is True
    client.list_buckets.side_effect = Exception("nope")
    assert storage.test_connection() is False


@patch("storage.boto3.client")
def test_s3_storage_errors(mock_boto_client):
    client = MagicMock()
    mock_boto_client.return_value = client
    storage = S3Storage("bucket", "key", "secret")

    client.upload_fileobj.side_effect = make_client_error("AccessDenied")
    with pytest.raises(StorageError):
        storage.save("abc", b"content")

    client.upload_fileobj.side_effect = Exception("other")
    with pytest.raises(StorageError):
        storage.save("abc", b"content")

    client.get_object.side_effect = make_client_error("NoSuchKey")
    with pytest.raises(StorageError, match="File not found"):
        list(storage.retrieve("uploads/missing"))

    client.get_object.side_effect = make_client_error("AccessDenied")
    with pytest.raises(StorageError, match="S3 retrieval failed"):
        list(storage.retrieve("uploads/denied"))

    client.get_object.side_effect = Exception("generic")
    with pytest.raises(StorageError, match="Failed to retrieve"):
        list(storage.retrieve("uploads/error"))

    client.delete_object.side_effect = Exception("ignore")
    storage.delete("uploads/abc")


@patch("storage.boto3.client")
def test_get_storage_backend_and_print_info(mock_boto_client, tmp_path, capsys):
    class AttrLocalConfig:
        STORAGE_BACKEND = "local"
        UPLOAD_FOLDER = str(tmp_path)

    local_storage = get_storage_backend(AttrLocalConfig)
    assert isinstance(local_storage, LocalStorage)

    dict_local = get_storage_backend({"STORAGE_BACKEND": "local", "UPLOAD_FOLDER": str(tmp_path)})
    assert isinstance(dict_local, LocalStorage)

    s3_storage = get_storage_backend(
        {
            "STORAGE_BACKEND": "s3",
            "S3_BUCKET": "b",
            "S3_ACCESS_KEY": "a",
            "S3_SECRET_KEY": "s",
            "S3_REGION": "eu-west-1",
        }
    )
    assert isinstance(s3_storage, S3Storage)

    with pytest.raises(ValueError, match="S3 configuration incomplete"):
        get_storage_backend({"STORAGE_BACKEND": "s3"})

    with pytest.raises(ValueError, match="Unknown storage backend"):
        get_storage_backend({"STORAGE_BACKEND": "unknown"})

    print_backend_info(local_storage)
    assert "Storage backend: local" in capsys.readouterr().out

    s3_storage.test_connection = lambda: True
    print_backend_info(s3_storage)
    assert "S3 connection OK" in capsys.readouterr().out

    s3_storage.test_connection = lambda: False
    print_backend_info(s3_storage)
    assert "S3 connection FAILED" in capsys.readouterr().out
