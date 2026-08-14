# Idempotent installer/refresher for the workbook.myrlin.dev tunnel.
#
# CURRENT STATE (as of alpha.8 ship): everything below is ALREADY DONE on
# this PC. cert.pem is at ~/.cloudflared/cert.pem; named tunnel `myrlin2`
# (b97ba90b-7451-4807-8434-d4b4412c7bcf) routes workbook.myrlin.dev to
# localhost:3457 (was 3456 before the port-mismatch fix); the Cloudflared
# Windows service is installed, set to Automatic, and running. Cloudflare
# Access policy is active (verified by Www-Authenticate: Cloudflare-Access
# header on the public URL).
#
# This script exists so the setup is reproducible: a fresh PC reinstall,
# a tunnel rename, or a port change can be re-applied by re-running.
#
# Run once after `cloudflared tunnel login`:
#   powershell -ExecutionPolicy Bypass -File scripts/setup-cloudflared.ps1
#
# Re-run after editing $UpstreamPort (e.g., when the workbook moves back
# to its default :3456 port via env var or autostart task).

$ErrorActionPreference = 'Stop'
$TunnelName = 'myrlin2'        # Reusing the existing tunnel; do not create another
$Hostname = 'workbook.myrlin.dev'
$UpstreamPort = 3457           # alpha.7+ workbook listens here on this PC
$CfDir = Join-Path $env:USERPROFILE '.cloudflared'
$CertFile = Join-Path $CfDir 'cert.pem'
$ConfigFile = Join-Path $CfDir 'config.yml'

if (-not (Test-Path $CertFile)) {
    Write-Error "cert.pem missing at $CertFile. Run 'cloudflared tunnel login' first."
    exit 1
}

$listJson = & cloudflared tunnel list --output json | ConvertFrom-Json
$existing = $listJson | Where-Object { $_.name -eq $TunnelName }
if (-not $existing) {
    Write-Host "Creating tunnel $TunnelName ..." -ForegroundColor Gray
    & cloudflared tunnel create $TunnelName
    $listJson = & cloudflared tunnel list --output json | ConvertFrom-Json
    $existing = $listJson | Where-Object { $_.name -eq $TunnelName }
}
$tunnelId = $existing.id
Write-Host "Tunnel: $TunnelName ($tunnelId)" -ForegroundColor Cyan

# config.yml is the source of truth for ingress. The existing file may
# carry other hostnames (sylk.myrlin.dev, onnik.myrlin.dev) that this
# script must not clobber. Strategy: read, patch in-memory, write back.
if (Test-Path $ConfigFile) {
    $existingConfig = Get-Content $ConfigFile -Raw
    $lines = $existingConfig -split "`n"
    $newLines = @()
    $i = 0
    $patched = $false
    while ($i -lt $lines.Length) {
        $line = $lines[$i]
        if ($line -match "hostname:\s*$([regex]::Escape($Hostname))") {
            # Replace the next service line with our desired upstream.
            $newLines += $line
            $i++
            if ($i -lt $lines.Length -and $lines[$i] -match 'service:') {
                $newLines += "    service: http://localhost:$UpstreamPort"
                $patched = $true
                $i++
                continue
            }
        } else {
            $newLines += $line
        }
        $i++
    }
    if (-not $patched) {
        # Hostname not yet in config, insert a new ingress block before the
        # final catch-all 404.
        $newLines = @()
        foreach ($line in $lines) {
            if ($line -match 'service:\s*http_status:404') {
                $newLines += "  - hostname: $Hostname"
                $newLines += "    service: http://localhost:$UpstreamPort"
            }
            $newLines += $line
        }
    }
    ($newLines -join "`n") | Out-File -FilePath $ConfigFile -Encoding utf8 -NoNewline
} else {
    # No existing config, write a minimal one with just this hostname.
    @"
tunnel: $tunnelId
credentials-file: $(Join-Path $CfDir ($tunnelId + '.json'))

ingress:
  - hostname: $Hostname
    service: http://localhost:$UpstreamPort
  - service: http_status:404
"@ | Out-File -FilePath $ConfigFile -Encoding utf8 -NoNewline
}
Write-Host "Patched $ConfigFile to point $Hostname -> http://localhost:$UpstreamPort" -ForegroundColor Gray

# Validate
& cloudflared tunnel ingress validate
if ($LASTEXITCODE -ne 0) { Write-Error 'ingress validate failed'; exit 1 }

# Route DNS (idempotent, no-ops if the CNAME already exists)
Write-Host "Routing DNS $Hostname (idempotent)..." -ForegroundColor Gray
try { & cloudflared tunnel route dns $TunnelName $Hostname } catch {
    Write-Warning "route dns: $_  (often safe to ignore if CNAME already exists)"
}

# Service install/refresh
$svc = Get-Service Cloudflared -ErrorAction SilentlyContinue
if (-not $svc) {
    Write-Host 'Installing Cloudflared as Windows service...' -ForegroundColor Gray
    & cloudflared service install
    & sc.exe failure Cloudflared reset= 86400 actions= restart/5000/restart/5000/restart/5000 | Out-Null
}

Write-Host ''
Write-Host 'Restart the Cloudflared service in an ELEVATED shell to pick up config:' -ForegroundColor Yellow
Write-Host '  Restart-Service Cloudflared' -ForegroundColor Cyan
Write-Host ''
Write-Host "Verify with: curl -I https://$Hostname  (expect HTTP/2 302 to Cloudflare Access)" -ForegroundColor Cyan
