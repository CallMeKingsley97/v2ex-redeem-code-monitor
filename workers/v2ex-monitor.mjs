// @ts-nocheck
import core from '../src/core.js';

// Cloudflare Workers 版本：评分/解析逻辑由 src/core.js 提供，这里只保留
// KV 状态、fetch、HMAC Signing、Cron/fetch 入口等平台相关部分。
// 注意：core.js 用了 module.exports，所以在 Workers 里走 interop default import。

const DEFAULT_API_URL = 'https://www.v2ex.com/api/topics/latest.json';
const DEFAULT_STATE_KV_KEY = 'v2ex-monitor-state';
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
function getConfig(env) {
  return {
    apiUrl: env.V2EX_API_URL || DEFAULT_API_URL,
    webhook: env.FEISHU_WEBHOOK || '',
    secret: env.FEISHU_SECRET || '',
    stateKey: env.STATE_KV_KEY || DEFAULT_STATE_KV_KEY,
    notifyExistingOnStart: readBoolean(env.NOTIFY_EXISTING_ON_START, false),
    scoreThreshold: readNumber(env.SCORE_THRESHOLD, 5, 1),
    userAgent:
      env.V2EX_USER_AGENT ||
      'v2ex-redeem-code-monitor/1.0 (Cloudflare Workers)',
    kv: env.V2EX_MONITOR_KV
  };
}

function assertConfig(config) {
  if (!config.webhook) {
    throw new Error('缺少 FEISHU_WEBHOOK，请使用 wrangler secret put FEISHU_WEBHOOK 配置。');
  }

  if (!config.kv || typeof config.kv.get !== 'function' || typeof config.kv.put !== 'function') {
    throw new Error('缺少 KV 绑定 V2EX_MONITOR_KV，请检查 wrangler.jsonc。');
  }
}

function createInitialState() {
  return {
    initialized: false,
    seenTopicIds: [],
    notifiedTopicIds: [],
    matches: []
  };
}

async function readState(config) {
  const content = await config.kv.get(config.stateKey);
  if (!content) return createInitialState();

  let state;
  try {
    state = JSON.parse(content);
  } catch (error) {
    throw new Error(`KV 状态 JSON 解析失败：${error.message}`);
  }

  return {
    initialized: Boolean(state.initialized),
    seenTopicIds: Array.isArray(state.seenTopicIds) ? state.seenTopicIds : [],
    notifiedTopicIds: Array.isArray(state.notifiedTopicIds) ? state.notifiedTopicIds : [],
    matches: Array.isArray(state.matches) ? state.matches : []
  };
}

async function writeState(config, state) {
  const normalized = {
    initialized: Boolean(state.initialized),
    seenTopicIds: trimList(state.seenTopicIds, MAX_STATE_ITEMS),
    notifiedTopicIds: trimList(state.notifiedTopicIds, MAX_STATE_ITEMS),
    matches: trimList(state.matches, MAX_STATE_ITEMS)
  };

  await config.kv.put(config.stateKey, `${JSON.stringify(normalized, null, 2)}\n`);
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

async function signFeishuPayload(secret) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(`${timestamp}\n${secret}`),
    {
      name: 'HMAC',
      hash: 'SHA-256'
    },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(''));
  const sign = btoa(String.fromCharCode(...new Uint8Array(signature)));

  return { timestamp, sign };
}

async function sendFeishu(config, match) {
  const payload = buildFeishuPayload(match);
  if (config.secret) {
    Object.assign(payload, await signFeishuPayload(config.secret));
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

async function scanOnce(config) {
  assertConfig(config);

  const state = await readState(config);
  const topics = await fetchLatestTopics(config);
  const seenSet = new Set(state.seenTopicIds);
  const notifiedSet = new Set(state.notifiedTopicIds);
  const currentIds = topics.map((topic) => topic.id).filter(Boolean);
  const notifications = [];

  if (!state.initialized && !config.notifyExistingOnStart) {
    state.seenTopicIds.push(...currentIds);
    state.initialized = true;
    await writeState(config, state);

    return {
      scanned: topics.length,
      notified: 0,
      skippedExisting: currentIds.length,
      initialized: true
    };
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
    notifications.push({
      topicId: match.topicId,
      title: match.title,
      url: match.url,
      score: match.score
    });
  }

  state.initialized = true;
  await writeState(config, state);

  return {
    scanned: topics.length,
    notified: notifications.length,
    matches: notifications,
    initialized: true
  };
}

async function runScheduled(controller, env) {
  const config = getConfig(env);
  const result = await scanOnce(config);

  console.log(
    `[${new Date().toISOString()}] Cron ${controller.cron} 扫描完成：` +
      `scanned=${result.scanned}, notified=${result.notified}`
  );

  return result;
}

async function handleRequest(request, env) {
  const url = new URL(request.url);

  if (url.pathname === '/' && request.method === 'GET') {
    const config = getConfig(env);
    return jsonResponse({
      ok: true,
      service: 'v2ex-redeem-code-monitor',
      runtime: 'cloudflare-workers',
      stateKey: config.stateKey,
      hasKvBinding: Boolean(config.kv),
      hasWebhook: Boolean(config.webhook)
    });
  }

  if (url.pathname === '/scan' && request.method === 'POST') {
    if (!isAuthorized(request, env)) {
      return jsonResponse(
        {
          ok: false,
          error: env.ADMIN_TOKEN ? '未授权' : '手动扫描未启用，请配置 ADMIN_TOKEN。'
        },
        env.ADMIN_TOKEN ? 401 : 403
      );
    }

    const result = await scanOnce(getConfig(env));
    return jsonResponse({
      ok: true,
      ...result
    });
  }

  return jsonResponse(
    {
      ok: false,
      error: '未找到路由'
    },
    404
  );
}

function isAuthorized(request, env) {
  const token = env.ADMIN_TOKEN || '';
  if (!token) return false;

  return request.headers.get('Authorization') === `Bearer ${token}`;
}

function jsonResponse(body, status = 200) {
  return new Response(`${JSON.stringify(body, null, 2)}\n`, {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8'
    }
  });
}

export default {
  async scheduled(controller, env, ctx) {
    const task = runScheduled(controller, env);
    ctx.waitUntil(task);
    await task;
  },

  async fetch(request, env) {
    return handleRequest(request, env);
  }
};

export {
  buildFeishuPayload,
  extractCodes,
  getConfig,
  scanOnce,
  scoreTopic,
  signFeishuPayload
};
