"""
Utility functions for Buzzdrop application.
"""
from datetime import datetime, timezone
from typing import Optional
from flask import current_app, has_app_context


DEFAULT_TIMEZONE = 'Europe/Warsaw'


def _localize(iso_timestamp: str, tz_name: str = DEFAULT_TIMEZONE) -> datetime:
    """Parse an ISO timestamp as an aware datetime in ``tz_name``.

    Naive timestamps (what the app stores) are read as ``tz_name`` local
    time. Falls back to UTC if the timezone can't be loaded. Raises
    ValueError on an unparseable timestamp.
    """
    dt = datetime.fromisoformat(iso_timestamp)
    try:
        from zoneinfo import ZoneInfo
        local_tz = ZoneInfo(tz_name)

        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=local_tz)
        else:
            dt = dt.astimezone(local_tz)

    except Exception:
        # Fallback to UTC if zoneinfo is not available or timezone is invalid
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
    return dt


def format_timestamp(iso_timestamp: str, tz_name: str = DEFAULT_TIMEZONE) -> str:
    """
    Convert ISO timestamp to localized formatted string.
    Falls back to UTC if timezone conversion fails.
    
    Args:
        iso_timestamp: ISO 8601 timestamp string
        tz_name: Timezone name (default: Europe/Warsaw)
    
    Returns:
        Formatted timestamp string in format: YYYY-MM-DD HH:MM:SS TZ
        If parsing fails, returns original timestamp
    
    Example:
        >>> format_timestamp('2024-01-15T10:30:00')
        '2024-01-15 10:30:00 CET'
    """
    try:
        return _localize(iso_timestamp, tz_name).strftime('%Y-%m-%d %H:%M:%S %Z')
    except Exception:
        # If all else fails, return original timestamp
        return iso_timestamp


def format_file_timestamps(file_dict: dict, tz_name: str = DEFAULT_TIMEZONE) -> dict:
    """
    Format all timestamp fields in a file dictionary.
    Modifies the dictionary in place.
    
    Args:
        file_dict: File information dictionary
        tz_name: Timezone name for formatting
    
    Returns:
        Modified file_dict with formatted timestamps
    
    Example:
        >>> file_data = {'created_at': '2024-01-15T10:30:00', 'name': 'test.txt'}
        >>> format_file_timestamps(file_data)
        {'created_at': '2024-01-15 10:30:00 CET', 'name': 'test.txt'}
    """
    timestamp_fields = ['created_at', 'downloaded_at', 'expiry_at']
    
    for field in timestamp_fields:
        # The <field>_iso twin keeps an offset-aware ISO value for
        # <time datetime>, sorting and relative times in the browser.
        file_dict[f'{field}_iso'] = None
        if file_dict.get(field):
            try:
                file_dict[f'{field}_iso'] = _localize(file_dict[field], tz_name).isoformat()
            except Exception:
                pass
            file_dict[field] = format_timestamp(file_dict[field], tz_name)
    
    return file_dict


# What the drop list calls each status. Only an active drop's link works.
STATUS_LABELS = {
    'active': 'Active',
    'decrypted': 'Decrypted',
    'decryption-failed': 'Decryption failed',
    'locked-out': 'Locked out',
    'downloaded': 'Downloaded',
    'expired': 'Expired',
}


def _display_name(file_dict: dict, tz_name: str) -> str:
    """The drop's title in the list: every note is stored as 'Secret Note',
    so a note goes by its private note, or failing that its time."""
    if file_dict.get('type') != 'text':
        return file_dict.get('original_name') or ''
    note = (file_dict.get('private_note') or '').strip()
    if note:
        return note
    try:
        return f"Text note \u00b7 {_localize(file_dict['created_at'], tz_name):%H:%M}"
    except Exception:
        return 'Text note'


def enhance_file_display(file_dict: dict, tz_name: str = DEFAULT_TIMEZONE) -> dict:
    """
    Enhance file dictionary with formatted timestamps and status display.
    Modifies the dictionary in place.
    
    Args:
        file_dict: File information dictionary
        tz_name: Timezone name for formatting timestamps
    
    Returns:
        Enhanced file_dict with:
        - Formatted timestamp fields (created_at, downloaded_at, expiry_at),
          each with an offset-aware ISO twin (<field>_iso, None when unset)
        - status_key (a key of STATUS_LABELS; only 'active' is a live link)
          and status_display, its label
        - display_name: the file name, or for a text note its private note,
          else "Text note · HH:MM"
    """
    # A text note has no file name; read the note's creation time before
    # the timestamps are formatted for display.
    file_dict['display_name'] = _display_name(file_dict, tz_name)

    # Format timestamps
    format_file_timestamps(file_dict, tz_name)

    # downloaded_at outranks expired: a drop that was claimed before its
    # deadline was consumed, not expired — and a downloaded drop with no
    # decryption report (e.g. wrong password, share burned) must not fall
    # through to Active. decryption_success=False without a download is
    # the key-release lockout (the password was never proven).
    if file_dict.get('decryption_success') is True:
        status_key = 'decrypted'
    elif file_dict.get('decryption_success') is False:
        status_key = 'decryption-failed' if file_dict.get('downloaded_at') else 'locked-out'
    elif file_dict.get('downloaded_at'):
        status_key = 'downloaded'
    elif file_dict.get('status') == 'expired':
        status_key = 'expired'
    else:
        status_key = 'active'
    file_dict['status_key'] = status_key
    file_dict['status_display'] = STATUS_LABELS[status_key]

    return file_dict


def allowed_file(filename: str) -> bool:
    """
    Check if a filename has an allowed extension.
    
    Args:
        filename: Filename to check
    
    Returns:
        True if file extension is allowed, False otherwise
    """
    if has_app_context():
        allowed_extensions = current_app.config.get('ALLOWED_EXTENSIONS', set())
    else:
        # Fallback to default if no app context
        import os
        allowed_extensions = set(
            os.getenv('ALLOWED_EXTENSIONS', 'txt,pdf,png,jpg,jpeg,gif,doc,docx,xls,xlsx').split(',')
        )
    
    return '.' in filename and filename.rsplit('.', 1)[1].lower() in allowed_extensions


def get_client_ip() -> str:
    """
    Get the client address for server-side enforcement.
    
    Returns:
        Client IP address as string
    """
    from flask import request

    return request.remote_addr or 'unknown'


def cleanup_orphaned_files(upload_dir: str, tracked_files: set) -> int:
    """
    Remove files from upload directory that are not tracked in database.
    
    Args:
        upload_dir: Path to upload directory
        tracked_files: Set of filenames that should be kept
    
    Returns:
        Number of files removed
    """
    import os
    
    if not os.path.exists(upload_dir):
        return 0
    
    # Get list of files in uploads directory
    uploaded_files = set(os.listdir(upload_dir))
    
    # Find orphaned files
    orphaned_files = uploaded_files - tracked_files
    
    removed_count = 0
    
    # Remove orphaned files
    for orphaned_file in orphaned_files:
        try:
            file_path = os.path.join(upload_dir, orphaned_file)
            os.remove(file_path)
            print(f"Removed orphaned file: {orphaned_file}")
            removed_count += 1
        except Exception as e:
            print(f"Error removing orphaned file {orphaned_file}: {str(e)}")
    
    return removed_count
