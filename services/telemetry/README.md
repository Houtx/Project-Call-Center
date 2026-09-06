# 匿名使用统计服务

该服务使用 Python 标准库和 SQLite，为低配服务器提供 Android 匿名按日汇总接收、管理员登录、宏观统计面板和终端公告发布。

管理员可在面板发布标题不超过 80 字、正文不超过 2,000 字的公告。最新公告通过公开只读接口 `/api/app/v1/announcement/latest` 提供给 APP；没有公告时返回 `204`。发布和历史列表接口均要求管理员会话及 CSRF 校验。

`TELEMETRY_ADMIN_PASSWORD_HASH` 只在数据库首次初始化时写入管理员密码。管理员可在统计面板中修改密码；新哈希和会话版本保存在 SQLite，修改后其他已登录会话立即失效，后续重启不会被环境变量中的初始哈希覆盖。

管理端从同域 `/release.json` 读取最新 Android 版本，并生成直接下载链接和二维码。二维码生成使用随服务托管的 `qrcode-generator 2.0.4`（Kazuhiko Arase，MIT License），不会调用第三方二维码接口；完整许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

本地校验：

```bash
(cd services/telemetry && python3 -m unittest -v test_telemetry_server.py)
node services/telemetry/test_dashboard.mjs
```

详细部署、隐私边界和发布流程见根目录 [Android 更新服务指南](../../ANDROID_UPDATE_SERVER_GUIDE.md)。
