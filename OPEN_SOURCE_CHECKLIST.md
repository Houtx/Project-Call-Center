# 公开发布检查清单

本仓库应只包含可公开的源码、通用示例和匿名化文档。真实客户、员工、设备、服务器、域名、发布账号与密钥必须保存在私有系统中。

## 发布前必须完成

1. 从干净克隆目录检查工作树，确认 `git status --short` 只包含计划公开的改动。
2. 确认未跟踪或被忽略的 `.env`、`.env.production`、`.local-data/`、`backups/`、`uploads/`、签名证书、APK/AAB 和私有笔记没有被 `git add -f`。APK 可以作为 GitHub Release 资产发布，但不能提交进 Git 历史。
3. 为 APK 更新配置本源码仓库的 Release 地址，并在构建 Release 时通过未提交的 `CALL_CENTER_UPDATE_MANIFEST_URL` 和 `CALL_CENTER_UPDATE_RELEASES_BASE_URL` 传入。每个正式 Release 同时发布 APK 和 `release.json`。
4. 创建或选定开源许可证。许可证选择涉及法律责任，未确定前不要将仓库标记为已授权开源。
5. 在公开前运行依赖漏洞扫描、许可证扫描、测试与构建，并审查所有迁移、示例和文档。

## 当前文件扫描

在仓库根目录运行下列命令，确认输出不含真实地址、姓名、手机号、邮箱、令牌、密钥或内部域名：

```bash
git grep -n -i -E 'houtx|houtianx|internal|corp|192\\.168\\.|10\\.[0-9]|[A-Z0-9._%+-]+@[A-Z0-9.-]+\\.[A-Z]{2,}'
git grep -n -i -E '(password|secret|token|api[_-]?key|private[_-]?key)[[:space:]]*[:=][[:space:]]*[^[:space:]]+'
git diff --check
```

The commands may report documented placeholder names and test fixtures. Review every match; do not simply suppress an unfamiliar value.

运行测试与构建：

```bash
npm run lint
npm test
npm run build
(cd apps/android && ./gradlew test lintDebug assembleDebug)
```

## Git 历史与发布身份

当前文件已清理不等于旧提交已经清理。公开现有 GitHub 仓库前，必须检查全部提交、标签和其他引用：

```bash
git log --all --format='%h %an <%ae> %s'
git log --all -- .env .env.production PRODUCTION_DEPLOYMENT_RECORD.md
git fsck --full --no-reflogs --unreachable
```

如果历史包含不应公开的文件、作者邮箱、服务器信息或密钥，优先将已清理的工作树导出到全新仓库并重新提交。若必须保留历史，请由熟悉 `git filter-repo` 的维护者先备份并重写全部受影响引用，再强制推送。

公开仓库的组织名、提交作者邮箱、Release 仓库与 Issue 联系方式都应使用可公开的身份；不要把个人账号、私人邮箱或内部工单地址写入源码和文档。

## 不应提交的内容

- 客户号码、通话记录、导入文件、导出文件、审计日志或数据库备份。
- 真实坐席/管理员账号、密码、访问令牌、Cookie、JWT、API key、S3 凭据、SSH key、keystore 和签名密码。
- 私有服务器 IP、主机名、内网地址、域名、Nginx 配置、容量盘点、现有服务清单和生产日志。
- 带有真实业务配置的 APK、AAB、Docker 镜像导出文件、截图和录屏。

## 配置原则

- 只提交 `.env.example` 和 `deploy/.env.production.example`，且其中只能出现清晰的占位值。
- Debug APK 默认不预填账号、密码或组织专属更新地址；开发人员可通过本机环境变量注入。
- Release APK 必须显式配置 HTTPS 更新清单和资产地址；构建脚本会拒绝缺失这些参数的 Release 构建。
- 任何生产验证记录都保存到私有文档系统，不要回填到本仓库。
