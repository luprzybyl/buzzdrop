// --- Success Page Logic ---
// This file controls the UI for the upload success page:
// - Copying the share link to clipboard
// - Toggling password visibility
// - Auto-filling the password from sessionStorage

// Copy the share link to clipboard and show a temporary message
function copyLink() {
    const shareLink = document.getElementById('share-link');
    shareLink.select();
    document.execCommand('copy');

    const button = shareLink.nextElementSibling;
    const originalText = button.textContent;
    button.textContent = 'Copied!';
    setTimeout(() => {
        button.textContent = originalText;
    }, 2000);
}

// Toggle password field between 'password' and 'text' for user convenience
function togglePasswordVisibility() {
    const pwdInput = document.getElementById('password-display');
    const toggleBtn = document.getElementById('toggle-password');
    if (pwdInput.type === 'password') {
        pwdInput.type = 'text';
        toggleBtn.textContent = 'Hide';
        setTimeout(() => {
            pwdInput.type = 'password';
            toggleBtn.textContent = 'Show';
        }, 5000);
    } else {
        pwdInput.type = 'password';
        toggleBtn.textContent = 'Show';
    }
}

// On page load, auto-fill password from sessionStorage if present
// (This helps the user copy/share the password after upload)
document.addEventListener('DOMContentLoaded', function() {
    const pwd = sessionStorage.getItem('uploadPassword');
    if (pwd) {
        document.getElementById('password-display').value = pwd;
        sessionStorage.removeItem('uploadPassword');
    }
});
