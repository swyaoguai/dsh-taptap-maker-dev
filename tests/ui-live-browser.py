"""Observe the EXISTING DSH GUI in a fresh isolated browser; never launch a server.
No login profiles, external providers, game previews or project writes are used.
"""
import argparse
import json
import tempfile
from pathlib import Path
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright

parser = argparse.ArgumentParser()
parser.add_argument("--url", required=True, help="The exact current DSH GUI URL")
args = parser.parse_args()
parsed = urlparse(args.url)
if parsed.hostname not in {"127.0.0.1", "localhost", "::1"}:
    raise SystemExit("Only the explicitly supplied existing local GUI is allowed")
artifacts = Path(tempfile.mkdtemp(prefix="ui-live-gui-"))
report = {"gui": args.url, "artifacts": str(artifacts), "requests": [], "currentGuiRefreshed": False, "nativeVerified": False}
with sync_playwright() as play:
    browser = play.chromium.launch(headless=True)
    context = browser.new_context(viewport={"width": 1440, "height": 1000})
    page = context.new_page()
    page.on("response", lambda response: report["requests"].append({"path": urlparse(response.url).path, "status": response.status}) if urlparse(response.url).hostname == parsed.hostname else None)
    page.goto(args.url, wait_until="domcontentloaded", timeout=30000)
    page.reload(wait_until="domcontentloaded", timeout=30000)
    report["currentGuiRefreshed"] = True
    page.locator("body").wait_for(state="visible", timeout=15000)
    # Some shell versions consume/delete the bootstrap object after startup.
    # Its continued existence is NOT evidence required for UI route activation.
    report["injectedBoot"] = "__DSH_BOOT__" in page.content() or page.evaluate("!!window.__DSH_BOOT__")
    report["title"] = page.title()
    report["moduleLoaderPresent"] = page.evaluate("!!window.__ModuleLoader__")
    buttons = page.get_by_role("button", name="打开 UI 工作台", exact=True)
    try:
        buttons.first.wait_for(state="visible", timeout=15000)
        report["uiDockVisible"] = True
        buttons.first.click()
        iframe = page.frame_locator('iframe[title^="UI 工作台"]')
        try:
            iframe.locator("#draft-status[data-dirty]").wait_for(state="visible", timeout=10000)
            report["workbenchBooted"] = True
        except Exception:
            report["workbenchBooted"] = False
        page.screenshot(path=str(artifacts / "existing-gui-ui-entry.png"), full_page=False)
    except Exception:
        report["uiDockVisible"] = False
    report["uiStatus"] = context.request.get(args.url.rstrip("/") + "/api/taptap-maker-dev/ui/status").status
    report["reloadControls"] = page.get_by_role("button").filter(has_text="重新加载").all_text_contents()
    context.close()
    browser.close()
(artifacts / "observation.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
print(json.dumps(report, ensure_ascii=False, indent=2))
