# Price Games systemd units

One-time infrastructure units that live alongside the app. These are committed
to the repo so every deploy target can install them consistently, and so the
host configuration is reviewable in code.

## `price-game-admin-serve.{service,timer}`

Keeps the admin-panel Tailscale serve rule in place.

The admin panel (`/admin`, `/api/admin/*`) is blocked at Caddy on the public
domain and reachable only via the Tailscale network. That access depends on a
single `tailscale serve` rule:

```
https://<tailscale-hostname>/  →  http://localhost:3001
```

If that rule is ever removed (by a `tailscale serve --https=443 off`, a
tailscaled reset, a confused operator, etc.) the admin panel goes dark.

The service runs `scripts/ensure-admin-tailscale-serve.sh`, which is idempotent
— it reads the current serve JSON, and only touches state if the rule is
missing or wrong. The paired timer fires it 30 s after boot and every 5 min
after that, so the system self-heals within one timer window.

### Install (one-time per host)

```bash
# 1. Install the ensure-script to a stable location. This decouples the
#    systemd unit from any repo checkout path — branch switches and
#    worktree moves won't break admin self-heal.
sudo install -m 0755 \
  scripts/ensure-admin-tailscale-serve.sh \
  /usr/local/bin/ensure-price-game-admin-serve.sh

# 2. Install the systemd unit + timer.
sudo cp infra/systemd/price-game-admin-serve.service /etc/systemd/system/
sudo cp infra/systemd/price-game-admin-serve.timer   /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now price-game-admin-serve.timer
```

### Updating the ensure-script

When `scripts/ensure-admin-tailscale-serve.sh` changes in the repo, re-run
step 1 above to refresh `/usr/local/bin/ensure-price-game-admin-serve.sh`.
The systemd unit does **not** auto-refresh from the repo. Consider wiring
this into the deploy pipeline so it's not forgotten.

### Verify

```bash
# Timer is scheduled:
systemctl list-timers price-game-admin-serve.timer

# Last run succeeded:
systemctl status price-game-admin-serve.service

# Force a run right now:
sudo systemctl start price-game-admin-serve.service

# See what it did:
journalctl -u price-game-admin-serve.service -n 20
```

