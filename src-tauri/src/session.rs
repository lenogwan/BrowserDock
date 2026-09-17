//! Coordinates cancellation and pending key cleanup without holding a lock over crypto.
//!
//! Poison recovery: a mutex poisoned by a panicking holder recovers its inner
//! state instead of panicking the backend (which would kill the Tauri process).
//! The generation counter is monotonic, so a recovered state stays consistent.
use std::sync::Mutex;
#[derive(Default)]
struct State {
    generation: u64,
    locking: bool,
}
#[derive(Default)]
pub struct SessionGate(Mutex<State>);
fn recover<T: Default>(result: Result<std::sync::MutexGuard<'_, T>, std::sync::PoisonError<std::sync::MutexGuard<'_, T>>>) -> std::sync::MutexGuard<'_, T> {
    result.unwrap_or_else(|error| error.into_inner())
}
impl SessionGate {
    pub fn ticket(&self) -> Option<u64> {
        let state = recover(self.0.lock());
        (!state.locking).then_some(state.generation)
    }
    pub fn valid(&self, ticket: u64) -> bool {
        self.ticket() == Some(ticket)
    }
    pub fn request_lock(&self) -> u64 {
        let mut state = recover(self.0.lock());
        state.generation = state.generation.wrapping_add(1);
        state.locking = true;
        state.generation
    }
    /// Caller already owns the vault mutex. Wiping completes before new auth is permitted.
    pub fn complete_lock(&self, ticket: u64, wipe: impl FnOnce()) -> bool {
        let mut state = recover(self.0.lock());
        if state.generation != ticket || !state.locking {
            return false;
        }
        wipe();
        state.locking = false;
        true
    }
    /// Expiry cannot supersede an outstanding panic cleanup ticket.
    pub fn expired(&self) -> bool {
        let mut state = recover(self.0.lock());
        if state.locking {
            return false;
        }
        state.generation = state.generation.wrapping_add(1);
        true
    }
}
