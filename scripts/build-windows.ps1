# Run from a Windows checkout with Node.js and the Rust MSVC build tools installed.
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if ($env:OS -ne 'Windows_NT') {
    throw 'Build the installers on Windows, or run the Windows installers GitHub Actions workflow.'
}

# rustup may have been installed since this terminal was opened.
if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) {
    $cargoBin = Join-Path $env:USERPROFILE '.cargo\bin'
    if (Test-Path (Join-Path $cargoBin 'cargo.exe')) {
        $env:Path = "$cargoBin;$env:Path"
    }
}
foreach ($tool in @('node', 'npm.cmd', 'cargo', 'rustup')) {
    if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
        if ($tool -eq 'cargo') {
            throw "Missing cargo. Install the Rust MSVC toolchain with: winget install --id Rustlang.Rustup -e; then close and reopen this terminal. See docs/windows-installer.md for build prerequisites."
        }
        throw "Missing $tool. See docs/windows-installer.md for build prerequisites."
    }
}

function Invoke-Checked {
    param([string]$Program, [string[]]$Arguments)
    & $Program @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$Program failed with exit code $LASTEXITCODE. No distribution was created."
    }
}

$projectRoot = Split-Path $PSScriptRoot -Parent
Push-Location $projectRoot
try {
    # Keep the output location independent of the developer's Cargo environment.
    $previousTargetDir = $env:CARGO_TARGET_DIR
    $env:CARGO_TARGET_DIR = Join-Path $projectRoot 'src-tauri\target'
    $target = 'x86_64-pc-windows-msvc'
    Invoke-Checked 'rustup' @('target', 'add', $target)
    Invoke-Checked 'npm.cmd' @('ci')
    Invoke-Checked 'npm.cmd' @('run', 'check')
    Invoke-Checked 'npm.cmd' @('run', 'test:ui')
    Invoke-Checked 'npm.cmd' @('run', 'build:extension')
    Invoke-Checked 'npm.cmd' @('run', 'test:extension')
    Invoke-Checked 'cargo' @('test', '--locked', '--manifest-path', 'src-tauri/core/Cargo.toml')
    Invoke-Checked 'npm.cmd' @('run', 'tauri', '--', 'build', '--ci', '--target', $target, '--', '--locked')

    $version = (Get-Content 'src-tauri/tauri.conf.json' -Raw | ConvertFrom-Json).version
    $releaseDir = Join-Path $env:CARGO_TARGET_DIR "$target\release"
    # Resolve installers by glob so a Tauri bundle-layout change fails with a
    # clear "not found" instead of silently copying a stale versioned file.
    $setup = Get-ChildItem (Join-Path $releaseDir 'bundle\nsis') -Filter "BrowserDock_${version}_x64-setup.exe" -File -ErrorAction SilentlyContinue | Select-Object -First 1
    $msi = Get-ChildItem (Join-Path $releaseDir 'bundle\msi') -Filter "BrowserDock_${version}_x64_*.msi" -File -ErrorAction SilentlyContinue | Select-Object -First 1
    foreach ($file in @($setup, $msi)) {
        if (-not $file -or -not (Test-Path $file.FullName)) { throw "Expected installer missing for version $version (nsis setup / msi) under $releaseDir\bundle" }
    }

    # A separate directory per run prevents accidentally distributing stale builds.
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
    $outputDir = Join-Path $projectRoot "dist\BrowserDock-$version-windows-x64-$stamp"
    New-Item -ItemType Directory -Path $outputDir | Out-Null
    Copy-Item $setup.FullName, $msi.FullName -Destination $outputDir
    # Prune older per-run outputs (this script's own pattern only) so dist/
    # never accumulates stale installers next to the fresh one.
    Get-ChildItem (Join-Path $projectRoot 'dist') -Directory -Filter 'BrowserDock-*-windows-x64-*' -ErrorAction SilentlyContinue |
        Sort-Object Name -Descending | Select-Object -Skip 3 | Remove-Item -Recurse -Force
    foreach ($required in @('docs/INSTALL-WINDOWS.txt', 'scripts/install-companion.ps1')) {
        if (-not (Test-Path (Join-Path $projectRoot $required))) { throw "Required dist input missing: $required" }
    }
    Copy-Item 'docs/INSTALL-WINDOWS.txt' -Destination $outputDir
    Copy-Item 'scripts/install-companion.ps1' -Destination $outputDir
    Compress-Archive -Path 'extension/chromium', 'extension/gecko', 'extension/README.md' `
        -DestinationPath (Join-Path $outputDir 'BrowserDock-Companion.zip')
    Get-ChildItem $outputDir -File | Sort-Object Name | ForEach-Object {
        $hash = (Get-FileHash $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
        "$hash  $($_.Name)"
    } | Set-Content (Join-Path $outputDir 'SHA256SUMS.txt') -Encoding ascii
    Write-Host "Installers and checksums are ready in: $outputDir"
    Write-Host 'Native acceptance still required on Windows: foregrounding, tray-less startup, double-Esc timing, Argon2 profile, <35MB memory, installer run (see docs/phase-6-7.md).'
}
finally {
    $env:CARGO_TARGET_DIR = $previousTargetDir
    Pop-Location
}
