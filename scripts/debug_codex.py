"""One-off debug script to see what events the codex SDK emits."""

import asyncio
import os
import shutil
import sys

from codex_app_server_sdk import CodexClient, ThreadConfig


def codex_command() -> list[str]:
    for name in ("codex.cmd", "codex.exe", "codex"):
        found = shutil.which(name)
        if found:
            return [found, "app-server"]
    return ["codex", "app-server"]


async def main() -> None:
    config = ThreadConfig(
        cwd=os.getcwd(),
        sandbox="danger-full-access",
        approval_policy="never",
    )
    async with CodexClient.connect_stdio(command=codex_command()) as client:
        await client.initialize()
        thread = await client.start_thread(config=config)
        print(f"thread: {thread.thread_id}\n")
        async for step in client.chat("reply with just: ok", thread_id=thread.thread_id):
            print(f"step item_type={step.item_type!r} item_id={step.item_id!r}")
            print(f"  dump={step.model_dump()}"[:500])
            print()


asyncio.run(main())
