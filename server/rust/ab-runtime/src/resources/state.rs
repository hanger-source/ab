use ab_protocol::ResourceEvent;
use serde_json::{json, Value};
use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::sync::Mutex;

const MAX_BUFFERED_EVENTS: usize = 512;

pub(super) struct ResourceState {
    created_at_unix_ms: u64,
    sequence: AtomicU64,
    complete: AtomicBool,
    closed_emitted: AtomicBool,
    buffer: Mutex<VecDeque<ResourceEvent>>,
    lifecycle: Mutex<ResourceLifecycle>,
}

#[derive(Debug, Clone)]
pub(super) struct ResourceLifecycle {
    pub(super) state: &'static str,
    pub(super) close_reason: Option<String>,
    pub(super) closed_at_unix_ms: Option<u64>,
}

impl ResourceState {
    pub(super) fn new() -> Self {
        Self {
            created_at_unix_ms: now_unix_ms(),
            sequence: AtomicU64::new(0),
            complete: AtomicBool::new(true),
            closed_emitted: AtomicBool::new(false),
            buffer: Mutex::new(VecDeque::new()),
            lifecycle: Mutex::new(ResourceLifecycle {
                state: "open",
                close_reason: None,
                closed_at_unix_ms: None,
            }),
        }
    }

    pub(super) fn created_at_unix_ms(&self) -> u64 {
        self.created_at_unix_ms
    }

    pub(super) fn complete(&self) -> bool {
        self.complete.load(Ordering::SeqCst)
    }

    pub(super) fn last_sequence(&self) -> u64 {
        self.sequence.load(Ordering::SeqCst)
    }

    pub(super) fn mark_incomplete(&self) {
        self.complete.store(false, Ordering::SeqCst);
    }

    pub(super) fn claim_closed_emission(&self) -> bool {
        self.closed_emitted
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
    }

    pub(super) async fn lifecycle(&self) -> ResourceLifecycle {
        self.lifecycle.lock().await.clone()
    }

    pub(super) async fn close(
        &self,
        reason: impl Into<String>,
        complete: bool,
    ) -> ResourceLifecycle {
        if !complete {
            self.mark_incomplete();
        }
        let mut lifecycle = self.lifecycle.lock().await;
        if lifecycle.state == "open" {
            lifecycle.state = "closed";
            lifecycle.close_reason = Some(reason.into());
            lifecycle.closed_at_unix_ms = Some(now_unix_ms());
        }
        lifecycle.clone()
    }

    pub(super) async fn record(
        &self,
        resource_id: &str,
        event: String,
        value: Value,
    ) -> ResourceEvent {
        let message = ResourceEvent {
            resource_id: resource_id.to_owned(),
            sequence: self.sequence.fetch_add(1, Ordering::SeqCst) + 1,
            event,
            value,
            complete: self.complete(),
        };
        let mut buffer = self.buffer.lock().await;
        if buffer.len() == MAX_BUFFERED_EVENTS {
            buffer.pop_front();
        }
        buffer.push_back(message.clone());
        message
    }

    pub(super) async fn snapshot(&self, after_sequence: u64) -> Value {
        let buffer = self.buffer.lock().await;
        let lifecycle = self.lifecycle().await;
        let buffered_from = buffer
            .front()
            .map(|event| event.sequence)
            .unwrap_or_else(|| self.last_sequence().saturating_add(1));
        let gap = after_sequence.saturating_add(1) < buffered_from;
        let events = buffer
            .iter()
            .filter(|event| event.sequence > after_sequence)
            .cloned()
            .collect::<Vec<_>>();
        json!({
            "state": lifecycle.state,
            "createdAtUnixMs": self.created_at_unix_ms,
            "sequence": self.last_sequence(),
            "complete": self.complete(),
            "closeReason": lifecycle.close_reason,
            "closedAtUnixMs": lifecycle.closed_at_unix_ms,
            "bufferedFrom": buffered_from,
            "gap": gap,
            "events": events
        })
    }
}

fn now_unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
