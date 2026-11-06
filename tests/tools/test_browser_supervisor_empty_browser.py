"""The CDP supervisor never opens a tab of its own.

On a browser with no page (Chrome started with ``--no-startup-window``, or every tab closed) the
supervisor used to create an ``about:blank`` page just to have something to attach to. Nothing ever
closed it, and every supervisor that started on an empty browser added one: parallel subagents each
left a blank tab behind. It now waits for the first page that appears instead. No real Chrome: the
supervisor's ``_cdp`` is replaced by an in-memory fake.
"""

from __future__ import annotations

import asyncio

from tools import browser_supervisor as bs


class _FakeBrowser:
    """Answers the CDP calls the supervisor makes; records them in order."""

    def __init__(self, pages: list[str]):
        self.pages = pages
        self.calls: list[tuple[str, dict, str | None]] = []
        self._sessions = 0

    async def cdp(self, method, params=None, *, session_id=None, timeout=10.0):
        self.calls.append((method, dict(params or {}), session_id))
        if method == "Target.getTargets":
            infos = [{"targetId": tid, "type": "page", "url": "https://example.com/"} for tid in self.pages]
            infos.append({"targetId": "SW", "type": "service_worker", "url": "https://example.com/sw.js"})
            return {"result": {"targetInfos": infos}}
        if method == "Target.createTarget":
            self.pages.append("CREATED")
            return {"result": {"targetId": "CREATED"}}
        if method == "Target.attachToTarget":
            self._sessions += 1
            return {"result": {"sessionId": f"S{self._sessions}"}}
        return {"result": {}}

    def methods(self) -> list[str]:
        return [method for method, _, _ in self.calls]

    def attached(self) -> list[str]:
        return [params["targetId"] for method, params, _ in self.calls if method == "Target.attachToTarget"]


def _supervisor(browser: _FakeBrowser) -> bs.CDPSupervisor:
    sup = bs.CDPSupervisor(task_id="empty-browser", cdp_url="ws://127.0.0.1:9/devtools/browser/x")
    sup._cdp = browser.cdp
    return sup


async def _created(sup: bs.CDPSupervisor, target_type: str, target_id: str) -> None:
    """Deliver ``Target.targetCreated`` the way ``_read_loop`` does, then let spawned work finish."""
    handler = sup._EVENT_HANDLERS["Target.targetCreated"]
    result = handler(sup, {"targetInfo": {"targetId": target_id, "type": target_type, "url": "about:blank"}}, None)
    if result is not None:
        await result
    for _ in range(20):
        await asyncio.sleep(0)


def test_empty_browser_gets_no_tab_from_the_supervisor():
    browser = _FakeBrowser(pages=[])
    sup = _supervisor(browser)

    asyncio.run(sup._attach_initial_page())

    assert "Target.createTarget" not in browser.methods()
    assert browser.pages == []
    assert sup._page_session_id is None
    assert "Target.setDiscoverTargets" in browser.methods()


def test_first_page_that_appears_gets_the_supervisor_session():
    browser = _FakeBrowser(pages=[])
    sup = _supervisor(browser)

    async def scenario():
        await sup._attach_initial_page()
        await _created(sup, "service_worker", "SW2")  # not a page: ignored
        await _created(sup, "page", "DAEMON-TAB")
        await _created(sup, "page", "SECOND-TAB")  # already attached: stays on the first

    asyncio.run(scenario())

    assert browser.attached() == ["DAEMON-TAB"]
    assert sup._page_session_id == "S1"
    assert "Target.createTarget" not in browser.methods()
    # The page session gets the same setup as an initial attach (domains + dialog bridge).
    assert ("Page.enable", {}, "S1") in browser.calls


def test_a_page_closed_before_the_attach_landed_leaves_the_next_page_its_chance():
    browser = _FakeBrowser(pages=[])
    real_cdp = browser.cdp

    async def cdp(method, params=None, **kwargs):
        params = params or {}
        if method == "Target.attachToTarget" and params.get("targetId") == "GONE":
            browser.calls.append((method, dict(params), None))
            raise RuntimeError("No target with given id found")
        return await real_cdp(method, params, **kwargs)

    sup = _supervisor(browser)
    sup._cdp = cdp

    async def scenario():
        await sup._attach_initial_page()
        await _created(sup, "page", "GONE")
        await _created(sup, "page", "NEXT")

    asyncio.run(scenario())

    assert browser.attached() == ["GONE", "NEXT"]
    assert sup._page_session_id == "S1"


def test_existing_page_is_attached_as_before():
    browser = _FakeBrowser(pages=["USER-TAB"])
    sup = _supervisor(browser)

    asyncio.run(sup._attach_initial_page())

    assert browser.attached() == ["USER-TAB"]
    assert sup._page_session_id == "S1"
    assert "Target.createTarget" not in browser.methods()
