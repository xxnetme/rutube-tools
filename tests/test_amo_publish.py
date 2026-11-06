"""Проверки локальных частей AMO-издателя, без сети и настоящих ключей."""
from __future__ import annotations

import base64
import hashlib
import hmac
import importlib.util
import json
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("amo_publish", ROOT / "tools" / "amo-publish.py")
assert SPEC and SPEC.loader
AMO = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(AMO)


def decode_segment(value: bytes) -> dict:
    return json.loads(base64.urlsafe_b64decode(value + b"=" * (-len(value) % 4)))


class JwtTests(unittest.TestCase):
    def test_jti_is_a_changing_nonce_not_the_secret(self) -> None:
        issuer = "user:12345:67"
        secret = "test-only-secret"
        first = AMO.jwt(issuer, secret)
        second = AMO.jwt(issuer, secret)
        first_parts = first.encode().split(b".")
        second_parts = second.encode().split(b".")
        self.assertEqual(len(first_parts), 3)

        header = decode_segment(first_parts[0])
        payload = decode_segment(first_parts[1])
        self.assertEqual(header, {"alg": "HS256", "typ": "JWT"})
        self.assertEqual(payload["iss"], issuer)
        self.assertNotEqual(payload["jti"], secret)
        self.assertNotEqual(payload["jti"], decode_segment(second_parts[1])["jti"])
        self.assertGreaterEqual(payload["exp"] - payload["iat"], 1)
        self.assertLessEqual(payload["exp"] - payload["iat"], 60)

        expected = hmac.new(
            secret.encode(), first_parts[0] + b"." + first_parts[1], hashlib.sha256
        ).digest()
        actual = base64.urlsafe_b64decode(first_parts[2] + b"=" * (-len(first_parts[2]) % 4))
        self.assertTrue(hmac.compare_digest(actual, expected))


if __name__ == "__main__":
    unittest.main()
