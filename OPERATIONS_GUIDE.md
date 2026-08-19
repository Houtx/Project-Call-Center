# 生产运维与发布指南

> 适用代码基线：当前 `main` 源码。

## 当前生产状态

**生产环境由部署者自行评估。** 本仓库不包含任何真实主机、域名、端口盘点或容量测试记录。

本文档是后续运维基线，不是绕过容量门槛的授权。

## 上线门槛

### 硬件与容量

- 当前实现的保守建议仍是 2 vCPU、4 GiB 物理内存、至少 20 GiB 可用磁盘；共享主机能否部署必须以现有服务占用为准。
- 默认三个常驻容器的内存硬上限合计约 1.1 GiB：API `512m`、PostgreSQL `512m`、Web `64m`。上线前 `MemAvailable` 至少应有 1.5 GiB，并在压测时确认没有 OOM、swap 抖动或现有服务延迟上升。
- 生产默认 `IMPORT_MAX_ROWS=10000`。不要在 512 MiB API 限额下恢复 10 万行导入；如确有需要，应先改为后台分片任务并单独压测。
- 批量分配默认每次最多 10,000 条、候选扫描最多 100,000 条。超限时按批次或筛选条件拆分，不在低配服务器上直接放大阈值。
- 不启用录音时，初始建议预留 20 GiB。启用录音时按“每日录音数 × 平均文件大小 × 保留天数”另算容量；例如每天 1 万个 300 KiB 文件保留 30 天约需 86 GiB，低配本地盘不应直接开启。

本轮在本地 ARM64 Docker 空闲状态做过一次非压力采样：API 约 70 MiB、Web 约 15 MiB、本地 PostgreSQL 约 49 MiB；API 镜像解包层约 184 MiB、Web 镜像约 21 MiB。这些数字只证明镜像能在当前上限内启动，不代表生产峰值，也不能替代目标服务器的导入、分配、同步、报表和并发回传压测。

### 当前需要完成的工程门槛

1. 在 CI 或隔离构建机产出并验证 `linux/amd64` API/Web 镜像。开发 Mac 的 `arm64` 镜像不能直接用在 `x86_64` 生产主机。
2. 镜像使用不可变 tag 和 digest，不在小内存生产主机现场 `docker build`。
3. 在目标服务器验证 Compose 默认资源上限；资源上限已配置，但不能代替目标机压测。
4. 验证 API 健康响应中的后台任务最近完成时间与错误字段，并接入外部监控。
5. 为大导入单独评估 Nginx 超时；同步解析和提交仍可能超过默认代理超时。
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
7. 生产 `DATABASE_URL` 保留示例中的 `connection_limit=10&pool_timeout=10`；调整 PostgreSQL `max_connections` 时同时核算 API、可选 Worker、迁移任务和运维连接。

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
6. 启动 API 和 Web；后台对账默认内嵌在 API 中，不启动独立 Worker。
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
| API | `GET /api/v1/health` 必须返回 `status=ok`、`database=up`，且 `backgroundJobs.lastCycleCompletedAt` 持续更新 |
| Web | `/healthz` 返回 200 |
| PostgreSQL | `pg_isready` 成功，迁移表与业务表可读 |
| 后台任务 | 默认在 API 内运行；`enabled=true`、`running=true`、最近完成时间不超过 3 分钟且 `lastError` 为空 |
| Android | 心跳时间、版本、拨号权限、CallLog 权限和机型兼容状态 |

### 需要报警的指标

- 主机内存可用量、swap in/out、容器 OOM、CPU load、iowait、磁盘与 inode。
- API 5xx、P95/P99 延迟、登录失败、导入失败和 504。
- PostgreSQL 连接数、慢查询、数据库大小和备份新鲜度。
- `COLLECTING` 超期数、`UNKNOWN` 比例、回传延迟和设备权限失效。
- 5 分钟内采集率低于 99% 或某机型未知率超过 1% 时，立即暂停该机型外呼。
- 备份任务退出非零、对象存储中没有当日对象或恢复演练超期。

Docker `healthy` 不代表业务恢复。升级后还要验证管理员登录、客户查询、一次测试分配、移动 bootstrap/sync、后台对账新鲜度和报表刷新。

### 磁盘增长与自动清理

- Docker 容器日志默认每个容器最多约 30 MiB（`10m × 3`），可通过生产环境变量调整。
- 幂等记录过期后清理；过期 refresh token 和撤销超过 7 天的 token 会清理。
- 已完成、失败或取消的导入行明细默认保留 7 天，`import_jobs` 汇总与审计仍保留。
- 移动同步增量只有在超过保留期且活跃设备已确认游标后才清理；没有活跃设备的坐席不会被冒险清理。
- 客户、分配、通话、通话结果和审计属于业务记录，不自动删除。必须监控 PostgreSQL 数据库大小并建立经审批的归档策略。
- 录音按后台配置的保留天数删除文件，只保留元数据；删除任务每小时分批执行，不能替代磁盘告警。

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
- 记录数据库核心表行数、现有域名返回码、容器 ID/digest 和后台任务状态。

### 升级

1. 先执行迁移一次性容器。
2. 只重建本项目的 API 和 Web。
3. 验证回环健康，再验证 HTTPS 业务。
4. 重复上线前保存的所有现有站点回归。

### 代码回滚

将 `API_IMAGE` 和 `WEB_IMAGE` 改回上一个已验证 tag，然后只重建本项目应用容器：

```bash
docker compose --env-file deploy/.env.production -f deploy/compose.production.yaml \
  up -d --no-deps api web
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

启动检查遇到纯网络故障时，客户端最多使用 72 小时内的成功检查缓存；这不是发布回滚机制。清单无效、APK 校验失败、客户端低于曾发现的最高 `versionCode` 或缓存过期时仍会锁定。更新源应部署可用性监控，不能依赖该宽限期替代稳定托管。

如构建时配置 `CALL_CENTER_TELEMETRY_URL`，接收端必须只接受文档约定的匿名每日聚合、限制请求大小和频率，并配置明确的数据保留期。该功能默认关闭，用户拒绝后不得发送；接收端不得尝试用 IP、User-Agent 或其他字段还原客户、坐席或设备身份。

## 事故处理

| 事故 | 第一动作 | 验证 |
| --- | --- | --- |
| API 不可用 | 保存容器状态和日志，检查 DB 连接，不先重启整机 | `/api/v1/health`、管理员登录、客户查询 |
| 后台任务停止 | 保存 API 健康响应和日志，只重启本项目 API | 超时尝试转换、最近完成时间、错误字段 |
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
