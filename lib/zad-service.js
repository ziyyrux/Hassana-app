const crypto = require('node:crypto');
const { GoogleGenAI, ThinkingLevel } = require('@google/genai');
const {
  ZAD_MODEL,
  ZAD_WELCOME_MESSAGE,
  ZAD_QUICK_PROMPTS,
  ZAD_SYSTEM_INSTRUCTION,
  getDailyTokenLimit,
  extractUsageMetadata,
  normalizeRequestId,
  validateChatRequest,
  buildGeminiContents,
  mapGeminiError,
} = require('./zad');
const ZadUsage = require('./zad-usage');
const { resolveApkDownloadUrl } = require('./apk-config');

const MAX_BODY_BYTES = 1024 * 1024;
const DEFAULT_RATE_LIMIT_COOLDOWN_SECONDS = 15;
const MAX_COOLDOWN_SECONDS = 12 * 3600;
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Idempotency-Key',
};

let cachedClient = null;
let cachedKey = null;

const inFlightRequests = new Map();
const upstreamCooldowns = new Map();
const userDailyUsage = new Map();

function resetZadServiceState() {
  inFlightRequests.clear();
  upstreamCooldowns.clear();
  userDailyUsage.clear();
  cachedClient = null;
  cachedKey = null;
}

function getKeyFingerprint(deps) {
  if (deps && typeof deps.keyFingerprint === 'string' && deps.keyFingerprint) {
    return deps.keyFingerprint;
  }
  const rawKey = typeof process.env.GEMINI_API_KEY === 'string' ? process.env.GEMINI_API_KEY.trim() : '';
  if (rawKey) {
    return crypto.createHash('sha256').update(rawKey).digest('hex').slice(0, 12);
  }
  if (deps && typeof deps.getClient === 'function') {
    return 'custom-client';
  }
  return 'missing';
}

function getAiClient() {
  const rawKey = process.env.GEMINI_API_KEY;
  const apiKey = typeof rawKey === 'string' ? rawKey.trim() : '';
  if (!apiKey) {
    throw new Error('MISSING_API_KEY');
  }
  if (!cachedClient || cachedKey !== apiKey) {
    cachedKey = apiKey;
    cachedClient = new GoogleGenAI({
      apiKey,
      httpOptions: {
        retryOptions: {
          attempts: 1,
        },
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    });
  }
  return cachedClient;
}

function isNonRetryableError(err) {
  if (!err) return false;
  const status = err.status || err.statusCode || err.code;
  if (typeof status === 'number' && status >= 400 && status < 500) {
    return true;
  }
  const raw = String(err.message || err.toString() || '');
  return (
    raw.includes('MISSING_API_KEY') ||
    raw.includes('RESOURCE_EXHAUSTED') ||
    raw.includes('PERMISSION_DENIED') ||
    raw.includes('API_KEY_INVALID') ||
    raw.includes('INVALID_ARGUMENT') ||
    raw.includes('NOT_FOUND')
  );
}

async function generateWithRetry(ai, params, opts) {
  const sleep =
    opts && typeof opts.sleep === 'function'
      ? opts.sleep
      : (ms) => new Promise((r) => setTimeout(r, ms));
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await ai.models.generateContent(params);
      return response;
    } catch (err) {
      lastErr = err;
      if (err && typeof err === 'object') {
        err._retryCount = attempt;
      }
      if (isNonRetryableError(err)) {
        throw err;
      }
      if (attempt === 0) {
        const jitter = Math.floor(Math.random() * 180);
        await sleep(320 + jitter);
      }
    }
  }
  throw lastErr;
}

function sendJson(res, statusCode, payload, extraHeaders) {
  const mergedHeaders = { ...CORS_HEADERS, ...(extraHeaders || {}) };
  if (typeof res.setHeader === 'function') {
    for (const [k, v] of Object.entries(mergedHeaders)) {
      res.setHeader(k, v);
    }
  }
  if (typeof res.status === 'function' && typeof res.json === 'function') {
    return res.status(statusCode).json(payload);
  }
  if (typeof res.writeHead === 'function') {
    res.writeHead(statusCode, {
      'Content-Type': 'application/json; charset=utf-8',
      ...mergedHeaders,
    });
  }
  return res.end(JSON.stringify(payload));
}

async function readJsonBody(req) {
  if (req && req.body !== undefined && req.body !== null) {
    if (typeof req.body === 'object' && !Buffer.isBuffer(req.body)) {
      return { ok: true, body: req.body };
    }
    const rawStr = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String(req.body);
    if (!rawStr.trim()) {
      return { ok: true, body: {} };
    }
    try {
      return { ok: true, body: JSON.parse(rawStr) };
    } catch {
      return { ok: false, status: 400, error: 'تعذّر قراءة بيانات الطلب.' };
    }
  }

  if (!req || typeof req.on !== 'function') {
    return { ok: true, body: {} };
  }

  return new Promise((resolve) => {
    const chunks = [];
    let total = 0;
    let settled = false;

    req.on('data', (chunk) => {
      if (settled) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buf.length;
      if (total > MAX_BODY_BYTES) {
        settled = true;
        resolve({ ok: false, status: 413, error: 'حجم الطلب يتجاوز الحد المسموح.' });
        return;
      }
      chunks.push(buf);
    });

    req.on('end', () => {
      if (settled) return;
      settled = true;
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) {
        resolve({ ok: true, body: {} });
        return;
      }
      try {
        resolve({ ok: true, body: JSON.parse(raw) });
      } catch {
        resolve({ ok: false, status: 400, error: 'تعذّر قراءة بيانات الطلب.' });
      }
    });

    req.on('error', () => {
      if (settled) return;
      settled = true;
      resolve({ ok: false, status: 400, error: 'تعذّر قراءة الطلب.' });
    });
  });
}

function handleZadConfig(req, res, deps) {
  const now = deps && typeof deps.now === 'function' ? deps.now : () => Date.now();
  const currentNow = now();
  const method = req && req.method ? String(req.method).toUpperCase() : 'GET';
  if (method === 'OPTIONS') {
    const optHeaders = { ...CORS_HEADERS, Allow: 'GET, HEAD, OPTIONS' };
    if (typeof res.setHeader === 'function') {
      for (const [k, v] of Object.entries(optHeaders)) {
        res.setHeader(k, v);
      }
    }
    if (typeof res.status === 'function' && typeof res.end === 'function') {
      return res.status(204).end();
    }
    if (typeof res.writeHead === 'function') res.writeHead(204, optHeaders);
    return res.end();
  }
  if (method !== 'GET' && method !== 'HEAD') {
    return sendJson(res, 405, { error: 'طريقة الطلب غير مدعومة.', code: 'METHOD_NOT_ALLOWED' }, { Allow: 'GET, HEAD, OPTIONS' });
  }

  const activeModel =
    process.env.ZAD_MODEL && process.env.ZAD_MODEL.trim() ? process.env.ZAD_MODEL.trim() : ZAD_MODEL;
  const keyFingerprint = getKeyFingerprint(deps);
  const cooldownKey = `${keyFingerprint}:${activeModel}`;
  const existingCooldown = upstreamCooldowns.get(cooldownKey);
  let cooldown = null;
  if (existingCooldown) {
    if (existingCooldown.until > currentNow) {
      cooldown = {
        code: existingCooldown.code,
        retryAfterSeconds: Math.max(1, Math.ceil((existingCooldown.until - currentNow) / 1000)),
        until: existingCooldown.until,
      };
    } else {
      upstreamCooldowns.delete(cooldownKey);
    }
  }

  const dailyTokenLimit =
    deps && Number.isFinite(Number(deps.dailyTokenLimit)) && Number(deps.dailyTokenLimit) > 0
      ? Math.round(Number(deps.dailyTokenLimit))
      : getDailyTokenLimit();
  const resetAt = ZadUsage.getNextPacificMidnightMs(currentNow);
  const apkInfo = resolveApkDownloadUrl({
    env: deps && deps.env,
    rootDir: deps && deps.rootDir,
  });

  return sendJson(res, 200, {
    name: 'زاد',
    welcomeMessage: ZAD_WELCOME_MESSAGE,
    quickPrompts: ZAD_QUICK_PROMPTS,
    dailyTokenLimit,
    resetAt,
    resetTimezone: ZadUsage.RESET_TIMEZONE,
    cooldown,
    apkUrl: apkInfo.url,
    apkFilename: apkInfo.filename,
  });
}

function handleApkDownload(req, res, deps) {
  const method = req && req.method ? String(req.method).toUpperCase() : 'GET';
  if (method === 'OPTIONS') {
    const optHeaders = { ...CORS_HEADERS, Allow: 'GET, HEAD, OPTIONS' };
    if (typeof res.setHeader === 'function') {
      for (const [k, v] of Object.entries(optHeaders)) {
        res.setHeader(k, v);
      }
    }
    if (typeof res.status === 'function' && typeof res.end === 'function') {
      return res.status(204).end();
    }
    if (typeof res.writeHead === 'function') res.writeHead(204, optHeaders);
    return res.end();
  }
  if (method !== 'GET' && method !== 'HEAD') {
    return sendJson(res, 405, { error: 'طريقة الطلب غير مدعومة.', code: 'METHOD_NOT_ALLOWED' }, { Allow: 'GET, HEAD, OPTIONS' });
  }

  const info = resolveApkDownloadUrl({
    env: deps && deps.env,
    rootDir: deps && deps.rootDir,
  });

  let format = req && req.query && req.query.format ? String(req.query.format) : '';
  if (!format && req && req.url) {
    try {
      const parsed = new URL(req.url, 'http://localhost');
      format = parsed.searchParams.get('format') || '';
    } catch {}
  }

  if (format === 'json') {
    return sendJson(res, 200, {
      available: Boolean(info.url),
      url: info.url,
      source: info.source,
      filename: info.filename,
    });
  }

  if (!info.url) {
    return sendJson(res, 404, {
      available: false,
      error: 'ملف APK غير متاح للتنزيل المباشر بعد.',
      code: 'APK_NOT_CONFIGURED',
    });
  }

  if (typeof res.setHeader === 'function') {
    for (const [k, v] of Object.entries(CORS_HEADERS)) {
      res.setHeader(k, v);
    }
    res.setHeader('Location', info.url);
    res.setHeader('Cache-Control', 'no-cache');
  }
  if (typeof res.status === 'function' && typeof res.end === 'function') {
    return res.status(302).end();
  }
  if (typeof res.writeHead === 'function') {
    res.writeHead(302, {
      ...CORS_HEADERS,
      Location: info.url,
      'Cache-Control': 'no-cache',
    });
  }
  return res.end();
}

async function handleZadChat(req, res, deps) {
  const now = deps && typeof deps.now === 'function' ? deps.now : () => Date.now();
  const startedAt = now();
  const method = req && req.method ? String(req.method).toUpperCase() : 'POST';
  if (method === 'OPTIONS') {
    const optHeaders = { ...CORS_HEADERS, Allow: 'POST, OPTIONS' };
    if (typeof res.setHeader === 'function') {
      for (const [k, v] of Object.entries(optHeaders)) {
        res.setHeader(k, v);
      }
    }
    if (typeof res.status === 'function' && typeof res.end === 'function') {
      return res.status(204).end();
    }
    if (typeof res.writeHead === 'function') res.writeHead(204, optHeaders);
    return res.end();
  }
  if (method !== 'POST') {
    return sendJson(res, 405, { error: 'طريقة الطلب غير مدعومة.', code: 'METHOD_NOT_ALLOWED' }, { Allow: 'POST, OPTIONS' });
  }

  const parsed = await readJsonBody(req);
  if (!parsed.ok) {
    return sendJson(res, parsed.status, { error: parsed.error, code: 'INVALID_REQUEST' });
  }

  const check = validateChatRequest(parsed.body);
  if (!check.ok) {
    return sendJson(res, check.status, { error: check.error, code: 'INVALID_REQUEST' });
  }

  const headerReqId =
    req && req.headers
      ? req.headers['idempotency-key'] || req.headers['Idempotency-Key']
      : '';
  const requestId =
    normalizeRequestId(headerReqId) ||
    normalizeRequestId(parsed.body && parsed.body.requestId) ||
    '';

  const userId = normalizeRequestId(parsed.body && parsed.body.userId);
  const dailyTokenLimit =
    deps && Number.isFinite(Number(deps.dailyTokenLimit)) && Number(deps.dailyTokenLimit) > 0
      ? Math.round(Number(deps.dailyTokenLimit))
      : getDailyTokenLimit();
  const currentNow = now();
  const dayKey = ZadUsage.getPacificDayKey(currentNow);
  const resetAt = ZadUsage.getNextPacificMidnightMs(currentNow);

  const resolveClient = deps && typeof deps.getClient === 'function' ? deps.getClient : getAiClient;
  const activeModel =
    process.env.ZAD_MODEL && process.env.ZAD_MODEL.trim() ? process.env.ZAD_MODEL.trim() : ZAD_MODEL;
  const keyFingerprint = getKeyFingerprint(deps);
  const cooldownKey = `${keyFingerprint}:${activeModel}`;

  const existingCooldown = upstreamCooldowns.get(cooldownKey);
  if (existingCooldown) {
    if (existingCooldown.until > now()) {
      const retryAfterSeconds = Math.max(1, Math.ceil((existingCooldown.until - now()) / 1000));
      console.warn(
        JSON.stringify({
          event: 'zad_chat_cooldown',
          requestId: requestId || undefined,
          status: 429,
          code: existingCooldown.code,
          source: 'zad_limiter',
          retryAfterSeconds,
          durationMs: now() - startedAt,
        })
      );
      return sendJson(
        res,
        429,
        {
          error: existingCooldown.error,
          code: existingCooldown.code,
          source: 'zad_limiter',
          retryAfterSeconds,
          resetAt,
          dailyTokenLimit,
        },
        { 'Retry-After': String(retryAfterSeconds) }
      );
    }
    upstreamCooldowns.delete(cooldownKey);
  }

  const userUsageKey = userId ? `${cooldownKey}:${dayKey}:${userId}` : '';
  if (userUsageKey) {
    const usedSoFar = userDailyUsage.get(userUsageKey) || 0;
    if (usedSoFar >= dailyTokenLimit) {
      const retryAfterSeconds = Math.max(1, Math.ceil((resetAt - now()) / 1000));
      return sendJson(
        res,
        429,
        {
          error: 'تم استهلاك الحد اليومي المتاح من التوكنز. يرجى الانتظار حتى يتجدد الحد اليومي.',
          code: 'USER_DAILY_LIMIT',
          source: 'zad_limiter',
          retryAfterSeconds,
          resetAt,
          dailyTokenLimit,
        },
        { 'Retry-After': String(retryAfterSeconds) }
      );
    }
  }

  const dedupeKey = requestId ? `${cooldownKey}:${requestId}` : '';

  const executeChat = async () => {
    try {
      const ai = resolveClient();
      const contents = buildGeminiContents(check.history, check.message);
      const response = await generateWithRetry(
        ai,
        {
          model: activeModel,
          contents,
          config: {
            systemInstruction: ZAD_SYSTEM_INSTRUCTION,
            thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
          },
        },
        { sleep: deps && deps.sleep }
      );

      const reply = typeof response.text === 'string' ? response.text.trim() : '';
      if (!reply) {
        return {
          status: 502,
          payload: {
            error: 'لم يصل رد واضح من مساعد زاد. يرجى المحاولة مرة أخرى.',
            code: 'EMPTY_RESPONSE',
            source: 'gemini',
          },
        };
      }

      const usage = extractUsageMetadata(response);
      if (userUsageKey && usage.totalTokens > 0) {
        const prevUsed = userDailyUsage.get(userUsageKey) || 0;
        userDailyUsage.set(userUsageKey, prevUsed + usage.totalTokens);
      }

      return {
        status: 200,
        payload: {
          reply,
          usage,
          dailyTokenLimit,
          resetAt,
        },
      };
    } catch (err) {
      const mapped = mapGeminiError(err);
      const retryCount = err && typeof err._retryCount === 'number' ? err._retryCount : 0;
      const headers = {};
      const payload = {
        error: mapped.error,
        code: mapped.code,
        source: mapped.source,
        dailyTokenLimit,
        resetAt,
      };

      if (mapped.status === 429) {
        const retryAfterSeconds = mapped.retryAfterSeconds || DEFAULT_RATE_LIMIT_COOLDOWN_SECONDS;
        const cappedCooldown = Math.min(MAX_COOLDOWN_SECONDS, Math.max(1, retryAfterSeconds));
        upstreamCooldowns.set(cooldownKey, {
          until: now() + cappedCooldown * 1000,
          code: mapped.code,
          error: mapped.error,
        });
        payload.retryAfterSeconds = retryAfterSeconds;
        headers['Retry-After'] = String(retryAfterSeconds);
      }

      console.error(
        JSON.stringify({
          event: 'zad_chat_error',
          requestId: requestId || undefined,
          status: mapped.status,
          code: mapped.code,
          source: mapped.source,
          retryCount,
          retryAfterSeconds: payload.retryAfterSeconds,
          durationMs: now() - startedAt,
        })
      );

      return { status: mapped.status, payload, headers };
    }
  };

  let outcome;
  if (dedupeKey && inFlightRequests.has(dedupeKey)) {
    outcome = await inFlightRequests.get(dedupeKey);
  } else if (dedupeKey) {
    const promise = executeChat().finally(() => {
      inFlightRequests.delete(dedupeKey);
    });
    inFlightRequests.set(dedupeKey, promise);
    outcome = await promise;
  } else {
    outcome = await executeChat();
  }

  return sendJson(res, outcome.status, outcome.payload, outcome.headers);
}

module.exports = {
  getAiClient,
  generateWithRetry,
  readJsonBody,
  sendJson,
  handleZadConfig,
  handleApkDownload,
  handleZadChat,
  resetZadServiceState,
};
