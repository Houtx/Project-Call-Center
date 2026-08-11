# Project Call Center

一个可自行部署的轻量级 SIM 外呼 CRM。管理员在 Web 端导入和分配客户，坐席通过 Android 手机领取任务并使用本机 SIM 卡拨号，系统自动回收通话时间、接通状态和通话时长。

> 项目面向企业内部合规外呼场景。它不是云呼叫中心，也不包含 SIP/VoIP、录音、自动连拨、语音识别或复杂销售漏斗。

## 项目能做什么

完整工作流如下：

```mermaid
flowchart LR
    A["管理员导入客户"] --> B["选择批次并分配坐席"]
    B --> C["Android APP 同步待呼任务"]
    C --> D["使用手机 SIM 卡拨号"]
    D --> E["APP 匹配系统通话记录"]
    E --> F["Web 端查看明细与统计"]
```

| 使用端 | 主要能力 |
| --- | --- |
| Web 管理端 | 客户和批次、Excel/CSV 导入、号码归属地、手工分配、坐席与设备、拒呼名单、通话明细、报表和审计 |
| Android 坐席端 | 服务器切换、账号登录、任务同步、号码查看、单卡/双卡拨号、未接通重试、本人通话历史和强制更新 |
| 服务端 | 号码加密、全局去重、单账号单设备、幂等回传、通话结果对账、分配历史和权限审计 |

## 技术栈

- Web：React、TypeScript、Ant Design、Vite
- API/Worker：NestJS、Prisma、Node.js
- 数据库：PostgreSQL 16
- Android：Kotlin、Jetpack Compose、Room、WorkManager
- 本地与生产：Docker Compose；生产入口使用 Nginx 和 HTTPS

## 快速开始

### 1. 准备环境

运行 Web 和 API 需要：

| 工具 | 要求 | 说明 |
| --- | --- | --- |
| Node.js | 22 或更高版本 | 自带 npm |
| Docker | Docker Desktop 或 Docker Engine | 必须支持 `docker compose` |
| Git | 当前稳定版 | 用于获取源码 |
| curl、lsof | macOS/Linux 一键脚本需要 | Windows 手工启动不需要 |

只有构建 Android APP 时才需要 JDK 17、Android SDK 35 和 Android 构建工具。

### 2. 获取代码并安装依赖

```bash
git clone https://github.com/Houtx/Project-Call-Center.git
cd Project-Call-Center
npm ci
```

### 3. 创建本地配置

macOS/Linux：

```bash
cp apps/api/.env.example apps/api/.env
```

Windows PowerShell：

```powershell
Copy-Item apps/api/.env.example apps/api/.env
```

打开 `apps/api/.env`，至少替换下面五项。不要继续使用文件中的 `replace-with-...` 占位值。

| 配置 | 要求 |
| --- | --- |
| `JWT_SECRET` | 至少 32 个随机字符 |
| `PHONE_ENCRYPTION_KEY` | 独立生成的 32 字节 Base64 密钥 |
| `PHONE_HASH_KEY` | 另一份独立生成的 32 字节 Base64 密钥 |
| `SEED_ADMIN_PASSWORD` | 本地管理员密码，至少 12 位 |
| `SEED_AGENT_PASSWORD` | 本地演示坐席密码，至少 12 位 |

可以使用以下命令生成前三个值：

```bash
openssl rand -hex 32
openssl rand -base64 32
openssl rand -base64 32
```

### 4. 初始化数据库

```bash
docker compose up -d postgres
npm run db:generate
npm run db:migrate
npm run db:seed
```

种子命令会创建管理员 `admin`、演示坐席 `agent001`/`agent002` 和少量匿名示例数据。登录密码就是你在 `apps/api/.env` 中设置的密码；修改环境变量不会自动修改已经写入数据库的账号密码。

### 5. 启动服务

macOS/Linux 推荐使用根目录的一键脚本：

```bash
./start-services.command
```

脚本会检查环境、启动 PostgreSQL、执行迁移、构建并启动 API/Worker/Web。重复执行不会重复启动已经由脚本管理的进程。

Windows 或希望手工控制进程时，先构建 API，然后分别打开三个终端：

```powershell
npm run build --workspace @call-center/api
```

```powershell
# 终端 1
npm run start:prod --workspace @call-center/api
```

```powershell
# 终端 2
npm run start:worker --workspace @call-center/api
```

```powershell
# 终端 3
npm run dev:web
```

启动成功后访问：

| 地址 | 用途 |
| --- | --- |
| `http://localhost:5173` | Web 管理端 |
| `http://localhost:8800/api/v1/health` | API 健康检查 |
| `http://localhost:8800/api/docs` | 开发环境 API 文档 |

管理员登录：`admin` + 你配置的 `SEED_ADMIN_PASSWORD`。

### 6. 停止服务

由一键脚本启动时：

```bash
./stop-services.command
```

脚本只停止本项目记录的 API、Worker、Web 和 PostgreSQL 容器，数据库卷与本地日志会保留。

手工启动时，在三个终端中按 `Ctrl+C`，然后执行：

```bash
docker compose stop postgres
```

## 常见问题

### 页面能打开，但无法登录

确认已经运行 `npm run db:seed`，并使用 `apps/api/.env` 中配置的管理员密码。种子密码必须至少 12 位。

### 一键脚本提示缺少 `.env`

从 `apps/api/.env.example` 创建 `apps/api/.env`，替换全部密钥和密码占位值后重新执行脚本。

### 端口被占用

默认端口为 Web `5173`、API `8800`、PostgreSQL `54329`。一键脚本不会强制关闭其他程序，会直接显示占用端口的进程。

### Docker 数据库无法启动

确认 Docker Desktop/Engine 正在运行，然后查看：

```bash
docker compose logs postgres
```

### 想清空本地测试数据

下面的命令会删除本项目的本地 PostgreSQL 数据卷，只能用于开发环境：

```bash
make db-reset
npm run db:migrate
npm run db:seed
```

## Android APP

### 支持范围

- Android 12（API 31）及以上
- 真机 SIM 外呼；模拟器只能验证界面和普通网络请求
- 单卡、双卡以及卡 1/卡 2/循环拨号策略
- Debug 构建允许局域网 HTTP；Release 构建只允许 HTTPS
- APP 需要电话、通话记录和电话状态权限

### 构建 Debug APK

```bash
cd apps/android
./gradlew test lintDebug assembleDebug
```

APK 输出位置：

```text
apps/android/app/build/outputs/apk/debug/app-debug.apk
```

Android 模拟器连接本机 API 时使用 `http://10.0.2.2:8800/api/v1/`。真机联调时，手机和电脑必须在同一局域网，并填写电脑的局域网地址，例如 `http://192.168.x.x:8800/api/v1/`。

Release APK 必须使用长期保管的正式签名证书，并显式配置 HTTPS 更新清单和 APK 下载地址。详细要求见 [Android 设备验证](docs/android-device-validation.md) 和 [开发指南](DEVELOPMENT_GUIDE.md)。

## 验证代码

```bash
npm run lint
npm test
npm run build
(cd apps/android && ./gradlew test lintDebug assembleDebug)
```

端到端脚本会向当前数据库写入验收数据，只能在隔离测试库执行：

```bash
ADMIN_PASSWORD='你的管理员密码' \
TEST_AGENT_PASSWORD='临时测试坐席密码' \
API_BASE_URL=http://127.0.0.1:8800/api/v1 \
./scripts/e2e-smoke.sh
```

## 项目结构

```text
apps/api/       NestJS API、Worker、Prisma 模型与迁移
apps/web/       React 管理后台
apps/android/   Android 坐席 APP
deploy/         生产 Compose、Nginx 示例与备份脚本
docs/           架构和设备验证文档
scripts/        端到端与容量测试脚本
```

## 生产部署

不要直接把开发配置用于生产。生产环境必须使用独立随机密钥、HTTPS、正式 Android 签名、数据库备份和严格的访问控制。共享服务器部署前还要检查端口、内存、磁盘、容器和现有 Nginx 站点。

具体步骤见 [运维指南](OPERATIONS_GUIDE.md) 和 [生产部署手册](deploy/README.md)。

## 数据与合规

- 手机号使用 AES-256-GCM 加密存储，并使用独立 HMAC 索引去重。
- 日志和审计只记录脱敏号码；查看完整号码会产生审计事件。
- APP 只上传由本 APP 发起且能匹配外呼尝试的通话记录。
- 拒呼名单会在导入、分配和拨号三个环节拦截。
- 使用者必须自行确认所在地关于外呼、个人信息和系统通话记录权限的法律要求。

请勿向公开 Issue、截图、测试库或示例文件上传真实客户号码、员工信息、服务器地址、密钥和业务数据。公开发布前请执行 [开源检查清单](OPEN_SOURCE_CHECKLIST.md)。

## 搜索关键词

中文关键词：外呼系统、电话外呼、手机外呼、SIM 卡外呼、安卓外呼 APP、呼叫中心、外呼 CRM、电话销售系统、客户资料管理、客户批次管理、客户分配、坐席外呼、通话记录、通话统计、接通率、双卡拨号、自动通话对账、自部署呼叫中心。

English keywords: outbound calling system, phone dialer, SIM outbound dialer, Android dialer, call center CRM, contact center, telephony CRM, customer assignment, lead distribution, call logs, call analytics, connection rate, dual SIM calling, self-hosted CRM.

## 更多文档

| 文档 | 内容 |
| --- | --- |
| [文档索引](DOCUMENTATION.md) | 按产品、开发、运维角色选择阅读路径 |
| [产品说明](PRODUCT_GUIDE.md) | 产品边界、业务状态和统计口径 |
| [用户手册](USER_GUIDE.md) | 管理员和坐席日常操作 |
| [开发指南](DEVELOPMENT_GUIDE.md) | API、数据库、Android 和测试细节 |
| [已知问题](KNOWN_ISSUES.md) | 当前限制与上线前阻断项 |

## 开源许可证

本项目使用 [GNU Affero General Public License v3.0](LICENSE)，对应 SPDX 标识为 `AGPL-3.0-only`。如果你修改本项目并通过网络向用户提供服务，需要按照该许可证向这些用户提供对应源码。
