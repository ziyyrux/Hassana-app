const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ZAD_MODEL,
  ZAD_WELCOME_MESSAGE,
  ZAD_REFUSAL_MESSAGE,
  ZAD_QUICK_PROMPTS,
  ZAD_SYSTEM_INSTRUCTION,
  MAX_MESSAGE_LENGTH,
  MAX_HISTORY_ITEMS,
  normalizeHistory,
  validateChatRequest,
  buildGeminiContents,
  mapGeminiError,
} = require('./zad');

const { formatZadMarkup, escapeHtml, getDefaultFabPos, clampFabPos } = require('./zad-format');

test('Zad identity, scope, and reliability rules are embedded in system instruction', () => {
  assert.equal(ZAD_MODEL, 'gemini-4-hydrogen');
  assert.ok(ZAD_WELCOME_MESSAGE.includes('زاد'));
  assert.ok(ZAD_WELCOME_MESSAGE.includes('مساعد حسنة'));
  assert.ok(ZAD_REFUSAL_MESSAGE.includes('الإسلام والقرآن الكريم والسنة النبوية والأذكار والأدعية'));
  assert.equal(ZAD_QUICK_PROMPTS.length, 6);
  assert.ok(ZAD_SYSTEM_INSTRUCTION.includes('زاد'));
  assert.ok(ZAD_SYSTEM_INSTRUCTION.includes('صحيح البخاري وصحيح مسلم'));
  assert.ok(ZAD_SYSTEM_INSTRUCTION.includes('لا أعلم'));
  assert.ok(ZAD_SYSTEM_INSTRUCTION.includes(ZAD_REFUSAL_MESSAGE));
});

test('validateChatRequest validates empty, missing, overlong, and valid payloads', () => {
  assert.equal(validateChatRequest(null).ok, false);
  assert.equal(validateChatRequest({ message: '   ' }).ok, false);
  assert.equal(validateChatRequest({ message: 'أ'.repeat(MAX_MESSAGE_LENGTH + 1) }).ok, false);

  const valid = validateChatRequest({
    message: '  ما هو دعاء الاستخارة؟  ',
    history: [{ role: 'user', text: 'السلام عليكم' }],
  });
  assert.equal(valid.ok, true);
  assert.equal(valid.message, 'ما هو دعاء الاستخارة؟');
  assert.equal(valid.history.length, 1);
});

test('normalizeHistory filters invalid turns, maps assistant to model, and caps length', () => {
  const raw = [
    null,
    { role: 'system', text: 'ignore' },
    { role: 'user', text: '  ' },
    { role: 'assistant', text: 'وعليكم السلام' },
    ...Array.from({ length: 20 }, (_, i) => ({ role: 'user', text: `سؤال ${i}` })),
  ];
  const out = normalizeHistory(raw);
  assert.equal(out.length, MAX_HISTORY_ITEMS);
  assert.equal(out[0].text, 'سؤال 4');
});

test('buildGeminiContents appends the new user turn after history', () => {
  const contents = buildGeminiContents(
    [
      { role: 'user', text: 'أول سؤال' },
      { role: 'model', text: 'أول جواب' },
    ],
    'ثاني سؤال'
  );
  assert.equal(contents.length, 3);
  assert.deepEqual(contents[2], { role: 'user', parts: [{ text: 'ثاني سؤال' }] });
});

test('mapGeminiError maps missing key, invalid key, rate limit, unavailable, network, and fallback errors', () => {
  assert.equal(mapGeminiError(new Error('MISSING_API_KEY')).status, 503);
  assert.equal(mapGeminiError({ status: 403, message: 'PERMISSION_DENIED' }).status, 401);
  assert.equal(mapGeminiError({ status: 429, message: 'RESOURCE_EXHAUSTED' }).status, 429);
  assert.equal(mapGeminiError({ status: 503, message: 'UNAVAILABLE' }).code, 'SERVICE_UNAVAILABLE');
  assert.equal(mapGeminiError(new Error('fetch failed')).code, 'NETWORK_ERROR');
  assert.equal(mapGeminiError(new Error('unexpected failure')).status, 502);
});

test('formatZadMarkup escapes HTML and formats Quranic verses, citations, lists, and sources', () => {
  const unsafe = escapeHtml('<script>alert(1)</script>');
  assert.equal(unsafe, '&lt;script&gt;alert(1)&lt;/script&gt;');

  const formatted = formatZadMarkup(
    'قال الله تعالى: ﴿رَبَّنَا آتِنَا فِي الدُّنْيَا حَسَنَةً﴾ [سورة البقرة: 201]\n\n**فائدة:**\n- داوم على الذكر.\n\nالمصادر والمراجع:\n- سورة البقرة: آية 201.'
  );
  assert.ok(formatted.includes('<span class="zq">﴿رَبَّنَا آتِنَا فِي الدُّنْيَا حَسَنَةً﴾</span>'));
  assert.ok(formatted.includes('<span class="zref">[سورة البقرة: 201]</span>'));
  assert.ok(formatted.includes('<strong>فائدة:</strong>'));
  assert.ok(formatted.includes('<ul><li>'));
  assert.ok(formatted.includes('<div class="zsrc"><p class="zsrc-t">المصادر والمراجع</p>'));
  assert.ok(!formatted.includes('<script>'));
});

test('clampFabPos and getDefaultFabPos keep floating button safely inside viewport bounds', () => {
  const defMobile = getDefaultFabPos(390, 844);
  assert.equal(defMobile.x, 16);
  assert.equal(defMobile.y, 694);

  const defDesktop = getDefaultFabPos(1440, 900);
  assert.ok(defDesktop.x >= 420 && defDesktop.x <= 450);
  assert.equal(defDesktop.y, 750);

  const clampedOut = clampFabPos({ x: -100, y: 2000 }, 390, 844);
  assert.deepEqual(clampedOut, { x: 12, y: 694 });

  const preserved = clampFabPos({ x: 240, y: 310 }, 390, 844);
  assert.deepEqual(preserved, { x: 240, y: 310 });
});

const fs = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');
const configHandler = require('../api/zad/config');
const chatHandler = require('../api/zad/chat');
const { handleZadChat } = require('./zad-service');
const { buildStaticDist } = require('../scripts/build');

function createMockRes() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    ended: false,
    setHeader(k, v) {
      this.headers[k] = v;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(data) {
      this.body = data;
      this.ended = true;
      return this;
    },
    end(chunk) {
      if (chunk !== undefined && this.body === null) {
        try {
          this.body = JSON.parse(String(chunk));
        } catch {
          this.body = String(chunk);
        }
      }
      this.ended = true;
      return this;
    },
  };
}

test('Vercel serverless /api/zad/config returns config on GET and rejects POST', () => {
  const getRes = createMockRes();
  configHandler({ method: 'GET' }, getRes);
  assert.equal(getRes.statusCode, 200);
  assert.equal(getRes.body.name, 'زاد');
  assert.equal(getRes.body.quickPrompts.length, 6);

  const postRes = createMockRes();
  configHandler({ method: 'POST' }, postRes);
  assert.equal(postRes.statusCode, 405);
  assert.equal(postRes.body.code, 'METHOD_NOT_ALLOWED');
});

test('Vercel serverless /api/zad/chat validates method, body, and missing API key cleanly', async () => {
  const getRes = createMockRes();
  await chatHandler({ method: 'GET' }, getRes);
  assert.equal(getRes.statusCode, 405);

  const badJsonReq = Readable.from(['{invalid json']);
  badJsonReq.method = 'POST';
  const badJsonRes = createMockRes();
  await chatHandler(badJsonReq, badJsonRes);
  assert.equal(badJsonRes.statusCode, 400);
  assert.equal(badJsonRes.body.code, 'INVALID_REQUEST');

  const emptyReq = { method: 'POST', body: { message: '   ' } };
  const emptyRes = createMockRes();
  await chatHandler(emptyReq, emptyRes);
  assert.equal(emptyRes.statusCode, 400);

  const prevKey = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  try {
    const noKeyReq = { method: 'POST', body: { message: 'ما هو دعاء الاستخارة؟' } };
    const noKeyRes = createMockRes();
    await chatHandler(noKeyReq, noKeyRes);
    assert.equal(noKeyRes.statusCode, 503);
    assert.equal(noKeyRes.body.code, 'MISSING_API_KEY');
  } finally {
    if (prevKey !== undefined) process.env.GEMINI_API_KEY = prevKey;
  }
});

test('handleZadChat invokes Gemini client with Zad system instruction and returns reply', async () => {
  let capturedParams = null;
  const mockClient = {
    models: {
      async generateContent(params) {
        capturedParams = params;
        return { text: 'وعليكم السلام ورحمة الله وبركاته 🌿' };
      },
    },
  };

  const rawBodyReq = Readable.from([
    JSON.stringify({
      message: 'ما هي أذكار الصباح؟',
      history: [{ role: 'assistant', text: 'مرحبًا' }],
    }),
  ]);
  rawBodyReq.method = 'POST';
  const res = createMockRes();

  await handleZadChat(rawBodyReq, res, { getClient: () => mockClient });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.reply, 'وعليكم السلام ورحمة الله وبركاته 🌿');
  assert.equal(capturedParams.model, ZAD_MODEL);
  assert.equal(capturedParams.contents.length, 2);
  assert.equal(capturedParams.config.systemInstruction, ZAD_SYSTEM_INSTRUCTION);
});

test('buildStaticDist creates complete Vercel dist directory with root, sw, formatter, and Zad logo', () => {
  const rootDir = path.resolve(__dirname, '..');
  const distDir = buildStaticDist(rootDir);
  assert.ok(fs.existsSync(path.join(distDir, 'index.html')));
  assert.ok(fs.existsSync(path.join(distDir, 'sw.js')));
  assert.ok(fs.existsSync(path.join(distDir, 'lib', 'zad-format.js')));
  assert.ok(
    fs.existsSync(
      path.join(distDir, 'assets', 'aistudio', 'file_00000000ab4c81f4a4f16195c38363ee_a5eaba5d.png')
    )
  );
  const vercelCfg = JSON.parse(fs.readFileSync(path.join(rootDir, 'vercel.json'), 'utf8'));
  assert.equal(vercelCfg.outputDirectory, 'dist');
});
