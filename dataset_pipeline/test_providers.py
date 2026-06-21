"""Quick smoke test — verify each LLM provider responds before a full run."""

import asyncio
import httpx

from config import LLM_PROVIDERS, LLM_TIMEOUT


async def test_provider(client: httpx.AsyncClient, p: dict) -> tuple[str, bool, str]:
    try:
        r = await client.post(
            f"{p['base_url']}/chat/completions",
            headers={"Authorization": f"Bearer {p['key']}", "Content-Type": "application/json"},
            json={
                "model": p["model"],
                "messages": [{"role": "user", "content": "Reply with the single word: ok"}],
                "max_tokens": 10,
                "temperature": 0,
            },
            timeout=LLM_TIMEOUT,
        )
        if r.status_code != 200:
            return p["name"], False, f"HTTP {r.status_code}: {r.text[:160]}"
        content = r.json()["choices"][0]["message"]["content"].strip()
        return p["name"], True, f'OK → "{content}"'
    except Exception as e:
        return p["name"], False, f"{type(e).__name__}: {e}"


async def main():
    print("Testing LLM providers…\n")
    async with httpx.AsyncClient() as client:
        results = await asyncio.gather(*(test_provider(client, p) for p in LLM_PROVIDERS))

    for name, ok, msg in results:
        mark = "✓" if ok else "✗"
        print(f"  {mark} {name:<10} ({_model_for(name)})  {msg}")

    working = sum(1 for _, ok, _ in results if ok)
    print(f"\n  {working}/{len(results)} providers working.")
    if working == 0:
        print("  All providers failed — fix config before running the pipeline.")


def _model_for(name: str) -> str:
    for p in LLM_PROVIDERS:
        if p["name"] == name:
            return p["model"]
    return "?"


if __name__ == "__main__":
    asyncio.run(main())
