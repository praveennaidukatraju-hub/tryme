# Cloudflare Tunnel Setup (Worker VPS)

Each ComfyUI GPU VPS exposes `localhost:8188` to the dispatcher through a named tunnel.
No inbound ports are opened on the VPS.

## Prerequisites

- Cloudflare account (free tier is fine)
- `cloudflared` installed on the GPU worker VPS
- ComfyUI running on `127.0.0.1:8188`

> **No domain needed yet.** Each tunnel gets a `<uuid>.cfargotunnel.com` hostname automatically.
> Add custom DNS routing later when you have a domain on Cloudflare.

---

## Step-by-step: per GPU worker VPS

### 1. Install cloudflared

```bash
# On the GPU worker VPS (Ubuntu/Debian)
curl -L --output cloudflared.deb \
  https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb
sudo dpkg -i cloudflared.deb
cloudflared --version
```

### 2. Authenticate (headless VPS method)

```bash
# Run on VPS — prints a URL, open it in browser on your local machine
cloudflared tunnel login
# → Opens URL like https://dash.cloudflare.com/...
# → After auth, downloads cert.pem to ~/.cloudflared/cert.pem on VPS
```

### 3. Create the tunnel

```bash
# Replace "tryon-worker-a" with "tryon-worker-b" for second VPS
cloudflared tunnel create tryon-worker-a

# Output looks like:
#   Created tunnel tryon-worker-a with id 550e8400-e29b-41d4-a716-446655440000
#   Credentials written to /root/.cloudflared/550e8400-e29b-41d4-a716-446655440000.json
# SAVE THE UUID — you need it in config.yml and as WORKER_A_URL
```

### 4. Note your tunnel hostname

Your tunnel is accessible at:
```
https://<TUNNEL-UUID>.cfargotunnel.com
```
No extra setup needed — this works immediately once cloudflared is running.

### 5. Write config.yml

```bash
# Replace TUNNEL-UUID with the UUID from step 3
# No hostname needed — tunnel UUID is the sole entrypoint without a custom domain
cat > ~/.cloudflared/config.yml << 'EOF'
tunnel: TUNNEL-UUID
credentials-file: /root/.cloudflared/TUNNEL-UUID.json

ingress:
  - service: http://localhost:8000
    originRequest:
      connectTimeout: 10s

  - service: http_status:404

loglevel: info
transport-loglevel: warn
EOF
```

### 6. Test tunnel manually

```bash
# Run in foreground to verify connection
cloudflared tunnel run tryon-worker-a

# In another terminal:
curl https://TUNNEL-UUID.cfargotunnel.com/system_stats
# Should return ComfyUI JSON like {"system":{"os":"posix",...},"devices":[...]}
```

### 7. Install as systemd service

```bash
sudo cloudflared service install
sudo systemctl enable cloudflared
sudo systemctl start cloudflared
sudo systemctl status cloudflared
```

---

## Optional: Add custom DNS route (once you have a domain on Cloudflare)

```bash
# Add domain to Cloudflare DNS panel first, then:
cloudflared tunnel route dns tryon-worker-a worker-a.yourdomain.com

# Update config.yml hostname:
# - hostname: worker-a.yourdomain.com
#   service: http://localhost:8188
```

Update `WORKER_A_URL` in dispatcher `.env` to use the custom hostname.

---

## Cloudflare Access (Zero Trust) — secure the tunnel endpoint

Without this, anyone who knows the tunnel URL can reach ComfyUI.
Set up after you have a domain on Cloudflare.

1. Zero Trust dashboard → Access → Applications → Add → Self-hosted
2. Application domain: `worker-a.yourdomain.com` (or wildcard `worker-*.yourdomain.com`)
3. Policy type: Service Auth → Service Token → create token
4. Copy `CF_Access_Client_Id` and `CF_Access_Client_Secret`
5. Put into dispatcher `.env`:
   ```
   CF_ACCESS_CLIENT_ID=<id>
   CF_ACCESS_CLIENT_SECRET=<secret>
   ```

The dispatcher sends these on every `/prompt` and `/system_stats` request.

> **For now (no domain):** Skip CF Access. Tunnel URL is unguessable (UUID-based).
> Add Access policy when custom domain is set up.

---

## ComfyUI systemd service

Ensure ComfyUI starts automatically and binds only to localhost.

```bash
# /etc/systemd/system/comfyui.service
sudo tee /etc/systemd/system/comfyui.service << 'EOF'
[Unit]
Description=ComfyUI
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/root/ComfyUI
ExecStart=/root/miniconda3/envs/comfyui/bin/python main.py \
  --listen 127.0.0.1 \
  --port 8000 \
  --disable-auto-launch \
  --output-directory /root/ComfyUI/output
Restart=on-failure
RestartSec=5s
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable comfyui
sudo systemctl start comfyui
sudo systemctl status comfyui
```

> Adjust `WorkingDirectory` and `ExecStart` Python path to match your ComfyUI install.
> Check with: `which python` inside the conda env, or `ls /root/ComfyUI/`.

---

## Register worker in Redis (run from dispatcher/main VPS)

After tunnel is confirmed working:

```bash
# On main VPS where Redis runs, or via redis-cli:
redis-cli HSET worker:registry worker-a \
  '{"id":"worker-a","url":"https://TUNNEL-UUID.cfargotunnel.com","status":"IDLE","lastSeen":0}'

# Set initial health key (dispatcher health monitor will renew every 15s)
redis-cli SETEX worker:health:worker-a 30 1

# Verify
redis-cli HGETALL worker:registry
redis-cli GET worker:health:worker-a
```

---

## Smoke test from dispatcher host

```bash
# Replace URL and headers (skip CF-Access headers until Zero Trust is configured)
curl -s https://TUNNEL-UUID.cfargotunnel.com/system_stats | jq .

# With CF Access (after Zero Trust setup):
curl -s \
  -H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" \
  -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET" \
  https://worker-a.yourdomain.com/system_stats | jq .
```
