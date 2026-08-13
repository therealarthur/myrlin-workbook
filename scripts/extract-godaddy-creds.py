"""
Extract saved GoDaddy credentials from Chrome and Edge on Windows.

Runs LogonUser(INTERACTIVE) + ImpersonateLoggedOnUser so DPAPI master keys
become accessible (the shell's BATCH logon token can't unwrap them on its own).
Reads each browser's Login Data SQLite DB, unwraps the legacy 'encrypted_key'
via DPAPI, and decrypts v10/v11 password blobs with AES-GCM. v20 (app-bound
encrypted) blobs are reported but require SYSTEM-level decryption and are
skipped here.

Password is taken from the WIN_USER_PASSWORD env var so it does not have to
be embedded in source.
"""

import base64
import json
import os
import shutil
import sqlite3
import sys
import tempfile

import win32con
import win32crypt
import win32profile
import win32security
from Crypto.Cipher import AES


def unwrap_master_key(local_state_path):
    """Read encrypted_key from Local State and unwrap it with DPAPI."""
    with open(local_state_path, "r", encoding="utf-8") as fh:
        local_state = json.load(fh)
    osc = local_state.get("os_crypt", {})
    if "encrypted_key" not in osc:
        return None
    blob = base64.b64decode(osc["encrypted_key"])[5:]  # drop "DPAPI" prefix
    return win32crypt.CryptUnprotectData(blob, None, None, None, 0)[1]


def decrypt_password(blob, master_key):
    """Decrypt a single password blob.

    v10/v11: AES-GCM with DPAPI-derived master key (handled).
    v20: app-bound encryption, requires SYSTEM-context decryption (skipped).
    legacy: pure DPAPI blob.
    """
    if not blob:
        return ""
    prefix = blob[:3]
    try:
        if prefix == b"v20":
            return "<v20 app-bound encrypted - needs SYSTEM context>"
        if prefix in (b"v10", b"v11"):
            iv = blob[3:15]
            payload = blob[15:-16]
            tag = blob[-16:]
            cipher = AES.new(master_key, AES.MODE_GCM, iv)
            return cipher.decrypt_and_verify(payload, tag).decode("utf-8", errors="replace")
        return win32crypt.CryptUnprotectData(blob, None, None, None, 0)[1].decode(
            "utf-8", errors="replace"
        )
    except Exception as exc:
        return f"<decrypt failed: {exc!r}>"


def extract_browser(name, user_data_dir):
    """Extract GoDaddy/'amy' logins from one Chromium-family browser profile."""
    login_data_src = os.path.join(user_data_dir, "Default", "Login Data")
    local_state = os.path.join(user_data_dir, "Local State")
    if not os.path.exists(login_data_src) or not os.path.exists(local_state):
        print(f"[{name}] skipped: profile files missing")
        return []

    try:
        master_key = unwrap_master_key(local_state)
    except Exception as exc:
        print(f"[{name}] master key unwrap failed: {exc!r}")
        return []
    if not master_key:
        print(f"[{name}] no legacy encrypted_key found")
        return []

    with tempfile.TemporaryDirectory() as tmp:
        copy = os.path.join(tmp, "Login Data")
        shutil.copy2(login_data_src, copy)
        conn = sqlite3.connect(copy)
        cur = conn.cursor()
        cur.execute(
            "SELECT origin_url, username_value, password_value "
            "FROM logins "
            "WHERE origin_url LIKE '%godaddy%' OR username_value LIKE '%godaddy%' "
            "   OR username_value LIKE '%amy%'"
        )
        rows = cur.fetchall()
        conn.close()

    return [
        {
            "browser": name,
            "url": origin,
            "username": username,
            "password": decrypt_password(pw_blob, master_key),
        }
        for origin, username, pw_blob in rows
    ]


def run_with_interactive_logon(username, domain, password, fn):
    """Run fn() under an INTERACTIVE-logon impersonation so DPAPI works."""
    token = win32security.LogonUser(
        username,
        domain,
        password,
        win32con.LOGON32_LOGON_INTERACTIVE,
        win32con.LOGON32_PROVIDER_DEFAULT,
    )
    prof = win32profile.LoadUserProfile(token, {"UserName": username})
    try:
        win32security.ImpersonateLoggedOnUser(token)
        try:
            return fn()
        finally:
            win32security.RevertToSelf()
    finally:
        win32profile.UnloadUserProfile(token, prof)


def collect_all():
    """Top-level extraction across both browsers."""
    la = os.environ["LOCALAPPDATA"]
    targets = [
        ("Chrome", os.path.join(la, "Google", "Chrome", "User Data")),
        ("Edge", os.path.join(la, "Microsoft", "Edge", "User Data")),
    ]
    out = []
    for name, path in targets:
        out.extend(extract_browser(name, path))
    return out


def main():
    password = os.environ.get("WIN_USER_PASSWORD")
    if not password:
        print("Set WIN_USER_PASSWORD in env before running.", file=sys.stderr)
        sys.exit(2)
    username = os.environ.get("USERNAME", "arthur")
    domain = os.environ.get("USERDOMAIN", "cerberus")

    results = run_with_interactive_logon(username, domain, password, collect_all)

    if not results:
        print("No GoDaddy / 'amy' entries found.")
        return

    print(f"\nFound {len(results)} matching entr{'y' if len(results) == 1 else 'ies'}:\n")
    for i, row in enumerate(results, 1):
        print(f"--- Entry {i} ---")
        print(f"  Browser : {row['browser']}")
        print(f"  URL     : {row['url']}")
        print(f"  Username: {row['username']}")
        print(f"  Password: {row['password']}")
        print()


if __name__ == "__main__":
    main()
