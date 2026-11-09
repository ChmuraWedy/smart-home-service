"""Encrypt member API keys for explicit retrieval by household administrators."""

import os
import secrets
import tempfile
from pathlib import Path

from Crypto.Cipher import AES


class AccountKeyVault:
    def __init__(self, database_path: str):
        self.path = Path(database_path + ".account-key-vault") if database_path != ":memory:" else None
        self.memory_key = secrets.token_bytes(32) if self.path is None else None

    def _key(self, *, create: bool) -> bytes:
        if self.path is None:
            assert self.memory_key is not None
            return self.memory_key
        try:
            return self._read()
        except FileNotFoundError:
            if not create:
                raise

        fd, temporary = tempfile.mkstemp(prefix=".account-key-vault-", dir=self.path.parent)
        try:
            with os.fdopen(fd, "wb") as file:
                file.write(secrets.token_bytes(32))
                file.flush()
                os.fsync(file.fileno())
            try:
                os.link(temporary, self.path)
            except FileExistsError:
                pass
        finally:
            os.unlink(temporary)
        return self._read()

    def _read(self) -> bytes:
        fd = os.open(self.path, os.O_RDONLY | os.O_NOFOLLOW)
        with os.fdopen(fd, "rb") as file:
            if os.fstat(file.fileno()).st_mode & 0o077:
                raise PermissionError("Account key vault permissions are too broad")
            key = file.read(33)
        if len(key) != 32:
            raise ValueError("Invalid account key vault")
        return key

    def seal(self, member_id: str, token: str) -> bytes:
        cipher = AES.new(self._key(create=True), AES.MODE_GCM, nonce=secrets.token_bytes(16))
        cipher.update(member_id.encode("ascii"))
        ciphertext, tag = cipher.encrypt_and_digest(token.encode("ascii"))
        return cipher.nonce + tag + ciphertext

    def reveal(self, member_id: str, sealed: bytes) -> str:
        cipher = AES.new(self._key(create=False), AES.MODE_GCM, nonce=sealed[:16])
        cipher.update(member_id.encode("ascii"))
        return cipher.decrypt_and_verify(sealed[32:], sealed[16:32]).decode("ascii")
