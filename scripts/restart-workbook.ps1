# Restart the workbook into its supervised, auto-restarting state.
#
# Resets everything to a known-good configuration. Run AFTER killing the
# workbook by mistake, or any time the autostart task drifted out of sync
# with what's actually running.
#
# Requires admin (UAC) because:
#   - Register-ScheduledTask + Set-ScheduledTask for S4U principal tasks
#     can only be done elevated.
#   - Stopping rogue node processes if they're owned by SYSTEM.
#
# Run once:
#   Start-Process powershell -Verb RunAs -ArgumentList "-NoExit","-File","C:\Users\Arthur\Desktop\claude-workspace-manager\scripts\restart-workbook.ps1"

$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot

Write-Host '== 1. Regenerate autostart wrapper + Scheduled Task ==' -ForegroundColor Cyan
& (Join-Path $ProjectRoot 'scripts\setup-autostart.ps1')

Write-Host ''
Write-Host '== 2. Stop existing workbook processes on 3456 / 3457 ==' -ForegroundColor Cyan
$ports = @(3456, 3457)
foreach ($p in $ports) {
    $listeners = Get-NetTCPConnection -State Listen -LocalPort $p -ErrorAction SilentlyContinue
    if (-not $listeners) { Write-Host "  port $p — no listener" -ForegroundColor Gray; continue }
    foreach ($conn in $listeners) {
        $procId = $conn.OwningProcess
        $proc = Get-Process -Id $procId -ErrorAction SilentlyContinue
        $name = if ($proc) { $proc.ProcessName } else { 'unknown' }
        Write-Host "  port $p — stopping PID $procId ($name)..." -ForegroundColor Yellow
        try {
            Stop-Process -Id $procId -Force -ErrorAction Stop
            Write-Host "    stopped." -ForegroundColor Green
        } catch {
            Write-Warning "    Stop-Process failed: $_"
        }
    }
}
Start-Sleep -Seconds 2

Write-Host ''
Write-Host '== 3. Start the Scheduled Task ==' -ForegroundColor Cyan
Start-ScheduledTask -TaskName 'Myrlin-Workbook'
Write-Host '  task fired. Waiting 8s for supervisor + gui.js to bind...' -ForegroundColor Gray
Start-Sleep -Seconds 8

Write-Host ''
Write-Host '== 4. Verify ==' -ForegroundColor Cyan
$listener = Get-NetTCPConnection -State Listen -LocalPort 3457 -ErrorAction SilentlyContinue
if ($listener) {
    $procId = $listener.OwningProcess
    $proc = Get-Process -Id $procId -ErrorAction SilentlyContinue
    Write-Host "  Listener on 3457 — PID $procId ($($proc.ProcessName))" -ForegroundColor Green
    # Probe locally:
    try {
        $r = Invoke-WebRequest -Uri 'http://127.0.0.1:3457' -UseBasicParsing -Method Head -TimeoutSec 5
        Write-Host "  Local probe: HTTP $($r.StatusCode)" -ForegroundColor Green
    } catch {
        Write-Warning "  Local probe failed: $_"
    }
    # Probe the public tunnel:
    try {
        $r = Invoke-WebRequest -Uri 'https://workbook.myrlin.dev' -UseBasicParsing -Method Head -MaximumRedirection 0 -TimeoutSec 10 -ErrorAction Stop
        Write-Host "  Public probe: HTTP $($r.StatusCode)" -ForegroundColor Green
    } catch {
        # Cloudflare Access 302 is expected for unauthenticated; Invoke-WebRequest throws.
        if ($_.Exception.Response.StatusCode -eq 302) {
            Write-Host '  Public probe: HTTP 302 (Cloudflare Access OAuth gate — expected)' -ForegroundColor Green
        } else {
            Write-Warning "  Public probe failed: $($_.Exception.Message)"
        }
    }
} else {
    Write-Warning '  No listener on 3457. Check logs/server.log for crash details.'
}

Write-Host ''
Write-Host 'Done. The workbook is now under the Scheduled Task. If it crashes,' -ForegroundColor Green
Write-Host 'supervisor.js restarts it within 2-5s. If the supervisor itself dies,' -ForegroundColor Green
Write-Host 'Task Scheduler restart-on-failure brings it back within 5 minutes.' -ForegroundColor Green
