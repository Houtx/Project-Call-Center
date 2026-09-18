# 匿名使用统计服务

该服务使用 Python 标准库和 SQLite，为低配服务器提供 Android 匿名按日汇总接收、管理员登录、设备地理分布地图、宏观统计面板和终端公告发布。

管理员地图接口为 `GET /admin/api/map?days=30&zoom=8&bbox=west,south,east,north`，仅接受有效管理会话。所选时段内每台设备只使用最近一次位置；缩放级别低于 13 时由服务端按 Web Mercator 屏幕网格聚合，更高级别返回匿名设备点。地图支持活跃终端数、外呼量、接通量、接通率和通话时长等指标切换，位置明细与活跃明细使用相同保留期。

管理员可在面板发布、编辑和删除标题不超过 80 字、正文不超过 2,000 字的公告。最新公告通过公开只读接口 `/api/app/v1/announcement/latest` 提供给 APP；没有公告时返回 `204`。发布新公告会将上一条公告转为历史；编辑当前公告会增加修订号，使已读终端在下次冷启动重新显示；删除当前公告后不会自动恢复历史公告。所有管理写接口均要求管理员会话及 CSRF 校验。

服务启动时会自动兼容迁移旧版公告表，保留既有公告和统计数据。升级前仍应使用 SQLite 在线备份接口备份生产数据库；不要直接复制正在写入的数据库文件。

`TELEMETRY_ADMIN_PASSWORD_HASH` 只在数据库首次初始化时写入管理员密码。管理员可在统计面板中修改密码；新哈希和会话版本保存在 SQLite，修改后其他已登录会话立即失效，后续重启不会被环境变量中的初始哈希覆盖。

管理端从同域 `/release.json` 读取最新 Android 版本，并生成直接下载链接和二维码。二维码生成使用随服务托管的 `qrcode-generator 2.0.4`（Kazuhiko Arase，MIT License），不会调用第三方二维码接口；完整许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

地图组件使用随服务托管的 `Leaflet 1.9.4`，默认使用高德地图 HTTPS 标准图瓦片。Android 上报和服务端存储保持 WGS-84 原始坐标，Web 端绘制高德地图时转换为 GCJ-02，地图视口查询则反向转换为 WGS-84。可通过 `TELEMETRY_MAP_TILE_URL` 和 `TELEMETRY_MAP_ATTRIBUTION` 切换瓦片服务；如切换为 WGS-84 瓦片，应同时调整 Web 端坐标转换策略。浏览器会直接请求该瓦片服务，部署方应根据网络边界和供应商条款选择地址。

本地校验：

```bash
(cd services/telemetry && python3 -m unittest -v test_telemetry_server.py)
node services/telemetry/test_dashboard.mjs
```

详细部署、隐私边界和发布流程见根目录 [Android 更新服务指南](../../ANDROID_UPDATE_SERVER_GUIDE.md)。
