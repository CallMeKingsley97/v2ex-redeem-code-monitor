# Cloudflare Workers + KV 部署指南

本文档说明如何把本项目的 Cloudflare Workers 版本部署到 Cloudflare，并让它通过 Cron Trigger 定时扫描 V2EX 最新主题，再通过飞书机器人推送疑似 App 兑换码帖子。

现有本地 Node 版本入口仍然是 `src/monitor.js`。Cloudflare Workers 版本入口是 `workers/v2ex-monitor.mjs`，部署配置是 `wrangler.jsonc`。

## 部署后的运行方式

Worker 版本不是一个常驻进程，而是 Cloudflare 按 Cron 表达式定时唤醒它：

1. Cloudflare Cron Trigger 触发 Worker。
2. Worker 请求 V2EX 最新主题 API。
3. Worker 从 KV 读取历史状态，避免重复推送。
4. 命中规则后调用飞书机器人 Webhook。
5. Worker 把已扫描、已推送、命中记录写回 KV。
6. 本次扫描结束，Worker 退出，等待下一次 Cron。

默认配置为每分钟执行一次：

```jsonc
"triggers": {
  "crons": ["* * * * *"]
}
```

如果希望降低频率，可以改成每 3 分钟一次：

```jsonc
"triggers": {
  "crons": ["*/3 * * * *"]
}
```

## 需要准备什么

部署前请确认：

- 已有 Cloudflare 账号。
- 本机能运行 Node.js 18+。
- 项目根目录已有这些文件：
  - `workers/v2ex-monitor.mjs`
  - `wrangler.jsonc`
  - `.dev.vars.example`
  - `package.json`
- 已经创建飞书机器人，并拿到 Webhook。
- 如果飞书机器人启用了签名校验，还需要拿到签名密钥。

建议先在项目根目录执行一次语法检查：

```bash
npm run worker:check
```

如果输出没有报错，说明 Worker 文件至少能被解析。

## 第 1 步：登录 Cloudflare

在项目根目录执行：

```bash
npx wrangler login
```

Wrangler 会打开浏览器，让你授权当前终端访问 Cloudflare。授权完成后回到终端，确认命令成功结束。

如果浏览器没有自动打开，可以按终端输出的 URL 手动打开。

## 第 2 步：创建 KV 命名空间

Worker 需要用 Cloudflare KV 保存状态。执行：

```bash
npx wrangler kv namespace create V2EX_MONITOR_KV
```

命令成功后，会输出一段类似这样的配置：

```jsonc
{
  "binding": "V2EX_MONITOR_KV",
  "id": "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
}
```

复制里面的真实 `id`，替换 `wrangler.jsonc` 中的占位值：

```jsonc
"kv_namespaces": [
  {
    "binding": "V2EX_MONITOR_KV",
    "id": "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
  }
]
```

注意：

- 只替换 `id`，不要改 `binding`。
- `binding` 必须保持为 `V2EX_MONITOR_KV`，因为 Worker 代码通过 `env.V2EX_MONITOR_KV` 访问 KV。
- `00000000000000000000000000000000` 只是占位符，不能直接部署使用。

## 第 3 步：配置飞书 Webhook

飞书 Webhook 是敏感信息，不要写进 `wrangler.jsonc`，应使用 Wrangler secret。

执行：

```bash
npx wrangler secret put FEISHU_WEBHOOK
```

终端会提示输入值，把飞书机器人 Webhook 粘贴进去，例如：

```text
https://open.feishu.cn/open-apis/bot/v2/hook/...
```

输入时终端通常不会明文显示，这是正常的。

如果飞书机器人启用了“签名校验”，继续执行：

```bash
npx wrangler secret put FEISHU_SECRET
```

然后输入飞书机器人签名密钥。

## 第 4 步：可选配置手动扫描令牌

项目提供了一个可选接口：

```text
POST /scan
```

它可以让你手动触发一次扫描，方便部署后立即验证。但这个接口必须配置 `ADMIN_TOKEN` 才能使用。

执行：

```bash
npx wrangler secret put ADMIN_TOKEN
```

输入一个足够长、不要公开的随机字符串。

之后可以这样手动触发：

```bash
curl -X POST \
  -H "Authorization: Bearer 你的_ADMIN_TOKEN" \
  "https://你的-worker-url/scan"
```

如果不需要手动触发，可以跳过这一节。Cron 定时任务不依赖 `ADMIN_TOKEN`。

## 第 5 步：本地调试

本地调试不是必须的，但建议第一次部署前跑一遍。

复制本地变量模板：

```bash
cp .dev.vars.example .dev.vars
```

编辑 `.dev.vars`，至少填入：

```bash
FEISHU_WEBHOOK=https://open.feishu.cn/open-apis/bot/v2/hook/...
```

如果飞书机器人启用了签名校验，也填入：

```bash
FEISHU_SECRET=你的飞书签名密钥
```

如果想本地测试 `POST /scan`，再填入：

```bash
ADMIN_TOKEN=你的本地测试令牌
```

启动本地 Worker：

```bash
npm run worker:dev
```

这个脚本实际执行的是：

```bash
npx wrangler dev --test-scheduled
```

`--test-scheduled` 会让 Wrangler 暴露一个本地测试 Cron 的地址。

另开一个终端，触发一次本地 Cron：

```bash
curl "http://localhost:8787/__scheduled?cron=*+*+*+*+*"
```

也可以访问状态检查接口：

```bash
curl "http://localhost:8787/"
```

如果配置了本地 `ADMIN_TOKEN`，可以测试手动扫描：

```bash
curl -X POST \
  -H "Authorization: Bearer 你的_ADMIN_TOKEN" \
  "http://localhost:8787/scan"
```

本地测试常见现象：

- 第一次运行默认不会推送历史帖子，只会记录当前最新主题。
- 如果返回 `hasWebhook: true`，说明本地 Webhook 配置已被读取。
- 如果提示缺少 KV 绑定，先检查 `wrangler.jsonc` 里的 `kv_namespaces`。

## 第 6 步：部署到 Cloudflare

确认 `wrangler.jsonc` 里的 KV `id` 已经替换成真实值后，执行：

```bash
npm run worker:deploy
```

这个脚本实际执行的是：

```bash
npx wrangler deploy
```

部署成功后，终端会输出 Worker 地址，通常类似：

```text
https://v2ex-redeem-code-monitor.你的子域.workers.dev
```

把这个地址保存下来，后续检查状态和手动扫描会用到。

## 第 7 步：上线后验证

先访问根路径：

```bash
curl "https://你的-worker-url/"
```

正常情况下会返回类似：

```json
{
  "ok": true,
  "service": "v2ex-redeem-code-monitor",
  "runtime": "cloudflare-workers",
  "stateKey": "v2ex-monitor-state",
  "hasKvBinding": true,
  "hasWebhook": true
}
```

重点看：

- `ok` 应为 `true`。
- `hasKvBinding` 应为 `true`。
- `hasWebhook` 应为 `true`。

如果配置了 `ADMIN_TOKEN`，可以立即触发一次扫描：

```bash
curl -X POST \
  -H "Authorization: Bearer 你的_ADMIN_TOKEN" \
  "https://你的-worker-url/scan"
```

第一次扫描默认会返回 `notified: 0`，这是正常的。因为默认配置：

```jsonc
"NOTIFY_EXISTING_ON_START": "false"
```

这表示首次运行只记录当前最新列表，不推送历史内容。之后出现新的命中主题才会推送。

## 第 8 步：查看日志

可以用 Wrangler 查看线上日志：

```bash
npx wrangler tail
```

也可以在 Cloudflare 控制台查看：

1. 打开 Cloudflare Dashboard。
2. 进入 Workers & Pages。
3. 找到 `v2ex-redeem-code-monitor`。
4. 查看 Logs、Metrics、Triggers。

一次成功的 Cron 执行通常会输出类似：

```text
[2026-06-25T12:00:00.000Z] Cron * * * * * 扫描完成：scanned=10, notified=0
```

如果有命中并成功推送，`notified` 会大于 `0`。

## 配置项说明

`wrangler.jsonc` 中的非敏感变量：

- `V2EX_API_URL`：V2EX 最新主题 API，默认 `https://www.v2ex.com/api/topics/latest.json`。
- `V2EX_USER_AGENT`：请求 V2EX 时使用的 User-Agent。
- `NOTIFY_EXISTING_ON_START`：首次运行是否推送当前最新列表中的命中帖子，默认 `false`。
- `SCORE_THRESHOLD`：命中阈值，默认 `5`。调低会更敏感，调高会减少误报。
- `STATE_KV_KEY`：KV 中保存状态的 key，默认 `v2ex-monitor-state`。

通过 Wrangler secret 配置的敏感变量：

- `FEISHU_WEBHOOK`：飞书机器人 Webhook，必填。
- `FEISHU_SECRET`：飞书机器人签名密钥，未启用签名校验时不填。
- `ADMIN_TOKEN`：手动扫描接口令牌，不需要手动扫描时不填。

## 调整扫描频率

扫描频率由 `wrangler.jsonc` 的 `triggers.crons` 控制。

每分钟一次：

```jsonc
"crons": ["* * * * *"]
```

每 3 分钟一次：

```jsonc
"crons": ["*/3 * * * *"]
```

每 5 分钟一次：

```jsonc
"crons": ["*/5 * * * *"]
```

改完后需要重新部署：

```bash
npm run worker:deploy
```

## 状态与重复推送

Worker 会把状态写到 KV，默认 key 是：

```text
v2ex-monitor-state
```

状态里包含：

- 已扫描主题 ID。
- 已推送主题 ID。
- 最近命中的主题记录。

因此 Worker 重新部署后不会因为进程重启而重复推送。

如果你确实想重置状态，可以在 Cloudflare Dashboard 的 KV 页面删除 `v2ex-monitor-state`。删除后下一次运行会重新初始化状态。

重置状态可能导致历史主题被重新判断。默认 `NOTIFY_EXISTING_ON_START=false` 时，重置后的第一次运行仍然只记录当前最新列表，不推送历史内容。

## 更新代码后的重新部署

以后如果修改了 `workers/v2ex-monitor.mjs` 或 `wrangler.jsonc`，按下面流程：

```bash
npm run worker:check
npm run worker:deploy
```

如果只改了 secret，例如更换飞书 Webhook，不需要重新部署：

```bash
npx wrangler secret put FEISHU_WEBHOOK
```

## 常见问题

### 部署时报 KV namespace 不存在

检查 `wrangler.jsonc`：

- `id` 是否仍然是 `00000000000000000000000000000000`。
- `id` 是否复制完整。
- `binding` 是否仍然是 `V2EX_MONITOR_KV`。

### 根路径返回 `hasWebhook: false`

说明线上没有配置 `FEISHU_WEBHOOK` secret。执行：

```bash
npx wrangler secret put FEISHU_WEBHOOK
```

### 手动访问 `/scan` 返回未授权

检查请求头是否正确：

```bash
Authorization: Bearer 你的_ADMIN_TOKEN
```

如果没有配置 `ADMIN_TOKEN`，`POST /scan` 会被禁用。

### 第一次运行没有收到飞书消息

这是默认行为。默认 `NOTIFY_EXISTING_ON_START=false`，首次运行只记录当前最新主题，避免把历史内容当成新内容推送。

如果你想首次运行也推送当前列表中的命中帖子，可以改成：

```jsonc
"NOTIFY_EXISTING_ON_START": "true"
```

然后重新部署：

```bash
npm run worker:deploy
```

### Cron 没有马上执行

部署后 Cron Trigger 不一定立刻执行。可以等待一个周期，或配置 `ADMIN_TOKEN` 后用 `POST /scan` 手动触发一次。

### 飞书返回签名错误

通常是 `FEISHU_SECRET` 配错，或者飞书机器人没有启用签名校验但配置了错误 secret。

处理方式：

1. 确认飞书机器人安全设置是否启用了“签名校验”。
2. 如果启用了，重新执行 `npx wrangler secret put FEISHU_SECRET`。
3. 如果未启用，可以不配置 `FEISHU_SECRET`。

### 本地测试能跑，线上不能跑

重点检查这些差异：

- `.dev.vars` 只对本地有效，线上必须用 `wrangler secret put`。
- 本地 KV 和线上 KV 不是同一份状态。
- 线上必须把真实 KV namespace id 写入 `wrangler.jsonc`。

## 部署检查清单

部署前：

- [ ] `npm run worker:check` 通过。
- [ ] 已执行 `npx wrangler login`。
- [ ] 已创建 KV namespace。
- [ ] 已把真实 KV `id` 写入 `wrangler.jsonc`。
- [ ] 已配置 `FEISHU_WEBHOOK` secret。
- [ ] 如需飞书签名，已配置 `FEISHU_SECRET` secret。
- [ ] 如需手动扫描，已配置 `ADMIN_TOKEN` secret。

部署后：

- [ ] `npm run worker:deploy` 成功。
- [ ] 访问根路径返回 `ok: true`。
- [ ] 根路径返回 `hasKvBinding: true`。
- [ ] 根路径返回 `hasWebhook: true`。
- [ ] Cloudflare Dashboard 能看到 Cron Trigger。
- [ ] `npx wrangler tail` 能看到扫描日志。

## 官方文档参考

- Cloudflare Workers Cron Triggers: https://developers.cloudflare.com/workers/configuration/cron-triggers/
- Cloudflare Workers Scheduled Handler: https://developers.cloudflare.com/workers/runtime-apis/handlers/scheduled/
- Cloudflare Workers KV: https://developers.cloudflare.com/kv/
- Wrangler CLI: https://developers.cloudflare.com/workers/wrangler/
