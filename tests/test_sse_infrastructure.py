"""Tests for SSE infrastructure: event signaling, queue management, and resource cleanup."""

import threading
import time
from collections.abc import Generator
from typing import Any

import pytest

from app.routes.upload import (
    SSE_QUEUE_TTL_SECONDS,
    _cleanup_old_sse_queues,
    _sse_events,
    _sse_queues,
    _sse_timestamps,
    send_sse_event,
)


@pytest.fixture
def clear_sse_state() -> Generator[None, None, None]:
    """Clear SSE module state before each test."""
    _sse_queues.clear()
    _sse_events.clear()
    _sse_timestamps.clear()
    yield
    _sse_queues.clear()
    _sse_events.clear()
    _sse_timestamps.clear()


def test_send_sse_event_creates_timestamp(clear_sse_state: Any) -> None:
    """Test that sending an event updates the timestamp."""
    from collections import deque

    job_id = "test-job-123"

    # Create a queue manually
    queue = deque()
    _sse_queues[job_id] = [queue]

    # Send event
    send_sse_event(job_id, {"type": "test", "data": "hello"})

    # Verify timestamp was created
    assert job_id in _sse_timestamps
    assert time.time() - _sse_timestamps[job_id] < 1  # Within 1 second


def test_send_sse_event_signals_waiting_threads(clear_sse_state: Any) -> None:
    """Test that sending an event signals the threading.Event."""
    from collections import deque

    job_id = "test-job-456"

    # Create queue and event
    queue = deque()
    event = threading.Event()
    _sse_queues[job_id] = [queue]
    _sse_events[job_id] = event

    # Event should not be set initially
    assert not event.is_set()

    # Send event
    send_sse_event(job_id, {"type": "test"})

    # Event should now be set
    assert event.is_set()
    assert len(queue) == 1


def test_cleanup_removes_old_queues(clear_sse_state: Any) -> None:
    """Test that cleanup removes expired queues."""
    from collections import deque

    # Create some queues with old timestamps
    old_time = time.time() - SSE_QUEUE_TTL_SECONDS - 100
    recent_time = time.time()

    _sse_queues["old-job-1"] = [deque()]
    _sse_timestamps["old-job-1"] = old_time
    _sse_events["old-job-1"] = threading.Event()

    _sse_queues["old-job-2"] = [deque()]
    _sse_timestamps["old-job-2"] = old_time

    _sse_queues["recent-job"] = [deque()]
    _sse_timestamps["recent-job"] = recent_time

    # Run cleanup
    removed = _cleanup_old_sse_queues()

    # Should remove 2 old jobs, keep recent one
    assert removed == 2
    assert "old-job-1" not in _sse_queues
    assert "old-job-1" not in _sse_events
    assert "old-job-1" not in _sse_timestamps
    assert "old-job-2" not in _sse_queues
    assert "recent-job" in _sse_queues


def test_cleanup_with_no_expired_queues(clear_sse_state: Any) -> None:
    """Test that cleanup does nothing when all queues are recent."""
    from collections import deque

    recent_time = time.time()

    _sse_queues["job-1"] = [deque()]
    _sse_timestamps["job-1"] = recent_time

    _sse_queues["job-2"] = [deque()]
    _sse_timestamps["job-2"] = recent_time

    # Run cleanup
    removed = _cleanup_old_sse_queues()

    # Should remove nothing
    assert removed == 0
    assert len(_sse_queues) == 2


def test_event_driven_signaling(clear_sse_state: Any) -> None:
    """Test that Event.wait() is more efficient than polling."""
    from collections import deque

    job_id = "test-job-signal"
    queue = deque()
    event = threading.Event()

    _sse_queues[job_id] = [queue]
    _sse_events[job_id] = event

    # Simulate waiting thread
    wait_result: list[float] = []

    def waiter() -> None:
        # This should block until event is set
        start = time.time()
        event.wait(timeout=2.0)
        elapsed = time.time() - start
        wait_result.append(elapsed)

    thread = threading.Thread(target=waiter)
    thread.start()

    # Small delay to ensure thread is waiting
    time.sleep(0.1)

    # Send event to wake thread
    send_sse_event(job_id, {"type": "wake"})

    # Wait for thread to finish
    thread.join(timeout=3.0)

    # Thread should have woken up quickly (< 0.5s, not 2s timeout)
    assert len(wait_result) == 1
    assert wait_result[0] < 0.5  # Should be nearly instant
