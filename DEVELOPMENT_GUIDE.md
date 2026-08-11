# 开发与测试指南

> 适用代码基线：当前 `main` 源码。

## 技术栈

| 层 | 技术 | 说明 |
| --- | --- | --- |
| Web | React + TypeScript + Vite + Ant Design | 只有管理员后台，开发端口 5173 |
| API | NestJS 11 + TypeScript | 模块化单体，全局前缀 `/api/v1` |
| ORM/DB | Prisma 6 + PostgreSQL 16 | 迁移是数据库结构的唯一来源 |
| Worker | Nest application context | 每 60 秒处理超时外呼和清理任务 |
| Android | Kotlin + Jetpack Compose + Room + WorkManager | Android 12/API 31 及以上 |
| 部署 | Docker Compose + Nginx + S3 兼容存储 | 不使用微服务、Kafka 或 Elasticsearch |

## 仓库结构

```text
apps/api/       NestJS 接口、Worker、Prisma schema/migrations
apps/web/       React 管理后台
apps/android/   Kotlin 坐席 APP
deploy/         生产 Compose、Nginx 模板、备份脚本、上线手册
docs/           架构和 Android 真机验收细则
examples/       客户导入模板
scripts/        端到端和导入压测脚本
```

## 环境要求

- Node.js 22+
- npm 与根目录 `package-lock.json`
- Docker Engine/Desktop，用于本地 PostgreSQL
- JDK 17、Android SDK 35、Android 构建工具
- `curl` 、`jq`；导入压测还需 `awk`
- 建议使用 Git hooks 或 CI 执行 `git diff --check`、测试和构建

## 本地启动

### 一键启动与关闭

macOS 可在 Finder 中双击根目录的 `start-services.command`，也可在终端运行：

```bash
./start-services.command
```

脚本统一管理本项目 PostgreSQL、API、Worker 和 Web。运行时 PID 位于 `.local-data/runtime/`，日志位于 `.local-data/logs/`。API、Worker 和 Web 使用 `nohup` 与启动脚本分离，因此关闭启动脚本或 Terminal 窗口不会带停服务。脚本会应用已有 Prisma 迁移，但不会自动执行 `db:seed`。端口被未登记进程占用时会停止启动并显示占用者，不会自动杀死其他进程。

关闭时双击 `stop-services.command`，或执行：

```bash
./stop-services.command
```

关闭顺序为 Web、API、Worker、PostgreSQL；数据库容器与 `project-call-center-postgres` 数据卷不会删除。脚本启动失败时会回滚本次新启动的进程，不影响启动前已经运行的本项目服务。

### 手工启动

#### 1. 安装依赖与配置

```bash
npm install
cp .env.example apps/api/.env
```

开发密钥只用于本机，不要复用生产密钥：

```bash
openssl rand -hex 32       # JWT_SECRET
openssl rand -base64 32    # PHONE_ENCRYPTION_KEY
openssl rand -base64 32    # PHONE_HASH_KEY
```

#### 2. 启动 PostgreSQL 与迁移

```bash
docker compose up -d postgres
npm run db:generate
npm run db:migrate
export SEED_ADMIN_PASSWORD='set-a-local-admin-password'
export SEED_AGENT_PASSWORD='set-a-local-agent-password'
npm run db:seed
```

本地数据库映射为 `127.0.0.1:54329`。`db:seed` 仅用于开发或隔离测试，会创建示例管理员和坐席。生产不得执行种子命令。

#### 3. 启动 API、Worker 和 Web

分别开三个终端：

```bash
npm run dev:api
npm run start:worker --workspace @call-center/api
npm run dev:web
```

| 地址 | 用途 |
| --- | --- |
| `http://localhost:5173` | Web 管理端 |
| `http://localhost:8800/api/v1/health` | API 健康 |
| `http://localhost:8800/api/docs` | 非生产 Swagger UI |
| `http://localhost:5173/api/*` | Vite 代理到 API |

## 环境变量

### API

| 变量 | 用途 | 要求 |
| --- | --- | --- |
| `NODE_ENV` | 运行模式 | 生产必须为 `production` |
| `API_PORT` | API 内部端口 | 默认 8800 |
| `WEB_ORIGIN` | CORS 允许的 Web 源 | 生产填完整 HTTPS 域名，多域名用逗号分隔 |
| `DATABASE_URL` | Prisma 数据库连接 | 不包含默认开发密码 |
| `JWT_SECRET` | Access/refresh token 签名 | 至少 32 位随机值 |
| `JWT_ACCESS_TTL` | Access token 有效期 | 默认 15m |
| `JWT_REFRESH_DAYS` | Refresh token 有效天数 | 默认 30 |
| `PHONE_ENCRYPTION_KEY` | 号码 AES 加密密钥 | 生产创建后不得随意更改，需离站备份 |
| `PHONE_HASH_KEY` | 号码去重/查询 HMAC 密钥 | 不得更换，否则无法匹配旧号码 |
| `ADMIN_INITIAL_PASSWORD` | 首个管理员密码 | 仅临时用于 `bootstrap-admin`，成功后删除 |

### Web

| 变量 | 用途 |
| --- | --- |
| `VITE_API_BASE_URL` | 构建时 API 前缀，生产 Compose 使用 `/api/v1` |
| `VITE_API_PROXY_TARGET` | Vite 开发代理目标，默认 `http://localhost:8800` |

### Android 构建参数

| 参数 | 用途 |
| --- | --- |
| `CALL_CENTER_API_URL` | 可选的默认服务器建议值，Release 只允许 HTTPS |
| `CALL_CENTER_UPDATE_MANIFEST_URL` | 更新清单 URL；Release 构建必填，必须 HTTPS |
| `CALL_CENTER_UPDATE_RELEASES_BASE_URL` | APK 资产下载基地址；Release 构建必填，必须 HTTPS 且以 `/` 结尾 |
| `CALL_CENTER_DEBUG_AGENT_USERNAME` / `CALL_CENTER_DEBUG_AGENT_PASSWORD` | 可选 Debug 登录预填值，只能在本机环境或 CI 注入 |
| `CALL_CENTER_KEYSTORE_FILE` | Release 签名 keystore 路径 |
| `CALL_CENTER_KEYSTORE_PASSWORD` | keystore 密码，只从密码管理器或 CI 注入 |
| `CALL_CENTER_KEY_ALIAS` / `CALL_CENTER_KEY_PASSWORD` | 签名 alias 和 key 密码 |

## 常用命令

| 目的 | 命令 |
| --- | --- |
| 代码风格检查 | `npm run lint` |
| API + Web 单测 | `npm test` |
| API/Web 生产构建 | `npm run build` |
| Prisma 客户端 | `npm run db:generate` |
| 执行当前迁移 | `npm run db:migrate` |
| 重置本地数据库 | `make db-reset` |
| 本地端到端验收 | `ADMIN_PASSWORD='...' TEST_AGENT_PASSWORD='...' API_BASE_URL=http://127.0.0.1:8800/api/v1 ./scripts/e2e-smoke.sh` |
| Android 单元测试 | `(cd apps/android && ./gradlew test)` |
| Android Debug APK | `(cd apps/android && ./gradlew assembleDebug)` |
| Android Debug lint | `(cd apps/android && ./gradlew lintDebug)` |

`e2e-smoke.sh` 会在当前数据库中创建验收数据，只能在独立测试库执行。`import-load-test.sh` 会持久写入指定数量客户，必须显式设置 `IMPORT_LOAD_TEST_CONFIRM` 后才会运行：

```bash
ADMIN_PASSWORD='...' IMPORT_COUNT=100000 IMPORT_LOAD_TEST_CONFIRM=100000 ./scripts/import-load-test.sh
```

## 数据库与迁移

- Schema：`apps/api/prisma/schema.prisma`
- 迁移：`apps/api/prisma/migrations/`
- 开发迁移：`npm run db:migrate:dev --workspace @call-center/api`
- 生产迁移：只用 `prisma migrate deploy`，不用 `migrate reset`。
- 迁移前必须完成数据库备份；不自动生成破坏性 down migration。
- 任何新字段都要同时更新 DTO、服务、前端类型、单测和运维文档。

## API 模块与路由空间

除健康检查外，路由默认需要 JWT 和角色权限：

| 模块 | 路由范围 | 用途 |
| --- | --- | --- |
| Auth | `/auth/*` | 登录、刷新、退出、修改密码 |
| Customers/Batches | `/customers*` 、`/batches*` | 客户、号段归属、批次 |
| Imports | `/customers/import/*` | 预览、提交、导出 |
| Assignments | `/assignments*` | 分配、回收、改派 |
| Users/Devices | `/agents*` 、`/devices*` 、`/device-models*` | 坐席、设备、机型和 APP 版本策略 |
| Suppression | `/suppression*` | 拒呼名单 |
| Mobile | `/mobile/*` | 同步、拨号尝试、CallLog 回传、心跳；设备信息在 `/auth/login` 中登记 |
| Reports | `/dashboard/stats`、`/reports/summary`、`/calls*`、`/audit-events` | 工作台、通话和审计查询 |

非生产模式下可以打开 `/api/docs` 查看 Swagger。生产不应暴露 Swagger。所有可重放写请求都应使用 `Idempotency-Key`，并在服务端使用与业务对象匹配的唯一键。

## 开发约定

1. 所有时间在数据库中按 UTC 保存，界面按 `Asia/Shanghai` 显示。
2. 完整号码不进入普通日志、审计 metadata、幂等性回复或导出之外的返回。
3. 新增和更新要遵守乐观并发版本校验；客户编辑使用 `version` 防止覆盖他人修改。
4. 服务端拒呼、分配归属、设备状态和重拨规则是最终约束，不能只在前端做隐藏。
5. 手机 APP 上传数据必须同时匹配 `attemptId`、设备和服务器账号，不接受个人通讯录。

## 发布前必做

- 本地 `npm run lint && npm test && npm run build`。
- Android `./gradlew test lintDebug assembleDebug`；Release 另需正式签名。
- 检查 Prisma migration、空数据库部署、管理员 bootstrap 和 `e2e-smoke.sh`。
- 新 APK 必须使用同一个正式证书，更新 `update-manifest.json`、APK 文件名、SHA-256、`versionCode` 和 `versionName`。
- 发布后在实机上测试更新门禁、服务器切换、权限撤销、CallLog 迟到和杀进程恢复。
