const express = require('express');
const path = require('path');
const { GoogleGenAI, ThinkingLevel } = require('@google/genai');
const {
  ZAD_MODEL,
  ZAD_WELCOME_MESSAGE,
  ZAD_QUICK_PROMPTS,
  ZAD_SYSTEM_INSTRUCTION,
  validateChatRequest,
  buildGeminiContents,
  mapGeminiError,
} = require('./lib/zad');

const app = express();
const PORT = Number(process.env.PORT) || 3000;

app.use(express.json({ limit: '1mb' }));

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

app.get('/api/zad/config', (req, res) => {
  res.json({
    name: 'زاد',
    welcomeMessage: ZAD_WELCOME_MESSAGE,
    quickPrompts: ZAD_QUICK_PROMPTS,
  });
});

app.post('/api/zad/chat', async (req, res) => {
  const check = validateChatRequest(req.body);
  if (!check.ok) {
    return res.status(check.status).json({ error: check.error, code: 'INVALID_REQUEST' });
  }

  try {
    const ai = getAiClient();
    const contents = buildGeminiContents(check.history, check.message);
    const response = await generateWithRetry(ai, {
      model: ZAD_MODEL,
      contents,
      config: {
        systemInstruction: ZAD_SYSTEM_INSTRUCTION,
        thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
      },
    });

    const reply = typeof response.text === 'string' ? response.text.trim() : '';
    if (!reply) {
      return res.status(502).json({
        error: 'لم يصل رد واضح من مساعد زاد. يرجى المحاولة مرة أخرى.',
        code: 'EMPTY_RESPONSE',
      });
    }

    return res.json({ reply });
  } catch (err) {
    const mapped = mapGeminiError(err);
    console.error('[Zad API Error]', mapped.code, err && err.message ? err.message : err);
    return res.status(mapped.status).json({ error: mapped.error, code: mapped.code });
  }
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('/sw.js', (req, res) => {
  res.sendFile(path.join(__dirname, 'sw.js'));
});

app.get('/lib/zad-format.js', (req, res) => {
  res.sendFile(path.join(__dirname, 'lib', 'zad-format.js'));
});

app.get(['/', '/index.html'], (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.use('/api', (req, res) => {
  res.status(404).json({ error: 'المسار غير موجود.' });
});

app.use((req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Hassana app listening on http://0.0.0.0:${PORT}`);
});
