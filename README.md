# V2EX App 兑换码监听器

监听 V2EX 全站最新主题，发现疑似 iOS/macOS/App Store 兑换码帖子后，通过飞书机器人 Webhook 第一时间推送。

## 功能

- 轮询 V2EX 全站最新主题 API。
- 识别标题、正文、节点中的兑换码关键词和疑似兑换码。
- 支持飞书机器人普通 Webhook 和签名校验。
- 本地记录已扫描、已推送和命中历史，重启后不重复提醒。
- 零第三方依赖，只需要 Node.js 18+。

## 快速开始

1. 复制环境变量模板：

```bash
cp .env.example .env
```

2. 编辑 `.env`，至少填写：

```bash
FEISHU_WEBHOOK=https://open.feishu.cn/open-apis/bot/v2/hook/...
```

3. 运行：

```bash
npm start
```

## 配置项

- `FEISHU_WEBHOOK`：飞书机器人 Webhook，必填。
- `FEISHU_SECRET`：飞书机器人签名密钥，未启用签名时留空。
- `V2EX_POLL_INTERVAL_SECONDS`：轮询间隔，默认 `20` 秒，最小 `10` 秒。
- `NOTIFY_EXISTING_ON_START`：首次启动是否推送当前最新列表中的命中帖子，默认 `false`。
- `SCORE_THRESHOLD`：命中阈值，默认 `5`。调低会更敏感，调高会减少误报。
- `STATE_FILE`：本地状态文件，默认 `./data/v2ex-monitor-state.json`。

## 常驻运行建议

本地测试可以直接 `npm start`。长期运行建议使用：

- macOS：`launchd`
- Linux：`systemd` 或 `pm2`
- Windows：任务计划程序
- NAS/服务器：Docker 或进程守护工具

## Cloudflare Workers + KV 部署

项目额外提供了 Cloudflare Workers 版本，入口文件是 `workers/v2ex-monitor.mjs`。
现有 Node 版本仍然使用 `src/monitor.js`，两者互不影响。

Worker 版本不是常驻进程，而是由 Cron Trigger 定时触发，每次只扫描一次。
状态会写入 Cloudflare KV，不再使用本地 `STATE_FILE`。

更完整的部署、验证、排错和维护说明见：
[Cloudflare Workers + KV 部署指南](docs/cloudflare-workers-deploy.md)。

1. 登录 Cloudflare：

```bash
npx wrangler login
```

2. 创建 KV 命名空间：

```bash
npx wrangler kv namespace create V2EX_MONITOR_KV
```

把命令返回的 `id` 填到 `wrangler.jsonc` 的 `kv_namespaces[0].id`。

3. 配置飞书 Webhook：

```bash
npx wrangler secret put FEISHU_WEBHOOK
```

如果飞书机器人启用了签名校验，再配置：

```bash
npx wrangler secret put FEISHU_SECRET
```

如果需要部署后手动触发 `/scan`，再配置一个管理令牌：

```bash
npx wrangler secret put ADMIN_TOKEN
```

4. 本地调试：

```bash
cp .dev.vars.example .dev.vars
npm run worker:dev
```

另开一个终端触发一次定时任务：

```bash
curl "http://localhost:8787/__scheduled?cron=*+*+*+*+*"
```

5. 部署：

```bash
npm run worker:deploy
```

默认 Cron 配置为每分钟执行一次：

```json
"crons": ["* * * * *"]
```

如果想降低频率，可以改成每 3 分钟一次：

```json
"crons": ["*/3 * * * *"]
```

### Worker 配置项

- `FEISHU_WEBHOOK`：飞书机器人 Webhook，使用 Wrangler secret 配置，必填。
- `FEISHU_SECRET`：飞书机器人签名密钥，使用 Wrangler secret 配置，未启用签名时可不填。
- `ADMIN_TOKEN`：可选。配置后可以用 `POST /scan` 手动触发扫描。
- `V2EX_API_URL`：V2EX 最新主题 API，默认 `https://www.v2ex.com/api/topics/latest.json`。
- `V2EX_USER_AGENT`：请求 V2EX 时使用的 User-Agent。
- `NOTIFY_EXISTING_ON_START`：首次运行是否推送当前最新列表中的命中帖子，默认 `false`。
- `SCORE_THRESHOLD`：命中阈值，默认 `5`。
- `STATE_KV_KEY`：KV 中保存状态的 key，默认 `v2ex-monitor-state`。

## 说明

这个脚本只做监听和通知，不会尝试自动兑换，也不会登录 V2EX 或 Apple 账号。
为了减少对站点的压力，请保持合理轮询间隔。
