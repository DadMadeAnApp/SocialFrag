# Fetches the whisper.cpp v1.9.4 Windows CPU build (release b5130) and installs whisper-cli as a Tauri sidecar.
# Usage: powershell -ExecutionPolicy Bypass -File scripts/fetch-whisper.ps1
$ErrorActionPreference = 'Stop'

$tag = 'b5130'
$name = 'whisper-bin-x64.zip'  # pinned by SHA-256 below
$url = "https://github.com/ggml-org/whisper.cpp/releases/download/$tag/$name"

$root = Split-Path -Parent $PSScriptRoot
$bin = Join-Path $root 'src-tauri/binaries'
$dlls = Join-Path $bin 'whisper-dlls'
New-Item -ItemType Directory -Force $bin, $dlls | Out-Null

$zip = Join-Path $env:TEMP $name
Invoke-WebRequest $url -OutFile $zip
$sha256 = 'f9ec6c52a2e949b62ab51fa21d0d497958f9e41c3010c157c4e42932d5316f3c'
$got = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLower()
if ($got -ne $sha256) { throw "$name checksum mismatch: got $got, expected $sha256" }
$out = Join-Path $env:TEMP 'socialfrag-whisper'
Remove-Item -Recurse -Force $out -ErrorAction SilentlyContinue
Expand-Archive $zip -DestinationPath $out
$rel = Join-Path $out 'Release'

$triple = 'x86_64-pc-windows-msvc'
Copy-Item (Join-Path $rel 'whisper-cli.exe') (Join-Path $bin "whisper-cli-$triple.exe") -Force
# whisper-cli loads these from its own folder; ggml-cpu-*.dll are CPU variants picked at run time.
Remove-Item (Join-Path $dlls '*.dll') -ErrorAction SilentlyContinue
foreach ($d in @('whisper.dll', 'ggml.dll', 'ggml-base.dll')) { Copy-Item (Join-Path $rel $d) $dlls -Force }
Get-ChildItem $rel -Filter 'ggml-cpu-*.dll' | Copy-Item -Destination $dlls -Force
Set-Content (Join-Path $root 'src-tauri/licenses/whisper-source.txt') @"
whisper.cpp build: $name (release $tag, whisper.cpp v1.9.4)
Downloaded from: $url
Upstream source: https://github.com/ggml-org/whisper.cpp (MIT)
"@

foreach ($f in @((Join-Path $bin "whisper-cli-$triple.exe"), (Join-Path $dlls 'whisper.dll'), (Join-Path $dlls 'ggml.dll'))) {
  if (-not (Test-Path $f)) { throw "Missing $f after extracting $name" }
}
Write-Host "Bundled whisper-cli from $tag with $((Get-ChildItem $dlls -Filter *.dll).Count) DLLs"
# whisper-cli -h exits 1 by design, so it is not run here.
