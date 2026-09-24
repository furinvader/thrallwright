#!/usr/bin/env python3
"""Optional real-browser check. Install the app, terminal assets, and Playwright first."""
import argparse
import asyncio
import json
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import sys
import tempfile

from aiohttp import web
from playwright.async_api import async_playwright, expect

from thrallwright.server import MANAGER, create_app


async def main(screenshot: Path | None):
    with tempfile.TemporaryDirectory(prefix="thrallwright-browser-") as temporary:
        workspace = Path(temporary) / "thrallwright"
        workspace.mkdir()
        (workspace / ".gitignore").write_text(".thrallwright/\n")
        (workspace / "README.md").write_text("# Thrallwright\nA local workbench.\n")
        def git(*args):
            subprocess.run(["git", *args], cwd=workspace, check=True, capture_output=True)
        git("init", "-b", "feat/bootstrap-workspace")
        git("add", ".")
        git("-c", "user.name=Browser Test", "-c", "user.email=test@example.invalid", "commit", "-m", "fixture")
        (workspace / "README.md").write_text("# Thrallwright\nBuild the next bit, right here.\n")
        os.environ["SHELL"] = "/bin/sh"
        app = create_app(workspace)
        runner = web.AppRunner(app, shutdown_timeout=2)
        await runner.setup()
        site = web.TCPSite(runner, "127.0.0.1", 0)
        await site.start()
        port = site._server.sockets[0].getsockname()[1]
        errors = []
        try:
            async with async_playwright() as playwright:
                system_browser = (None if Path(playwright.chromium.executable_path).is_file()
                                  else shutil.which("chromium"))
                browser = await playwright.chromium.launch(executable_path=system_browser, headless=True)
                context = await browser.new_context(viewport={"width": 1440, "height": 960})
                page = await context.new_page()
                page.on("pageerror", lambda error: errors.append(str(error)))
                page.on("console", lambda message: errors.append(message.text) if message.type == "error" else None)
                # Locator assertions retry without string eval under the app's strict CSP.
                await page.goto(f"http://127.0.0.1:{port}")
                await page.locator("#new-session").click()
                await page.locator("#profile").select_option("shell")
                await page.locator("#session-name").fill("Develop Thrallwright")
                await page.locator("#launch").click()
                await page.locator("#terminal .xterm-helper-textarea").wait_for()
                await expect(page.locator("#connection-state")).to_contain_text("Connected")
                item = next(iter(app[MANAGER].sessions.values()))
                pid = item.process.pid
                async def typed(command):
                    await page.locator(".xterm-helper-textarea").focus()
                    await page.keyboard.type(command)
                    await page.keyboard.press("Enter")
                async def output_contains(marker):
                    async with asyncio.timeout(30):
                        while marker not in app[MANAGER].store.transcript(item.meta["id"]).decode(errors="replace"):
                            await asyncio.sleep(0.05)
                await typed("printf '__BROWSER_%s__\\n' 'PASS'")
                await output_contains("__BROWSER_PASS__")
                await page.reload()
                await expect(page.locator("#connection-state")).to_contain_text("Connected")
                assert item.process.pid == pid and item.running, "Reload lost the process"
                await typed("printf '__AFTER_%s__\\n' 'REFRESH'")
                await output_contains("__AFTER_REFRESH__")
                await page.locator("#tab-diff").click()
                await expect(page.locator("#diff-unstaged")).to_contain_text("+Build the next bit")
                workflow = {"version": 1, "title": "Develop Thrallwright", "steps": [
                    {"id": "launch", "title": "Start the workbench", "status": "done"},
                    {"id": "test", "title": "Run the integration tests", "status": "running"},
                    {"id": "next", "title": "Build the next feature", "status": "pending"},
                ]}
                workflow_path = workspace / ".thrallwright/workflow.json"
                workflow_path.write_text(json.dumps(workflow))
                await page.locator("#tab-workflow").click()
                await page.locator("#refresh").click()
                await expect(page.locator(".workflow-step")).to_have_count(3)
                source = Path(__file__).resolve().parents[1]
                await typed(f"{shlex.quote(sys.executable)} -m unittest discover -s {shlex.quote(str(source / 'tests'))} -v; "
                            "result=$?; printf '__SUITE_EXIT_%s__\\n' \"$result\"; printf '__TESTS_%s__\\n' 'FINISHED'")
                await output_contains("__TESTS_FINISHED__")
                log = app[MANAGER].store.transcript(item.meta["id"])
                assert b"__SUITE_EXIT_0__" in log, "Integration tests failed inside browser shell"
                if screenshot:
                    screenshot.parent.mkdir(parents=True, exist_ok=True)
                    await page.screenshot(path=str(screenshot), full_page=True)
                async with page.expect_download() as downloaded:
                    await page.locator("#download").click()
                assert (await downloaded.value).suggested_filename.endswith(".log")
                workflow_path.write_text('{"title":"<img src=x onerror=alert(1)>"}')
                await page.locator("#refresh").click()
                await expect(page.locator("#workflow-title")).to_contain_text("<img")
                await expect(page.locator("#workflow-title img")).to_have_count(0)
                workflow_path.write_text("{")
                await page.locator("#refresh").click()
                await expect(page.locator("#workflow-json")).to_contain_text("Cannot read workflow")
                await page.set_viewport_size({"width": 390, "height": 844})
                await page.wait_for_timeout(150)
                assert await page.evaluate("() => document.documentElement.scrollWidth <= innerWidth"), "Mobile overflow"
                await page.set_viewport_size({"width": 1440, "height": 960})
                await typed("sleep 30")
                await asyncio.sleep(0.2)
                await page.locator("#interrupt").click()
                await typed("printf '__INTERRUPT_%s__\\n' 'PASS'")
                await output_contains("__INTERRUPT_PASS__")
                page.on("dialog", lambda dialog: asyncio.create_task(dialog.accept()))
                await page.locator("#stop").click()
                await asyncio.wait_for(item.finished.wait(), 5)
                assert item.meta["status"] == "stopped"
                assert not errors, "Browser errors: " + repr(errors)
                await browser.close()
        finally:
            await runner.cleanup()
    print("Browser smoke test passed: launch, typing, refresh, self-hosted tests, workflow, diff, logs, escaping, mobile, interrupt, stop.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--screenshot", type=Path)
    asyncio.run(main(parser.parse_args().screenshot))
