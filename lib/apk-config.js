const fs = require('node:fs');
const path = require('node:path');

const APK_FILENAME = 'Hassana-Android.apk';

function normalizeApkUrl(raw) {
  if (typeof raw !== 'string') return '';
  const trimmed = raw.trim();
  if (!trimmed) return '';
  if (trimmed.startsWith('/')) {
    return trimmed.startsWith('//') ? '' : trimmed;
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return '';
    }
    return parsed.toString();
  } catch {
    return '';
  }
}

function escapeAttr(val) {
  return String(val)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function resolveApkDownloadUrl(options = {}) {
  const env = options.env || process.env;
  const rootDir = options.rootDir || path.resolve(__dirname, '..');

  const explicit = normalizeApkUrl(env && env.HASSANA_APK_URL);
  if (explicit) {
    return { url: explicit, source: 'env', filename: APK_FILENAME };
  }

  const localPublicApk = path.join(rootDir, 'public', APK_FILENAME);
  if (fs.existsSync(localPublicApk)) {
    return { url: `/${APK_FILENAME}`, source: 'local', filename: APK_FILENAME };
  }

  const provider = env && typeof env.VERCEL_GIT_PROVIDER === 'string' ? env.VERCEL_GIT_PROVIDER.trim().toLowerCase() : '';
  const owner = env && typeof env.VERCEL_GIT_REPO_OWNER === 'string' ? env.VERCEL_GIT_REPO_OWNER.trim() : '';
  const slug = env && typeof env.VERCEL_GIT_REPO_SLUG === 'string' ? env.VERCEL_GIT_REPO_SLUG.trim() : '';
  if (provider === 'github' && /^[A-Za-z0-9_.-]+$/.test(owner) && /^[A-Za-z0-9_.-]+$/.test(slug)) {
    return {
      url: `https://github.com/${owner}/${slug}/releases/latest/download/${APK_FILENAME}`,
      source: 'github_release',
      filename: APK_FILENAME,
    };
  }

  return { url: '', source: 'none', filename: APK_FILENAME };
}

function injectApkUrlIntoHtml(html, apkUrl) {
  const cleanUrl = normalizeApkUrl(apkUrl);
  if (!cleanUrl || typeof html !== 'string') return html;
  const metaTag = `<meta name="hassana-apk-url" content="${escapeAttr(cleanUrl)}">`;
  if (/<meta\s+name="hassana-apk-url"\s+content="[^"]*"\s*>/i.test(html)) {
    return html.replace(/<meta\s+name="hassana-apk-url"\s+content="[^"]*"\s*>/i, metaTag);
  }
  return html.replace('</head>', `${metaTag}\n</head>`);
}

module.exports = {
  APK_FILENAME,
  normalizeApkUrl,
  resolveApkDownloadUrl,
  injectApkUrlIntoHtml,
};
