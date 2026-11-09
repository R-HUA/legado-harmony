# 终身会员改名更新包 · 2026-10-22

把服务端返回的“永久会员 / 永久超级会员”改为“终身会员 / 终身超级会员”：会员商品目录里的商品名，以及动态头像、专属主题、云空间、朗读礼包、重复购买这几处的错误提示。
只替换这些文字，商品 SKU、价格、权益、活动价和数据库都不变，已购会员不受影响。

## 部署

运行目录 `/www/wwwroot/qingye.icynol.com`，服务 `legado-account.service`，Node `/www/server/nodejs/v22.23.1/bin/node`。
只修改 `cloudFileService.js`、`imageSecurity.js`、`membershipPolicy.js`、`membershipService.js`、`superThemeService.js` 中共 7 处文字，保留其他代码。
脚本逐一核对原文字，任何一处对不上都会在停止服务前退出，不改任何文件。
不包含或修改 `.env`、密钥、数据库、会员记录及其他运行模块。部署会短暂重启服务。

将 `qingye-lifetime-rename-20261022.zip` 上传至服务器 `/root`，使用 root 执行：

```bash
stage=$(mktemp -d /root/qingye-lifetime-rename.XXXXXX)
unzip -q /root/qingye-lifetime-rename-20261022.zip -d "$stage"
bash "$stage/update.sh"
```

脚本校验包内 SHA256、生成候选文件、做语法检查，并确认候选文件除这 7 处文字外与原文件完全一致、商品目录名称与价格正确，之后备份并替换文件。
看到 `PASS: lifetime tiers renamed` 表示已通过本机和公网健康检查。重复执行会提示 `Already installed`，不重启服务。
脚本输出备份目录 `/root/qingye-lifetime-rename-backup.XXXXXX`。安装或健康检查失败时会尝试自动恢复。
部署后在 App 会员中心刷新，方案卡上的商品名应显示“终身会员 / 终身超级会员”。

## 手动回滚

使用部署时输出的真实备份目录：

```bash
bash "$stage/rollback.sh" /root/qingye-lifetime-rename-backup.XXXXXX
```

若运行文件已被后续更新修改，回滚脚本会拒绝覆盖，需先核对版本。

## 验证范围

本地用改名前后各编译一次服务端，确认编译产物只差这 7 处文字。
以改名前的编译产物模拟线上目录：补丁与检查通过、重复执行不再改动、任一处原文字对不上时拒绝执行。未在线上服务器执行过。
