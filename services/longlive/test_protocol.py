# Run: cd services/longlive && python -m unittest -v test_protocol
import base64
import hashlib
import hmac
import json
import unittest

from protocol import (
    CLOSE_BAD_REQUEST,
    CLOSE_BAD_TICKET,
    PromptMessage,
    ProtocolError,
    StartMessage,
    StopMessage,
    is_allowed_image_url,
    pack_frame,
    parse_client_message,
    sign_ticket,
    verify_ticket,
)

SECRET = "s" * 64
NOW = 1_800_000_000


def b64(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


class TicketTest(unittest.TestCase):
    def test_round_trip(self):
        ticket = sign_ticket({"sid": "abc", "exp": NOW + 120}, SECRET)
        self.assertEqual(verify_ticket(ticket, SECRET, NOW), "abc")

    def test_matches_contract_format_built_by_hand(self):
        # Mirrors the Next.js mint: base64url(JSON) + "." + base64url(HMAC-SHA256(secret, payloadPart)).
        payload_part = b64(json.dumps({"sid": "u-1", "exp": NOW + 60}).encode())
        signature = hmac.new(SECRET.encode(), payload_part.encode(), hashlib.sha256).digest()
        self.assertEqual(verify_ticket(f"{payload_part}.{b64(signature)}", SECRET, NOW), "u-1")

    def test_accepts_padded_base64(self):
        payload_part = base64.urlsafe_b64encode(json.dumps({"sid": "x", "exp": NOW + 5}).encode()).decode()
        signature = hmac.new(SECRET.encode(), payload_part.encode(), hashlib.sha256).digest()
        ticket = f"{payload_part}.{base64.urlsafe_b64encode(signature).decode()}"
        self.assertEqual(verify_ticket(ticket, SECRET, NOW), "x")

    def assert_rejected(self, ticket, secret=SECRET, now=NOW):
        with self.assertRaises(ProtocolError) as caught:
            verify_ticket(ticket, secret, now)
        self.assertEqual(caught.exception.code, CLOSE_BAD_TICKET)

    def test_expired(self):
        self.assert_rejected(sign_ticket({"sid": "a", "exp": NOW}, SECRET))
        self.assert_rejected(sign_ticket({"sid": "a", "exp": NOW - 1}, SECRET))

    def test_wrong_secret(self):
        self.assert_rejected(sign_ticket({"sid": "a", "exp": NOW + 60}, "t" * 64))

    def test_tampered_payload(self):
        ticket = sign_ticket({"sid": "a", "exp": NOW + 60}, SECRET)
        _, signature = ticket.split(".")
        forged = b64(json.dumps({"sid": "a", "exp": NOW + 99999}).encode())
        self.assert_rejected(f"{forged}.{signature}")

    def test_malformed(self):
        for ticket in [None, "", "abc", "a.b.c", "!!!.???", "e30.e30"]:
            self.assert_rejected(ticket)

    def test_missing_fields(self):
        self.assert_rejected(sign_ticket({"exp": NOW + 60}, SECRET))
        self.assert_rejected(sign_ticket({"sid": "a"}, SECRET))
        self.assert_rejected(sign_ticket({"sid": "a", "exp": "later"}, SECRET))
        self.assert_rejected(sign_ticket({"sid": "a", "exp": True}, SECRET))
        self.assert_rejected(sign_ticket(["sid"], SECRET))

    def test_fails_closed_without_secret(self):
        ticket = sign_ticket({"sid": "a", "exp": NOW + 60}, "")
        self.assert_rejected(ticket, secret="")
        self.assert_rejected(ticket, secret=None)
        self.assert_rejected(sign_ticket({"sid": "a", "exp": NOW + 60}, "short"), secret="short")


class AllowlistTest(unittest.TestCase):
    def test_allowed(self):
        for url in [
            "https://fal.media/files/a.png",
            "https://v3.fal.media/files/b/c.jpeg",
            "https://v3b.fal.media/files/x.webp",
            "https://cdn.eu.fal.media/y.png",
            "https://storage.googleapis.com/falserverless/example/z.png",
        ]:
            self.assertTrue(is_allowed_image_url(url), url)

    def test_rejected(self):
        for url in [
            "http://v3.fal.media/files/a.png",
            "https://evilfal.media/a.png",
            "https://fal.media.evil.com/a.png",
            "https://storage.googleapis.com/other-bucket/a.png",
            "https://storage.googleapis.com/falserverless-evil/a.png",
            "https://user:pw@v3.fal.media/a.png",
            "https://v3.fal.media:8443/a.png",
            "https://127.0.0.1/a.png",
            "file:///etc/passwd",
            "data:image/png;base64,AAAA",
            "not a url",
        ]:
            self.assertFalse(is_allowed_image_url(url), url)


class MessageTest(unittest.TestCase):
    def start(self, **overrides):
        message = {
            "type": "start",
            "referenceImageUrl": "https://v3.fal.media/files/a.png",
            "prompt": "an adult woman waves",
            "width": 480,
            "height": 832,
            "fps": 16,
        }
        message.update(overrides)
        return json.dumps(message)

    def assert_bad(self, text, **kwargs):
        with self.assertRaises(ProtocolError) as caught:
            parse_client_message(text, **kwargs)
        self.assertEqual(caught.exception.code, CLOSE_BAD_REQUEST)

    def test_start(self):
        self.assertEqual(
            parse_client_message(self.start()),
            StartMessage("https://v3.fal.media/files/a.png", "an adult woman waves", 480, 832, 16),
        )

    def test_start_rejects_bad_host_and_shapes(self):
        self.assert_bad(self.start(referenceImageUrl="https://example.com/a.png"))
        self.assert_bad(self.start(width=481))
        self.assert_bad(self.start(width=128))
        self.assert_bad(self.start(width=1280, height=1280))
        self.assert_bad(self.start(fps=60))
        self.assert_bad(self.start(fps=True))
        self.assert_bad(self.start(prompt=""))
        self.assert_bad(self.start(prompt="x" * 2001))

    def test_data_uri_needs_explicit_opt_in(self):
        text = self.start(referenceImageUrl="data:image/png;base64,iVBORw0KGgo=")
        self.assert_bad(text)
        self.assertIsInstance(parse_client_message(text, allow_data_uri=True), StartMessage)

    def test_prompt_and_stop(self):
        self.assertEqual(
            parse_client_message(json.dumps({"type": "prompt", "prompt": " hi ", "id": "r1"})), PromptMessage("hi", "r1")
        )
        self.assertEqual(parse_client_message('{"type":"stop"}'), StopMessage())
        self.assert_bad(json.dumps({"type": "prompt", "prompt": "hi"}))
        self.assert_bad("[]")
        self.assert_bad("nope")
        self.assert_bad('{"type":"dance"}')

    def test_pack_frame(self):
        self.assertEqual(pack_frame(258, b"\xff\xd8"), b"\x00\x00\x01\x02\xff\xd8")


if __name__ == "__main__":
    unittest.main()
