# 同步限额提示修复更新包 · 2026-10-22

修复老版本 App 上传超过 960KB 的书源时，非超级会员也收到“不能超过 960KB”的错误提示。
服务端先确定账号额度再校验：非超级会员保持 512KB，生效中的终身超级会员为 960KB；其他同步实体保持 64KB。
这里的大小是单项同步 JSON 的 UTF-8 字节数，不是书籍文件大小。超限内容仍不能上传；本包不放宽额度。

## 部署

适用于已安装 2026-10-22 超级会员 960KB 书源扩容版本的服务端。
运行目录 `/www/wwwroot/qingye.icynol.com`，服务 `legado-account.service`，Node `/www/server/nodejs/v22.23.1/bin/node`。
脚本核对目标代码，无法匹配时会在停止服务前退出。只修改 `sync.js` 中的三个校验片段，保留其他代码。
不包含或修改 `.env`、密钥、数据库、会员记录、主题及其他运行模块。部署会短暂重启服务。

将 `qingye-sync-limit-fix-20261022.zip` 上传至服务器 `/root`，使用 root 执行：

```bash
stage=$(mktemp -d /root/qingye-sync-limit-fix.XXXXXX)
unzip -q /root/qingye-sync-limit-fix-20261022.zip -d "$stage"
bash "$stage/update.sh"
```

脚本校验包内 SHA256、生成候选文件、运行语法及额度回归检查，之后备份并替换文件。
看到 `PASS: sync limit message fixed` 表示已通过本机和公网健康检查。旧客户端无需更新。
脚本输出备份目录 `/root/qingye-sync-limit-backup.XXXXXX`。安装或健康检查失败时会尝试自动恢复。
修复生效后，以非超级会员账号上传超过 960KB 的单个书源，应提示 512KB；超级会员应提示 960KB。

## 手动回滚

使用部署时输出的真实备份目录：

```bash
bash "$stage/rollback.sh" /root/qingye-sync-limit-backup.XXXXXX
```

若运行文件已被后续更新修改，回滚脚本会拒绝覆盖，需先核对版本。

## 验证范围

构建及同步单元测试、使用临时数据库的真实同步事务回归测试通过。
部署前 `check.mjs` 使用候选文件的实际校验代码，以内存替身验证各会员等级报错，不连接线上数据库、不产生同步数据。
包内补丁支持重复执行，并拒绝不兼容的校验代码版本。
