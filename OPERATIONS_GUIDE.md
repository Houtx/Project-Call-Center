# 生产运维与发布指南

> 适用代码基线：当前 `main` 源码。

## 当前生产状态

**生产环境由部署者自行评估。** 本仓库不包含任何真实主机、域名、端口盘点或容量测试记录。

本文档是后续运维基线，不是绕过容量门槛的授权。

## 上线门槛

### 硬件与容量

- 当前实现的最低建议：2 vCPU、4 GiB 物理内存、至少 20 GiB 可用磁盘。
- 上线前主机 `MemAvailable` 应至少为 3 GiB。
- 如果频繁执行 10 万行导入，建议 8 GiB 内存，或先把导入改为流式/后台分批任务并重新压测。
- 长期保留通话、审计、同步和导入明细时，建议为项目预留 30 GiB 以上可扩展空间并设置容量报警。

### 当前需要完成的工程门槛

1. 在 CI 或隔离构建机产出并验证 `linux/amd64` API/Web 镜像。开发 Mac 的 `arm64` 镜像不能直接用在 `x86_64` 生产主机。
2. 镜像使用不可变 tag 和 digest，不在小内存生产主机现场 `docker build`。
3. 为 API、Worker、PostgreSQL 和 Web 设置经压测确认的内存/CPU/PID 限额与日志轮转。当前 [deploy/compose.production.yaml](deploy/compose.production.yaml) 还没有这些上限。
4. 为 Worker 补充可证明对账循环正常的健康/新鲜度指标，不只检查进程存活。
5. 为大导入单独评估 Nginx 超时。当前示例 `proxy_read_timeout=60s`，本机 10 万行提交已需 46 秒，生产机容易超时。
6. 固定所有生产基础镜像的可追溯版本或 digest，包括 PostgreSQL。

## 共享主机隔离约定

| 对象 | 约定 |
| --- | --- |
| 应用目录 | `/opt/project-call-center` |
| Compose 项目 | `project-call-center` |
| 独立网络 | `project-call-center-network` |
| PostgreSQL 数据卷 | `project-call-center-postgres-production` |
| API 端口 | `127.0.0.1:18800` |
| Web 端口 | `127.0.0.1:18801` |
| 候选域名 | `call.example.com` |
| Nginx | 独立 vhost；先 `nginx -t`，只 reload，不 restart |

不复用现有项目的数据库、用户、密钥、卷、网络、服务名、端口或 Nginx 文件。日常升级和回滚不使用 `docker compose down`，避免无必要中断数据库。

## 上线前只读盘点

必须先保存服务器时间、端口、进程、容器、数据卷、Nginx 虚拟主机、证书、磁盘、内存压力和已有服务健康基线：

```bash
date -Is
df -h
free -h
ss -lntup
docker ps --format '{{.Names}}\t{{.Image}}\t{{.Ports}}\t{{.Status}}'
docker network ls
docker volume ls
sudo nginx -T
systemctl --type=service --state=running
```

记录每个现有 Host 的源站与公网返回码，上线后用同样的请求回归。容量、端口或健康任一不满足时必须停止。

## 生产配置与密钥

1. 从 [deploy/.env.production.example](deploy/.env.production.example) 生成私有 `.env.production`。
2. 生产文件权限只授予专用运维账号，不提交 Git，不发送到群聊。
3. 分别生成 PostgreSQL 密码、JWT 密钥、电话加密密钥、电话 HMAC 密钥和初始管理员密码。
4. `PHONE_ENCRYPTION_KEY` 和 `PHONE_HASH_KEY` 是长期数据密钥。丢失前者无法解密历史号码，更换后者会破坏去重和精确查询。
5. 密钥必须在公司密码库中做离站备份，备份恢复演练要包含抽样号码解密。
6. `ADMIN_INITIAL_PASSWORD` 只在首次 `bootstrap-admin` 期间存在，创建成功后立即从生产环境文件删除。

建议命令：

```bash
openssl rand -hex 32
openssl rand -base64 32
openssl rand -base64 32
openssl rand -base64 36
```

## 镜像、Compose 与首次启动

详细命令以 [deploy/README.md](deploy/README.md) 为准。标准顺序：

1. 在隔离构建环境执行测试，构建 `linux/amd64` API/Web 镜像，记录 tag 和 digest。
2. 在主机上只创建 `/opt/project-call-center`，放入 Compose 和私有环境文件。
3. 解析配置与拉取镜像，不启动：

```bash
docker compose --env-file deploy/.env.production -f deploy/compose.production.yaml config --quiet
docker compose --env-file deploy/.env.production -f deploy/compose.production.yaml pull
```

4. 只启动 PostgreSQL，等待健康。
5. 执行 `migrate`，再执行一次性 `bootstrap-admin`。
6. 启动 API、Worker 和 Web，检查 Compose 状态、API 数据库健康和 Web `/healthz`。
7. 在任何 Nginx 修改前，先完成回环地址验证。

```bash
curl --fail --silent http://127.0.0.1:18800/api/v1/health
curl --fail --silent http://127.0.0.1:18801/healthz
```

## DNS、TLS 与 Nginx

- 生产 Android Release 只允许 HTTPS，因此必须有独立域名和有效证书。
- 在 DNS 中为自己的生产域名配置可验证的解析记录，再签发证书。
- 签发 Let's Encrypt 时先使用 DNS-only 或明确可验证的 ACME 流程，源站 HTTPS 通过后再开启 Cloudflare 代理。
- Cloudflare SSL 使用 `Full (strict)`，不使用 `Flexible`。
- Nginx 只新增专用 vhost，`/api/` 代理到 `127.0.0.1:18800`，其余路径代理到 `127.0.0.1:18801`。
- 每次修改先执行 `sudo nginx -t`，通过后只执行 `sudo systemctl reload nginx`。

## 健康、监控与报警

### 最低健康检查

| 对象 | 检查 |
| --- | --- |
| API | `GET /api/v1/health` 必须返回 `status=ok` 且 `database=up` |
| Web | `/healthz` 返回 200 |
| PostgreSQL | `pg_isready` 成功，迁移表与业务表可读 |
| Worker | 进程存活，且最近对账循环/待处理队列新鲜（需补充专用指标） |
| Android | 心跳时间、版本、拨号权限、CallLog 权限和机型兼容状态 |

### 需要报警的指标

- 主机内存可用量、swap in/out、容器 OOM、CPU load、iowait、磁盘与 inode。
- API 5xx、P95/P99 延迟、登录失败、导入失败和 504。
- PostgreSQL 连接数、慢查询、数据库大小和备份新鲜度。
- `COLLECTING` 超期数、`UNKNOWN` 比例、回传延迟和设备权限失效。
- 5 分钟内采集率低于 99% 或某机型未知率超过 1% 时，立即暂停该机型外呼。
- 备份任务退出非零、对象存储中没有当日对象或恢复演练超期。

Docker `healthy` 不代表业务恢复。升级后还要验证管理员登录、客户查询、一次测试分配、移动 bootstrap/sync、Worker 对账和报表刷新。

## 备份与恢复

[deploy/backup-postgres.sh](deploy/backup-postgres.sh) 使用 `pg_dump` 生成 custom dump，在客户端用 `age` 加密，再上传 S3 兼容对象存储。

生产要求：

1. 每日至少一次离站加密备份；同一台主机上的副本不算灾备。
2. `age` 私钥不保存在应用主机，S3 凭据使用最小权限。
3. 对象存储策略负责保留期、版本化和防删除，备份脚本不承担保留策略。
4. 上传 dump 和 `.sha256` 校验文件，监控任务退出码和实际对象存在。
5. 至少每季度在独立恢复环境执行一次恢复演练。

恢复验收必须包含：

- checksum 校验和 `age` 解密成功。
- `pg_restore --exit-on-error --no-owner --no-acl` 恢复到全新数据库。
- 核对 users/customers/assignments/call_attempts/call_results/audit_events 行数。
- 管理员登录、报表查询和抽样号码解密。
- 记录 RPO、RTO、演练时间、问题和修复责任人。

## 应用升级与回滚

### 升级前

- 确认不可变镜像 tag/digest 和上一版本可用。
- 完成并验证离站备份。
- 审查 Prisma migration 是否兼容回滚。
- 记录数据库核心表行数、现有域名返回码、容器 ID/digest 和 Worker 状态。

### 升级

1. 先执行迁移一次性容器。
2. 只重建本项目的 API、Worker 和 Web。
3. 验证回环健康，再验证 HTTPS 业务。
4. 重复上线前保存的所有现有站点回归。

### 代码回滚

将 `API_IMAGE` 和 `WEB_IMAGE` 改回上一个已验证 tag，然后只重建本项目应用容器：

```bash
docker compose --env-file deploy/.env.production -f deploy/compose.production.yaml \
  up -d --no-deps api worker web
```

数据库不自动 down migration。如新代码已写入不兼容数据，必须使用事先审核的数据修复或备份恢复方案，不临时删列/删表。

## Android APK 发布与强制升级

### 发布资产

独立 APK Release 仓库只用于发布资产，不放业务源码、生产配置或客户数据。每个版本至少包含：

- 正式签名 APK
- `update-manifest.json`
- `SHA256SUMS.txt`

清单中的 `versionCode`、`versionName`、tag、包名、APK 文件名、文件大小和 SHA-256 必须与真实资产完全一致。所有后续 APK 必须沿用同一个签名证书，并对 keystore 做加密离站备份。

### 发布验收

1. 在干净环境构建 Release，通过单测、lint、APK 包名/版本/签名验证。
2. 上传资产后，通过 `releases/latest/download/update-manifest.json` 获取清单，再从公开 URL 重新下载 APK 校验 SHA-256。
3. 在真机用上一版本验证检查、下载、未知来源授权、系统安装器和更新后登录。
4. 更新 Web 中的最低/最新 `versionCode` 和 HTTPS 下载地址。当前“强制升级”是全局锁定开关，会阻止包括最新版在内的所有设备；常规发布使用最低版本号门槛并保持该开关关闭。
5. 保留上一个可用 APK，但不允许用降低版本号的 APK 直接覆盖安装。

## 事故处理

| 事故 | 第一动作 | 验证 |
| --- | --- | --- |
| API 不可用 | 保存容器状态和日志，检查 DB 连接，不先重启整机 | `/api/v1/health`、管理员登录、客户查询 |
| Worker 停止 | 保留错误日志，只重启 Worker | 超时尝试转换、队列新鲜度 |
| PostgreSQL 异常 | 停止写入风险操作，保存日志/磁盘现状 | `pg_isready`、行数、抽样解密、备份新鲜度 |
| 主机内存压力 | 暂停大导入，查看 cgroup 和 swap，不终止无关项目 | 现有站点和本项目同时恢复 |
| 未知率升高 | 暂停问题机型白名单 | 真机 CallLog、权限、系统版本、采集时延 |
| APK 更新失败 | 停止调高最低版本，验证公开清单和 APK | URL、大小、SHA-256、包名、签名、真机安装 |
| Nginx/TLS 异常 | 恢复本项目 vhost 上一版，先 `nginx -t` 后 reload | 新站、全部旧 Host、证书链 |

事故中不删除数据卷、不执行 `docker system prune -a`、不使用 `git reset --hard`、不重启无关项目。

## 正式开放前验收

- Web 管理员登录、客户新增/导入、分配、回收、拒呼、导出和审计端到端通过。
- APP 回到前台 5 秒内可看到新分配。
- 个人通话与其他应用发起的通话零上传。
- 报表在结果回传后 1 分钟内可查。
- 每个白名单机型完成接通、零秒、取消、断网、杀进程、重启、权限撤销、时钟偏差和同号连续拨打测试。
- 5-10 人试运行至少 7 天，5 分钟采集率不低于 99%，未知率低于 1%。
- 验证每日离站备份、告警通知和一次独立恢复演练。
- 共享主机的所有现有域名在上线前后返回一致。
