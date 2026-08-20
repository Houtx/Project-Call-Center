# Project Call Center 文档索引

## 项目状态

- 定位：单公司、轻量级 SIM 外呼 CRM。
- 当前版本：源码中的 Android 候选版本为 `0.6.0 (6)`；已发布版本以 Git 标签和 Android Release 清单为准。
- 生产状态：本仓库不包含任何生产环境记录；上线前必须在目标环境重新完成容量评估。
- 数据范围：不迁移旧系统一年历史数据，不包含旧系统源码、品牌或专有素材。

## 按角色阅读

| 读者 | 先看 | 之后参考 |
| --- | --- | --- |
| 业务负责人 | [PRODUCT_GUIDE.md](PRODUCT_GUIDE.md) | [USER_GUIDE.md](USER_GUIDE.md) |
| 管理员 | [USER_GUIDE.md](USER_GUIDE.md) | [OPERATIONS_GUIDE.md](OPERATIONS_GUIDE.md) |
| 坐席培训人员 | [USER_GUIDE.md](USER_GUIDE.md) 的 Android 部分 | [docs/android-device-validation.md](docs/android-device-validation.md) |
| 后端/前端开发者 | [DEVELOPMENT_GUIDE.md](DEVELOPMENT_GUIDE.md) | [docs/architecture.md](docs/architecture.md) |
| 发布/运维人员 | [OPERATIONS_GUIDE.md](OPERATIONS_GUIDE.md) | [deploy/README.md](deploy/README.md) |

## 文档清单

### 业务与产品

- [PRODUCT_GUIDE.md](PRODUCT_GUIDE.md)：产品范围、角色、数据流、状态机、报表口径和合规边界。
- [USER_GUIDE.md](USER_GUIDE.md)：Web 管理员和 Android 坐席的日常操作步骤与故障排查。
- [PRIVACY.md](PRIVACY.md)：在线与本机独立模式的数据边界、权限和可选匿名统计。

### 开发与架构

- [DEVELOPMENT_GUIDE.md](DEVELOPMENT_GUIDE.md)：环境、目录、命令、测试、数据库迁移、Android 构建和发布流程。
- [KNOWN_ISSUES.md](KNOWN_ISSUES.md)：当前生产阻断、性能、Android 和 Web 限制以及安全的运维方法。
- [docs/architecture.md](docs/architecture.md)：信任边界、组件职责、通话状态和数据保护原则。
- [apps/api/README.md](apps/api/README.md)：API 模块、路由概览和业务不变式。

### 生产与恢复

- [OPERATIONS_GUIDE.md](OPERATIONS_GUIDE.md)：上线准入、密钥、备份、监控、升级、回滚和事故处理。
- [deploy/README.md](deploy/README.md)：实际 Compose/Nginx 上线和恢复命令，只能在容量门槛满足后使用。
- [docs/android-device-validation.md](docs/android-device-validation.md)：Android 机型白名单和真机试运行验收。
- [OPEN_SOURCE_CHECKLIST.md](OPEN_SOURCE_CHECKLIST.md)：公开发布前的敏感信息和 Git 历史检查。

## 一页架构

```text
Web 管理端 ───────────┐
                                      ├── API (NestJS) ── PostgreSQL
Android 坐席 APP ── HTTPS ───────────┘          └── Worker
       └── 系统拨号器 / CallLog

Android 本机独立模式 ── 独立加密 Room 数据库
       └── 系统拨号器 / CallLog（不连接 CRM API）

生产备份：PostgreSQL ─ age 加密 ─ S3 兼容对象存储（离站）
```

在线模式下 API 是业务真相，每次拨号前都需服务端重新校验分配、设备、拒呼、重拨间隔和次数。本机独立模式使用另一套数据库和本地状态机，不同步在线客户、拒呼规则或通话记录。

## 文档维护规则

1. 任何 API 、数据库、安卓版本策略或部署约定变更时，同一个变更中更新对应文档。
2. 文档中不写入真实密码、JWT、电话号加密密钥、签名密钥密码或 S3 凭据。
3. 实测数据、生产地址、设备标识和验收结果保存在私有记录中；公开文档只保留可复现的方法和匿名化结论。
4. 上线前以生产盘点、健康检查和现有域名回归为准，不以 Docker `healthy` 单独作为业务恢复证据。
