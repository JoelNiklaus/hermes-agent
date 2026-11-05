"""The idle auto-archive sweep never hides an unread chat.

``sessions.auto_archive`` archives lineages idle for ``auto_archive_days``. A chat whose newest
activity postdates its read watermark (a reply the user has not seen, or one marked unread) must
stay in the sidebar however long it sits: archiving it would hide the reply before it was read.
Read chats, and chats with no watermark (``last_read_at`` NULL = read), are still swept.
"""
import time

import pytest

from hermes_state import SessionDB


@pytest.fixture
def db(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "home"))
    return SessionDB(tmp_path / "state.db")


def _tick():
    time.sleep(0.02)


def _chat(db, sid):
    db.create_session(sid, "desktop")
    db.append_message(sid, "user", "hello")
    db.append_message(sid, "assistant", "hi")


def _sweep(db):
    _tick()
    return db.archive_stale_sessions(0)


def _archived(db, sid):
    return bool(db.get_session(sid)["archived"])


def _unread_in_listing(db):
    rows = db.list_sessions_rich(
        limit=50, offset=0, min_message_count=1, include_archived=True, archived_only=False,
        order_by_last_active=True, compact_rows=True, include_pinned=True)
    return {row["id"]: row["unread"] for row in rows}


def test_reply_after_last_read_is_never_auto_archived(db):
    _chat(db, "s")
    db.set_session_read("s", True)
    _tick()
    db.append_message("s", "assistant", "a reply the user has not seen")
    assert _unread_in_listing(db)["s"] is True

    assert _sweep(db) == 0
    assert not _archived(db, "s")


def test_chat_marked_unread_is_never_auto_archived(db):
    _chat(db, "s")
    db.set_session_read("s", False)
    assert _unread_in_listing(db)["s"] is True

    assert _sweep(db) == 0
    assert not _archived(db, "s")


def test_read_idle_chat_is_still_auto_archived(db):
    _chat(db, "s")
    _tick()
    db.set_session_read("s", True)
    assert _unread_in_listing(db)["s"] is False

    assert _sweep(db) == 1
    assert _archived(db, "s")


def test_chat_without_read_watermark_is_still_auto_archived(db):
    _chat(db, "s")
    assert db.get_session("s")["last_read_at"] is None
    assert _unread_in_listing(db)["s"] is False

    assert _sweep(db) == 1
    assert _archived(db, "s")


def _compress(db, parent, child):
    holder = f"holder-{child}"
    assert db.try_acquire_compression_lock(parent, holder, ttl_seconds=60)
    db.publish_compression_child(
        parent_session_id=parent, child_session_id=child, source="desktop", system_prompt="p",
        messages=[{"role": "user", "content": "summary"}], compression_lock_holder=holder)


def test_unread_compressed_lineage_keeps_every_segment_visible(db):
    db.create_session("root", "desktop")
    db.append_message("root", "user", "hello")
    _compress(db, "root", "tip")
    db.append_message("tip", "assistant", "unseen reply")
    db.set_session_read("tip", False)

    assert _sweep(db) == 0
    assert not _archived(db, "root")
    assert not _archived(db, "tip")


def test_reply_after_compression_of_a_read_chat_is_never_auto_archived(db):
    """Read, then compressed: the sidebar judges the new tip's reply against the root's watermark."""
    _chat(db, "root")
    _tick()
    db.set_session_read("root", True)
    _tick()
    _compress(db, "root", "tip")
    db.append_message("tip", "assistant", "unseen reply after compression")
    assert _unread_in_listing(db)["tip"] is True

    assert _sweep(db) == 0
    assert not _archived(db, "root")
    assert not _archived(db, "tip")


def test_sweep_and_listing_agree_on_unread(db):
    """Every chat the listing shows as unread survives the sweep; every read one is archived."""
    _chat(db, "unseen")
    db.set_session_read("unseen", True)
    _tick()
    db.append_message("unseen", "assistant", "new")
    _chat(db, "flagged")
    db.set_session_read("flagged", False)
    _chat(db, "seen")
    _tick()
    db.set_session_read("seen", True)
    _chat(db, "untracked")

    before = _unread_in_listing(db)
    _sweep(db)
    for sid, unread in before.items():
        assert _archived(db, sid) is (not unread), sid
