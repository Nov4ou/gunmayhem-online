# Deployment

The repository includes a generic release script, systemd unit, and Caddy example. The script builds and tests locally, uploads an immutable release, switches `/opt/gunmayhem/current` atomically, restarts the service, and rolls back automatically if health checks fail.

## Server requirements

- Linux with systemd
- Node.js 22 or newer at `/usr/bin/node`, or a custom directory supplied through `GUNMAYHEM_NODE_DIR`
- Caddy or another reverse proxy with WebSocket support
- SSH access for the deployment user

Install the example service after reviewing its paths:

```bash
sudo cp deploy/gunmayhem.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable gunmayhem
```

Configure a domain in `deploy/Caddyfile`, place the site block in the server's active Caddy configuration, and reload Caddy.

## Release

```bash
export GUNMAYHEM_SSH=user@game-server.example.com
export GUNMAYHEM_PUBLIC_HEALTH=https://game.example.com/health
./deploy/deploy.sh v18.1
```

For a nonstandard Node installation:

```bash
export GUNMAYHEM_NODE_DIR=/opt/node-v22/bin
```

The remote deployment needs permission to create `/opt/gunmayhem/releases`, update `/opt/gunmayhem/current`, and restart `gunmayhem.service`. The supplied remote commands assume root access. Adapt them to `sudo` or a dedicated deployment service if the SSH account is unprivileged.

The game server listens only on `127.0.0.1:3001`; expose it through the reverse proxy. The `/health` endpoint returns a small JSON response and does not reveal room data.

## Rollback

Every release is stored in its own directory. To restore a previous release:

```bash
sudo ln -sfn /opt/gunmayhem/releases/PREVIOUS_RELEASE /opt/gunmayhem/current
sudo systemctl restart gunmayhem
```

Keep the previous release until the new version has completed real two-, three-, and four-player sessions.
