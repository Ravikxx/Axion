"""
LLM client with automatic fallback chain: Z.ai → Groq → Mistral
Retries each provider with exponential backoff before falling back.
"""

import asyncio
import json
import time
from typing import Any

import httpx

from config import LLM_LOG, LLM_MAX_RETRIES, LLM_BACKOFF_BASE, LLM_TIMEOUT, LLM_MAX_TOKENS, LLM_PROVIDERS
from utils import JsonlLogger


class LLMError(Exception):
    """Raised when all providers fail."""


class LLMClient:
    def __init__(self):
        self._logger = JsonlLogger(LLM_LOG)
        self._client = httpx.AsyncClient(timeout=LLM_TIMEOUT)
        self._stats  = {p["name"]: {"ok": 0, "fail": 0, "fallbacks": 0} for p in LLM_PROVIDERS}

    async def close(self):
        self._logger.close()
        await self._client.aclose()

    def _is_retryable(self, status: int) -> bool:
        return status in (429, 500, 502, 503, 504)

    async def _call_provider(self, provider: dict, messages: list[dict]) -> str:
        """Make a single API call to one provider. Returns the text response."""
        headers = {
            "Authorization": f"Bearer {provider['key']}",
            "Content-Type":  "application/json",
        }
        payload = {
            "model":      provider["model"],
            "messages":   messages,
            "max_tokens": LLM_MAX_TOKENS,
            "temperature":0.7,
        }
        r = await self._client.post(
            f"{provider['base_url']}/chat/completions",
            headers=headers,
            json=payload,
            timeout=LLM_TIMEOUT,
        )
        if r.status_code != 200:
            raise httpx.HTTPStatusError(
                f"HTTP {r.status_code}", request=r.request, response=r)
        data = r.json()
        return data["choices"][0]["message"]["content"].strip()

    async def generate(self, prompt: str) -> str:
        """
        Send prompt through the fallback chain.
        Returns the response text, or raises LLMError if all providers fail.
        """
        messages = [{"role": "user", "content": prompt}]

        for i, provider in enumerate(LLM_PROVIDERS):
            name = provider["name"]
            last_err = None

            for attempt in range(LLM_MAX_RETRIES + 1):
                try:
                    text = await self._call_provider(provider, messages)
                    self._stats[name]["ok"] += 1
                    if i > 0:
                        self._stats[LLM_PROVIDERS[i - 1]["name"]]["fallbacks"] += 1
                    return text

                except httpx.TimeoutException as e:
                    last_err = f"timeout: {e}"
                except httpx.HTTPStatusError as e:
                    last_err = f"HTTP {e.response.status_code}"
                    if not self._is_retryable(e.response.status_code):
                        break  # non-retryable — skip remaining retries
                except Exception as e:
                    last_err = str(e)

                if attempt < LLM_MAX_RETRIES:
                    wait = LLM_BACKOFF_BASE ** (attempt + 1)
                    self._logger.log(
                        event="retry", provider=name,
                        attempt=attempt + 1, error=last_err, wait=wait,
                    )
                    await asyncio.sleep(wait)

            # This provider exhausted — log and fall back
            self._stats[name]["fail"] += 1
            self._logger.log(
                event="fallback", from_provider=name,
                to_provider=LLM_PROVIDERS[i + 1]["name"] if i + 1 < len(LLM_PROVIDERS) else "none",
                error=last_err,
            )

        raise LLMError("All LLM providers failed.")

    def print_stats(self):
        print("\n  LLM provider stats:")
        for name, s in self._stats.items():
            print(f"    {name:<10}  ok={s['ok']}  fail={s['fail']}  fallbacks={s['fallbacks']}")
