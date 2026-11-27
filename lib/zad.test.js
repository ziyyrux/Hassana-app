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
  DEFAULT_DAILY_TOKEN_LIMIT,
  getDailyTokenLimit,
  extractUsageMetadata,
  normalizeHistory,
  normalizeRequestId,
  parseRetryAfterSeconds,
  validateChatRequest,
  buildGeminiContents,
  mapGeminiError,
} = require('./zad');

const { formatZadMarkup, escapeHtml, getDefaultFabPos, clampFabPos } = require('./zad-format');
const ZadHistory = require('./zad-history');
const ZadUsage = require('./zad-usage');

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

test('Vercel serverless /api/zad/config returns config with token limit, resetAt, and rejects POST', () => {
  resetZadServiceState();
  const getRes = createMockRes();
  configHandler({ method: 'GET' }, getRes);
  assert.equal(getRes.statusCode, 200);
  assert.equal(getRes.body.name, 'زاد');
  assert.equal(getRes.body.quickPrompts.length, 6);
  assert.equal(getRes.body.dailyTokenLimit, DEFAULT_DAILY_TOKEN_LIMIT);
  assert.ok(Number.isFinite(getRes.body.resetAt) && getRes.body.resetAt > Date.now());
  assert.equal(getRes.body.cooldown, null);

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

test('buildStaticDist creates complete Vercel dist directory with root, sw, formatter, history, usage, and Zad logo', () => {
  const rootDir = path.resolve(__dirname, '..');
  const distDir = buildStaticDist(rootDir);
  assert.ok(fs.existsSync(path.join(distDir, 'index.html')));
  assert.ok(fs.existsSync(path.join(distDir, 'sw.js')));
  assert.ok(fs.existsSync(path.join(distDir, 'lib', 'zad-format.js')));
  assert.ok(fs.existsSync(path.join(distDir, 'lib', 'zad-history.js')));
  assert.ok(fs.existsSync(path.join(distDir, 'lib', 'zad-usage.js')));
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
  assert.ok(!/Secrets|Settings|API|Free Tier|مفتاح/i.test(mapped.error));
  assert.ok(!/Secrets|Settings|API|مفتاح/i.test(mapGeminiError(new Error('MISSING_API_KEY')).error));
  assert.ok(!/Secrets|Settings|API|مفتاح/i.test(mapGeminiError({ status: 401, message: 'API_KEY_INVALID' }).error));

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

test('extractUsageMetadata normalizes Gemini token counts accurately', () => {
  const full = extractUsageMetadata({
    usageMetadata: {
      promptTokenCount: 4100,
      candidatesTokenCount: 620,
      thoughtsTokenCount: 80,
      totalTokenCount: 4800,
    },
  });
  assert.deepEqual(full, {
    promptTokens: 4100,
    candidatesTokens: 620,
    thoughtsTokens: 80,
    totalTokens: 4800,
  });

  const computedTotal = extractUsageMetadata({
    usageMetadata: { promptTokenCount: 300, candidatesTokenCount: 150 },
  });
  assert.equal(computedTotal.totalTokens, 450);
  assert.equal(extractUsageMetadata({}).totalTokens, 0);
});

test('ZadUsage tracks daily remaining tokens, computes Pacific midnight reset, and resets on new day', () => {
  const storage = createMemoryStorage();
  // 2026-11-26T14:58:30-08:00 -> 2026-11-26T22:58:30Z (PST, UTC-8)
  const t1 = Date.parse('2026-11-26T22:58:30Z');
  assert.equal(ZadUsage.getPacificDayKey(t1), '2026-11-26');
  const nextMidnight = ZadUsage.getNextPacificMidnightMs(t1);
  // Next PT midnight is 2026-11-27T00:00:00-08:00 = 2026-11-27T08:00:00Z
  assert.equal(nextMidnight, Date.parse('2026-11-27T08:00:00Z'));

  let st = ZadUsage.loadUsage(storage, 'u_test', 10000, t1);
  assert.equal(ZadUsage.getUsageSummary(st, t1).remainingTokens, 10000);

  st = ZadUsage.recordUsage(st, { promptTokens: 3200, candidatesTokens: 800, totalTokens: 4000 }, 10000, t1 + 1000);
  ZadUsage.saveUsage(storage, 'u_test', st, t1 + 1000);

  const summary = ZadUsage.getUsageSummary(ZadUsage.loadUsage(storage, 'u_test', 10000, t1 + 2000), t1 + 2000);
  assert.equal(summary.remainingTokens, 6000);
  assert.equal(summary.percentRemaining, 60);
  assert.ok(ZadUsage.formatRemainingResetTime(summary.msUntilReset).includes('س'));

  // After Pacific midnight -> resets automatically to full quota
  const afterReset = nextMidnight + 5000;
  const resetSummary = ZadUsage.getUsageSummary(
    ZadUsage.loadUsage(storage, 'u_test', 10000, afterReset),
    afterReset
  );
  assert.equal(resetSummary.dayKey, '2026-11-27');
  assert.equal(resetSummary.remainingTokens, 10000);
  assert.equal(resetSummary.usedTokens, 0);
});

test('handleZadChat returns usage metadata and enforces per-user daily token limit on warm instances', async () => {
  resetZadServiceState();
  const clock = Date.parse('2026-11-26T22:00:00Z');
  let calls = 0;
  const mockClient = {
    models: {
      async generateContent() {
        calls++;
        return {
          text: 'جواب من زاد',
          usageMetadata: {
            promptTokenCount: 400,
            candidatesTokenCount: 200,
            totalTokenCount: 600,
          },
        };
      },
    },
  };

  const res1 = createMockRes();
  await handleZadChat(
    { method: 'POST', body: { message: 'سؤال ١', userId: 'u_quota_test' } },
    res1,
    { getClient: () => mockClient, keyFingerprint: 'fp-quota', dailyTokenLimit: 500, now: () => clock }
  );
  assert.equal(res1.statusCode, 200);
  assert.equal(res1.body.usage.totalTokens, 600);
  assert.equal(res1.body.dailyTokenLimit, 500);
  assert.equal(calls, 1);

  // Second request for same userId exceeds 500 dailyTokenLimit -> short-circuited before calling Gemini
  const res2 = createMockRes();
  await handleZadChat(
    { method: 'POST', body: { message: 'سؤال ٢', userId: 'u_quota_test' } },
    res2,
    { getClient: () => mockClient, keyFingerprint: 'fp-quota', dailyTokenLimit: 500, now: () => clock + 1000 }
  );
  assert.equal(res2.statusCode, 429);
  assert.equal(res2.body.code, 'USER_DAILY_LIMIT');
  assert.equal(calls, 1);

  // Different userId is unaffected
  const res3 = createMockRes();
  await handleZadChat(
    { method: 'POST', body: { message: 'سؤال ٣', userId: 'u_other' } },
    res3,
    { getClient: () => mockClient, keyFingerprint: 'fp-quota', dailyTokenLimit: 500, now: () => clock + 2000 }
  );
  assert.equal(res3.statusCode, 200);
  assert.equal(calls, 2);
});

test('Zad endpoints send CORS headers and handle OPTIONS preflight for Android WebView', async () => {
  const { handleZadConfig } = require('./zad-service');
  const optCfg = createMockRes();
  handleZadConfig({ method: 'OPTIONS' }, optCfg);
  assert.equal(optCfg.statusCode, 204);
  assert.equal(optCfg.headers['Access-Control-Allow-Origin'], '*');

  const getCfg = createMockRes();
  handleZadConfig({ method: 'GET' }, getCfg);
  assert.equal(getCfg.statusCode, 200);
  assert.equal(getCfg.headers['Access-Control-Allow-Origin'], '*');

  const optChat = createMockRes();
  await handleZadChat({ method: 'OPTIONS' }, optChat);
  assert.equal(optChat.statusCode, 204);
  assert.equal(optChat.headers['Access-Control-Allow-Origin'], '*');
  assert.ok(optChat.headers['Access-Control-Allow-Headers'].includes('Idempotency-Key'));
});

test('Static PWA manifest, icons, Capacitor config, and Android APK build helpers work cleanly', () => {
  const rootDir = path.resolve(__dirname, '..');
  const manifest = JSON.parse(fs.readFileSync(path.join(rootDir, 'public', 'manifest.json'), 'utf8'));
  assert.equal(manifest.name, 'حسنة – صدقة جارية');
  assert.equal(manifest.dir, 'rtl');
  assert.equal(manifest.icons.length, 3);
  for (const ic of manifest.icons) {
    assert.ok(fs.existsSync(path.join(rootDir, 'public', ic.src.replace(/^\//, ''))));
  }
  assert.ok(fs.existsSync(path.join(rootDir, 'public', 'icons', 'apple-touch-icon.png')));

  const capCfg = JSON.parse(fs.readFileSync(path.join(rootDir, 'capacitor.config.json'), 'utf8'));
  assert.equal(capCfg.appId, 'com.hassana.app');
  assert.equal(capCfg.webDir, 'dist');
  assert.equal(capCfg.server.androidScheme, 'https');

  const workflowPath = path.join(rootDir, '.github', 'workflows', 'build-apk.yml');
  assert.ok(fs.existsSync(workflowPath));
  const wf = fs.readFileSync(workflowPath, 'utf8');
  assert.ok(wf.includes('android-actions/setup-android@v4'));
  assert.ok(wf.includes('platform-tools'));
  assert.ok(wf.includes('platforms;android-34'));
  assert.ok(wf.includes('build-tools;34.0.0'));
  assert.ok(wf.includes('sdkmanager --licenses'));
  assert.ok(wf.includes('@capacitor/local-notifications@6'));
  const packagesMatch = wf.match(/packages:\s*([^\n]+)/);
  assert.ok(packagesMatch);
  const packageTokens = packagesMatch[1].trim().split(/\s+/);
  assert.ok(!packageTokens.includes('tools'));
  assert.ok(wf.includes('assembleDebug'));
  assert.ok(wf.includes('Hassana-Android.apk'));

  assert.ok(capCfg.plugins && capCfg.plugins.LocalNotifications);
  assert.equal(capCfg.plugins.LocalNotifications.smallIcon, 'ic_stat_hassana');

  const {
    normalizeApiOrigin,
    injectApiOriginIntoHtml,
    patchAndroidManifestXml,
    prepareApkDist,
  } = require('../scripts/build-apk');

  assert.equal(normalizeApiOrigin('https://hassana.vercel.app/api'), 'https://hassana.vercel.app');
  assert.equal(normalizeApiOrigin('javascript:alert(1)'), '');

  const injected = injectApiOriginIntoHtml(
    '<head><meta name="zad-api-origin" content=""></head>',
    'https://hassana.vercel.app/'
  );
  assert.ok(injected.includes('<meta name="zad-api-origin" content="https://hassana.vercel.app">'));

  const patchedManifest = patchAndroidManifestXml(
    '<manifest><application android:label="حسنة"></application></manifest>'
  );
  assert.ok(patchedManifest.includes('android.permission.ACCESS_FINE_LOCATION'));
  assert.ok(patchedManifest.includes('android.permission.ACCESS_COARSE_LOCATION'));
  assert.ok(patchedManifest.includes('android.permission.POST_NOTIFICATIONS'));
  assert.ok(patchedManifest.includes('android.permission.SCHEDULE_EXACT_ALARM'));
  assert.ok(patchedManifest.includes('android.permission.RECEIVE_BOOT_COMPLETED'));
  assert.ok(patchedManifest.includes('android:supportsRtl="true"'));

  const { distDir } = prepareApkDist(rootDir, 'https://hassana.vercel.app');
  assert.ok(fs.existsSync(path.join(distDir, 'manifest.json')));
  assert.ok(fs.existsSync(path.join(distDir, 'icons', 'icon-512.png')));
  assert.ok(fs.existsSync(path.join(distDir, 'lib', 'zad-notifications.js')));
  const distIndex = fs.readFileSync(path.join(distDir, 'index.html'), 'utf8');
  assert.ok(distIndex.includes('content="https://hassana.vercel.app"'));
  // Restore clean relative dist for local web serving
  buildStaticDist(rootDir);
});

test('ZadNotifications normalizes settings, schedules prayer & daily reminders, and detects due web alerts', () => {
  const ZadNotifications = require('./zad-notifications');
  const storage = createMemoryStorage();

  const defaults = ZadNotifications.loadSettings(storage);
  assert.equal(defaults.enabled, false);
  assert.equal(defaults.prayer.offsetMinutes, 0);

  const normalized = ZadNotifications.saveSettings(storage, {
    enabled: true,
    prayer: {
      enabled: true,
      offsetMinutes: 10,
      prayers: { fajr: true, dhuhr: false, asr: true, maghrib: true, isha: false },
    },
    morning: { enabled: true, time: '6:05' },
    evening: { enabled: true, time: '17:15' },
    sleep: { enabled: false, time: '99:99' },
    khetma: { enabled: true, time: '20:45' },
    fridaySalawat: { enabled: true, time: '10:00' },
  });
  assert.equal(normalized.prayer.offsetMinutes, 10);
  assert.equal(normalized.morning.time, '06:05');
  assert.equal(normalized.sleep.time, '22:30');
  assert.equal(normalized.khetma.time, '20:45');

  const reloaded = ZadNotifications.loadSettings(storage);
  assert.equal(reloaded.enabled, true);
  assert.equal(reloaded.prayer.prayers.dhuhr, false);

  // Friday Nov 27, 2026 at 04:00 local time
  const baseDate = new Date(2026, 10, 27, 4, 0, 0, 0);
  const getDayPrayers = (d) => {
    const y = d.getFullYear(), m = d.getMonth(), day = d.getDate();
    return {
      fajr: new Date(y, m, day, 5, 30, 0, 0).getTime(),
      sunrise: new Date(y, m, day, 6, 50, 0, 0).getTime(),
      dhuhr: new Date(y, m, day, 12, 10, 0, 0).getTime(),
      asr: new Date(y, m, day, 15, 20, 0, 0).getTime(),
      maghrib: new Date(y, m, day, 17, 45, 0, 0).getTime(),
      isha: new Date(y, m, day, 19, 10, 0, 0).getTime(),
    };
  };

  const plan = ZadNotifications.buildScheduledPlan({
    settings: reloaded,
    getDayPrayers,
    nowMs: baseDate.getTime(),
    daysAhead: 3,
  });

  // 3 days * 3 enabled prayers (fajr, asr, maghrib) = 9 prayer alerts + 4 daily/weekly reminders (morning, evening, khetma, fridaySalawat) = 13
  assert.equal(plan.length, 13);
  const firstPrayer = plan[0];
  assert.equal(firstPrayer.title, 'اقترب وقت صلاة الفجر');
  assert.ok(firstPrayer.body.includes('10 دقائق'));
  assert.equal(firstPrayer.schedule.at.getHours(), 5);
  assert.equal(firstPrayer.schedule.at.getMinutes(), 20); // 5:30 - 10m

  const fridayAlert = plan.find((n) => n.id === 2005);
  assert.ok(fridayAlert);
  assert.equal(fridayAlert.schedule.on.weekday, 6);

  // Due web check at 05:20:15 (10 min before Fajr)
  const sentMap = {};
  const dueAtFajrAlert = ZadNotifications.getDueWebNotifications({
    settings: reloaded,
    getDayPrayers,
    nowMs: new Date(2026, 10, 27, 5, 20, 15, 0).getTime(),
    sentMap,
  });
  assert.equal(dueAtFajrAlert.length, 1);
  assert.equal(dueAtFajrAlert[0].title, 'اقترب وقت صلاة الفجر');
  sentMap[dueAtFajrAlert[0].dedupeKey] = 1;
  assert.equal(
    ZadNotifications.getDueWebNotifications({
      settings: reloaded,
      getDayPrayers,
      nowMs: new Date(2026, 10, 27, 5, 20, 45, 0).getTime(),
      sentMap,
    }).length,
    0
  );

  // Due web check at 10:00:10 on Friday -> Friday Salawat
  const dueFriday = ZadNotifications.getDueWebNotifications({
    settings: reloaded,
    getDayPrayers,
    nowMs: new Date(2026, 10, 27, 10, 0, 10, 0).getTime(),
    sentMap,
  });
  assert.equal(dueFriday.length, 1);
  assert.ok(dueFriday[0].title.includes('يوم الجمعة'));
});

test('APK download resolution, /api/apk handler, and GitHub Release publishing work cleanly', async () => {
  const os = require('node:os');
  const rootDir = path.resolve(__dirname, '..');
  const {
    normalizeApkUrl,
    resolveApkDownloadUrl,
    injectApkUrlIntoHtml,
  } = require('./apk-config');
  const { handleApkDownload, handleZadConfig } = require('./zad-service');
  const { buildStaticDist } = require('../scripts/build');

  assert.equal(normalizeApkUrl('javascript:alert(1)'), '');
  assert.equal(normalizeApkUrl('//evil.example/a.apk'), '');
  assert.equal(normalizeApkUrl('/Hassana-Android.apk'), '/Hassana-Android.apk');
  assert.equal(
    normalizeApkUrl('https://github.com/ziad/Hassana-app/releases/latest/download/Hassana-Android.apk'),
    'https://github.com/ziad/Hassana-app/releases/latest/download/Hassana-Android.apk'
  );

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hassana-apk-test-'));
  try {
    fs.mkdirSync(path.join(tmpRoot, 'public'), { recursive: true });

    const fromGitEnv = resolveApkDownloadUrl({
      rootDir: tmpRoot,
      env: {
        VERCEL_GIT_PROVIDER: 'github',
        VERCEL_GIT_REPO_OWNER: 'ziad',
        VERCEL_GIT_REPO_SLUG: 'Hassana-app',
      },
    });
    assert.equal(fromGitEnv.source, 'github_release');
    assert.equal(
      fromGitEnv.url,
      'https://github.com/ziad/Hassana-app/releases/latest/download/Hassana-Android.apk'
    );

    const fromExplicitEnv = resolveApkDownloadUrl({
      rootDir: tmpRoot,
      env: {
        HASSANA_APK_URL: 'https://cdn.example.com/Hassana-Android.apk',
        VERCEL_GIT_PROVIDER: 'github',
        VERCEL_GIT_REPO_OWNER: 'ziad',
        VERCEL_GIT_REPO_SLUG: 'Hassana-app',
      },
    });
    assert.equal(fromExplicitEnv.source, 'env');
    assert.equal(fromExplicitEnv.url, 'https://cdn.example.com/Hassana-Android.apk');

    const injected = injectApkUrlIntoHtml(
      '<head><meta name="hassana-apk-url" content=""></head>',
      fromGitEnv.url
    );
    assert.ok(injected.includes(`content="${fromGitEnv.url}"`));

    // Local public/Hassana-Android.apk detection
    fs.writeFileSync(path.join(tmpRoot, 'public', 'Hassana-Android.apk'), 'apk-bytes');
    const fromLocal = resolveApkDownloadUrl({ rootDir: tmpRoot, env: {} });
    assert.equal(fromLocal.source, 'local');
    assert.equal(fromLocal.url, '/Hassana-Android.apk');
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }

  // Test /api/apk?format=json, 302 redirect, and 404 when not configured
  const jsonRes = createMockRes();
  handleApkDownload(
    { method: 'GET', url: '/api/apk?format=json' },
    jsonRes,
    {
      env: {
        VERCEL_GIT_PROVIDER: 'github',
        VERCEL_GIT_REPO_OWNER: 'ziad',
        VERCEL_GIT_REPO_SLUG: 'Hassana-app',
      },
      rootDir: os.tmpdir(),
    }
  );
  assert.equal(jsonRes.statusCode, 200);
  assert.equal(jsonRes.body.available, true);

  const redirectRes = createMockRes();
  handleApkDownload(
    { method: 'GET', url: '/api/apk' },
    redirectRes,
    {
      env: { HASSANA_APK_URL: 'https://example.com/Hassana-Android.apk' },
      rootDir: os.tmpdir(),
    }
  );
  assert.equal(redirectRes.statusCode, 302);
  assert.equal(redirectRes.headers.Location, 'https://example.com/Hassana-Android.apk');

  const missingRes = createMockRes();
  handleApkDownload(
    { method: 'GET', url: '/api/apk' },
    missingRes,
    { env: {}, rootDir: os.tmpdir() }
  );
  assert.equal(missingRes.statusCode, 404);
  assert.equal(missingRes.body.code, 'APK_NOT_CONFIGURED');

  const cfgRes = createMockRes();
  handleZadConfig(
    { method: 'GET' },
    cfgRes,
    { env: { HASSANA_APK_URL: 'https://example.com/Hassana-Android.apk' }, rootDir: os.tmpdir() }
  );
  assert.equal(cfgRes.statusCode, 200);
  assert.equal(cfgRes.body.apkUrl, 'https://example.com/Hassana-Android.apk');

  // Verify buildStaticDist injects meta when HASSANA_APK_URL is set during Vercel build
  const prevApkEnv = process.env.HASSANA_APK_URL;
  process.env.HASSANA_APK_URL = 'https://example.com/Hassana-Android.apk';
  try {
    const distDir = buildStaticDist(rootDir);
    const html = fs.readFileSync(path.join(distDir, 'index.html'), 'utf8');
    assert.ok(html.includes('<meta name="hassana-apk-url" content="https://example.com/Hassana-Android.apk">'));
  } finally {
    if (prevApkEnv === undefined) delete process.env.HASSANA_APK_URL;
    else process.env.HASSANA_APK_URL = prevApkEnv;
    buildStaticDist(rootDir);
  }

  // Verify workflow has release upload + push fallback API origin
  const wf = fs.readFileSync(path.join(rootDir, '.github', 'workflows', 'build-apk.yml'), 'utf8');
  assert.ok(wf.includes('contents: write'));
  assert.ok(wf.includes('gh release'));
  assert.ok(wf.includes("vars.HASSANA_API_ORIGIN || 'https://hassana-sandy.vercel.app'"));
});



