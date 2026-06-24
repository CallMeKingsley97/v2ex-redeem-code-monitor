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

## 说明

这个脚本只做监听和通知，不会尝试自动兑换，也不会登录 V2EX 或 Apple 账号。
为了减少对站点的压力，请保持合理轮询间隔。
