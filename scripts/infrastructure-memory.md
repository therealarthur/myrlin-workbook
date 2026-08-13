# Infrastructure Setup

## Machines

### Arthur's PC (Cerberus)
- **OS**: Windows 11 (MINGW64/Git Bash available)
- **Hostname**: Cerberus
- **User**: Arthur
- **LAN IP**: 192.168.1.152
- **Tailscale IP**: 100.64.22.118
- **SSH**: `ssh Arthur@192.168.1.152` (key-based auth, no password needed)
- **Shell**: PowerShell (default) or Git Bash
- **Capabilities**: Full admin access -- can install software, manage services, run any command
- **Key tools**: Node.js, npm, Git, Python, PowerShell, Docker (via WSL), VS Code, Claude Code
- **Projects**: C:\Users\Arthur\Desktop\ (main workspace)

### Mac Mini (alloy)
- **OS**: macOS
- **Hostname**: alloy
- **User**: arthur
- **LAN IP**: 192.168.1.151
- **Tailscale IP**: 100.111.181.106 (may be on different tailnet)
- **SSH**: `ssh arthur@192.168.1.151` (key-based auth)
- **Capabilities**: Full access -- Homebrew, Docker (via Colima), Rust, Node.js, Python
- **Key tools**: Homebrew, cargo, node@22, docker, terraform, aws-cli, mcrcon, tmux, cloudflared, playit

## Cross-Machine SSH Access
- **Mac -> PC**: `ssh Arthur@192.168.1.152` (ed25519 key, no password)
- **PC -> Mac**: `ssh arthur@192.168.1.151` (ed25519 key, no password)
- Both directions work passwordless via SSH key authentication

## How to Run Commands on Arthur's PC
When asked to do something on Arthur's PC, use:
```bash
ssh Arthur@192.168.1.152 "command here"
```
For PowerShell commands:
```bash
ssh Arthur@192.168.1.152 "powershell.exe -Command 'Get-Process'"
```
For admin commands (requires elevation -- Arthur must approve UAC prompt):
```bash
ssh Arthur@192.168.1.152 "powershell.exe -Command \"Start-Process powershell -Verb RunAs -ArgumentList '-Command ...'\""
```

## Mac Mini Services (as of 2026-02-23)

### LaunchAgents (auto-start on login)
| Service | Label | Status |
|---------|-------|--------|
| OpenClaw Gateway | ai.openclaw.gateway | Running on :18789 |
| Remote Desktop | com.arthur.remote-desktop | Running on :9877 |
| Keep Awake | com.arthur.keepawake | Running |
| Cloudflared Webhook | com.arthur.cloudflared-webhook | Quick tunnel for Twilio |

### Running Services
- **OpenClaw**: http://192.168.1.151:18789 (LaunchAgent, OpenRouter/Sonnet 4.5)
- **Remote Desktop (Rust)**: http://192.168.1.151:9877 (WebSocket + HTTP viewer)
- **Cloudflared Tunnel**: Quick tunnel to localhost:3334 (voice-call webhook, ephemeral URL)

### Model Configuration (OpenRouter)
- **Primary**: openrouter/anthropic/claude-sonnet-4.5 (daily driver, ~$3/M tokens)
- **Fallback 1**: openrouter/deepseek/deepseek-chat (~$0.25/M tokens)
- **Fallback 2**: openrouter/google/gemini-2.5-flash-preview (~$0.50/M tokens)
- **For complex planning**: Use `/model openrouter/anthropic/claude-opus-4-6`
- **OpenRouter dashboard**: https://openrouter.ai/activity

### Installed Tools (Mac Mini)
| Tool | Purpose |
|------|---------|
| docker + colima | Container runtime |
| mcrcon | Minecraft RCON CLI |
| playit | Game server tunneling (playit.gg) |
| tmux | Long-running processes |
| terraform | Infrastructure as code |
| aws-cli | AWS cloud management |
| cloudflared | Cloudflare tunnels |
| wget | File downloads |
| jq | JSON processing |

### MCP Servers (mcporter)
| Server | Status |
|--------|--------|
| filesystem | Healthy (14 tools) |
| playwright | Healthy (22 tools) |
| brave-search | Needs BRAVE_API_KEY |

### Ports in Use
| Port | Service | Machine |
|------|---------|---------|
| 22 | SSH (OpenSSH) | Both machines |
| 9877 | Remote Desktop (Rust) | Mac Mini |
| 18789 | OpenClaw Gateway | Mac Mini |
| 3334 | Voice Call webhook | Mac Mini |

## Cron Jobs
| ID | Name | Schedule | Status |
|----|------|----------|--------|
| cf488334... | pr-review-myrlin-workbook | Every 5m | DISABLED |

## Pending Setup
- Brave Search API key -- for enhanced web search
- Reddit API credentials -- for posting automation
- Cloudflared named tunnel auth -- for persistent URLs
- Tailscale funnel enable -- admin approval needed
- Gmail app password -- for email CLI
- ClawHub login -- for installing community skills (needs browser flow)
