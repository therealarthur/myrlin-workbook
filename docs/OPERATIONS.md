# Operations — Myrlin Workbook

Operational notes for the always-on `workbook.myrlin.dev` deployment.

## Layers

| Layer | Process | Auto-start | Auto-restart |
|---|---|---|---|
| Workbook (`node gui.js`) | child of supervisor.js OR launched by watchdog | yes (via supervisor + watchdog) | yes (supervisor 2s back-off; watchdog 10s poll) |
| Supervisor (`node supervisor.js`) | Scheduled Task `Myrlin-Workbook` | yes (Task Scheduler `AtStartup`, S4U) | yes (Task Scheduler restart-on-failure x3) |
| Watchdog (`node scripts/watchdog.js`) | Scheduled Task `Myrlin-Workbook-Watchdog` | yes (Task Scheduler `AtLogon`, Interactive) | yes (Task Scheduler restart-on-failure x3) |
| Cloudflared | Windows service `Cloudflared` | yes (`start=auto`) | yes (SCM recovery: restart x3 / 5s delay) |
| DNS | Cloudflare DNS (`myrlin.dev` zone) | n/a | n/a |
| TLS | Cloudflare edge | n/a | n/a |
| Auth | Cloudflare Access (Zero Trust) | n/a | n/a |

### Watchdog vs Supervisor

The watchdog (user-space, non-admin) and supervisor (S4U Scheduled Task, admin to register) are belt-and-suspenders for different failure modes:

- **Supervisor** owns the workbook process — knows when its child crashes within milliseconds, restarts immediately.
- **Watchdog** doesn't own anything — polls `http://127.0.0.1:3457/` every 10s. Spawns a replacement workbook if the port doesn't answer, regardless of why (manual kill, parent process death, supervisor itself dying).

Together they handle every failure mode except a wedged tunnel or a kernel-level Windows crash.

## Quick health check

```powershell
# All three should be Running:
Get-Service Cloudflared | Select-Object Name,Status,StartType
Get-ScheduledTask Myrlin-Workbook | Select-Object TaskName,State

# Workbook port (default 3456; on this PC currently 3457 — see config.yml):
(Get-NetTCPConnection -State Listen -LocalPort 3456,3457 -ErrorAction SilentlyContinue).LocalPort

# Public reachability:
curl -I https://workbook.myrlin.dev
# Expected: HTTP/2 302 with Www-Authenticate: Cloudflare-Access (Access OAuth gate)
```

## Cloudflare assets

- **DNS zone:** `myrlin.dev` (zone ID `045577a5aec0099cf1e99c2f1db188cd`).
- **Tunnel:** `myrlin2` (UUID `b97ba90b-7451-4807-8434-d4b4412c7bcf`). Currently serves `sylk.myrlin.dev`, `workbook.myrlin.dev`, `onnik.myrlin.dev`.
- **Config:** `C:\Users\Arthur\.cloudflared\config.yml`. Edit + restart the `Cloudflared` service to apply.
- **Access policy:** Cloudflare Zero Trust dashboard → Applications → `workbook.myrlin.dev`. Allow rule + Service Token for mobile bypass.

## Re-install / refresh

```powershell
# Re-apply tunnel config + service settings (idempotent):
powershell -ExecutionPolicy Bypass -File scripts/setup-cloudflared.ps1

# Re-apply "never sleep" power policy:
powershell -ExecutionPolicy Bypass -File scripts/setup-power-never-sleep.ps1

# Re-install autostart Scheduled Task:
powershell -ExecutionPolicy Bypass -File scripts/setup-autostart.ps1
```

## Logs

| Component | Location |
|---|---|
| Workbook | `logs/server.log` (project dir; `tail -F logs/server.log` to watch) |
| Cloudflared | Event Viewer → Windows Logs → Application → Source `cloudflared` |
| Scheduled Task | Task Scheduler → `Myrlin-Workbook` → History tab |

## Rotate Service Token

If the Cloudflare Access Service Token leaks:

1. `https://one.dash.cloudflare.com` → Access → Service Auth → Tokens.
2. Revoke the old token.
3. Create a new one. Copy the Client ID + Client Secret immediately (shown once).
4. Update `~/.claude/credentials.md`.
5. Update the mobile client + any scripts that use the old token.

## Port mismatch (current)

The cloudflared `config.yml` routes `workbook.myrlin.dev` → `localhost:3457` because the workbook on this PC currently listens on `:3457` (originally bound when `:3456` was busy on a prior boot). To re-standardize on `:3456`:

1. Set `PORT=3456` in the Scheduled Task action OR system environment.
2. Restart the workbook (`Restart-ScheduledTask -TaskName Myrlin-Workbook`).
3. Update `scripts/setup-cloudflared.ps1` `$UpstreamPort = 3456`.
4. Re-run the installer + `Restart-Service Cloudflared`.

## Failure scenarios

| Failure | Symptom | Recovery |
|---|---|---|
| Workbook crashes | Tunnel returns 502 briefly | Supervisor restarts within 2s; no action needed |
| Supervisor crashes | Tunnel returns 502 for ~30s | Scheduled Task restart-on-failure fires; no action needed |
| Cloudflared crashes | Tunnel offline; DNS still resolves | SCM restart within ~5s; no action needed |
| PC sleep / hibernate | Tunnel offline; DNS still resolves | Wake the PC. Run `scripts/setup-power-never-sleep.ps1` if recurring |
| PC reboot | All layers offline briefly | All auto-start at boot; back up in 60-90s |
| Cloudflare edge issue | Connection retries / 5xx | cloudflared internal reconnect; transient |
| Cloudflare Access locked out (lost OAuth) | Can't browse the site | Add a second identity provider (GitHub) to the Access app |

## Out of scope

- Multi-machine workbook replication / state sync.
- Mac Mini hosting (explicitly out per design).
- Migrating workbook from `:3457` to `:3456` (operational task, no code change needed).
