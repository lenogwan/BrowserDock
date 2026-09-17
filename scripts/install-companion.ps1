# One-click companion setup for BrowserDock on Windows.
#
# Run after installing BrowserDock (the .exe or .msi from dist/):
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File install-companion.ps1
#
# What it does (no manual config.json digging):
#   1. Ensures %APPDATA%\BrowserDock\config.json exists (launch BrowserDock once first).
#   2. Stages the bundled companion to %APPDATA%\BrowserDock\companion\{chromium,gecko}
#      so "Load unpacked" always points at a permanent folder.
#   3. Writes one pairing file per browser to %APPDATA%\BrowserDock\pairing\.
#   4. Optionally opens every installed browser at its extensions page
#      (-OpenBrowsers) for the final two-click load + import.
#
# Chrome/Edge/Firefox block silent extension installs (malware protection), so
# the last step is two clicks per browser inside the browser itself:
#   Chrome/Edge : Developer mode > Load unpacked > pick the chromium folder,
#                 then Import the pairing code/file on the companion page.
#   Firefox/Mullvad: about:debugging > Load Temporary Add-on > manifest.json,
#                 then Import. Permanent installs need a Mozilla-signed package.
[CmdletBinding()]
param(
  [switch]$OpenBrowsers,
  [string]$SourceDir = $PSScriptRoot
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$appData = Join-Path $env:APPDATA 'BrowserDock'
$configPath = Join-Path $appData 'config.json'
if (-not (Test-Path $configPath)) {
  throw "No config yet at $configPath. Launch BrowserDock once from the Start menu, then re-run this script."
}
$config = Get-Content $configPath -Raw | ConvertFrom-Json
$token = $config.settings.auth_token
$port = [int]$config.settings.ws_port
if ($token -notmatch '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$') {
  throw 'config.json settings.auth_token is not a UUIDv4. Repair or delete config.json and restart BrowserDock.'
}
if ($port -lt 1 -or $port -gt 65535) { throw 'config.json settings.ws_port must be between 1 and 65535.' }

# Locate the bundled companion next to this script, in the installed resources,
# or in a developer checkout.
$candidates = @(
  (Join-Path $SourceDir 'extension'),
  (Join-Path $SourceDir 'companion'),
  (Join-Path ${env:ProgramFiles} 'BrowserDock\companion'),
  (Join-Path $PSScriptRoot '..\extension')
)
$companionSource = $candidates | Where-Object { Test-Path (Join-Path $_ 'chromium\manifest.json') } | Select-Object -First 1
if (-not $companionSource) { throw "Bundled companion not found. Searched: $($candidates -join '; '). Re-run from the extracted dist folder, reinstall BrowserDock, or point Load unpacked at the extension/ folder of a source checkout." }

$companionDest = Join-Path $appData 'companion'
New-Item -ItemType Directory -Path $companionDest -Force | Out-Null
foreach ($flavor in @('chromium', 'gecko')) {
  $target = Join-Path $companionDest $flavor
  if (Test-Path $target) {
    # Keep a timestamped backup: a failed copy must never destroy the last
    # working staged companion (Load unpacked points at this folder).
    $backup = "$target.bak.$(Get-Date -Format 'yyyyMMdd-HHmmss')"
    Move-Item $target $backup -Force
    Write-Host "Previous $flavor companion backed up to: $backup"
  }
  Copy-Item (Join-Path $companionSource $flavor) -Destination $target -Recurse -Force
}
Write-Host "Companion staged at: $companionDest"

# The desktop app owns the port: confirm it answers before writing pairing
# files, otherwise the user imports a port nothing listens on.
try {
  $tcp = New-Object Net.Sockets.TcpClient
  $connected = $tcp.BeginConnect('127.0.0.1', $port, $null, $null).AsyncWaitHandle.WaitOne(2000)
  $tcp.Close()
  if (-not $connected) { Write-Warning "Nothing is listening on 127.0.0.1:$port. Launch BrowserDock first, then re-run to verify companions can connect." }
} catch {
  Write-Warning "Could not probe 127.0.0.1:$port ($($_.Exception.Message)). Launch BrowserDock first."
}

$pairingDir = Join-Path $appData 'pairing'
New-Item -ItemType Directory -Path $pairingDir -Force | Out-Null
foreach ($browser in @('firefox', 'mullvad', 'chrome', 'edge')) {
  $payload = [ordered]@{
    browser = $browser
    token = $token
    port = $port
    includePrivate = ($browser -eq 'mullvad')
  }
  $payload | ConvertTo-Json | Set-Content -Path (Join-Path $pairingDir "browserdock-pairing-$browser.json") -Encoding utf8NoBOM
}
Write-Host "Pairing files written to: $pairingDir"

if ($OpenBrowsers) {
  $pages = @{
    chrome = 'chrome://extensions'
    edge = 'edge://extensions'
    firefox = 'about:debugging#/runtime/this-firefox'
    mullvad = 'about:debugging#/runtime/this-firefox'
  }
  foreach ($entry in $config.browsers) {
    $id = [string]$entry.id
    if (-not $pages.ContainsKey($id)) { continue }
    $exe = [string]$entry.exe_path
    if (-not $exe -or -not (Test-Path $exe)) { Write-Warning "Skipping ${id}: executable not found."; continue }
    Start-Process -FilePath $exe -ArgumentList $pages[$id]
  }
}

Write-Host ''
Write-Host 'Next (two clicks per browser):'
Write-Host '  Chrome/Edge : enable Developer mode > Load unpacked > pick the chromium folder, then Import the pairing file.'
Write-Host '  Firefox/Mullvad: Load Temporary Add-on > gecko/manifest.json, then Import the pairing file.'
Write-Host 'Or do the same from inside BrowserDock: Settings > Connect your browsers.'
