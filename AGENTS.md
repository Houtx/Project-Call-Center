# Android 打包约定

- 用户要求：测试包和正式包全部使用既有正式签名证书，禁止使用 Android 默认 Debug 证书或临时生成证书。
- 正式证书 SHA-256：`1dc77e4ffdeba9e7bffa730826e4f7bb839884a92ccada8a75b88e2e0d45380d`。凭据获取方式见 `DEVELOPMENT_GUIDE.md`，不得输出或提交密码、私钥。
- 交付用户安装的测试 APK 也使用 Release 构建、生产包名 `com.company.callcenter` 和生产更新地址。保持版本号可被后续正式版本升级，不使用额外包名后缀。
- 缺少正式签名凭据时停止打包，不回退到 Debug 签名。交付前校验实际 APK 的包名、版本号、证书指纹。
