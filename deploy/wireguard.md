# Cinderella admin access over WireGuard (Addendum 3)

The admin console is reachable **only over a WireGuard tunnel** — no public HTTP(S)
exposure. This supersedes Addendum 2's public nginx + Let's Encrypt vhost.

**Placeholders only in this file.** Real keys, preshared keys, and the VPS public
IP are never committed — they live only on the VPS (`/etc/wireguard/`, `0600`)
and in the peer configs handed to the operator.

## Final network surface

- WireGuard: `wg0` at `10.8.0.1/24`, listening `UDP 51820` (the only new inbound
  port). No host-wide firewall on this shared VPS (other services legitimately use
  many ports) — Cinderella is scoped at the bind level instead.
- Admin nginx vhost binds `10.8.0.1:9443` (WG interface only) → Fastify
  `127.0.0.1:8787`. PostgreSQL stays `127.0.0.1:5432`.
- Public `80/443` are untouched (reserved for the future public embed front).
- Verified: the console does **not** respond on the public IP.

## Server (VPS)

```bash
apt-get install -y wireguard qrencode
umask 077
install -d -m 0700 /etc/wireguard/clients
wg genkey | tee /etc/wireguard/server_private.key | wg pubkey > /etc/wireguard/server_public.key
# Allow nginx to bind the WG IP even before wg0 is up (do NOT couple nginx to wg0):
echo 'net.ipv4.ip_nonlocal_bind = 1' > /etc/sysctl.d/99-cinderella-wg.conf && sysctl -p /etc/sysctl.d/99-cinderella-wg.conf
```

`/etc/wireguard/wg0.conf` (server, `0600`):

```ini
[Interface]
Address = 10.8.0.1/24
ListenPort = 51820
PrivateKey = <SERVER_PRIVATE_KEY>

[Peer]                                  # desktop
PublicKey = <DESKTOP_PUBLIC_KEY>
PresharedKey = <DESKTOP_PSK>
AllowedIPs = 10.8.0.2/32

[Peer]                                  # phone
PublicKey = <PHONE_PUBLIC_KEY>
PresharedKey = <PHONE_PSK>
AllowedIPs = 10.8.0.3/32
```

```bash
systemctl enable --now wg-quick@wg0
wg show
```

## Peer configs (operator devices)

Each peer: `wg genkey`/`wg pubkey` + `wg genpsk`, a unique `10.8.0.x/32` address.
Ideally generate the private key on the device itself; for a solo operator it is
acceptable to generate on the VPS and hand the config over securely — **never
commit a peer private key.** Server-side copies live in
`/etc/wireguard/clients/*.{priv,psk,conf}` (`0600`); delete them after import if
you don't want them retained.

Client config template (`AllowedIPs = 10.8.0.1/32` = split tunnel, only the VPS
console routes through WireGuard; `PersistentKeepalive` keeps the CGNAT mapping
alive on Starlink):

```ini
[Interface]
PrivateKey = <CLIENT_PRIVATE_KEY>
Address = 10.8.0.2/32

[Peer]
PublicKey = <SERVER_PUBLIC_KEY>
PresharedKey = <CLIENT_PSK>
Endpoint = <VPS_PUBLIC_IP>:51820
AllowedIPs = 10.8.0.1/32
PersistentKeepalive = 25
```

Phone import via QR: `qrencode -t ansiutf8 < /etc/wireguard/clients/phone.conf`.

## TLS on the tunnel (the Secure-cookie gotcha)

The session cookie is `Secure`, so the browser only sends it over HTTPS — plain
HTTP over the tunnel would break login. Terminate TLS at nginx:

- **Deployed now — self-signed** with an IP SAN for `10.8.0.1`:
  ```bash
  install -d -m 0755 /etc/cinderella/tls
  openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
    -keyout /etc/cinderella/tls/key.pem -out /etc/cinderella/tls/cert.pem \
    -subj "/CN=cinderella.wg" -addext "subjectAltName=IP:10.8.0.1,DNS:cinderella.wg"
  chmod 600 /etc/cinderella/tls/key.pem
  ```
  Browse `https://10.8.0.1:9443` — one-time browser trust prompt, then the
  `Secure` cookie works.
- **Upgrade — real cert via DNS-01** (no browser warning): create a public DNS
  A-record for a hostname pointing at the private `10.8.0.1` (harmless — the host
  is unreachable without the tunnel), then `certbot certonly --dns-<provider>`
  with the provider's API token, and point `ssl_certificate*` at the issued cert.

## nginx vhost

See [deploy/nginx-admin.conf](nginx-admin.conf). Install:

```bash
cp deploy/nginx-admin.conf /etc/nginx/sites-available/cinderella-admin
ln -sf ../sites-available/cinderella-admin /etc/nginx/sites-enabled/cinderella-admin
nginx -t && systemctl reload nginx      # reload, never restart (don't disrupt neighbours)
```

## Connect

Bring up the tunnel on your device, then open `https://10.8.0.1:9443` and log in
as `operator`.
