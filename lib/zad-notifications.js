(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.ZadNotifications = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const STORAGE_KEY = 'hasana_notif_v1';
  const CHANNEL_ID = 'hassana-reminders';
  const CHANNEL_NAME = 'تنبيهات حسنة';
  const CHANNEL_DESC = 'تنبيهات مواقيت الصلاة والأذكار والورد اليومي';

  const PRAYER_KEYS = ['fajr', 'dhuhr', 'asr', 'maghrib', 'isha'];
  const PRAYER_NAMES = {
    fajr: 'الفجر',
    dhuhr: 'الظهر',
    asr: 'العصر',
    maghrib: 'المغرب',
    isha: 'العشاء',
  };
  const VALID_OFFSETS = [0, 5, 10, 15];

  const DEFAULT_SETTINGS = {
    enabled: false,
    prayer: {
      enabled: true,
      offsetMinutes: 0,
      prayers: {
        fajr: true,
        dhuhr: true,
        asr: true,
        maghrib: true,
        isha: true,
      },
    },
    morning: { enabled: true, time: '06:30' },
    evening: { enabled: true, time: '17:00' },
    sleep: { enabled: false, time: '22:30' },
    khetma: { enabled: false, time: '20:00' },
    fridaySalawat: { enabled: true, time: '10:00' },
  };

  function parseTimeHm(raw, fallback) {
    const fb = fallback || '06:30';
    if (typeof raw !== 'string') return parseTimeHm(fb, '06:30');
    const m = raw.trim().match(/^(\d{1,2}):(\d{2})$/);
    if (!m) {
      if (raw === fb) return { hour: 6, minute: 30, text: '06:30' };
      return parseTimeHm(fb, '06:30');
    }
    const hour = Number(m[1]);
    const minute = Number(m[2]);
    if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
      if (raw === fb) return { hour: 6, minute: 30, text: '06:30' };
      return parseTimeHm(fb, '06:30');
    }
    return {
      hour,
      minute,
      text: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
    };
  }

  function cloneDefaults() {
    return JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  }

  function normalizeSettings(raw) {
    const base = cloneDefaults();
    if (!raw || typeof raw !== 'object') return base;

    base.enabled = !!raw.enabled;

    if (raw.prayer && typeof raw.prayer === 'object') {
      base.prayer.enabled = raw.prayer.enabled !== undefined ? !!raw.prayer.enabled : true;
      const off = Number(raw.prayer.offsetMinutes);
      base.prayer.offsetMinutes = VALID_OFFSETS.includes(off) ? off : 0;
      if (raw.prayer.prayers && typeof raw.prayer.prayers === 'object') {
        for (const k of PRAYER_KEYS) {
          if (raw.prayer.prayers[k] !== undefined) {
            base.prayer.prayers[k] = !!raw.prayer.prayers[k];
          }
        }
      }
    }

    for (const key of ['morning', 'evening', 'sleep', 'khetma', 'fridaySalawat']) {
      if (raw[key] && typeof raw[key] === 'object') {
        base[key].enabled = raw[key].enabled !== undefined ? !!raw[key].enabled : base[key].enabled;
        base[key].time = parseTimeHm(raw[key].time, base[key].time).text;
      }
    }

    return base;
  }

  function loadSettings(storage) {
    if (!storage || typeof storage.getItem !== 'function') return cloneDefaults();
    try {
      const raw = storage.getItem(STORAGE_KEY);
      if (!raw) return cloneDefaults();
      return normalizeSettings(JSON.parse(raw));
    } catch {
      return cloneDefaults();
    }
  }

  function saveSettings(storage, settings) {
    const clean = normalizeSettings(settings);
    if (storage && typeof storage.setItem === 'function') {
      try {
        storage.setItem(STORAGE_KEY, JSON.stringify(clean));
      } catch {}
    }
    return clean;
  }

  function buildPrayerNotificationSpecs(opts) {
    const o = opts || {};
    const settings = normalizeSettings(o.settings);
    if (!settings.enabled || !settings.prayer.enabled) return [];
    if (typeof o.getDayPrayers !== 'function') return [];

    const nowMs = Number.isFinite(Number(o.nowMs)) ? Number(o.nowMs) : Date.now();
    const daysAhead = Number.isInteger(o.daysAhead) && o.daysAhead > 0 ? Math.min(14, o.daysAhead) : 7;
    const offsetMinutes = settings.prayer.offsetMinutes;
    const offsetMs = offsetMinutes * 60000;
    const baseDate = new Date(nowMs);
    const list = [];

    for (let dayIdx = 0; dayIdx < daysAhead; dayIdx++) {
      const dayDate = new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate() + dayIdx);
      const dayTimes = o.getDayPrayers(dayDate);
      if (!dayTimes || typeof dayTimes !== 'object') continue;

      for (let pIdx = 0; pIdx < PRAYER_KEYS.length; pIdx++) {
        const key = PRAYER_KEYS[pIdx];
        if (!settings.prayer.prayers[key]) continue;
        const prayerAt = Number(dayTimes[key]);
        if (!Number.isFinite(prayerAt)) continue;
        const fireAt = prayerAt - offsetMs;
        if (fireAt <= nowMs + 5000) continue;

        const name = PRAYER_NAMES[key];
        const title = offsetMinutes > 0 ? `اقترب وقت صلاة ${name}` : `حان وقت صلاة ${name}`;
        const body =
          offsetMinutes > 0
            ? `متبقّي ${offsetMinutes} دقائق على أذان ${name}.`
            : `حيّ على الصلاة — افتح حسنة لمتابعة المواقيت وأذكار ما بعد الصلاة.`;

        list.push({
          id: 1000 + dayIdx * 10 + pIdx,
          title,
          body,
          channelId: CHANNEL_ID,
          schedule: {
            at: new Date(fireAt),
            allowWhileIdle: true,
          },
          extra: {
            kind: 'prayer',
            prayer: key,
            view: 'home',
            target: 'pt',
          },
        });
      }
    }

    return list;
  }

  function buildDailyReminderSpecs(opts) {
    const o = opts || {};
    const settings = normalizeSettings(o.settings);
    if (!settings.enabled) return [];

    const defs = [
      {
        key: 'morning',
        id: 2001,
        title: 'أذكار الصباح',
        body: 'ابدأ يومك بذكر الله — أذكار الصباح في تطبيق حسنة.',
        extra: { kind: 'adhkar', view: 'daily', group: 'morning' },
      },
      {
        key: 'evening',
        id: 2002,
        title: 'أذكار المساء',
        body: 'مساء مطمئن بذكر الله — حان وقت أذكار المساء.',
        extra: { kind: 'adhkar', view: 'daily', group: 'evening' },
      },
      {
        key: 'sleep',
        id: 2003,
        title: 'أذكار النوم',
        body: 'اختم يومك بأذكار النوم والاستغفار.',
        extra: { kind: 'adhkar', view: 'daily', group: 'sleep' },
      },
      {
        key: 'khetma',
        id: 2004,
        title: 'وردك اليومي من القرآن',
        body: 'لا تنسَ قراءة ورد اليوم من ختمة القرآن في حسنة.',
        extra: { kind: 'khetma', view: 'kh' },
      },
      {
        key: 'fridaySalawat',
        id: 2005,
        weekday: 6, // Capacitor LocalNotifications weekday: 1=Sunday ... 6=Friday ... 7=Saturday
        title: 'يوم الجمعة · صلِّ على النبي ﷺ',
        body: 'أكثروا من الصلاة على النبي ﷺ في هذا اليوم المبارك.',
        extra: { kind: 'salawat', view: 'home', openSalawat: true },
      },
    ];

    const list = [];
    for (const def of defs) {
      const cfg = settings[def.key];
      if (!cfg || !cfg.enabled) continue;
      const hm = parseTimeHm(cfg.time, DEFAULT_SETTINGS[def.key].time);
      const on = { hour: hm.hour, minute: hm.minute };
      if (def.weekday) on.weekday = def.weekday;

      list.push({
        id: def.id,
        title: def.title,
        body: def.body,
        channelId: CHANNEL_ID,
        schedule: {
          on,
          allowWhileIdle: true,
        },
        extra: def.extra,
      });
    }

    return list;
  }

  function buildScheduledPlan(opts) {
    const o = opts || {};
    const settings = normalizeSettings(o.settings);
    if (!settings.enabled) return [];

    const prayers = buildPrayerNotificationSpecs({
      settings,
      getDayPrayers: o.getDayPrayers,
      nowMs: o.nowMs,
      daysAhead: o.daysAhead,
    });
    const daily = buildDailyReminderSpecs({ settings });

    // Android AlarmManager limit safe cap: reserve space for daily repeating reminders first
    const maxPrayers = Math.max(0, 60 - daily.length);
    return prayers.slice(0, maxPrayers).concat(daily);
  }

  function getDueWebNotifications(opts) {
    const o = opts || {};
    const settings = normalizeSettings(o.settings);
    if (!settings.enabled) return [];

    const nowMs = Number.isFinite(Number(o.nowMs)) ? Number(o.nowMs) : Date.now();
    const sentMap = o.sentMap && typeof o.sentMap === 'object' ? o.sentMap : {};
    const nowDate = new Date(nowMs);
    const dayKey = `${nowDate.getFullYear()}-${String(nowDate.getMonth() + 1).padStart(2, '0')}-${String(nowDate.getDate()).padStart(2, '0')}`;
    const due = [];

    if (settings.prayer.enabled && typeof o.getDayPrayers === 'function') {
      const dayTimes = o.getDayPrayers(nowDate);
      const offsetMinutes = settings.prayer.offsetMinutes;
      if (dayTimes && typeof dayTimes === 'object') {
        for (const key of PRAYER_KEYS) {
          if (!settings.prayer.prayers[key]) continue;
          const prayerAt = Number(dayTimes[key]);
          if (!Number.isFinite(prayerAt)) continue;
          const fireAt = prayerAt - offsetMinutes * 60000;
          const diff = nowMs - fireAt;
          const dedupeKey = `${dayKey}:prayer:${key}:${offsetMinutes}`;
          if (diff >= 0 && diff < 60000 && !sentMap[dedupeKey]) {
            const name = PRAYER_NAMES[key];
            due.push({
              dedupeKey,
              title: offsetMinutes > 0 ? `اقترب وقت صلاة ${name}` : `حان وقت صلاة ${name}`,
              body:
                offsetMinutes > 0
                  ? `متبقّي ${offsetMinutes} دقائق على أذان ${name}.`
                  : `حيّ على الصلاة — افتح حسنة لمتابعة المواقيت وأذكار ما بعد الصلاة.`,
              extra: { kind: 'prayer', prayer: key, view: 'home', target: 'pt' },
            });
          }
        }
      }
    }

    const dailyDefs = buildDailyReminderSpecs({ settings });
    for (const item of dailyDefs) {
      const on = item.schedule && item.schedule.on;
      if (!on) continue;
      if (on.weekday) {
        // JS Date.getDay(): 0=Sunday..5=Friday..6=Saturday -> Capacitor weekday = getDay() + 1
        if (nowDate.getDay() + 1 !== on.weekday) continue;
      }
      if (nowDate.getHours() === on.hour && nowDate.getMinutes() === on.minute) {
        const dedupeKey = `${dayKey}:daily:${item.id}:${on.hour}:${on.minute}`;
        if (!sentMap[dedupeKey]) {
          due.push({
            dedupeKey,
            title: item.title,
            body: item.body,
            extra: item.extra,
          });
        }
      }
    }

    return due;
  }

  function getManagedNotificationIds() {
    const ids = [];
    for (let dayIdx = 0; dayIdx < 14; dayIdx++) {
      for (let pIdx = 0; pIdx < PRAYER_KEYS.length; pIdx++) {
        ids.push({ id: 1000 + dayIdx * 10 + pIdx });
      }
    }
    for (const id of [2001, 2002, 2003, 2004, 2005]) {
      ids.push({ id });
    }
    return ids;
  }

  return {
    STORAGE_KEY,
    CHANNEL_ID,
    CHANNEL_NAME,
    CHANNEL_DESC,
    PRAYER_KEYS,
    PRAYER_NAMES,
    VALID_OFFSETS,
    DEFAULT_SETTINGS,
    parseTimeHm,
    normalizeSettings,
    loadSettings,
    saveSettings,
    buildPrayerNotificationSpecs,
    buildDailyReminderSpecs,
    buildScheduledPlan,
    getDueWebNotifications,
    getManagedNotificationIds,
  };
});
