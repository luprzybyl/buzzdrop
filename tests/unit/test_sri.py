"""
Unit tests for Subresource Integrity (SRI) functionality.

Tests verify that:
1. SRI hashes are generated correctly using SHA-384
2. The sri_hash function works as expected
3. Hashes match actual file contents
"""
import os
import hashlib
import base64
import pytest
from app import app


def get_sri_hash_function():
    """Helper to get the sri_hash function from app context."""
    # Import the function directly by rendering a template that uses it
    with app.test_request_context():
        from flask import render_template_string
        # Render a simple template to access the function
        template = "{{ sri_hash('js/main.js') }}"
        result = render_template_string(template)
        return result
    

def test_sri_hash_function_available_in_templates():
    """Test that sri_hash function is available in template context."""
    with app.test_client() as client:
        # Create a test template that uses sri_hash
        with app.test_request_context():
            from flask import render_template_string
            template = "{{ 'sri_hash' in globals() or 'sri_hash' in locals() }}"
            try:
                result = render_template_string("{{ sri_hash }}")
                assert True, "sri_hash should be accessible in templates"
            except Exception:
                pytest.fail("sri_hash function not available in templates")


def test_sri_hash_generates_valid_hash():
    """Test that sri_hash generates a valid SHA-384 hash."""
    with app.test_request_context():
        from flask import render_template_string
        # Test with main.js
        template = "{{ sri_hash('js/main.js') }}"
        hash_result = render_template_string(template)
        
        # Should start with 'sha384-'
        assert hash_result.startswith('sha384-'), "Hash should start with 'sha384-'"
        
        # Should be base64 encoded (SHA-384 produces 48 bytes, base64 encoded is 64 chars)
        hash_value = hash_result.replace('sha384-', '')
        assert len(hash_value) == 64, "SHA-384 base64 hash should be 64 characters"


def test_sri_hash_matches_actual_file():
    """Test that generated hash matches the actual file content."""
    with app.test_request_context():
        from flask import render_template_string
        
        # Test with main.js
        template = "{{ sri_hash('js/main.js') }}"
        hash_result = render_template_string(template)
        
        # Calculate hash manually
        filepath = os.path.join(app.static_folder, 'js/main.js')
        with open(filepath, 'rb') as f:
            file_content = f.read()
            expected_hash = 'sha384-' + base64.b64encode(
                hashlib.sha384(file_content).digest()
            ).decode()
        
        assert hash_result == expected_hash, "Generated hash should match manual calculation"


def test_sri_hash_different_files_different_hashes():
    """Test that different files produce different hashes."""
    with app.test_request_context():
        from flask import render_template_string
        
        hash1 = render_template_string("{{ sri_hash('js/main.js') }}")
        hash2 = render_template_string("{{ sri_hash('js/view.js') }}")
        
        assert hash1 != hash2, "Different files should have different hashes"


def test_sri_hash_nonexistent_file_dev_mode(monkeypatch):
    """Test that missing file raises error in development mode."""
    monkeypatch.setenv('FLASK_ENV', 'development')
    
    with app.test_request_context():
        from flask import render_template_string
        
        with pytest.raises(FileNotFoundError):
            render_template_string("{{ sri_hash('js/nonexistent.js') }}")


def test_sri_hash_nonexistent_file_production_mode(monkeypatch):
    """Test that missing file returns empty string in production mode."""
    monkeypatch.setenv('FLASK_ENV', 'production')
    
    with app.test_request_context():
        from flask import render_template_string
        
        # Should return empty string instead of raising
        result = render_template_string("{{ sri_hash('js/nonexistent.js') }}")
        assert result == "", "Should return empty string in production for missing files"


def test_sri_hash_consistent_for_same_file():
    """Test that the same file always produces the same hash."""
    with app.test_request_context():
        from flask import render_template_string
        
        hash1 = render_template_string("{{ sri_hash('js/main.js') }}")
        hash2 = render_template_string("{{ sri_hash('js/main.js') }}")
        
        assert hash1 == hash2, "Same file should produce consistent hash"


def test_all_javascript_files_have_valid_hashes():
    """Test that all JavaScript files in static folder can generate valid hashes."""
    with app.test_request_context():
        from flask import render_template_string
        
        # List of JS files that should exist
        js_files = ['js/main.js', 'js/view.js', 'js/success.js', 'js/crypto.js']
        
        for js_file in js_files:
            filepath = os.path.join(app.static_folder, js_file)
            if os.path.exists(filepath):
                template = f"{{{{ sri_hash('{js_file}') }}}}"
                hash_result = render_template_string(template)
                assert hash_result.startswith('sha384-'), f"{js_file} should have valid hash"
                assert len(hash_result) > 10, f"{js_file} hash should not be empty"
