# dev.ps1 — start forge-hub + forge-dash-community on random available ports
# Usage: pwsh scripts/dev.ps1  (from repo root)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-FreePort {
    $l = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
    $l.Start()
    $port = $l.LocalEndpoint.Port
    $l.Stop()
    return $port
}

$root     = (Resolve-Path "$PSScriptRoot/..").Path
$hubDir   = Join-Path $root "packages/forge-hub"
$dashDir  = Join-Path $root "packages/forge-dash-community"
$envLocal = Join-Path $dashDir ".env.local"

$hubPort  = Get-FreePort
$dashPort = Get-FreePort
$hubUrl   = "http://localhost:$hubPort"

Write-Host ""
Write-Host "forge-lab dev"
Write-Host "  hub   -> $hubUrl"
Write-Host "  dash  -> http://localhost:$dashPort"
Write-Host ""

Set-Content $envLocal "FORGE_HUB_URL=$hubUrl"

$hubCmd  = "cd '$hubDir'; `$env:FORGE_HUB_PORT='$hubPort'; pnpm dev"
$dashCmd = "cd '$dashDir'; pnpm exec next dev --port $dashPort --hostname 0.0.0.0"

Start-Process pwsh -ArgumentList "-NoExit", "-Command", $hubCmd
Start-Process pwsh -ArgumentList "-NoExit", "-Command", $dashCmd

Write-Host "Processes started in new terminals."
Write-Host ""
Write-Host "Hub  : $hubUrl"
Write-Host "Dash : http://localhost:$dashPort"
