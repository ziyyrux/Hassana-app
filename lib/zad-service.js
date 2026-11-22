const { GoogleGenAI, ThinkingLevel } = require('@google/genai');
const {
  ZAD_MODEL,
  ZAD_WELCOME_MESSAGE,
  ZAD_QUICK_PROMPTS,
  ZAD_SYSTEM_INSTRUCTION,
  validateChatRequest,
  buildGeminiContents,
  mapGeminiError,
} = require('./zad');

const MAX_BODY_BYTES = 1024 * 1024;
let cachedClient = null;
let cachedKey = null;

function getAiClient() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || !apiKey.trim()) {
    throw new Error('MISSING_API_KEY');
  }
  if (!cachedClient || cachedKey !== apiKey) {
    cachedKey = apiKey;
    cachedClient = new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    });
  }
  return cachedClient;
}

async function generateWithRetry(ai, params) {
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await ai.models.generateContent(params);
    } catch (err) {
      lastErr = err;
      const status = err && (err.status || err.statusCode || err.code);
      if (status && status >= 400 && status < 500) {
        throw err;
      }
      if (attempt === 0) {
        await new Promise((r) => setTimeout(r, 400));
      }
    }
  }
  throw lastErr;
}

function sendJson(res, statusCode, payload, extraHeaders) {
  if (extraHeaders && typeof res.setHeader === 'function') {
    for (const [k, v] of Object.entries(extraHeaders)) {
      res.setHeader(k, v);
    }
  }
  if (typeof res.status === 'function' && typeof res.json === 'function') {
    return res.status(statusCode).json(payload);
  }
  if (typeof res.writeHead === 'function') {
    res.writeHead(statusCode, {
      'Content-Type': 'application/json; charset=utf-8',
      ...(extraHeaders || {}),
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

function handleZadConfig(req, res) {
  const method = req && req.method ? String(req.method).toUpperCase() : 'GET';
  if (method === 'OPTIONS') {
    if (typeof res.setHeader === 'function') {
      res.setHeader('Allow', 'GET, HEAD, OPTIONS');
    }
    if (typeof res.status === 'function' && typeof res.end === 'function') {
      return res.status(204).end();
    }
    if (typeof res.writeHead === 'function') res.writeHead(204);
    return res.end();
  }
  if (method !== 'GET' && method !== 'HEAD') {
    return sendJson(res, 405, { error: 'طريقة الطلب غير مدعومة.', code: 'METHOD_NOT_ALLOWED' }, { Allow: 'GET, HEAD, OPTIONS' });
  }
  return sendJson(res, 200, {
    name: 'زاد',
    welcomeMessage: ZAD_WELCOME_MESSAGE,
    quickPrompts: ZAD_QUICK_PROMPTS,
  });
}

async function handleZadChat(req, res, deps) {
  const method = req && req.method ? String(req.method).toUpperCase() : 'POST';
  if (method === 'OPTIONS') {
    if (typeof res.setHeader === 'function') {
      res.setHeader('Allow', 'POST, OPTIONS');
    }
    if (typeof res.status === 'function' && typeof res.end === 'function') {
      return res.status(204).end();
    }
    if (typeof res.writeHead === 'function') res.writeHead(204);
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

  const resolveClient = deps && typeof deps.getClient === 'function' ? deps.getClient : getAiClient;
  const activeModel =
    process.env.ZAD_MODEL && process.env.ZAD_MODEL.trim() ? process.env.ZAD_MODEL.trim() : ZAD_MODEL;

  try {
    const ai = resolveClient();
    const contents = buildGeminiContents(check.history, check.message);
    const response = await generateWithRetry(ai, {
      model: activeModel,
      contents,
      config: {
        systemInstruction: ZAD_SYSTEM_INSTRUCTION,
        thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
      },
    });

    const reply = typeof response.text === 'string' ? response.text.trim() : '';
    if (!reply) {
      return sendJson(res, 502, {
        error: 'لم يصل رد واضح من مساعد زاد. يرجى المحاولة مرة أخرى.',
        code: 'EMPTY_RESPONSE',
      });
    }

    return sendJson(res, 200, { reply });
  } catch (err) {
    const mapped = mapGeminiError(err);
    console.error('[Zad API Error]', mapped.code, err && err.message ? err.message : err);
    return sendJson(res, mapped.status, { error: mapped.error, code: mapped.code });
  }
}

module.exports = {
  getAiClient,
  generateWithRetry,
  readJsonBody,
  sendJson,
  handleZadConfig,
  handleZadChat,
};
