//! Win32 foreground helpers (Phase 2, corrected).
//!
//! Fixes applied vs skill draft:
//! - Correct `HWND(isize)` construction (skill used `as *mut _`, which is wrong type).
//! - Handle Windows foreground-lock: `SetForegroundWindow` alone usually fails
//!   unless our process is the foreground process. We best-effort attach our
//!   input thread to the foreground thread via `AttachThreadInput`, then call
//!   `ShowWindow(SW_RESTORE)` + `SetForegroundWindow` + `BringWindowToTop`.
//! - All logic is `#[cfg(windows)]`-gated so `cargo check` on Linux still passes.

#[cfg(windows)]
use windows::Win32::Foundation::{BOOL, HANDLE, HWND, LPARAM};
#[cfg(windows)]
use windows::core::PWSTR;
#[cfg(windows)]
use windows::Win32::System::Threading::{
    AttachThreadInput, GetCurrentThreadId, OpenProcess, QueryFullProcessImageNameW,
    PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
};
#[cfg(windows)]
use windows::Win32::UI::WindowsAndMessaging::{
    AllowSetForegroundWindow, BringWindowToTop, EnumWindows, GetForegroundWindow,
    GetWindowTextLengthW, GetWindowThreadProcessId, IsWindowVisible, SetForegroundWindow, ShowWindow,
    SW_RESTORE,
};
#[cfg(windows)]
use windows::Win32::Foundation::CloseHandle;

/// Best-effort bring of a top-level window to the foreground.
///
/// Returns `true` if `SetForegroundWindow` reported success.
pub fn bring_window_to_front(hwnd_val: isize) -> bool {
    #[cfg(windows)]
    unsafe {
        let hwnd = HWND(hwnd_val as *mut core::ffi::c_void);
        if hwnd.0.is_null() {
            return false;
        }

        // Restore if minimized.
        let _ = ShowWindow(hwnd, SW_RESTORE);

        // Work around foreground-lock timeout: attach to the foreground thread.
        let fg = GetForegroundWindow();
        let current_thread = GetCurrentThreadId();
        let mut fg_pid = 0u32;
        let fg_thread = GetWindowThreadProcessId(fg, Some(&mut fg_pid));
        let attached = fg_thread != 0
            && fg_thread != current_thread
            && AttachThreadInput(current_thread, fg_thread, BOOL(1)) == BOOL(1);

        // Allow ourselves to set foreground (ASFW_ANY = u32::MAX).
        let _ = AllowSetForegroundWindow(u32::MAX);

        let ok = SetForegroundWindow(hwnd).as_bool();
        let _ = BringWindowToTop(hwnd);

        if attached {
            let _ = AttachThreadInput(current_thread, fg_thread, BOOL(0));
        }
        ok
    }
    #[cfg(not(windows))]
    {
        let _ = hwnd_val;
        false
    }
}

/// Candidate executable file names (lowercase) for a browser id.
///
/// The configured `exe_path` comes first so portable/custom installs match;
/// the well-known file name is the fallback. Matching is by file name only
/// because `QueryFullProcessImageNameW` may return short/long path variants.
pub fn browser_exe_names(browser_id: &str, exe_path: Option<&str>) -> Vec<String> {
    let mut names = Vec::new();
    if let Some(path) = exe_path {
        let base = path
            .rsplit(['/', '\\'])
            .next()
            .unwrap_or(path)
            .to_ascii_lowercase();
        if base.ends_with(".exe") && !names.contains(&base) {
            names.push(base);
        }
    }
    let known = match browser_id {
        "firefox" => "firefox.exe",
        "mullvad" => "mullvadbrowser.exe",
        "chrome" => "chrome.exe",
        "edge" => "msedge.exe",
        _ => "",
    };
    if !known.is_empty() && !names.iter().any(|n| n == known) {
        names.push(known.to_string());
    }
    names
}

#[cfg(windows)]
fn process_image_file_name(pid: u32) -> Option<String> {
    unsafe {
        let handle: HANDLE = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, BOOL(0), pid).ok()?;
        let mut buf = [0u16; 1024];
        let mut len = buf.len() as u32;
        let ok =
            QueryFullProcessImageNameW(handle, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut len)
                .is_ok();
        let _ = CloseHandle(handle);
        if !ok {
            return None;
        }
        let full = String::from_utf16_lossy(&buf[..len as usize]);
        Some(
            full.rsplit(['/', '\\'])
                .next()
                .unwrap_or(&full)
                .to_ascii_lowercase(),
        )
    }
}

#[cfg(windows)]
struct FindWindowCtx<'a> {
    wanted: &'a [String],
    found: Option<HWND>,
}

/// `EnumWindows` visits top-level windows in Z-order (topmost first), so the
/// first visible, titled window owned by the target browser is the best
/// candidate to bring forward.
#[cfg(windows)]
unsafe extern "system" fn find_browser_window(hwnd: HWND, lparam: LPARAM) -> BOOL {
    let ctx = &mut *(lparam.0 as *mut FindWindowCtx);
    if !IsWindowVisible(hwnd).as_bool() || GetWindowTextLengthW(hwnd) == 0 {
        return BOOL(1);
    }
    let mut pid = 0u32;
    GetWindowThreadProcessId(hwnd, Some(&mut pid));
    if pid == 0 {
        return BOOL(1);
    }
    if process_image_file_name(pid)
        .is_some_and(|image| ctx.wanted.iter().any(|w| w == &image))
    {
        ctx.found = Some(hwnd);
        return BOOL(0);
    }
    BOOL(1)
}

/// Bring the target browser's topmost window to the foreground.
///
/// The companion extension already activated the right tab; this covers the
/// OS half that the extension cannot do on its own: a background browser
/// process cannot steal the foreground from another app (e.g. Chrome in
/// front of Firefox) because of the Windows foreground lock. The dock was
/// just clicked, so this process may legally transfer the foreground.
/// Best-effort: returns `false` when nothing was found or the OS refused.
pub fn bring_browser_to_front(browser_id: &str, exe_path: Option<&str>) -> bool {
    #[cfg(windows)]
    unsafe {
        let wanted = browser_exe_names(browser_id, exe_path);
        if wanted.is_empty() {
            return false;
        }
        let mut ctx = FindWindowCtx { wanted: &wanted, found: None };
        let _ = EnumWindows(
            Some(find_browser_window),
            LPARAM(&mut ctx as *mut FindWindowCtx as isize),
        );
        match ctx.found {
            Some(hwnd) => bring_window_to_front(hwnd.0 as isize),
            None => false,
        }
    }
    #[cfg(not(windows))]
    {
        let _ = (browser_id, exe_path);
        false
    }
}

#[cfg(test)]
mod tests {
    use super::browser_exe_names;

    #[test]
    fn known_browser_ids_map_to_their_executables() {
        assert_eq!(browser_exe_names("firefox", None), vec!["firefox.exe"]);
        assert_eq!(browser_exe_names("mullvad", None), vec!["mullvadbrowser.exe"]);
        assert_eq!(browser_exe_names("chrome", None), vec!["chrome.exe"]);
        assert_eq!(browser_exe_names("edge", None), vec!["msedge.exe"]);
    }

    #[test]
    fn configured_exe_path_takes_precedence_and_dedupes() {
        assert_eq!(
            browser_exe_names("firefox", Some(r"D:\Portable\MyFirefox.exe")),
            vec!["myfirefox.exe", "firefox.exe"]
        );
        assert_eq!(
            browser_exe_names("edge", Some(r"C:\Program Files\Microsoft\Edge\Application\msedge.exe")),
            vec!["msedge.exe"]
        );
    }

    #[test]
    fn unknown_browser_without_exe_matches_nothing() {
        assert!(browser_exe_names("arc", None).is_empty());
        assert_eq!(
            browser_exe_names("arc", Some("/opt/arc/arc")),
            Vec::<String>::new()
        );
    }
}
