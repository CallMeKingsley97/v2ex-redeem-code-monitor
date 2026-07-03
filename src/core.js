'use strict';

// 平台无关的评分/解析核心。
// src/monitor.js (Node) 与 workers/v2ex-monitor.mjs (Cloudflare Workers) 共用，
// 避免关键词表与评分逻辑在两处各维护一份。只依赖纯 JS，无任何 Node/Worker 专属 API。

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
  '兑换链接',
  '兑换地址',
  'offer code',
  'offercodes'
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
  '验证码登录',
  '两步验证'
];

const DISCOUNT_NEGATIVE_KEYWORDS = [
  '优惠码',
  '折扣码',
  'coupon'
];

const APP_STORE_REDEEM_KEYWORDS = [
  'apps.apple.com/redeem',
  'offercodes'
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
    if (code.length < 8 || code.length > 20) continue;
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
  const hasAppContext = containsAny(lower, APP_CONTEXT_KEYWORDS);
  const hasStrongKeyword = containsAny(lower, STRONG_KEYWORDS);
  const hasGiveawayContext = containsAny(lower, GIVEAWAY_KEYWORDS);
  const hasAppStoreRedeemContext = containsAny(lower, APP_STORE_REDEEM_KEYWORDS);

  if (
    containsAny(lower, NEGATIVE_KEYWORDS) ||
    (containsAny(lower, DISCOUNT_NEGATIVE_KEYWORDS) && !hasAppContext && !hasAppStoreRedeemContext)
  ) {
    score -= 4;
    reasons.push('包含容易误判的负向词');
  }

  if (hasStrongKeyword) {
    score += 5;
    reasons.push('包含兑换码强关键词');
  }

  if (hasAppContext) {
    score += 2;
    reasons.push('包含 Apple/App 相关上下文');
  }

  if (hasGiveawayContext) {
    score += 2;
    reasons.push('包含赠送/限量上下文');
  }

  if (codes.length > 0) {
    score += 4;
    reasons.push(`提取到 ${codes.length} 个疑似兑换码`);
  }

  // 只有孤立大写串但没有 App 或兑换上下文时，容易误报为版本号、缩写或日志片段。
  if (codes.length > 0 && !hasStrongKeyword && !hasAppContext) {
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

function markSeen(state, seenSet, topicId) {
  if (seenSet.has(topicId)) return;
  state.seenTopicIds.push(topicId);
  seenSet.add(topicId);
}

module.exports = {
  MAX_STATE_ITEMS,
  STRONG_KEYWORDS,
  APP_CONTEXT_KEYWORDS,
  GIVEAWAY_KEYWORDS,
  NEGATIVE_KEYWORDS,
  DISCOUNT_NEGATIVE_KEYWORDS,
  APP_STORE_REDEEM_KEYWORDS,
  CODE_BLOCKLIST,
  readBoolean,
  readNumber,
  trimList,
  normalizeText,
  stripTags,
  decodeHtml,
  containsAny,
  extractCodes,
  getTopicUrl,
  scoreTopic,
  buildFeishuPayload,
  markSeen
};
