# 远程协助中继 —— VPS 部署指南

两条链路都要到公网，但只需要一台最低配 VPS（1 核 1G 足够）。

## 快速开始（有域名，推荐）

```bash
# 1. 克隆到 VPS
git clone https://github.com/你的仓库/remote-assist.git
cd remote-assist/deploy

# 2. 填环境变量
cp .env.example .env
# 编辑 .env：至少改 HEALTH_TOKEN，填你的域名到 Caddyfile.letsencrypt

# 3. 选配置
cp Caddyfile.letsencrypt Caddyfile
# 编辑 Caddyfile：把 example.com 换成你的域名

# 4. 起服务
docker compose up -d

# 5. 看日志
docker compose logs -f relay
docker compose logs -f caddy
```

控制端打开 `https://你的域名/` ，被控端填 `你的域名:8081`。

## 快速开始（无域名，自签证书）

```bash
cd remote-assist/deploy
cp .env.example .env
# 编辑 .env：至少改 HEALTH_TOKEN

bash self-signed.sh          # 生成证书 + 打印指纹
cp Caddyfile.selfsigned Caddyfile

docker compose up -d
```

控制端打开 `https://VPS_IP/`（浏览器会报证书警告，点继续）。
被控端填 `VPS_IP:8081`，TLS 打开，指纹框留空（第一次连自动 TOFU）。

## 防火墙

只放行 443（控制端）和 8081（被控端）。不需要任何入站 NAT 或端口映射。

```bash
# Ubuntu UFW
sudo ufw allow 443/tcp
sudo ufw allow 8081/tcp
```

## 安全加固（按推荐顺序）

| 层 | 怎么做 | 文件 |
|---|---|---|
| IP 白名单 | Caddyfile 里取消注释 `remote_ip` 行 | `Caddyfile` |
| 基本身份验证 | Caddyfile 里取消注释 `basicauth` 块 | `Caddyfile` |
| 速率限制 | Caddyfile 里取消注释 `rate_limit` 块 | `Caddyfile` |
| /health 令牌 | `.env` 里设 `HEALTH_TOKEN` | `.env` |
| 被控端端口白名单 | 防火墙只放行公司和家里的出口 IP | 防火墙规则 |

## 更新

```bash
cd remote-assist/deploy
docker compose down
cd .. && git pull
cd deploy
docker compose up -d --build
```

## 常见问题

**Q: 被控端连不上 8081**
- 检查防火墙是否放行 8081
- 检查 `.env` 里 `TLS_CERT` / `TLS_KEY` 是否给了（自签路径时）
- 检查 App 里是否勾了「加密连接」

**Q: 控制端页面打不开**
- 检查域名 DNS 是否指向 VPS
- 检查 Caddy 日志：`docker compose logs caddy`
- 检查 80 端口是否放行（Let's Encrypt 验证需要）

**Q: 想关掉 TLS（只在可信内网用）**
- 把 `.env` 里的 `TLS_CERT` / `TLS_KEY` 注释掉
- Caddy 那端也改成 `reverse_proxy relay:8080` 不用 tls 前缀
- **不建议在公网这么干**
