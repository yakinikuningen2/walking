"""Bounded, process-wide admission control; no IP addresses or request bodies."""
from collections import deque
from contextlib import contextmanager
from email.utils import parsedate_to_datetime
from math import ceil, isfinite
from threading import Condition
import time


class ApiLimitError(Exception):
    def __init__(self, message="検索の利用上限に達しました。時間を置いてお試しください。", retry_after=1):
        super().__init__(message)
        self.message, self.code, self.status = message, "ROUTING_RATE_LIMIT", 429
        self.retry_after = max(1, min(86400, ceil(retry_after)))


class RequestGate:
    def __init__(self, interval=1, minute=45, daily=1000, queue=2, wait=2, clock=time.monotonic):
        self.interval, self.minute, self.daily = interval, minute, daily
        self.queue, self.wait, self.clock = queue, wait, clock
        self.condition = Condition()
        self.events = deque()
        self.active = False
        self.waiting = 0
        self.next_at = self.blocked_until = 0

    def cooldown(self, retry_after=None, default=60):
        delay = default
        try:
            delay = float(retry_after)
        except (TypeError, ValueError):
            try:
                delay = parsedate_to_datetime(retry_after).timestamp() - time.time()
            except (TypeError, ValueError, AttributeError, OverflowError):
                pass
        delay = max(default, delay) if isfinite(delay) else default
        with self.condition:
            self.blocked_until = max(self.blocked_until, self.clock() + delay)
            self.condition.notify_all()
            return max(1, ceil(self.blocked_until - self.clock()))

    @contextmanager
    def slot(self):
        acquired = False
        with self.condition:
            if self.waiting >= self.queue:
                raise ApiLimitError("検索が混み合っています。少し待ってから再度お試しください。")
            self.waiting += 1
            deadline = self.clock() + self.wait
            try:
                while True:
                    now = self.clock()
                    while self.events and self.events[0] <= now - 86400:
                        self.events.popleft()
                    if now < self.blocked_until:
                        raise ApiLimitError(retry_after=self.blocked_until - now)
                    if len(self.events) >= self.daily:
                        raise ApiLimitError(retry_after=self.events[0] + 86400 - now)
                    recent = [t for t in self.events if t > now - 60]
                    if len(recent) >= self.minute:
                        raise ApiLimitError(retry_after=recent[0] + 60 - now)
                    if not self.active and now >= self.next_at:
                        self.active = acquired = True
                        self.next_at = now + self.interval
                        self.events.append(now)
                        break
                    remaining = deadline - now
                    if remaining <= 0:
                        raise ApiLimitError("検索が混み合っています。少し待ってから再度お試しください。")
                    self.condition.wait(min(remaining, .1 if self.active else max(.001, self.next_at - now)))
            finally:
                self.waiting -= 1
        try:
            yield
        finally:
            if acquired:
                with self.condition:
                    self.active = False
                    self.condition.notify_all()


VALHALLA_GATE = RequestGate()
ORS_GATE = RequestGate(interval=2, minute=20, daily=500)
