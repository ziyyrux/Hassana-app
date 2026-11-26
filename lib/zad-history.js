(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.ZadHistory = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const USER_ID_STORAGE_KEY = 'zad_uid';
  const STORE_KEY_PREFIX = 'zad_chats_v1:';
  const LEGACY_MSGS_KEY = 'zad_msgs';
  const DEFAULT_CONVERSATION_TITLE = 'محادثة جديدة';
  const MAX_CONVERSATIONS = 40;
  const MAX_MESSAGES_PER_CONV = 40;
  const MAX_TITLE_LENGTH = 42;

  const GREETING_PATTERNS = [
    /^السلام\s+عليكم(?:\s+ورحمة\s+الله(?:\s+وبركاته)?)?[،,!؟.\s-]*/i,
    /^وعليكم\s+السلام(?:\s+ورحمة\s+الله(?:\s+وبركاته)?)?[،,!؟.\s-]*/i,
    /^(?:مرحبًا|مرحبا|أهلًا|أهلا|اهلا|اهلاً|حياك\s+الله|صباح\s+الخير|مساء\s+الخير)[،,!؟.\s-]*/i,
    /^(?:يا\s+زاد|يا\s+مساعد(?:\s+حسنة)?|زاد)[،,:!؟.\s-]+/i,
    /^(?:لو\s+سمحت|من\s+فضلك|فضلاً|فضلا|أرجوك|ممكن|أريد\s+أن\s+أسأل(?:\s+عن)?|عندي\s+سؤال(?:\s+عن)?|هل\s+يمكنك(?:\s+مساعدتي\s+في)?)[،,:!؟.\s-]*/i,
    /^(?:assalamu\s*alaikum|salam(?:\s*alaikum)?|hello|hi|hey|bonjour|salut)\b[,\s!?:.-]*/i,
  ];

  function createId(prefix) {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return `${prefix}_${crypto.randomUUID()}`;
    }
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  }

  function readRaw(storage, key) {
    if (!storage || typeof storage.getItem !== 'function') return null;
    try {
      const val = storage.getItem(key);
      return val === null ? null : JSON.parse(val);
    } catch {
      return null;
    }
  }

  function writeRaw(storage, key, val) {
    if (!storage || typeof storage.setItem !== 'function') return false;
    try {
      storage.setItem(key, JSON.stringify(val));
      return true;
    } catch {
      return false;
    }
  }

  function sanitizeUserId(raw) {
    if (typeof raw !== 'string') return '';
    const trimmed = raw.trim();
    if (!trimmed || trimmed.length > 80) return '';
    return /^[A-Za-z0-9_.:-]+$/.test(trimmed) ? trimmed : '';
  }

  function getOrCreateUserId(storage) {
    const existing = sanitizeUserId(readRaw(storage, USER_ID_STORAGE_KEY));
    if (existing) return existing;
    const next = createId('u');
    writeRaw(storage, USER_ID_STORAGE_KEY, next);
    return next;
  }

  function getUserStorageKey(userId) {
    const clean = sanitizeUserId(userId) || 'default';
    return `${STORE_KEY_PREFIX}${clean}`;
  }

  function generateConversationTitle(text) {
    if (typeof text !== 'string') return DEFAULT_CONVERSATION_TITLE;
    const collapsed = text.replace(/\s+/g, ' ').trim();
    if (!collapsed) return DEFAULT_CONVERSATION_TITLE;

    let cleaned = collapsed;
    let changed = true;
    let passes = 0;
    while (changed && passes < 5) {
      changed = false;
      passes++;
      for (const rx of GREETING_PATTERNS) {
        const next = cleaned.replace(rx, '').trim();
        if (next !== cleaned) {
          cleaned = next;
          changed = true;
        }
      }
    }

    cleaned = cleaned.replace(/^[،,:;.؟!?\-\s]+/, '').trim();
    const candidate = cleaned || collapsed;
    if (!candidate || /^[،,:;.؟!?\-\s]+$/.test(candidate)) {
      return DEFAULT_CONVERSATION_TITLE;
    }

    if (candidate.length <= MAX_TITLE_LENGTH) {
      return candidate;
    }

    const slice = candidate.slice(0, MAX_TITLE_LENGTH);
    const lastSpace = slice.lastIndexOf(' ');
    const cut = lastSpace >= 16 ? slice.slice(0, lastSpace) : slice;
    return `${cut.replace(/[،,:;.؟!?\-\s]+$/, '').trim()}…`;
  }

  function sanitizeMessage(msg) {
    if (!msg || typeof msg !== 'object') return null;
    const role = msg.role === 'model' || msg.role === 'assistant' ? 'model' : msg.role === 'user' ? 'user' : null;
    const text = typeof msg.text === 'string' ? msg.text.trim() : '';
    if (!role || !text) return null;
    return {
      role,
      text,
      ts: Number.isFinite(Number(msg.ts)) && Number(msg.ts) > 0 ? Number(msg.ts) : undefined,
    };
  }

  function inferTitleFromMessages(messages, existingTitle) {
    const cleanTitle = typeof existingTitle === 'string' ? existingTitle.trim() : '';
    if (cleanTitle && cleanTitle !== DEFAULT_CONVERSATION_TITLE) {
      return cleanTitle.slice(0, MAX_TITLE_LENGTH + 4);
    }
    const firstUser = messages.find((m) => m.role === 'user');
    return firstUser ? generateConversationTitle(firstUser.text) : DEFAULT_CONVERSATION_TITLE;
  }

  function sanitizeConversation(conv, now) {
    if (!conv || typeof conv !== 'object') return null;
    const id = typeof conv.id === 'string' && conv.id.trim() ? conv.id.trim() : createId('c');
    const rawMsgs = Array.isArray(conv.messages) ? conv.messages : [];
    const messages = rawMsgs.map(sanitizeMessage).filter(Boolean).slice(-MAX_MESSAGES_PER_CONV);
    const createdAt = Number.isFinite(Number(conv.createdAt)) && Number(conv.createdAt) > 0 ? Number(conv.createdAt) : now;
    const updatedAt = Number.isFinite(Number(conv.updatedAt)) && Number(conv.updatedAt) > 0 ? Number(conv.updatedAt) : createdAt;
    const title = inferTitleFromMessages(messages, conv.title);
    return { id, title, createdAt, updatedAt, messages };
  }

  function sortConversations(list) {
    return list.slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }

  function normalizeStore(raw, now) {
    const ts = typeof now === 'number' && Number.isFinite(now) ? now : Date.now();
    const rawList = raw && Array.isArray(raw.conversations) ? raw.conversations : [];
    const seen = new Set();
    const conversations = [];
    for (const item of rawList) {
      const clean = sanitizeConversation(item, ts);
      if (!clean || seen.has(clean.id)) continue;
      seen.add(clean.id);
      conversations.push(clean);
    }
    const sorted = sortConversations(conversations).slice(0, MAX_CONVERSATIONS);
    let activeId = raw && typeof raw.activeId === 'string' && seen.has(raw.activeId) ? raw.activeId : null;
    if (!activeId && sorted.length > 0) {
      activeId = sorted[0].id;
    }
    return {
      version: 1,
      activeId,
      conversations: sorted,
    };
  }

  function loadStore(storage, userId, now) {
    const ts = typeof now === 'number' && Number.isFinite(now) ? now : Date.now();
    const uid = sanitizeUserId(userId) || getOrCreateUserId(storage);
    const key = getUserStorageKey(uid);
    const saved = readRaw(storage, key);
    if (saved && typeof saved === 'object' && Array.isArray(saved.conversations)) {
      return normalizeStore(saved, ts);
    }

    const legacy = readRaw(storage, LEGACY_MSGS_KEY);
    if (Array.isArray(legacy) && legacy.length > 0) {
      const cleanMsgs = legacy.map(sanitizeMessage).filter(Boolean).slice(-MAX_MESSAGES_PER_CONV);
      if (cleanMsgs.length > 0) {
        const conv = {
          id: createId('c'),
          title: inferTitleFromMessages(cleanMsgs, DEFAULT_CONVERSATION_TITLE),
          createdAt: ts,
          updatedAt: ts,
          messages: cleanMsgs,
        };
        const migrated = { version: 1, activeId: conv.id, conversations: [conv] };
        writeRaw(storage, key, migrated);
        return migrated;
      }
    }

    return { version: 1, activeId: null, conversations: [] };
  }

  function saveStore(storage, userId, store, now) {
    const uid = sanitizeUserId(userId) || getOrCreateUserId(storage);
    const clean = normalizeStore(store, now);
    writeRaw(storage, getUserStorageKey(uid), clean);
    return clean;
  }

  function getActiveConversation(store) {
    if (!store || !Array.isArray(store.conversations) || !store.activeId) return null;
    return store.conversations.find((c) => c.id === store.activeId) || null;
  }

  function getConversationMessages(store, convId) {
    if (!store || !Array.isArray(store.conversations)) return [];
    const targetId = convId || store.activeId;
    if (!targetId) return [];
    const found = store.conversations.find((c) => c.id === targetId);
    if (!found || !Array.isArray(found.messages)) return [];
    return found.messages.map((m) => ({ role: m.role, text: m.text }));
  }

  function createConversation(store, now) {
    const ts = typeof now === 'number' && Number.isFinite(now) ? now : Date.now();
    const base = normalizeStore(store, ts);
    const existingActive = getActiveConversation(base);
    if (existingActive && existingActive.messages.length === 0) {
      return base;
    }
    const nonEmpty = base.conversations.filter((c) => c.messages.length > 0);
    const conv = {
      id: createId('c'),
      title: DEFAULT_CONVERSATION_TITLE,
      createdAt: ts,
      updatedAt: ts,
      messages: [],
    };
    return {
      version: 1,
      activeId: conv.id,
      conversations: [conv, ...nonEmpty].slice(0, MAX_CONVERSATIONS),
    };
  }

  function selectConversation(store, convId, now) {
    const base = normalizeStore(store, now);
    const target = base.conversations.find((c) => c.id === convId);
    if (!target) return base;
    const cleaned = base.conversations.filter((c) => c.id === convId || c.messages.length > 0);
    return {
      version: 1,
      activeId: target.id,
      conversations: cleaned,
    };
  }

  function appendMessage(store, convId, msg, now) {
    const ts = typeof now === 'number' && Number.isFinite(now) ? now : Date.now();
    const cleanMsg = sanitizeMessage({ ...msg, ts: msg && msg.ts ? msg.ts : ts });
    if (!cleanMsg) return normalizeStore(store, ts);

    const base = normalizeStore(store, ts);
    let targetId = convId && base.conversations.some((c) => c.id === convId) ? convId : base.activeId;
    let conversations = base.conversations.map((c) => ({ ...c, messages: c.messages.slice() }));

    if (!targetId) {
      const created = {
        id: createId('c'),
        title: DEFAULT_CONVERSATION_TITLE,
        createdAt: ts,
        updatedAt: ts,
        messages: [],
      };
      conversations = [created, ...conversations];
      targetId = created.id;
    }

    const idx = conversations.findIndex((c) => c.id === targetId);
    const target = conversations[idx];
    const nextMsgs = [...target.messages, cleanMsg].slice(-MAX_MESSAGES_PER_CONV);
    const nextTitle =
      target.title === DEFAULT_CONVERSATION_TITLE && cleanMsg.role === 'user'
        ? generateConversationTitle(cleanMsg.text)
        : target.title;

    conversations[idx] = {
      ...target,
      title: nextTitle,
      updatedAt: ts,
      messages: nextMsgs,
    };

    return {
      version: 1,
      activeId: targetId,
      conversations: sortConversations(conversations).slice(0, MAX_CONVERSATIONS),
    };
  }

  function deleteConversation(store, convId, now) {
    const base = normalizeStore(store, now);
    const remaining = base.conversations.filter((c) => c.id !== convId);
    let nextActive = base.activeId;
    if (nextActive === convId) {
      nextActive = remaining.length > 0 ? remaining[0].id : null;
    }
    return {
      version: 1,
      activeId: nextActive,
      conversations: remaining,
    };
  }

  function clearHistory() {
    return {
      version: 1,
      activeId: null,
      conversations: [],
    };
  }

  function formatConversationDate(ts, now) {
    const target = Number(ts);
    if (!Number.isFinite(target) || target <= 0) return '';
    const ref = typeof now === 'number' && Number.isFinite(now) ? now : Date.now();
    const d = new Date(target);
    const r = new Date(ref);
    const sameDay =
      d.getFullYear() === r.getFullYear() &&
      d.getMonth() === r.getMonth() &&
      d.getDate() === r.getDate();
    if (sameDay) return 'اليوم';
    const yesterday = new Date(r.getFullYear(), r.getMonth(), r.getDate() - 1);
    if (
      d.getFullYear() === yesterday.getFullYear() &&
      d.getMonth() === yesterday.getMonth() &&
      d.getDate() === yesterday.getDate()
    ) {
      return 'أمس';
    }
    try {
      return d.toLocaleDateString('ar-u-nu-latn', { month: 'short', day: 'numeric' });
    } catch {
      return `${d.getDate()}/${d.getMonth() + 1}`;
    }
  }

  return {
    USER_ID_STORAGE_KEY,
    STORE_KEY_PREFIX,
    LEGACY_MSGS_KEY,
    DEFAULT_CONVERSATION_TITLE,
    MAX_CONVERSATIONS,
    MAX_MESSAGES_PER_CONV,
    getOrCreateUserId,
    getUserStorageKey,
    generateConversationTitle,
    loadStore,
    saveStore,
    getActiveConversation,
    getConversationMessages,
    createConversation,
    selectConversation,
    appendMessage,
    deleteConversation,
    clearHistory,
    formatConversationDate,
  };
});
