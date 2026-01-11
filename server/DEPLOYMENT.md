# CS-CLI Server Deployment Guide

This guide covers deploying the CS-CLI game server to various hosting platforms.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8080` | Game server WebSocket port |
| `HUB_PORT` | `8081` | Hub server port (for federation) |
| `MAX_ROOMS` | `100` | Maximum concurrent game rooms |
| `SERVER_NAME` | `CS-CLI Server` | Server display name |
| `PUBLIC_URL` | auto | Public WebSocket URL (e.g., `wss://game.example.com`) |

## Client Configuration

After deploying, clients connect using the `GAME_SERVER_URL` environment variable:

```bash
GAME_SERVER_URL=wss://your-server.example.com npm run play
```

---

## Hosting Platform Comparison

### Fly.io

**Best for:** Low-latency global distribution, simple deploys

| Pros | Cons |
|------|------|
| Global edge network (30+ regions) | Usage-based billing can grow unpredictably |
| Built-in WebSocket support | More complex infrastructure management |
| Easy deploys via `fly deploy` | Steeper learning curve |
| Automatic TLS/SSL | |
| Can scale to multiple regions | |

**Pricing:** ~$5-15/month for small game server (shared CPU, 512MB RAM)

**Latency:** Excellent - servers run close to players

### DigitalOcean

**Best for:** Budget-conscious teams, predictable costs

| Pros | Cons |
|------|------|
| Predictable flat pricing | Single region per droplet |
| Simple VPS management | Manual SSL setup (or use App Platform) |
| Good documentation | No built-in global distribution |
| Marketplace apps available | |
| $200 free credit for new users | |

**Pricing:** $6/month (1 vCPU, 1GB RAM) or $12/month (1 vCPU, 2GB RAM)

**Latency:** Good for regional deployment

### Linode (Akamai)

**Best for:** Cost-effective VPS, straightforward setup

| Pros | Cons |
|------|------|
| Transparent flat pricing | Manual infrastructure management |
| Free DDoS protection | Single region per instance |
| VLAN support for private networking | Less modern developer experience |
| Good performance per dollar | |
| No hidden fees | |

**Pricing:** $5/month (1 vCPU, 1GB RAM) - cheapest option

**Latency:** Good for regional deployment

---

## Deployment Instructions

### Option 1: Fly.io (Recommended for Global)

1. Install Fly CLI:
   ```bash
   curl -L https://fly.io/install.sh | sh
   ```

2. Login and launch:
   ```bash
   cd server
   fly auth login
   fly launch
   ```

3. Set the public URL secret:
   ```bash
   fly secrets set PUBLIC_URL=wss://your-app-name.fly.dev
   ```

4. Deploy:
   ```bash
   fly deploy
   ```

5. Connect clients:
   ```bash
   GAME_SERVER_URL=wss://your-app-name.fly.dev npm run play
   ```

### Option 2: DigitalOcean Droplet

1. Create a Droplet:
   - Choose Ubuntu 22.04
   - Select $6 or $12/month plan
   - Add SSH key

2. SSH in and install Docker:
   ```bash
   ssh root@your-droplet-ip
   curl -fsSL https://get.docker.com | sh
   ```

3. Clone and deploy:
   ```bash
   git clone your-repo
   cd cs_cli/server
   docker build -t cs-cli-server .
   docker run -d \
     --name cs-cli \
     --restart unless-stopped \
     -p 8080:8080 \
     -e PUBLIC_URL=ws://your-droplet-ip:8080 \
     cs-cli-server
   ```

4. (Optional) Add SSL with Caddy:
   ```bash
   apt install caddy
   # Edit /etc/caddy/Caddyfile:
   # game.yourdomain.com {
   #   reverse_proxy localhost:8080
   # }
   systemctl restart caddy
   ```

5. Connect clients:
   ```bash
   GAME_SERVER_URL=ws://your-droplet-ip:8080 npm run play
   # Or with SSL:
   GAME_SERVER_URL=wss://game.yourdomain.com npm run play
   ```

### Option 3: Linode

1. Create a Linode:
   - Choose Ubuntu 22.04
   - Select Nanode ($5/month) or Linode 2GB ($12/month)
   - Add SSH key

2. SSH in and install Docker:
   ```bash
   ssh root@your-linode-ip
   curl -fsSL https://get.docker.com | sh
   ```

3. Clone and deploy (same as DigitalOcean):
   ```bash
   git clone your-repo
   cd cs_cli/server
   docker build -t cs-cli-server .
   docker run -d \
     --name cs-cli \
     --restart unless-stopped \
     -p 8080:8080 \
     -e PUBLIC_URL=ws://your-linode-ip:8080 \
     cs-cli-server
   ```

4. Connect clients:
   ```bash
   GAME_SERVER_URL=ws://your-linode-ip:8080 npm run play
   ```

---

## Local Development with Docker

```bash
# From project root
docker-compose up --build

# Connect locally
npm run play
# (defaults to ws://localhost:8080)
```

---

## SSL/TLS for Production

For production, always use `wss://` (WebSocket Secure):

- **Fly.io**: Automatic - just use `wss://your-app.fly.dev`
- **DigitalOcean/Linode**: Use a reverse proxy like Caddy or nginx

Example Caddy config:
```
game.yourdomain.com {
    reverse_proxy localhost:8080
}
```

Caddy automatically provisions SSL certificates via Let's Encrypt.

---

## Scaling Considerations

### Single Server (Standalone Mode)
- Good for up to ~100 concurrent players
- Simple deployment
- Default configuration

### Federation (Hub + Pool Mode)
For larger deployments, run multiple game servers connected to a hub:

```bash
# Hub server (routes players to pools)
docker run -d -p 8081:8081 cs-cli-server --hub-only

# Pool servers (run games)
docker run -d -p 8080:8080 \
  -e PUBLIC_URL=wss://pool1.example.com \
  cs-cli-server --pool --hub=ws://hub-server:8081

docker run -d -p 8080:8080 \
  -e PUBLIC_URL=wss://pool2.example.com \
  cs-cli-server --pool --hub=ws://hub-server:8081
```

---

## Recommendation Summary

| Use Case | Recommendation |
|----------|----------------|
| Global players, low latency | **Fly.io** |
| Budget-conscious, single region | **Linode** ($5/month) |
| Team familiarity with DO | **DigitalOcean** |
| Maximum control | Any VPS with Docker |
