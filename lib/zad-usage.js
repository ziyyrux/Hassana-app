(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.ZadUsage = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const DEFAULT_DAILY_TOKEN_LIMIT = 100000;
  const USAGE_KEY_PREFIX = 'zad_usage_v1:';
  const RESET_TIMEZONE = 'America/Los_Angeles';

  function sanitizeUserId(raw) {
    if (typeof raw !== 'string') return '';
    const trimmed = raw.trim();
    if (!trimmed || trimmed.length > 80) return '';
    return /^[A-Za-z0-9_.:-]+$/.test(trimmed) ? trimmed : '';
  }

  function getUsageStorageKey(userId) {
    const clean = sanitizeUserId(userId) || 'default';
    return `${USAGE_KEY_PREFIX}${clean}`;
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

  function normalizeLimit(limit) {
    const num = Number(limit);
    if (!Number.isFinite(num) || num <= 0) return DEFAULT_DAILY_TOKEN_LIMIT;
    return Math.round(num);
  }

  function getTimeZoneParts(ms, timeZone) {
    const d = new Date(ms);
    try {
      const fmt = new Intl.DateTimeFormat('en-US', {
        timeZone: timeZone || RESET_TIMEZONE,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23',
      });
      const parts = fmt.formatToParts(d);
      const out = {};
      for (const p of parts) {
        if (p.type !== 'literal') out[p.type] = Number(p.value);
      }
      if (out.hour === 24) out.hour = 0;
      if (
        Number.isFinite(out.year) &&
        Number.isFinite(out.month) &&
        Number.isFinite(out.day) &&
        Number.isFinite(out.hour) &&
        Number.isFinite(out.minute) &&
        Number.isFinite(out.second)
      ) {
        return out;
      }
    } catch {
      // Fallback to UTC if Intl timezone formatting is unavailable
    }
    return {
      year: d.getUTCFullYear(),
      month: d.getUTCMonth() + 1,
      day: d.getUTCDate(),
      hour: d.getUTCHours(),
      minute: d.getUTCMinutes(),
      second: d.getUTCSeconds(),
    };
  }

  function pad2(n) {
    return String(n).padStart(2, '0');
  }

  function getPacificDayKey(now) {
    const ts = typeof now === 'number' && Number.isFinite(now) ? now : Date.now();
    const p = getTimeZoneParts(ts, RESET_TIMEZONE);
    return `${p.year}-${pad2(p.month)}-${pad2(p.day)}`;
  }

  function getNextPacificMidnightMs(now) {
    const ts = typeof now === 'number' && Number.isFinite(now) ? now : Date.now();
    const cur = getTimeZoneParts(ts, RESET_TIMEZONE);
    const nextUtcDate = new Date(Date.UTC(cur.year, cur.month - 1, cur.day + 1, 0, 0, 0));
    const ny = nextUtcDate.getUTCFullYear();
    const nm = nextUtcDate.getUTCMonth() + 1;
    const nd = nextUtcDate.getUTCDate();
    const targetAsUtc = Date.UTC(ny, nm - 1, nd, 0, 0, 0);

    // Start with standard PST (+8h) offset and converge to exact PT 00:00:00
    let candidate = Date.UTC(ny, nm - 1, nd, 8, 0, 0);
    for (let i = 0; i < 3; i++) {
      const p = getTimeZoneParts(candidate, RESET_TIMEZONE);
      const localAsUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
      const diff = targetAsUtc - localAsUtc;
      if (diff === 0) break;
      candidate += diff;
    }
    if (candidate <= ts) {
      candidate += 24 * 3600 * 1000;
    }
    return candidate;
  }

  function createEmptyUsage(limit, now) {
    const ts = typeof now === 'number' && Number.isFinite(now) ? now : Date.now();
    return {
      version: 1,
      dayKey: getPacificDayKey(ts),
      limit: normalizeLimit(limit),
      usedTokens: 0,
      promptTokens: 0,
      candidatesTokens: 0,
      requestsCount: 0,
      resetAt: getNextPacificMidnightMs(ts),
      blockedUntil: 0,
      blockedCode: '',
      updatedAt: ts,
    };
  }

  function normalizeUsage(raw, limit, now) {
    const ts = typeof now === 'number' && Number.isFinite(now) ? now : Date.now();
    const currentDay = getPacificDayKey(ts);
    const nextResetAt = getNextPacificMidnightMs(ts);
    const effectiveLimit = normalizeLimit(limit || (raw && raw.limit));

    if (!raw || typeof raw !== 'object' || raw.dayKey !== currentDay) {
      return createEmptyUsage(effectiveLimit, ts);
    }

    const blockedUntilRaw = Number(raw.blockedUntil);
    const blockedActive = Number.isFinite(blockedUntilRaw) && blockedUntilRaw > ts;

    return {
      version: 1,
      dayKey: currentDay,
      limit: effectiveLimit,
      usedTokens: Math.max(0, Math.round(Number(raw.usedTokens) || 0)),
      promptTokens: Math.max(0, Math.round(Number(raw.promptTokens) || 0)),
      candidatesTokens: Math.max(0, Math.round(Number(raw.candidatesTokens) || 0)),
      requestsCount: Math.max(0, Math.round(Number(raw.requestsCount) || 0)),
      resetAt:
        Number.isFinite(Number(raw.resetAt)) && Number(raw.resetAt) > ts
          ? Number(raw.resetAt)
          : nextResetAt,
      blockedUntil: blockedActive ? Math.round(blockedUntilRaw) : 0,
      blockedCode: blockedActive && typeof raw.blockedCode === 'string' ? raw.blockedCode : '',
      updatedAt:
        Number.isFinite(Number(raw.updatedAt)) && Number(raw.updatedAt) > 0
          ? Number(raw.updatedAt)
          : ts,
    };
  }

  function loadUsage(storage, userId, limit, now) {
    const ts = typeof now === 'number' && Number.isFinite(now) ? now : Date.now();
    const key = getUsageStorageKey(userId);
    const saved = readRaw(storage, key);
    const normalized = normalizeUsage(saved, limit, ts);
    if (!saved || saved.dayKey !== normalized.dayKey || (saved.blockedUntil && !normalized.blockedUntil)) {
      writeRaw(storage, key, normalized);
    }
    return normalized;
  }

  function saveUsage(storage, userId, state, now) {
    const ts = typeof now === 'number' && Number.isFinite(now) ? now : Date.now();
    const clean = normalizeUsage(state, state && state.limit, ts);
    writeRaw(storage, getUsageStorageKey(userId), clean);
    return clean;
  }

  function recordUsage(state, usage, limit, now) {
    const ts = typeof now === 'number' && Number.isFinite(now) ? now : Date.now();
    const base = normalizeUsage(state, limit || (state && state.limit), ts);
    const promptAdd = Math.max(0, Math.round(Number(usage && usage.promptTokens) || 0));
    const candAdd = Math.max(0, Math.round(Number(usage && usage.candidatesTokens) || 0));
    const thoughtsAdd = Math.max(0, Math.round(Number(usage && usage.thoughtsTokens) || 0));
    const rawTotal = Math.max(0, Math.round(Number(usage && usage.totalTokens) || 0));
    const totalAdd = rawTotal > 0 ? rawTotal : promptAdd + candAdd + thoughtsAdd;

    return {
      ...base,
      usedTokens: base.usedTokens + totalAdd,
      promptTokens: base.promptTokens + promptAdd,
      candidatesTokens: base.candidatesTokens + candAdd,
      requestsCount: base.requestsCount + 1,
      blockedUntil: 0,
      blockedCode: '',
      updatedAt: ts,
    };
  }

  function recordUpstreamBlock(state, retryAfterSeconds, code, now) {
    const ts = typeof now === 'number' && Number.isFinite(now) ? now : Date.now();
    const base = normalizeUsage(state, state && state.limit, ts);
    const sec = Math.max(1, Math.ceil(Number(retryAfterSeconds) || 0));
    const nextResetAt = base.resetAt > ts ? base.resetAt : getNextPacificMidnightMs(ts);
    const blockUntil = sec > 0 ? ts + sec * 1000 : nextResetAt;

    return {
      ...base,
      blockedUntil: blockUntil,
      blockedCode: typeof code === 'string' ? code : 'QUOTA_EXHAUSTED',
      updatedAt: ts,
    };
  }

  function applyServerConfig(state, config, now) {
    const ts = typeof now === 'number' && Number.isFinite(now) ? now : Date.now();
    const limit = config && config.dailyTokenLimit ? config.dailyTokenLimit : state && state.limit;
    const base = normalizeUsage(state, limit, ts);
    let resetAt = base.resetAt;
    if (config && Number.isFinite(Number(config.resetAt)) && Number(config.resetAt) > ts) {
      resetAt = Math.round(Number(config.resetAt));
    }

    let blockedUntil = base.blockedUntil;
    let blockedCode = base.blockedCode;
    if (config && config.cooldown && Number(config.cooldown.retryAfterSeconds) > 0) {
      const serverUntil = ts + Math.ceil(Number(config.cooldown.retryAfterSeconds)) * 1000;
      if (serverUntil > blockedUntil) {
        blockedUntil = serverUntil;
        blockedCode = config.cooldown.code || 'QUOTA_EXHAUSTED';
      }
    }

    return {
      ...base,
      resetAt,
      blockedUntil,
      blockedCode,
    };
  }

  function getUsageSummary(state, now) {
    const ts = typeof now === 'number' && Number.isFinite(now) ? now : Date.now();
    const clean = normalizeUsage(state, state && state.limit, ts);
    const remainingTokens = Math.max(0, clean.limit - clean.usedTokens);
    const percentRemaining =
      clean.limit > 0 ? Math.max(0, Math.min(100, Math.round((remainingTokens / clean.limit) * 100))) : 0;
    const msUntilDailyReset = Math.max(0, clean.resetAt - ts);
    const msBlocked = clean.blockedUntil > ts ? clean.blockedUntil - ts : 0;
    const isUpstreamDailyBlocked =
      msBlocked > 0 && (clean.blockedCode === 'QUOTA_EXHAUSTED' || msBlocked > 300 * 1000);
    const isRateLimited = msBlocked > 0 && !isUpstreamDailyBlocked;
    const isUserLimitReached = remainingTokens <= 0;
    const effectiveResetAt =
      isUpstreamDailyBlocked && clean.blockedUntil > ts ? clean.blockedUntil : clean.resetAt;
    const msUntilReset = Math.max(0, effectiveResetAt - ts);

    return {
      dayKey: clean.dayKey,
      limit: clean.limit,
      usedTokens: clean.usedTokens,
      remainingTokens,
      percentRemaining,
      requestsCount: clean.requestsCount,
      resetAt: effectiveResetAt,
      msUntilReset,
      msUntilDailyReset,
      blockedUntil: clean.blockedUntil,
      blockedCode: clean.blockedCode,
      msBlocked,
      isUserLimitReached,
      isUpstreamDailyBlocked,
      isRateLimited,
    };
  }

  function formatRemainingResetTime(ms) {
    const totalSec = Math.max(1, Math.ceil(Math.max(0, Number(ms) || 0) / 1000));
    if (totalSec >= 3600) {
      const h = Math.floor(totalSec / 3600);
      const m = Math.floor((totalSec % 3600) / 60);
      return m > 0 ? `${h} س ${m} د` : `${h} س`;
    }
    if (totalSec >= 60) {
      const m = Math.floor(totalSec / 60);
      const s = totalSec % 60;
      return s > 0 && m < 5 ? `${m} د ${s} ث` : `${m} د`;
    }
    return `${totalSec} ث`;
  }

  return {
    DEFAULT_DAILY_TOKEN_LIMIT,
    USAGE_KEY_PREFIX,
    RESET_TIMEZONE,
    getUsageStorageKey,
    getPacificDayKey,
    getNextPacificMidnightMs,
    createEmptyUsage,
    normalizeUsage,
    loadUsage,
    saveUsage,
    recordUsage,
    recordUpstreamBlock,
    applyServerConfig,
    getUsageSummary,
    formatRemainingResetTime,
  };
});
