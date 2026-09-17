use browserdock_launcher::session::SessionGate;
use std::sync::{Arc, Barrier};
#[test]
fn pending_lock_cancels_old_work_and_rejects_new_work_until_wiped() {
    let gate = SessionGate::default();
    let old = gate.ticket().unwrap();
    let lock = gate.request_lock();
    assert!(!gate.valid(old));
    assert!(gate.ticket().is_none());
    let mut wiped = false;
    assert!(gate.complete_lock(lock, || wiped = true));
    assert!(wiped);
    assert!(gate.ticket().is_some());
    assert!(!gate.valid(old));
}
#[test]
fn old_cleanup_cannot_unlock_newer_pending_lock() {
    let gate = SessionGate::default();
    let old = gate.request_lock();
    let newest = gate.request_lock();
    assert!(!gate.complete_lock(old, || panic!("obsolete cleanup")));
    assert!(gate.ticket().is_none());
    assert!(gate.complete_lock(newest, || {}));
    assert!(gate.ticket().is_some());
}
#[test]
fn expiry_and_panic_race_cannot_leave_lock_pending_forever() {
    for _ in 0..100 {
        let gate = Arc::new(SessionGate::default());
        let barrier = Arc::new(Barrier::new(2));
        let (other, start) = (gate.clone(), barrier.clone());
        let worker = std::thread::spawn(move || {
            start.wait();
            other.expired();
        });
        barrier.wait();
        let lock = gate.request_lock();
        worker.join().unwrap();
        assert!(gate.complete_lock(lock, || {}));
        assert!(gate.ticket().is_some());
    }
}
#[test]
fn expiration_during_pending_lock_does_not_invalidate_cleanup() {
    let gate = SessionGate::default();
    let lock = gate.request_lock();
    assert!(!gate.expired());
    assert!(gate.complete_lock(lock, || {}));
    assert!(gate.ticket().is_some());
}
