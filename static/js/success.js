// --- Success Page Logic ---
// This file controls the UI for the upload success page:
// - Copying the share link to clipboard
// - Toggling password visibility
// - Auto-filling the password from sessionStorage

// Flash confirmation on the button. Only the visible label is rewritten: the
// button also carries a screen-reader-only prefix naming which link it copies,
// and setting textContent on the button itself would destroy it.
function flashCopied(button) {
    const label = button.querySelector('.copy-label');
    if (!label) return;
    const originalText = label.textContent;
    label.textContent = 'Copied!';
    setTimeout(() => {
        label.textContent = originalText;
    }, 2000);
}

// Copy the share link to clipboard and show a temporary message
function copyLink() {
    const shareLink = document.getElementById('share-link');
    shareLink.select();
    document.execCommand('copy');
    flashCopied(shareLink.nextElementSibling);
}

// Copy the share link with password to clipboard
function copyLinkWithPassword() {
    const shareLinkWithPassword = document.getElementById('share-link-with-password');
    shareLinkWithPassword.select();
    document.execCommand('copy');
    flashCopied(shareLinkWithPassword.nextElementSibling);
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

        // Generate link with password in URL fragment
        const shareLink = document.getElementById('share-link').value;
        const linkWithPassword = shareLink + '#' + encodeURIComponent(pwd);
        document.getElementById('share-link-with-password').value = linkWithPassword;

        sessionStorage.removeItem('uploadPassword');
    }
});
