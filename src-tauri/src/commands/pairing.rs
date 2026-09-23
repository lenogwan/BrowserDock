use crate::{current_config, launcher};
use tauri::Manager;

/// Pairing artifacts never carry the bearer token back to the webview: the
/// frontend only receives file paths, while the token stays in Rust memory
/// (clipboard) or inside files on disk (imported by the extension page).
#[derive(serde::Serialize)]
pub(crate) struct PairingExport {
    dir: String,
    files: Vec<String>,
}

#[tauri::command]
pub(crate) fn pairing_export(app: tauri::AppHandle) -> Result<PairingExport, String> {
    let config = current_config(&app)?;
    let dir = launcher::pairing::pairing_dir()?;
    let files = launcher::pairing::export_pairing_files(&config, std::path::Path::new(&dir))?;
    Ok(PairingExport {
        dir: dir.to_string_lossy().into_owned(),
        files: files
            .iter()
            .map(|p| p.to_string_lossy().into_owned())
            .collect(),
    })
}

#[tauri::command]
pub(crate) fn pairing_copy(
    app: tauri::AppHandle,
    browser_id: String,
    include_private: Option<bool>,
) -> Result<(), String> {
    use tauri_plugin_clipboard_manager::ClipboardExt;
    use zeroize::Zeroizing;
    let config = current_config(&app)?;
    let code = Zeroizing::new(launcher::pairing::pairing_code(
        &config,
        &browser_id,
        include_private,
    )?);
    app.clipboard()
        .write_text(code.as_str())
        .map_err(|_| "Cannot copy pairing code".to_string())
}

#[tauri::command]
pub(crate) fn pairing_open_page(app: tauri::AppHandle, browser_id: String) -> Result<(), String> {
    let url = launcher::pairing::extension_page_url(&browser_id)?;
    let config = current_config(&app)?;
    let configured = config
        .browsers
        .iter()
        .find(|b| b.id == browser_id)
        .map(|b| b.exe_path.clone())
        .unwrap_or_default();
    let exe = if configured.is_empty() {
        launcher::detection::detect_browsers()
            .into_iter()
            .find(|b| b.id == browser_id)
            .map(|b| b.exe_path)
            .unwrap_or_default()
    } else {
        configured
    };
    if exe.is_empty() {
        return Err(format!("Browser '{browser_id}' is not installed"));
    }
    std::process::Command::new(exe)
        .arg(url)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map(|_| ())
        .map_err(|_| format!("Cannot open {browser_id}"))
}

#[derive(serde::Serialize)]
pub(crate) struct CompanionInstall {
    dir: String,
    flavors: Vec<String>,
}
pub(crate) fn copy_dir_recursive(
    source: &std::path::Path,
    dest: &std::path::Path,
) -> Result<(), String> {
    std::fs::create_dir_all(dest).map_err(|e| format!("Cannot stage companion: {e}"))?;
    for entry in
        std::fs::read_dir(source).map_err(|e| format!("Cannot read bundled companion: {e}"))?
    {
        let entry = entry.map_err(|e| format!("Cannot read bundled companion: {e}"))?;
        let target = dest.join(entry.file_name());
        if entry
            .file_type()
            .map_err(|e| format!("Cannot read bundled companion: {e}"))?
            .is_dir()
        {
            copy_dir_recursive(&entry.path(), &target)?;
        } else {
            std::fs::copy(entry.path(), &target)
                .map_err(|e| format!("Cannot stage companion: {e}"))?;
        }
    }
    Ok(())
}

/// Locate a bundled companion flavor (`chromium`/`gecko`) by its manifest.
/// Tries explicit layouts first, then scans each base dir up to 3 levels deep
/// so any bundler layout (flat, `extension/`, `companion/`) resolves.
pub(crate) fn find_companion_flavor(
    bases: &[std::path::PathBuf],
    flavor: &str,
) -> Option<std::path::PathBuf> {
    for base in bases {
        for candidate in [
            base.join(flavor),
            base.join(format!("extension/{flavor}")),
            base.join(format!("companion/{flavor}")),
        ] {
            if candidate.join("manifest.json").is_file() {
                return Some(candidate);
            }
        }
    }
    for base in bases {
        let mut stack = vec![(base.clone(), 0u8)];
        let mut seen = 0usize;
        while let Some((dir, depth)) = stack.pop() {
            if depth > 3 || seen > 2000 {
                break;
            }
            let Ok(entries) = std::fs::read_dir(&dir) else {
                continue;
            };
            for entry in entries.flatten() {
                seen += 1;
                let path = entry.path();
                if !path.is_dir() {
                    continue;
                }
                if path.file_name().is_some_and(|name| name == flavor)
                    && path.join("manifest.json").is_file()
                {
                    return Some(path);
                }
                if depth < 3 {
                    stack.push((path, depth + 1));
                }
            }
        }
    }
    None
}

#[tauri::command]
pub(crate) fn pairing_install_companion(app: tauri::AppHandle) -> Result<CompanionInstall, String> {
    let mut bases: Vec<std::path::PathBuf> = vec![
        // Compile-time checkout path: resolves in `tauri dev` and any build
        // run from source, independent of the process working directory.
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../extension"),
    ];
    if let Ok(resource_dir) = app.path().resource_dir() {
        bases.push(resource_dir);
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let dir = dir.to_path_buf();
            if !bases.contains(&dir) {
                bases.push(dir);
            }
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        if !bases.contains(&cwd) {
            bases.push(cwd);
        }
    }
    let dest = launcher::pairing::stable_companion_dir()?;
    let mut flavors = vec![];
    for flavor in ["chromium", "gecko"] {
        let source = find_companion_flavor(&bases, flavor).ok_or_else(|| {
            let searched = bases
                .iter()
                .map(|b| b.to_string_lossy().into_owned())
                .collect::<Vec<_>>()
                .join("; ");
            format!(
                "Bundled companion ({flavor}) not found. Searched: {searched}. \
                Reinstall BrowserDock from the latest installer, or load the \
                extension/ folder from a source checkout instead."
            )
        })?;
        copy_dir_recursive(&source, &dest.join(flavor))?;
        flavors.push(flavor.to_string());
    }
    Ok(CompanionInstall {
        dir: dest.to_string_lossy().into_owned(),
        flavors,
    })
}
