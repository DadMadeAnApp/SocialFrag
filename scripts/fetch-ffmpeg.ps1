# Fetches an LGPL FFmpeg build for Windows and installs it as Tauri sidecars.
# Usage: powershell -ExecutionPolicy Bypass -File scripts/fetch-ffmpeg.ps1
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$bin = Join-Path $root 'src-tauri/binaries'
$lic = Join-Path $root 'src-tauri/licenses'
New-Item -ItemType Directory -Force $bin, $lic | Out-Null

# CI passes GITHUB_TOKEN so the API call isn't rate-limited on shared runner IPs.
$headers = @{}
if ($env:GITHUB_TOKEN) { $headers['Authorization'] = "Bearer $($env:GITHUB_TOKEN)" }
$release = Invoke-RestMethod 'https://api.github.com/repos/BtbN/FFmpeg-Builds/releases/latest' -Headers $headers

# Prefer a version-tagged LGPL static build; fall back to the master LGPL build.
$asset = $release.assets |
  Where-Object { $_.name -match '^ffmpeg-n\d+\.\d+.*-win64-lgpl.*\.zip$' } |
  Select-Object -First 1
if (-not $asset) {
  $asset = $release.assets |
    Where-Object { $_.name -eq 'ffmpeg-master-latest-win64-lgpl.zip' } |
    Select-Object -First 1
}
if (-not $asset) { throw 'No win64 LGPL (static) build found in the latest BtbN release.' }

$zip = Join-Path $env:TEMP $asset.name
Invoke-WebRequest $asset.browser_download_url -OutFile $zip
# Verify against the checksums published with the same release.
$sums = $release.assets | Where-Object { $_.name -eq 'checksums.sha256' } | Select-Object -First 1
if (-not $sums) { throw 'No checksums.sha256 in the BtbN release.' }
# Served as application/octet-stream, so save it and read it as text.
$sumsFile = Join-Path $env:TEMP 'socialfrag-ffmpeg-checksums.sha256'
Invoke-WebRequest $sums.browser_download_url -Headers $headers -OutFile $sumsFile
$line = Get-Content $sumsFile | Where-Object { $_ -match [regex]::Escape($asset.name) } | Select-Object -First 1
if (-not $line) { throw "$($asset.name) is not listed in checksums.sha256" }
$want = ($line -split '\s+')[0].ToLower()
$got = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLower()
if ($got -ne $want) { throw "$($asset.name) checksum mismatch: got $got, expected $want" }
$out = Join-Path $env:TEMP 'socialfrag-ffmpeg'
Remove-Item -Recurse -Force $out -ErrorAction SilentlyContinue
Expand-Archive $zip -DestinationPath $out
$dir = Get-ChildItem $out -Directory | Select-Object -First 1

$triple = 'x86_64-pc-windows-msvc'
Copy-Item (Join-Path $dir.FullName 'bin/ffmpeg.exe') (Join-Path $bin "ffmpeg-$triple.exe") -Force
Copy-Item (Join-Path $dir.FullName 'bin/ffprobe.exe') (Join-Path $bin "ffprobe-$triple.exe") -Force
Copy-Item (Join-Path $dir.FullName 'LICENSE.txt') (Join-Path $lic 'ffmpeg-LGPL-3.0.txt') -Force
Set-Content (Join-Path $lic 'ffmpeg-source.txt') @"
FFmpeg build: $($asset.name)
Downloaded from: $($asset.browser_download_url)
Upstream sources: https://github.com/BtbN/FFmpeg-Builds and https://ffmpeg.org/download.html
This build is LGPL-only and configured with --enable-version3, so it is covered by the
GNU Lesser General Public License version 3; the license text ships as licenses/ffmpeg-LGPL-3.0.txt.
Run 'ffmpeg -buildconf' on the bundled binary for its exact configuration.
"@

Write-Host "Bundled $($asset.name)"
& (Join-Path $bin "ffmpeg-$triple.exe") -hide_banner -encoders | Select-String 'h264|hevc'
