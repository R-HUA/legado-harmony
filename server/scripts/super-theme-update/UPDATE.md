# 曜金藏书 · 服务端增量更新包

此包对应终身超级会员专属主题：手动领取一年、到期后再领取、不支持点数购买。已编译，可直接用于现有 Node.js 服务，不需要在服务器运行 npm install 或 TypeScript 编译。

## 内容与范围

- `server/`：`index.js`、`membershipRoutes.js`、`themeCatalog.js`、`superThemeService.js`。
- `migrations/023_super_exclusive_theme.sql`：新增领取方式字段、专属主题目录项与领取记录表。
- `source/`：上述四个模块的 TypeScript 源码，便于审阅；不复制到线上运行目录。
- `update.sh`、`check.mjs`、`admin-*.sql`：应用预检、管理员迁移与更新工具。
- `manifest.json`、`SHA256SUMS`：构建信息、支持的旧版本摘要、包内文件摘要。

不含数据库、环境变量、认证信息、node_modules、客户端图片。沿用服务器现有配置，不调整会员价格、销售时间、朗读礼包或云下载额度。

## 适用环境

根据此前已确认的服务器配置：

| 项目 | 值 |
|---|---|
| 服务 | `legado-account.service` |
| 运行目录 | `/www/wwwroot/qingye.icynol.com` |
| Node | `/www/server/nodejs/v22.23.1/bin/node` |
| 环境文件 | `/etc/legado-account.env` |
| 数据库 / 应用角色 | `legado_commerce` / `qingye` |
| PostgreSQL 工具目录 / 本地 socket | `/www/server/pgsql/bin` / `/tmp` |

需要此前自然月礼包和下载额度更新的数据库结构已到位。脚本核对运行目录、旧模块摘要、模块依赖、数据库名、应用角色及表结构；不匹配时停止，不强行覆盖。`BASELINE_MISMATCH` 表示服务器版本与本包基线不同，请提供预检输出后适配更新包，不要跳过检查。

## 第一步：上传与只读预检

把 ZIP 和同名 `.sha256` 校验文件一起上传到 `/root/`，执行：

```bash
cd /root
sha256sum -c qingye-super-theme-20261022.zip.sha256
unzip qingye-super-theme-20261022.zip -d /root
bash /root/qingye-super-theme-20261022/update.sh --check
```

校验失败就停止。预检只创建独立暂存目录、读取文件和数据库，不停止服务，不改线上代码，不执行迁移。请保留输出中的 `STAGE_DIR`。

## 第二步：正式更新

只在第一步全部 PASS 后执行：

```bash
bash /root/qingye-super-theme-20261022/update.sh --apply
```

脚本重新预检，然后自动：

1. 在 `/root/qingye-super-theme-backup.*` 保存受影响的旧模块、配置副本和数据库自定义格式备份。`pg_restore --list` 检查备份目录可读，不代表已做完整恢复演练。
2. 短暂停止服务，通过本地 `postgres` 管理员在一个事务中执行 023；保留 `theme_catalog` 原所有者及 ACL，仅对新领取记录表向 `qingye` 授予 SELECT、INSERT。核对现有会员商品和其他主题配置未变，再以应用账号验证读取与记录表权限。
3. 安装四个模块并恢复原文件权限，重启服务。
4. 检查内外网健康接口、主题目录中的领取标记、匿名领取返回 401，以及进程是否稳定运行。

成功结尾为 `PASS: exclusive theme deployed and verified`。保留 `BACKUP_DIR` 和 `LOG` 路径。

脚本不会自动替任何真实账号领取主题。新版客户端中请用终身超级会员手动验收领取、重复点击不延长、应用主题；普通会员不能领取。到期与旧请求重放已由服务端自动化测试验证，无需修改生产时间或用户数据。

## 失败处理

- 预检或备份失败：服务保持原样。
- 停服后、尚未启动新版前失败：脚本通过管理员尝试禁用新主题目录项，再恢复旧模块并启动旧服务；新表和既有领取记录保留。
- 已尝试启动新版后失败：脚本停止服务并保留现场，不自动还原数据库；提供完整终端输出及 `LOG` 路径排查。
- **不能直接把旧代码覆盖回去而保留启用的零价格主题目录项**。旧点数兑换接口不认识 `SUPER_CLAIM`，恢复旧代码前必须禁用该主题。
- 不要直接恢复整库备份：备份之后可能已有订单或领取记录。该迁移主要增加结构，故障时优先保留数据排查。

此包在本地完成服务端 94 项测试，包含目录只读权限下的首次领取、重复领取和续领，以及脚本语法及包完整性检查；未连接或修改生产服务器。
