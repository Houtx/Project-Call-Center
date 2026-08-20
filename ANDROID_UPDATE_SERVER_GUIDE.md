# Android 更新服务运维指南

## 生产地址与用途

- 更新清单：`https://call.haoyunqiankun.com/release.json`
- APK 基地址：`https://call.haoyunqiankun.com/releases/`
- 健康检查：`https://call.haoyunqiankun.com/healthz`
- 服务器静态目录：`/opt/project-call-center-update/public`
- Nginx 配置模板：[deploy/nginx-android-update.conf](deploy/nginx-android-update.conf)

此服务只通过 Nginx 提供静态 `release.json` 和已签名 APK，不运行 Node、Java、数据库或常驻容器。它适合与其他服务共享低配服务器，但仍需监控磁盘、Nginx 和证书续期。

仓库是公开的，因此本文档不记录服务器 IP、SSH 用户、私钥路径、Cloudflare 凭据或签名密码。实际连接信息只保存在受控运维环境中。

## 目录和缓存规则

```text
/opt/project-call-center-update/public/
├── release.json
└── releases/
    └── v0.6.4/
        └── project-call-center-agent-v0.6.4.apk
```

- `release.json` 禁止缓存，发布时最后原子替换。
- 带版本号的 APK 地址长期缓存且不可修改；发现构建错误时必须提升版本，不能覆盖同名资产。
- 旧版 APK 至少保留到确认不再有客户端使用，不能只保留最新版。
- 根路径和目录列表不公开，只有清单、APK 和健康检查可访问。

## 首次部署

1. 确认域名已经解析到目标服务器，并记录所有现有站点的公网和源站状态。
2. 只读检查 `free -h`、`df -h`、`ss -lntup`、现有 Nginx vhost 和证书。
3. 创建独立静态目录，不复用其他项目目录。
4. 使用 Certbot 为 `call.haoyunqiankun.com` 签发证书，ACME webroot 固定为 `/var/www/certbot`。
5. 安装 `deploy/nginx-android-update.conf` 为独立 vhost。
6. 必须先执行 `sudo nginx -t`；通过后只执行 `sudo systemctl reload nginx`，禁止重启整台服务器或其他项目。
7. 检查 `/healthz`、清单、APK、TLS 证书，并重复验证所有既有站点。

## 每次发布 APK 的强制流程

每个 Android Release 必须同时同步到本更新服务和 GitHub Release。漏掉更新服务器会导致国内客户端无法升级；漏掉 GitHub Release 会失去公开下载和备用分发入口。

1. 提升 `versionCode` 和 `versionName`，使用长期不变的正式证书构建 APK。
2. 构建时固定更新地址：

```bash
CALL_CENTER_UPDATE_MANIFEST_URL=https://call.haoyunqiankun.com/release.json
CALL_CENTER_UPDATE_RELEASES_BASE_URL=https://call.haoyunqiankun.com/releases/
```

3. 生成 `release-assets/release.json`，核对版本、包名、文件名、大小和 SHA-256。
4. 先同步更新服务器并完成公网复验：

```bash
UPDATE_SERVER_SSH='受控运维账号@服务器' \
UPDATE_SERVER_IDENTITY_FILE='/本机私钥绝对路径' \
./scripts/publish-android-update-server.sh \
  release-assets/release.json \
  release-assets/project-call-center-agent-vX.Y.Z.apk
```

5. 使用完全相同的 APK 和 `release.json` 创建 GitHub Release。
6. 从更新服务器和 GitHub 各下载一次 APK，核对 SHA-256、大小、包名、版本号和签名。
7. 使用上一版本真机验证自动检查、下载、系统安装和更新后离线数据仍可解锁。

同步脚本会拒绝哈希或大小不匹配的文件，也会拒绝用不同内容覆盖已经存在的同版本 APK。只有 APK 安装完成后才会替换根清单。

## 回滚与故障处理

- 新版有问题时，不覆盖 APK。将服务器根 `release.json` 原子恢复为上一个已验证清单，并暂停提高服务端最低版本号。
- 如果只是 GitHub 无法访问但更新域名正常，不影响已经切换到生产更新源的客户端。
- 如果更新域名不可用，先检查 Cloudflare、源站 `/healthz`、证书和 Nginx 错误日志；不要重启无关服务。
- Nginx 配置异常时恢复 `/etc/nginx/sites-available/call-update` 的上一版，执行 `nginx -t` 后 reload。
- Certbot 续期使用 `/var/www/certbot`。定期执行 `sudo certbot renew --dry-run`，并监控证书到期时间。

## 最低监控

- 每分钟请求 `/healthz` 和 `/release.json`，要求 HTTPS 200。
- 校验清单 JSON 可解析，APK URL 可访问，返回大小和 SHA-256 与清单一致。
- 监控证书剩余天数、Nginx 5xx、磁盘空间和 inode。
- 更新失败时保留客户端显示的错误、APP 版本、Android 版本和发生时间，不收集客户号码或通话数据。

## 2026-08-20 部署记录

- 目标主机为共享低配服务器：2 vCPU、约 1.9 GiB 内存，部署时约 1.3 GiB `MemAvailable`，根盘约 36 GiB 可用。
- 因完整 CRM 常驻资源门槛不满足，本次只部署无常驻进程的 Nginx 静态更新服务。
- `call.haoyunqiankun.com` 已启用独立 Nginx vhost 和 Let's Encrypt 证书，证书由 Certbot 定时任务自动续期；首次部署已完成 `certbot renew --dry-run` 演练。
- 首次上线已同步 `v0.6.3`，公网清单与 APK 的大小、SHA-256 校验一致。
- 上线前后既有站点的公网和源站 HTTP 状态保持一致；部署过程只执行 Nginx 配置检查和 reload，没有重启其他服务。
