"""Klien Responses API dengan keluaran JSON terstruktur, memakai stdlib Python."""

import json
import math
import os
import time
from http.client import HTTPException
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener


class AIConfigurationError(ValueError):
    pass


class AIServiceError(RuntimeError):
    pass


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        # Jangan meneruskan Authorization ke tujuan redirect.
        return None


def _json_object(raw):
    def reject_constant(_):
        raise ValueError("Konstanta bukan JSON")

    def unique_keys(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError("Key JSON ganda")
            result[key] = value
        return result

    try:
        value = json.loads(raw, parse_constant=reject_constant, object_pairs_hook=unique_keys)
    except (ValueError, UnicodeError, RecursionError) as error:
        raise AIServiceError("Respons AI bukan JSON valid; tidak ada hasil yang dipakai") from error
    if not isinstance(value, dict):
        raise AIServiceError("Respons AI harus berupa objek JSON")
    return value


class OpenAIResponsesClient:
    def __init__(self, settings):
        if not isinstance(settings, dict):
            raise AIConfigurationError("Konfigurasi ai harus berupa objek JSON")
        if settings.get("provider", "openai") != "openai":
            raise AIConfigurationError("Provider yang didukung saat ini adalah 'openai'")
        self.model = settings.get("model", "gpt-4.1-mini")
        base_url = settings.get("base_url", "https://api.openai.com/v1")
        key_env = settings.get("api_key_env", "OPENAI_API_KEY")
        if any(not isinstance(value, str) or not value.strip() for value in (self.model, base_url, key_env)):
            raise AIConfigurationError("Isi ai.model, ai.base_url, dan ai.api_key_env dengan teks")
        try:
            parsed = urlsplit(base_url)
            valid_url = (parsed.scheme == "https" and parsed.hostname and not parsed.username
                         and not parsed.password and not parsed.query and not parsed.fragment)
            parsed.port
        except ValueError:
            valid_url = False
        if not valid_url:
            raise AIConfigurationError("ai.base_url harus URL HTTPS tanpa kredensial, query, atau fragment")
        self.endpoint = base_url.rstrip("/") + "/responses"
        timeout = settings.get("timeout_seconds", 60)
        if type(timeout) not in (int, float) or not math.isfinite(timeout) or not 0 < timeout <= 300:
            raise AIConfigurationError("ai.timeout_seconds harus angka lebih dari 0 sampai 300")
        self.timeout = timeout
        retries = settings.get("max_retries", 2)
        if type(retries) is not int or not 0 <= retries <= 5:
            raise AIConfigurationError("ai.max_retries harus bilangan bulat 0 sampai 5")
        self.max_retries = retries
        self._api_key = os.environ.get(key_env, "").strip()
        if not self._api_key:
            raise AIConfigurationError(f"Isi environment variable {key_env} dengan API key sebelum menjalankan analisis AI")
        self._opener = build_opener(_NoRedirect())

    def complete(self, *, name, instructions, payload, schema):
        request_body = {
            "model": self.model,
            "instructions": instructions,
            "input": json.dumps(payload, ensure_ascii=False, allow_nan=False),
            "text": {"format": {"type": "json_schema", "name": name, "strict": True, "schema": schema}},
            "store": False,
            "max_output_tokens": 2500,
        }
        request = Request(
            self.endpoint, data=json.dumps(request_body, ensure_ascii=False, allow_nan=False).encode("utf-8"),
            headers={"Authorization": "Bearer " + self._api_key, "Content-Type": "application/json"},
            method="POST",
        )
        for attempt in range(self.max_retries + 1):
            try:
                with self._opener.open(request, timeout=self.timeout) as response:
                    raw = response.read(2_000_001)
                if len(raw) > 2_000_000:
                    raise AIServiceError("Respons API melebihi batas ukuran")
                return self._result(_json_object(raw))
            except HTTPError as error:
                code = error.code
                error.close()
                retryable = code == 429 or 500 <= code < 600
                if retryable and attempt < self.max_retries:
                    time.sleep(min(2 ** attempt, 4))
                    continue
                if code in (401, 403):
                    message = "API key tidak valid atau akses model tidak diizinkan"
                elif code == 429:
                    message = "Batas permintaan/kuota API tercapai; periksa akun dan coba lagi"
                elif code == 400:
                    message = "Periksa model, dukungan Structured Outputs, dan konfigurasi API"
                else:
                    message = "Layanan API menolak atau gagal memproses permintaan"
                # Jangan sertakan body HTTP, header, atau URL yang bisa mengandung rahasia.
                raise AIServiceError(f"HTTP {code}: {message}") from None
            except (URLError, TimeoutError, OSError, HTTPException):
                if attempt < self.max_retries:
                    time.sleep(min(2 ** attempt, 4))
                    continue
                raise AIServiceError("Tidak dapat menghubungi API AI setelah percobaan ulang; periksa jaringan dan endpoint") from None

    @staticmethod
    def _result(response):
        if response.get("status") != "completed":
            raise AIServiceError("Respons AI belum selesai/gagal; hasil parsial tidak dipakai")
        output = response.get("output")
        if not isinstance(output, list):
            raise AIServiceError("Struktur output API tidak valid")
        texts = []
        for entry in output:
            if not isinstance(entry, dict):
                raise AIServiceError("Struktur output API tidak valid")
            if entry.get("type") != "message":
                continue
            if entry.get("role") != "assistant" or not isinstance(entry.get("content"), list):
                raise AIServiceError("Struktur pesan AI tidak valid")
            for part in entry["content"]:
                if not isinstance(part, dict):
                    raise AIServiceError("Struktur isi pesan AI tidak valid")
                if part.get("type") == "refusal":
                    raise AIServiceError("Model menolak analisis uraian; periksa manual")
                if part.get("type") == "output_text":
                    if not isinstance(part.get("text"), str):
                        raise AIServiceError("Teks keluaran AI tidak valid")
                    texts.append(part["text"])
        if not texts:
            raise AIServiceError("Model tidak menghasilkan JSON penilaian")
        return _json_object("".join(texts))
