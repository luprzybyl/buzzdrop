"""
Utility functions for Buzzdrop application.
"""
from datetime import datetime, timezone
from typing import Optional
from flask import current_app, has_app_context


DEFAULT_TIMEZONE = 'Europe/Warsaw'


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
        dt = datetime.fromisoformat(iso_timestamp)
        
        # Try to apply timezone
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
        
        return dt.strftime('%Y-%m-%d %H:%M:%S %Z')
    
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
        if file_dict.get(field):
            file_dict[field] = format_timestamp(file_dict[field], tz_name)
    
    return file_dict


def get_status_display(file_dict: dict) -> str:
    """
    Get human-readable status display for a file.
    
    Args:
        file_dict: File information dictionary
    
    Returns:
        Status string: 'Expired', 'Success', 'Failed', or empty string
    """
    if file_dict.get('status') == 'expired':
        return 'Expired'
    
    decryption_success = file_dict.get('decryption_success')
    
    if decryption_success is True:
        return 'Success'
    elif decryption_success is False:
        return 'Failed'
    else:
        return ''


def enhance_file_display(file_dict: dict, tz_name: str = DEFAULT_TIMEZONE) -> dict:
    """
    Enhance file dictionary with formatted timestamps and status display.
    Modifies the dictionary in place.
    
    Args:
        file_dict: File information dictionary
        tz_name: Timezone name for formatting timestamps
    
    Returns:
        Enhanced file_dict
    """
    # Format timestamps
    format_file_timestamps(file_dict, tz_name)
    
    # Add status display
    file_dict['status_display'] = get_status_display(file_dict)
    
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
    Get client IP address, handling proxies.
    
    Returns:
        Client IP address as string
    """
    from flask import request
    
    # Check for X-Forwarded-For header (behind proxy)
    if request.headers.get('X-Forwarded-For'):
        # X-Forwarded-For can contain multiple IPs, first one is the client
        return request.headers.get('X-Forwarded-For').split(',')[0].strip()
    
    # Fallback to direct remote address
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
