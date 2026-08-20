# 匿名使用统计服务

该服务使用 Python 标准库和 SQLite，为低配服务器提供 Android 匿名按日汇总接收、管理员登录和宏观统计面板。

`TELEMETRY_ADMIN_PASSWORD_HASH` 只在数据库首次初始化时写入管理员密码。管理员可在统计面板中修改密码；新哈希和会话版本保存在 SQLite，修改后其他已登录会话立即失效，后续重启不会被环境变量中的初始哈希覆盖。

本地校验：

```bash
(cd services/telemetry && python3 -m unittest -v test_telemetry_server.py)
node services/telemetry/test_dashboard.mjs
```

详细部署、隐私边界和发布流程见根目录 [Android 更新服务指南](../../ANDROID_UPDATE_SERVER_GUIDE.md)。
