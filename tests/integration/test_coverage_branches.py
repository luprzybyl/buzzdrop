import io

from flask import url_for
from tinydb import Query


def login_user(client, username="testuser", password="password"):
    return client.post(
        url_for("login"),
        data={"username": username, "password": password},
        follow_redirects=True,
    )


def test_favicon_route(client):
    response = client.get(url_for("favicon"))
    assert response.status_code == 200
    assert response.mimetype == "image/vnd.microsoft.icon"


def test_upload_file_ajax_success_and_invalid_expiry(client, files_table):
    login_user(client)
    response = client.post(
        url_for("upload_file"),
        data={"file": (io.BytesIO(b"hello"), "ajax.txt"), "expiry": "not-a-date"},
        content_type="multipart/form-data",
        headers={"X-Requested-With": "XMLHttpRequest"},
    )
    assert response.status_code == 200

    payload = response.get_json()
    assert payload["type"] == "file"
    assert payload["file_id"]

    file_row = files_table.get(Query().id == payload["file_id"])
    assert file_row["expiry_at"] is None


def test_upload_file_ajax_success_and_valid_expiry(client, files_table):
    login_user(client)
    response = client.post(
        url_for("upload_file"),
        data={"file": (io.BytesIO(b"hello"), "ajax-valid.txt"), "expiry": "2030-12-31T23:59"},
        content_type="multipart/form-data",
        headers={"X-Requested-With": "XMLHttpRequest"},
    )
    assert response.status_code == 200

    payload = response.get_json()
    file_row = files_table.get(Query().id == payload["file_id"])
    assert file_row["expiry_at"] is not None
    assert file_row["expiry_at"].startswith("2030-12-31T23:59")


def test_upload_file_disallowed_extension_ajax_returns_json_error(client):
    login_user(client)
    response = client.post(
        url_for("upload_file"),
        data={"file": (io.BytesIO(b"x"), "bad.exe")},
        content_type="multipart/form-data",
        headers={"X-Requested-With": "XMLHttpRequest"},
    )
    assert response.status_code == 400
    assert response.get_json() == {"error": "File type not allowed"}


def test_confirm_view_file_not_found(client):
    response = client.post(url_for("confirm_view_file", file_id="missing"), follow_redirects=True)
    assert response.status_code == 200
    assert b"File not found" in response.data


def test_report_decryption_invalid_payload(client, files_table):
    login_user(client)
    upload = client.post(
        url_for("upload_file"),
        data={"file": (io.BytesIO(b"hello"), "decrypt.txt")},
        content_type="multipart/form-data",
        headers={"X-Requested-With": "XMLHttpRequest"},
    ).get_json()

    response = client.post(url_for("report_decryption", file_id=upload["file_id"]), json={})
    assert response.status_code == 400
    assert response.get_json() == {"error": "Invalid request"}


def test_delete_file_not_owned_by_user(client, files_table):
    login_user(client, "testuser", "password")
    upload = client.post(
        url_for("upload_file"),
        data={"file": (io.BytesIO(b"hello"), "owned.txt")},
        content_type="multipart/form-data",
        headers={"X-Requested-With": "XMLHttpRequest"},
    ).get_json()

    client.get(url_for("logout"), follow_redirects=True)
    login_user(client, "adminuser", "adminpass")

    response = client.post(url_for("delete_file", file_id=upload["file_id"]), follow_redirects=True)
    assert response.status_code == 200
    assert b"File not found" in response.data
    assert files_table.get(Query().id == upload["file_id"]) is not None


def test_view_file_invalid_expiry_value_is_ignored(client, files_table):
    files_table.insert(
        {
            "id": "invalid-expiry",
            "original_name": "name.txt",
            "path": "/tmp/nowhere",
            "downloaded_at": None,
            "uploaded_by": "testuser",
            "expiry_at": "bad-expiry-format",
            "status": "active",
            "type": "file",
            "shared_with": [],
        }
    )

    response = client.get(url_for("view_file", file_id="invalid-expiry"))
    assert response.status_code == 200
    assert b"Ready to Download?" in response.data
