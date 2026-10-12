"""Uji protokol HTTP dengan transport tiruan; tidak memanggil penyedia AI."""

import io
import json
import os
import unittest
from unittest.mock import MagicMock, patch
from urllib.error import HTTPError, URLError

from ai_client import AIConfigurationError, AIServiceError, OpenAIResponsesClient, _NoRedirect


def api_response(text='{"ok": true}'):
    return {"status": "completed", "output": [{"type": "message", "role": "assistant",
            "content": [{"type": "output_text", "text": text}]}]}


def http_response(data):
    response = MagicMock()
    response.__enter__.return_value.read.return_value = json.dumps(data).encode("utf-8")
    return response


class AIClientTests(unittest.TestCase):
    def setUp(self):
        env = patch.dict(os.environ, {"OPENAI_API_KEY": "test-key-never-print"})
        env.start()
        self.addCleanup(env.stop)
        builder = patch("ai_client.build_opener")
        self.builder = builder.start()
        self.addCleanup(builder.stop)
        self.opener = self.builder.return_value
        sleep = patch("ai_client.time.sleep")
        self.sleep = sleep.start()
        self.addCleanup(sleep.stop)
        self.schema = {"type": "object", "properties": {"ok": {"type": "boolean"}},
                       "required": ["ok"], "additionalProperties": False}

    def call(self, client=None):
        return (client or OpenAIResponsesClient({})).complete(
            name="test_analysis", instructions="Ekstrak makna uraian.",
            payload={"description": "sebuah iPhone"}, schema=self.schema)

    def test_request_uses_structured_output_without_storing_response(self):
        self.opener.open.return_value = http_response(api_response())
        self.assertEqual(self.call(), {"ok": True})
        args, kwargs = self.opener.open.call_args
        request = args[0]
        self.assertEqual(request.full_url, "https://api.openai.com/v1/responses")
        self.assertEqual(request.get_method(), "POST")
        self.assertEqual(kwargs["timeout"], 60)
        body = json.loads(request.data)
        self.assertEqual(body["text"]["format"]["schema"], self.schema)
        self.assertTrue(body["text"]["format"]["strict"])
        self.assertFalse(body["store"])
        self.assertNotIn("tools", body)
        self.assertNotIn("test-key-never-print", request.data.decode())
        self.assertEqual(json.loads(body["input"]), {"description": "sebuah iPhone"})
        self.assertIsInstance(self.builder.call_args.args[0], _NoRedirect)

    def test_missing_key_fails_before_network(self):
        with patch.dict(os.environ, {}, clear=True), self.assertRaisesRegex(AIConfigurationError, "OPENAI_API_KEY"):
            OpenAIResponsesClient({})
        self.opener.open.assert_not_called()

    def test_invalid_configuration_is_rejected(self):
        for settings in (None, {"provider": "unknown"}, {"model": ""},
                         {"base_url": "http://api.example/v1"}, {"base_url": "https://user:pass@example/v1"},
                         {"base_url": "https://example/v1?key=secret"}, {"timeout_seconds": 0},
                         {"timeout_seconds": float("inf")}, {"max_retries": -1}, {"max_retries": True}):
            with self.subTest(settings=settings), self.assertRaises(AIConfigurationError):
                OpenAIResponsesClient(settings)

    def test_redirect_does_not_forward_authorization(self):
        self.assertIsNone(_NoRedirect().redirect_request(None, None, 302, "redirect", {}, "https://other.example"))

    def test_retryable_http_error_is_retried(self):
        error = HTTPError("https://example", 429, "Too many", {}, io.BytesIO(b"secret provider body"))
        self.opener.open.side_effect = [error, http_response(api_response())]
        self.assertEqual(self.call(), {"ok": True})
        self.assertEqual(self.opener.open.call_count, 2)
        self.sleep.assert_called_once_with(1)

    def test_network_retry_count_is_bounded_and_errors_are_sanitized(self):
        self.opener.open.side_effect = URLError("test-key-never-print")
        with self.assertRaises(AIServiceError) as error:
            self.call()
        self.assertEqual(self.opener.open.call_count, 3)
        self.assertNotIn("test-key-never-print", str(error.exception))
        self.assertEqual(self.sleep.call_count, 2)

    def test_permanent_http_error_does_not_retry_or_leak_body(self):
        self.opener.open.side_effect = HTTPError("https://example", 401, "test-key-never-print", {},
                                                io.BytesIO(b"test-key-never-print"))
        with self.assertRaises(AIServiceError) as error:
            self.call()
        self.assertIn("401", str(error.exception))
        self.assertNotIn("test-key-never-print", str(error.exception))
        self.assertEqual(self.opener.open.call_count, 1)

    def test_incomplete_refused_and_malformed_output_never_return_results(self):
        invalid = [
            {"status": "incomplete", "output": []},
            {"status": "completed", "output": []},
            {"status": "completed", "output": None},
            {"status": "completed", "output": [{"type": "message", "role": "assistant", "content": [
                {"type": "refusal", "refusal": "Cannot analyze"}]}]},
            api_response("```json\n{}\n```"), api_response("[]"), api_response('{"value": NaN}'),
            api_response('{"ok": true, "ok": false}'),
        ]
        for response in invalid:
            with self.subTest(response=response):
                self.opener.open.return_value = http_response(response)
                with self.assertRaises(AIServiceError):
                    self.call()

    def test_invalid_http_json_is_not_retried(self):
        response = MagicMock()
        response.__enter__.return_value.read.return_value = b"<html>bad gateway</html>"
        self.opener.open.return_value = response
        with self.assertRaises(AIServiceError):
            self.call()
        self.assertEqual(self.opener.open.call_count, 1)


if __name__ == "__main__":
    unittest.main()
