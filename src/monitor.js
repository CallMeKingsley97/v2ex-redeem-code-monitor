'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const core = require('./core');

const DEFAULT_API_URL = 'https://www.v2ex.com/api/topics/latest.json';
const DOTENV_FILE = '.env';
const DEFAULT_STATE_FILE = './data/v2ex-monitor-state.json';
const DOTENV_SOURCE_KEYS = new Set();

const {
  readBoolean,
  readNumber,
  trimList,
  markSeen,
  buildFeishuPayload,
  extractCodes,
  scoreTopic,
  MAX_STATE_ITEMS
} = core;

function parseDotEnvContent(content) {
  const entries = new Map();

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const index = line.indexOf('=');
    if (index === -1) continue;

    const key = line.slice(0, index).trim();
    let value = line.slice(index + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (key) {
      entries.set(key, value);
    }
  }

  return entries;
}

async function syncDotEnv() {
  let content;

  try {
    content = await fs.readFile(DOTENV_FILE, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { changedKeys: [], removedKeys: [], missing: true };
    }

    throw error;
  }

  const entries = parseDotEnvContent(content);
  const changedKeys = [];
  const removedKeys = [];

  for (const [key, value] of entries) {
    if (process.env[key] === undefined) {
      process.env[key] = value;
      DOTENV_SOURCE_KEYS.add(key);
      changedKeys.push(key);
      continue;
    }

    if (DOTENV_SOURCE_KEYS.has(key) && process.env[key] !== value) {
      process.env[key] = value;
      changedKeys.push(key);
    }
  }

  for (const key of Array.from(DOTENV_SOURCE_KEYS)) {
    if (entries.has(key)) continue;

    if (process.env[key] !== undefined) {
      delete process.env[key];
    }

    DOTENV_SOURCE_KEYS.delete(key);
    removedKeys.push(key);
  }

  return { changedKeys, removedKeys, missing: false };
}

function getConfig() {
  const pollIntervalSeconds = readNumber(process.env.V2EX_POLL_INTERVAL_SECONDS, 20, 10);

  return {
    apiUrl: process.env.V2EX_API_URL || DEFAULT_API_URL,
    webhook: process.env.FEISHU_WEBHOOK || '',
    secret: process.env.FEISHU_SECRET || '',
    pollIntervalMs: pollIntervalSeconds * 1000,
    stateFile: process.env.STATE_FILE || DEFAULT_STATE_FILE,
    notifyExistingOnStart: readBoolean(process.env.NOTIFY_EXISTING_ON_START, false),
    scoreThreshold: readNumber(process.env.SCORE_THRESHOLD, 5, 1),
    userAgent:
      process.env.V2EX_USER_AGENT ||
      'v2ex-redeem-code-monitor/1.0 (+https://github.com/local/v2ex-redeem-code-monitor)'
  };
}

async function readState(filePath) {
  try {
    const content = await fs.readFile(filePath, 'utf8');
    const state = JSON.parse(content);

    return {
      initialized: Boolean(state.initialized),
      seenTopicIds: Array.isArray(state.seenTopicIds) ? state.seenTopicIds : [],
      notifiedTopicIds: Array.isArray(state.notifiedTopicIds) ? state.notifiedTopicIds : [],
      matches: Array.isArray(state.matches) ? state.matches : []
    };
  } catch (error) {
    if (error.code === 'ENOENT') {
      return {
        initialized: false,
        seenTopicIds: [],
        notifiedTopicIds: [],
        matches: []
      };
    }
    throw error;
  }
}

async function writeState(filePath, state) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });

  const normalized = {
    initialized: Boolean(state.initialized),
    seenTopicIds: trimList(state.seenTopicIds, MAX_STATE_ITEMS),
    notifiedTopicIds: trimList(state.notifiedTopicIds, MAX_STATE_ITEMS),
    matches: trimList(state.matches, MAX_STATE_ITEMS)
  };

  const tempFile = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(tempFile, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
  await fs.rename(tempFile, filePath);
}

async function fetchLatestTopics(config) {
  const response = await fetch(config.apiUrl, {
    headers: {
      Accept: 'application/json',
      'User-Agent': config.userAgent
    }
  });

  if (!response.ok) {
    throw new Error(`V2EX 请求失败：HTTP ${response.status}`);
  }

  const topics = await response.json();
  if (!Array.isArray(topics)) {
    throw new Error('V2EX 返回格式异常：预期为主题数组');
  }

  return topics;
}

function signFeishuPayload(secret) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const stringToSign = `${timestamp}\n${secret}`;
  const sign = crypto.createHmac('sha256', stringToSign).update('').digest('base64');

  return { timestamp, sign };
}

async function sendFeishu(config, match) {
  if (!config.webhook) {
    throw new Error('缺少 FEISHU_WEBHOOK，无法发送通知');
  }

  const payload = buildFeishuPayload(match);
  if (config.secret) {
    Object.assign(payload, signFeishuPayload(config.secret));
  }

  const response = await fetch(config.webhook, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  const resultText = await response.text();
  if (!response.ok) {
    throw new Error(`飞书推送失败：HTTP ${response.status} ${resultText}`);
  }

  let result;
  try {
    result = JSON.parse(resultText);
  } catch {
    result = { raw: resultText };
  }

  const code = result.code ?? result.StatusCode ?? 0;
  if (code !== 0) {
    throw new Error(`飞书推送返回异常：${resultText}`);
  }
}

async function scanOnce(config, state) {
  const topics = await fetchLatestTopics(config);
  const seenSet = new Set(state.seenTopicIds);
  const notifiedSet = new Set(state.notifiedTopicIds);
  const currentIds = topics.map((topic) => topic.id).filter(Boolean);

  if (!state.initialized && !config.notifyExistingOnStart) {
    state.seenTopicIds.push(...currentIds);
    state.initialized = true;
    await writeState(config.stateFile, state);
    console.log(`[${new Date().toISOString()}] 首次启动，已记录 ${currentIds.length} 个当前主题，不推送历史内容。`);
    return;
  }

  for (const topic of topics.slice().reverse()) {
    if (!topic.id || seenSet.has(topic.id)) continue;

    const match = scoreTopic(topic);

    if (match.score < config.scoreThreshold) {
      markSeen(state, seenSet, topic.id);
      continue;
    }

    if (notifiedSet.has(topic.id)) {
      markSeen(state, seenSet, topic.id);
      continue;
    }

    await sendFeishu(config, match);
    markSeen(state, seenSet, topic.id);
    state.notifiedTopicIds.push(topic.id);
    notifiedSet.add(topic.id);
    state.matches.push({
      ...match,
      notifiedAt: new Date().toISOString()
    });

    console.log(`[${new Date().toISOString()}] 已推送：${match.title} ${match.url}`);
  }

  state.initialized = true;
  await writeState(config.stateFile, state);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function uniqueList(values) {
  return Array.from(new Set(values));
}

function formatDotEnvChange(keys) {
  return uniqueList(keys).join(', ');
}

async function waitWithHotReload(intervalMs) {
  const stepMs = Math.min(1000, intervalMs);
  let remainingMs = intervalMs;

  while (remainingMs > 0) {
    await delay(Math.min(stepMs, remainingMs));
    remainingMs -= stepMs;

    const syncResult = await syncDotEnv();
    const changedKeys = uniqueList([...syncResult.changedKeys, ...syncResult.removedKeys]);

    if (changedKeys.length > 0) {
      console.log(
        `[${new Date().toISOString()}] 检测到 .env 变更，已热加载：${formatDotEnvChange(changedKeys)}`
      );
      return true;
    }
  }

  return false;
}

async function main() {
  await syncDotEnv();

  const config = getConfig();
  if (!config.webhook) {
    console.error('缺少 FEISHU_WEBHOOK。请复制 .env.example 为 .env 并填写飞书机器人 Webhook。');
    process.exitCode = 1;
    return;
  }

  const state = await readState(config.stateFile);
  console.log(`V2EX 监听已启动，轮询间隔 ${config.pollIntervalMs / 1000}s，状态文件 ${config.stateFile}`);

  while (true) {
    try {
      await scanOnce(config, state);
    } catch (error) {
      console.error(`[${new Date().toISOString()}] 扫描失败：${error.message}`);
    }

    const reloaded = await waitWithHotReload(config.pollIntervalMs);
    if (reloaded) {
      Object.assign(config, getConfig());
    }
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = {
  extractCodes,
  scoreTopic,
  buildFeishuPayload,
  signFeishuPayload
};
