"""Shared Server-Sent Events (SSE) manager for job progress streaming."""

import threading
import time
from collections import deque
from typing import Any

# Default configuration constants (can be overridden at construction time)
SSE_QUEUE_TTL_SECONDS = 3600  # Remove queues after 1 hour of inactivity
SSE_HEARTBEAT_INTERVAL_SECONDS = 15  # Heartbeat cadence for the /progress endpoints


class SSEManager:
    """Manages SSE client queues, event signaling, and TTL cleanup for job streams.

    Supports multiple concurrent clients per job. Each client gets its own
    ``deque`` that receives a copy of every event broadcast via ``send_event()``.
    A shared ``threading.Event`` per job allows the progress generator to block
    efficiently (no busy-polling) until new data arrives.

    Usage pattern in a route::

        manager = get_sse_manager()

        def generate():
            queue, event = manager.register_client(job_id)
            try:
                # ... yield initial state, then loop reading queue / waiting on event
            finally:
                manager.deregister_client(job_id, queue)

        # Background thread / callback:
        manager.send_event(job_id, {"type": "progress", ...})
    """

    def __init__(
        self,
        ttl_seconds: int = SSE_QUEUE_TTL_SECONDS,
        heartbeat_interval: int = SSE_HEARTBEAT_INTERVAL_SECONDS,
    ) -> None:
        self._queues: dict[str, list[deque[dict[str, Any]]]] = {}
        self._events: dict[str, threading.Event] = {}
        self._timestamps: dict[str, float] = {}
        self._lock = threading.Lock()
        self.ttl_seconds = ttl_seconds
        self.heartbeat_interval = heartbeat_interval

    def send_event(self, job_id: str, data: dict[str, Any]) -> None:
        """Broadcast an event to all clients currently listening for ``job_id``.

        Thread-safe. Wakes up any blocked generator via the job's Event.
        """
        with self._lock:
            for q in self._queues.get(job_id, []):
                q.append(data)
            self._timestamps[job_id] = time.time()
            if job_id in self._events:
                self._events[job_id].set()

    def register_client(self, job_id: str) -> tuple[deque[dict[str, Any]], threading.Event]:
        """Register a new SSE client for ``job_id``.

        Returns a ``(queue, event)`` tuple. The generator should read from
        ``queue`` and call ``event.wait()`` when the queue is empty.
        """
        queue: deque[dict[str, Any]] = deque()
        with self._lock:
            if job_id not in self._queues:
                self._queues[job_id] = []
            self._queues[job_id].append(queue)
            if job_id not in self._events:
                self._events[job_id] = threading.Event()
            event = self._events[job_id]
            self._timestamps[job_id] = time.time()
        return queue, event

    def deregister_client(self, job_id: str, queue: deque[dict[str, Any]]) -> None:
        """Remove a client queue when its connection closes.

        If this was the last client for ``job_id``, the Event is also removed
        (but the timestamp is kept for TTL cleanup).
        """
        with self._lock:
            if job_id in self._queues:
                try:
                    self._queues[job_id].remove(queue)
                except ValueError:
                    pass
                if not self._queues[job_id]:
                    del self._queues[job_id]
                    self._events.pop(job_id, None)

    @property
    def queue_count(self) -> int:
        """Number of jobs that currently have at least one active client queue."""
        with self._lock:
            return len(self._queues)

    def cleanup_old_queues(self) -> int:
        """Remove SSE state for jobs idle longer than ``ttl_seconds``.

        Returns:
            Number of job entries removed.
        """
        now = time.time()
        removed = 0
        with self._lock:
            expired = [
                job_id for job_id, ts in self._timestamps.items() if now - ts > self.ttl_seconds
            ]
            for job_id in expired:
                self._queues.pop(job_id, None)
                self._events.pop(job_id, None)
                self._timestamps.pop(job_id, None)
                removed += 1
        return removed


# ---------------------------------------------------------------------------
# Singleton accessor
# ---------------------------------------------------------------------------

_sse_manager: SSEManager | None = None
_sse_manager_lock = threading.Lock()


def get_sse_manager() -> SSEManager:
    """Return the process-wide SSEManager singleton."""
    global _sse_manager
    if _sse_manager is None:
        with _sse_manager_lock:
            if _sse_manager is None:
                _sse_manager = SSEManager()
    return _sse_manager
