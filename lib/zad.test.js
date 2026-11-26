const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ZAD_MODEL,
  ZAD_WELCOME_MESSAGE,
  ZAD_REFUSAL_MESSAGE,
  ZAD_QUICK_PROMPTS,
  ZAD_APP_KNOWLEDGE,
  ZAD_SYSTEM_INSTRUCTION,
  MAX_MESSAGE_LENGTH,
  MAX_HISTORY_ITEMS,
  normalizeHistory,
  normalizeRequestId,
  parseRetryAfterSeconds,
  validateChatRequest,
  buildGeminiContents,
  mapGeminiError,
} = require('./zad');

const { formatZadMarkup, escapeHtml, getDefaultFabPos, clampFabPos } = require('./zad-format');
const ZadHistory = require('./zad-history');

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
const {
  getAiClient,
  generateWithRetry,
  handleZadChat,
  resetZadServiceState,
} = require('./zad-service');
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

test('buildStaticDist creates complete Vercel dist directory with root, sw, formatter, history, and Zad logo', () => {
  const rootDir = path.resolve(__dirname, '..');
  const distDir = buildStaticDist(rootDir);
  assert.ok(fs.existsSync(path.join(distDir, 'index.html')));
  assert.ok(fs.existsSync(path.join(distDir, 'sw.js')));
  assert.ok(fs.existsSync(path.join(distDir, 'lib', 'zad-format.js')));
  assert.ok(fs.existsSync(path.join(distDir, 'lib', 'zad-history.js')));
  assert.ok(
    fs.existsSync(
      path.join(distDir, 'assets', 'aistudio', 'file_00000000ab4c81f4a4f16195c38363ee_a5eaba5d.png')
    )
  );
  const vercelCfg = JSON.parse(fs.readFileSync(path.join(rootDir, 'vercel.json'), 'utf8'));
  assert.equal(vercelCfg.outputDirectory, 'dist');
});

test('parseRetryAfterSeconds and mapGeminiError classify Google Free Tier 20 RPD quota cleanly', () => {
  const realGoogleErr = {
    status: 429,
    message:
      '{"error":{"code":429,"message":"You exceeded your current quota... Please retry in 11h34m46.100851308s.","status":"RESOURCE_EXHAUSTED","details":[{"quotaId":"GenerateRequestsPerDayPerProjectPerModel-FreeTier","quotaValue":"20"},{"@type":"type.googleapis.com/google.rpc.RetryInfo","retryDelay":"41686s"}]}}',
  };

  assert.equal(parseRetryAfterSeconds(realGoogleErr), 41686);
  const mapped = mapGeminiError(realGoogleErr);
  assert.equal(mapped.status, 429);
  assert.equal(mapped.code, 'QUOTA_EXHAUSTED');
  assert.equal(mapped.source, 'gemini');
  assert.equal(mapped.retryAfterSeconds, 41686);
  assert.ok(mapped.error.includes('الحد اليومي'));

  assert.equal(
    parseRetryAfterSeconds({ headers: { get: (k) => (k === 'retry-after' ? '42' : null) }, message: '' }),
    42
  );
  assert.equal(
    parseRetryAfterSeconds({ message: 'Please retry in 2m15.2s.' }),
    136
  );
  assert.equal(normalizeRequestId('req_123-abc.456'), 'req_123-abc.456');
  assert.equal(normalizeRequestId('bad id with spaces!'), '');
});

test('getAiClient trims API key and disables SDK internal retry storm (attempts=1)', () => {
  resetZadServiceState();
  const prevKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = '  test-key-with-whitespace \n';
  try {
    const client = getAiClient();
    assert.equal(client.apiClient.getApiKey(), 'test-key-with-whitespace');
    const httpOpts = client.apiClient.clientOptions.httpOptions;
    assert.equal(httpOpts.retryOptions.attempts, 1);
  } finally {
    resetZadServiceState();
    if (prevKey !== undefined) process.env.GEMINI_API_KEY = prevKey;
    else delete process.env.GEMINI_API_KEY;
  }
});

test('generateWithRetry never retries 4xx/RESOURCE_EXHAUSTED and retries transient 503 once', async () => {
  let calls429 = 0;
  const mock429 = {
    models: {
      async generateContent() {
        calls429++;
        const err = new Error('RESOURCE_EXHAUSTED');
        err.status = 429;
        throw err;
      },
    },
  };
  await assert.rejects(() => generateWithRetry(mock429, {}, { sleep: async () => {} }));
  assert.equal(calls429, 1);

  let calls503 = 0;
  const mock503 = {
    models: {
      async generateContent() {
        calls503++;
        if (calls503 === 1) {
          const err = new Error('UNAVAILABLE');
          err.status = 503;
          throw err;
        }
        return { text: 'تمت الإجابة' };
      },
    },
  };
  const ok = await generateWithRetry(mock503, {}, { sleep: async () => {} });
  assert.equal(calls503, 2);
  assert.equal(ok.text, 'تمت الإجابة');
});

test('handleZadChat deduplicates concurrent in-flight requestId calls', async () => {
  resetZadServiceState();
  let upstreamCalls = 0;
  const mockClient = {
    models: {
      async generateContent() {
        upstreamCalls++;
        await new Promise((r) => setTimeout(r, 25));
        return { text: 'جواب موحد' };
      },
    },
  };

  const makeReq = () => ({
    method: 'POST',
    headers: { 'idempotency-key': 'dup-req-001' },
    body: { message: 'ما فضل الذكر؟', history: [] },
  });

  const res1 = createMockRes();
  const res2 = createMockRes();
  await Promise.all([
    handleZadChat(makeReq(), res1, { getClient: () => mockClient, keyFingerprint: 'fp-dedupe' }),
    handleZadChat(makeReq(), res2, { getClient: () => mockClient, keyFingerprint: 'fp-dedupe' }),
  ]);

  assert.equal(upstreamCalls, 1);
  assert.equal(res1.statusCode, 200);
  assert.equal(res2.statusCode, 200);
  assert.equal(res1.body.reply, 'جواب موحد');
  assert.equal(res2.body.reply, 'جواب موحد');
});

test('handleZadChat enforces Retry-After cooldown after 429 and resets when API key fingerprint changes', async () => {
  resetZadServiceState();
  let clock = 1_000_000;
  let upstreamCalls = 0;

  const failingClient = {
    models: {
      async generateContent() {
        upstreamCalls++;
        const err = new Error('{"error":{"code":429,"status":"RESOURCE_EXHAUSTED","details":[{"quotaId":"GenerateRequestsPerDayPerProjectPerModel-FreeTier"},{"retryDelay":"120s"}]}}');
        err.status = 429;
        throw err;
      },
    },
  };
  const workingClient = {
    models: {
      async generateContent() {
        upstreamCalls++;
        return { text: 'تم التبديل بنجاح' };
      },
    },
  };

  const r1 = createMockRes();
  await handleZadChat(
    { method: 'POST', body: { message: 'سؤال ١' } },
    r1,
    { getClient: () => failingClient, keyFingerprint: 'key-old', now: () => clock }
  );
  assert.equal(r1.statusCode, 429);
  assert.equal(r1.body.code, 'QUOTA_EXHAUSTED');
  assert.equal(r1.body.source, 'gemini');
  assert.equal(r1.body.retryAfterSeconds, 120);
  assert.equal(r1.headers['Retry-After'], '120');
  assert.equal(upstreamCalls, 1);

  // Advance 30s -> still in cooldown, must short-circuit without calling upstream
  clock += 30_000;
  const r2 = createMockRes();
  await handleZadChat(
    { method: 'POST', body: { message: 'سؤال ٢' } },
    r2,
    { getClient: () => failingClient, keyFingerprint: 'key-old', now: () => clock }
  );
  assert.equal(r2.statusCode, 429);
  assert.equal(r2.body.source, 'zad_limiter');
  assert.equal(r2.body.retryAfterSeconds, 90);
  assert.equal(r2.headers['Retry-After'], '90');
  assert.equal(upstreamCalls, 1);

  // Rotating key fingerprint bypasses old key cooldown immediately
  const r3 = createMockRes();
  await handleZadChat(
    { method: 'POST', body: { message: 'سؤال ٣' } },
    r3,
    { getClient: () => workingClient, keyFingerprint: 'key-new', now: () => clock }
  );
  assert.equal(r3.statusCode, 200);
  assert.equal(r3.body.reply, 'تم التبديل بنجاح');
  assert.equal(upstreamCalls, 2);
});

test('Zad embeds Hassana application knowledge base and strict dual-domain contextual intent rules', () => {
  assert.ok(ZAD_APP_KNOWLEDGE.includes('فاستبقوا الخيرات'));
  assert.ok(ZAD_APP_KNOWLEDGE.includes('ختمة القرآن'));
  assert.ok(ZAD_APP_KNOWLEDGE.includes('114 سورة'));
  assert.ok(ZAD_APP_KNOWLEDGE.includes('المسبحة'));
  assert.ok(ZAD_APP_KNOWLEDGE.includes('التقويم الهجري'));
  assert.ok(ZAD_APP_KNOWLEDGE.includes('مواقيت الصلاة'));
  assert.ok(ZAD_APP_KNOWLEDGE.includes('لا يوجد إعداد لتغيير لغة الواجهة'));
  assert.ok(ZAD_SYSTEM_INSTRUCTION.includes(ZAD_APP_KNOWLEDGE));
  assert.ok(ZAD_SYSTEM_INSTRUCTION.includes('كيف أستخدم المسبحة'));
  assert.ok(ZAD_SYSTEM_INSTRUCTION.includes('كيف أبرمج تطبيق مسبحة'));
  assert.ok(ZAD_SYSTEM_INSTRUCTION.includes('How do I change the app language?'));
  assert.ok(ZAD_SYSTEM_INSTRUCTION.includes('How do I implement language switching in JavaScript?'));
  assert.ok(ZAD_REFUSAL_MESSAGE.includes('تطبيق حسنة'));
});

function createMemoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial).map(([k, v]) => [k, JSON.stringify(v)]));
  return {
    getItem(k) {
      return map.has(k) ? map.get(k) : null;
    },
    setItem(k, v) {
      map.set(k, String(v));
    },
  };
}

test('ZadHistory generates meaningful titles, strips greetings, and truncates cleanly', () => {
  assert.equal(ZadHistory.generateConversationTitle('   '), ZadHistory.DEFAULT_CONVERSATION_TITLE);
  assert.equal(
    ZadHistory.generateConversationTitle('السلام عليكم ورحمة الله وبركاته يا زاد، كيف أصلي صلاة الاستخارة؟'),
    'كيف أصلي صلاة الاستخارة؟'
  );
  const longTitle = ZadHistory.generateConversationTitle(
    'من فضلك ما هو فضل قراءة سورة الكهف يوم الجمعة وما الآيات المستحب تدبرها في الصباح والمساء؟'
  );
  assert.ok(longTitle.endsWith('…'));
  assert.ok(longTitle.length <= 44);
});

test('ZadHistory persists per-user isolated conversations, migrates legacy messages, and supports delete/clear', () => {
  const storage = createMemoryStorage({
    zad_msgs: [
      { role: 'user', text: 'السلام عليكم، ما هي أذكار الصباح؟' },
      { role: 'model', text: 'أذكار الصباح تشمل آية الكرسي والمعوذات.' },
    ],
  });

  const userA = ZadHistory.getOrCreateUserId(storage);
  assert.ok(userA.startsWith('u_'));
  assert.equal(ZadHistory.getOrCreateUserId(storage), userA);

  let storeA = ZadHistory.loadStore(storage, userA, 1000);
  assert.equal(storeA.conversations.length, 1);
  assert.equal(storeA.conversations[0].title, 'ما هي أذكار الصباح؟');
  const conv1Id = storeA.activeId;

  // Start a fresh second conversation -> context must be strictly isolated
  storeA = ZadHistory.createConversation(storeA, 2000);
  const conv2Id = storeA.activeId;
  assert.notEqual(conv2Id, conv1Id);
  assert.deepEqual(ZadHistory.getConversationMessages(storeA, conv2Id), []);

  storeA = ZadHistory.appendMessage(storeA, conv2Id, { role: 'user', text: 'كيف أستخدم المسبحة في حسنة؟' }, 2100);
  storeA = ZadHistory.appendMessage(storeA, conv2Id, { role: 'model', text: 'افتح تبويب المسبحة بالأسفل.' }, 2200);
  ZadHistory.saveStore(storage, userA, storeA, 2200);

  // Re-load from storage as if after page refresh
  const reloaded = ZadHistory.loadStore(storage, userA, 3000);
  assert.equal(reloaded.conversations.length, 2);
  assert.equal(reloaded.activeId, conv2Id);

  // Reopen first conversation -> exact isolated messages restored
  const switched = ZadHistory.selectConversation(reloaded, conv1Id, 3100);
  assert.equal(switched.activeId, conv1Id);
  assert.equal(ZadHistory.getConversationMessages(switched, conv1Id).length, 2);
  assert.equal(ZadHistory.getConversationMessages(switched, conv1Id)[0].text, 'السلام عليكم، ما هي أذكار الصباح؟');
  assert.equal(ZadHistory.getConversationMessages(switched, conv2Id)[0].text, 'كيف أستخدم المسبحة في حسنة؟');

  // Different user ID is isolated from userA (note: empty store for userB ignores already-migrated or keeps separate key)
  const storeB = ZadHistory.saveStore(storage, 'u_other_user', ZadHistory.clearHistory(), 3200);
  assert.equal(storeB.conversations.length, 0);
  assert.equal(ZadHistory.loadStore(storage, userA, 3300).conversations.length, 2);

  // Delete single conversation
  const afterDel = ZadHistory.deleteConversation(switched, conv1Id, 3400);
  assert.equal(afterDel.conversations.length, 1);
  assert.equal(afterDel.activeId, conv2Id);

  // Clear entire history
  const cleared = ZadHistory.clearHistory();
  ZadHistory.saveStore(storage, userA, cleared, 3500);
  assert.equal(ZadHistory.loadStore(storage, userA, 3600).conversations.length, 0);
});
