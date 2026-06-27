const DEFAULT_API_URL = 'https://www.v2ex.com/api/topics/latest.json';
const DEFAULT_STATE_KV_KEY = 'v2ex-monitor-state';
const MAX_STATE_ITEMS = 1000;

const STRONG_KEYWORDS = [
  '兑换码',
  '兑换 code',
  'redeem code',
  'redemption code',
  'promo code',
  'promocode',
  'app store code',
  'appstore code',
  '发码',
  '送码',
  '赠码',
  '码在',
  '码已',
  '免费码',
  '兑换链接'
];

const APP_CONTEXT_KEYWORDS = [
  'app store',
  'appstore',
  'ios',
  'ipad',
  'iphone',
  'macos',
  'mac app',
  'watchos',
  'visionos',
  'testflight',
  '应用',
  '软件',
  '内购',
  '订阅',
  '终身版',
  'pro 版',
  '买断',
  '苹果'
];

const GIVEAWAY_KEYWORDS = [
  '免费',
  '抽奖',
  '赠送',
  '限量',
  '先到先得',
  '手慢无',
  '领取',
  '自取',
  '开发者',
  '独立开发'
];

const NEGATIVE_KEYWORDS = [
  '验证码',
  '邀请码',
  '优惠码',
  '折扣码',
  'coupon',
  '验证码登录',
  '两步验证'
];

const CODE_BLOCKLIST = new Set([
  'APPSTORE',
  'TESTFLIGHT',
  'IPHONE',
  'MACOS',
  'WATCHOS',
  'VISIONOS',
  'V2EX',
  'HTTPS',
  'HTTP',
  'COOKIE',
  'AUTHORIZATION'
]);

function readBoolean(value, fallback) {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'y', 'on'].includes(String(value).toLowerCase());
}

function readNumber(value, fallback, min) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(number, min);
}

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

function trimList(list, maxItems) {
  return Array.from(list).slice(-maxItems);
}

function normalizeText(value) {
  return decodeHtml(stripTags(String(value || '')))
    .replace(/\s+/g, ' ')
    .trim();
}

function stripTags(value) {
  return value.replace(/<[^>]*>/g, ' ');
}

function decodeHtml(value) {
  return value
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'");
}

function containsAny(text, keywords) {
  return keywords.some((keyword) => text.includes(keyword));
}

function extractCodes(text) {
  const withoutUrls = text.replace(/https?:\/\/\S+/gi, ' ');
  const matches = withoutUrls.match(/\b[A-Z0-9][A-Z0-9-]{6,18}[A-Z0-9]\b/g) || [];
  const codes = new Set();

  for (const match of matches) {
    const code = match.replace(/-/g, '').toUpperCase();

    if (code.length < 8 || code.length > 16) continue;
    if (/^\d+$/.test(code)) continue;
    if (/^[A-Z]+$/.test(code) && CODE_BLOCKLIST.has(code)) continue;
    if (CODE_BLOCKLIST.has(code)) continue;
    codes.add(code);
  }

  return Array.from(codes).slice(0, 20);
}

function getTopicUrl(topic) {
  if (topic.url) return topic.url;
  return `https://www.v2ex.com/t/${topic.id}`;
}

function scoreTopic(topic) {
  const title = normalizeText(topic.title);
  const content = normalizeText(topic.content || topic.content_rendered);
  const nodeTitle = normalizeText(topic.node && (topic.node.title || topic.node.name));
  const combined = `${title} ${content} ${nodeTitle}`;
  const lower = combined.toLowerCase();
  const codes = extractCodes(combined);
  const reasons = [];
  let score = 0;

  if (containsAny(lower, NEGATIVE_KEYWORDS)) {
    score -= 4;
    reasons.push('包含容易误判的负向词');
  }

  if (containsAny(lower, STRONG_KEYWORDS)) {
    score += 5;
    reasons.push('包含兑换码强关键词');
  }

  if (containsAny(lower, APP_CONTEXT_KEYWORDS)) {
    score += 2;
    reasons.push('包含 Apple/App 相关上下文');
  }

  if (containsAny(lower, GIVEAWAY_KEYWORDS)) {
    score += 2;
    reasons.push('包含赠送/限量上下文');
  }

  if (codes.length > 0) {
    score += 4;
    reasons.push(`提取到 ${codes.length} 个疑似兑换码`);
  }

  // 只有孤立大写串但没有 App 或兑换上下文时，容易误报为版本号、缩写或日志片段。
  if (codes.length > 0 && !containsAny(lower, STRONG_KEYWORDS) && !containsAny(lower, APP_CONTEXT_KEYWORDS)) {
    score -= 3;
    reasons.push('疑似码缺少兑换/App 上下文');
  }

  return {
    topicId: topic.id,
    title,
    content,
    nodeTitle,
    url: getTopicUrl(topic),
    codes,
    score,
    reasons
  };
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

function buildFeishuPayload(match) {
  const codesText = match.codes.length > 0 ? match.codes.join(', ') : '未直接提取到，建议打开原帖确认';
  const reasonsText = match.reasons.length > 0 ? match.reasons.join('；') : '规则命中';
  const contentPreview = match.content ? `\n\n摘要：${match.content.slice(0, 180)}` : '';

  return {
    msg_type: 'text',
    content: {
      text:
        `发现疑似 App 兑换码帖子\n` +
        `标题：${match.title}\n` +
        `节点：${match.nodeTitle || '未知'}\n` +
        `评分：${match.score}\n` +
        `疑似码：${codesText}\n` +
        `原因：${reasonsText}\n` +
        `链接：${match.url}` +
        contentPreview
    }
  };
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

function markSeen(state, seenSet, topicId) {
  if (seenSet.has(topicId)) return;
  state.seenTopicIds.push(topicId);
  seenSet.add(topicId);
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
