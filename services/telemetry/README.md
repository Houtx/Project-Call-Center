# 匿名使用统计服务

该服务使用 Python 标准库和 SQLite，为低配服务器提供 Android 匿名按日汇总接收、管理员登录和宏观统计面板。

本地校验：

```bash
(cd services/telemetry && python3 -m unittest -v test_telemetry_server.py)
node services/telemetry/test_dashboard.mjs
```

详细部署、隐私边界和发布流程见根目录 [Android 更新服务指南](../../ANDROID_UPDATE_SERVER_GUIDE.md)。
