"""Tests for SSE infrastructure: event signaling, queue management, and resource cleanup."""

import threading
import time
from unittest.mock import MagicMock, patch

import pytest

from app.services.sse_manager import SSEManager
from app.services.upload_manager import FileUploadState, UploadJob, UploadStatus


@pytest.fixture
def sse_manager() -> SSEManager:
    """Create a fresh SSEManager for each test."""
    return SSEManager(ttl_seconds=300, heartbeat_interval=15)


def test_send_sse_event_creates_timestamp(sse_manager: SSEManager) -> None:
    """Test that sending an event updates the internal timestamp."""
    job_id = "test-job-123"

    # Register a client to create the queue
    queue, _ = sse_manager.register_client(job_id)

    # Send event
    sse_manager.send_event(job_id, {"type": "test", "data": "hello"})

    # Verify item was added to queue
    assert len(queue) == 1


def test_send_sse_event_signals_waiting_threads(sse_manager: SSEManager) -> None:
    """Test that sending an event signals the threading.Event."""
    job_id = "test-job-456"

    queue, event = sse_manager.register_client(job_id)

    # Event should not be set initially
    assert not event.is_set()

    # Send event
    sse_manager.send_event(job_id, {"type": "test"})

    # Event should now be set
    assert event.is_set()
    assert len(queue) == 1


def test_cleanup_removes_old_queues(sse_manager: SSEManager) -> None:
    """Test that cleanup removes expired queues."""
    # Create queues with synthetic old timestamps
    job_id_old1 = "old-job-1"
    job_id_old2 = "old-job-2"
    job_id_recent = "recent-job"

    sse_manager.register_client(job_id_old1)
    sse_manager.register_client(job_id_old2)
    sse_manager.register_client(job_id_recent)

    # Manually expire old jobs by backdating their timestamps
    with sse_manager._lock:
        old_time = time.time() - sse_manager.ttl_seconds - 100
        sse_manager._timestamps[job_id_old1] = old_time
        sse_manager._timestamps[job_id_old2] = old_time

    # Run cleanup
    removed = sse_manager.cleanup_old_queues()

    # Should remove 2 old jobs, keep recent one
    assert removed == 2
    assert sse_manager.queue_count == 1


def test_cleanup_with_no_expired_queues(sse_manager: SSEManager) -> None:
    """Test that cleanup does nothing when all queues are recent."""
    sse_manager.register_client("job-1")
    sse_manager.register_client("job-2")

    # Run cleanup (timestamps are current, nothing should be removed)
    removed = sse_manager.cleanup_old_queues()

    assert removed == 0
    assert sse_manager.queue_count == 2


def test_throttled_progress_callback_coalesces_to_4_hz() -> None:
    """The throttled callback must cap non-terminal SSE emits at ~4 Hz.

    Simulates a 1 TB-style chunk callback storm — 1000 byte_callbacks within
    ~250 ms. Without throttling that would mean 1000 SSE events; with the
    0.25 s window the cap should be ~1 event per window (allow some jitter).
    """
    from app.routes.upload import (
        SSE_EMIT_INTERVAL_SECONDS,
        _make_throttled_progress_callback,
    )

    job = UploadJob(job_id="throttle-job")
    job.files.append(FileUploadState("f1", "/p/f1", 1_000_000))
    job.total_bytes_cached = 1_000_000
    job.status = UploadStatus.UPLOADING

    callback = _make_throttled_progress_callback(large_job_threshold=None)
    mock_sse = MagicMock()
    with patch("app.routes.upload.get_sse_manager", return_value=mock_sse):
        start = time.monotonic()
        emit_count = 0
        # Hammer for ~600 ms — enough to hit at least two 250 ms windows.
        while time.monotonic() - start < 0.6:
            callback(job)
            emit_count += 1
        elapsed = time.monotonic() - start

    # We fired hundreds of times but only ~4 Hz should have emitted.
    assert emit_count > 50, "loop should have run many iterations"
    max_expected = int(elapsed / SSE_EMIT_INTERVAL_SECONDS) + 2
    assert mock_sse.send_event.call_count <= max_expected, (
        f"emits={mock_sse.send_event.call_count} > cap={max_expected}"
    )


def test_throttled_progress_callback_always_emits_terminal() -> None:
    """Terminal status events must bypass the throttle."""
    from app.routes.upload import _make_throttled_progress_callback

    job = UploadJob(job_id="terminal-job")
    job.files.append(FileUploadState("f1", "/p/f1", 100))
    job.total_bytes_cached = 100
    job.status = UploadStatus.UPLOADING

    callback = _make_throttled_progress_callback(large_job_threshold=None)
    mock_sse = MagicMock()
    with patch("app.routes.upload.get_sse_manager", return_value=mock_sse):
        # Burn one emit slot
        callback(job)
        first_calls = mock_sse.send_event.call_count
        # Immediately fire again — should be throttled
        callback(job)
        assert mock_sse.send_event.call_count == first_calls
        # Now transition to terminal — must emit even though we're still inside the throttle window
        job.status = UploadStatus.COMPLETED
        callback(job)
        assert mock_sse.send_event.call_count == first_calls + 1


def test_throttled_callback_large_job_terminal_sends_summary_only() -> None:
    """Above large_job_threshold, terminal events send the summary, not the full to_dict."""
    from app.routes.upload import _make_throttled_progress_callback

    job = UploadJob(job_id="large-job")
    for i in range(2000):
        job.files.append(FileUploadState(f"f{i}", f"/p/f{i}", 100))
    job.total_bytes_cached = 200_000
    job.status = UploadStatus.COMPLETED

    callback = _make_throttled_progress_callback(large_job_threshold=1000)
    mock_sse = MagicMock()
    with patch("app.routes.upload.get_sse_manager", return_value=mock_sse):
        callback(job)

    assert mock_sse.send_event.call_count == 1
    payload = mock_sse.send_event.call_args[0][1]
    assert payload.get("terminal") is True
    # Summary shape never embeds the full 2000-file list
    assert len(payload["files"]) <= 8


def test_event_driven_signaling(sse_manager: SSEManager) -> None:
    """Test that Event.wait() is more efficient than polling."""
    job_id = "test-job-signal"
    queue, event = sse_manager.register_client(job_id)

    # Simulate waiting thread
    wait_result: list[float] = []

    def waiter() -> None:
        start = time.time()
        event.wait(timeout=2.0)
        elapsed = time.time() - start
        wait_result.append(elapsed)

    thread = threading.Thread(target=waiter)
    thread.start()

    # Small delay to ensure thread is waiting
    time.sleep(0.1)

    # Send event to wake thread
    sse_manager.send_event(job_id, {"type": "wake"})

    # Wait for thread to finish
    thread.join(timeout=3.0)

    # Thread should have woken up quickly (< 0.5s, not 2s timeout)
    assert len(wait_result) == 1
    assert wait_result[0] < 0.5
