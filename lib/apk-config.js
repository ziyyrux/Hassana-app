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

function parseGitHubRepoSlug(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  const direct = trimmed.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
  if (direct) {
    return { owner: direct[1], slug: direct[2] };
  }
  const urlMatch = trimmed.match(/^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?:\/releases(?:\/|$)|$)/i);
  if (urlMatch) {
    return { owner: urlMatch[1], slug: urlMatch[2].replace(/\.git$/i, '') };
  }
  return null;
}

function resolveGitHubRepoInfo(env = process.env) {
  if (!env || typeof env !== 'object') return null;

  const explicitRepo = parseGitHubRepoSlug(env.HASSANA_GITHUB_REPO);
  if (explicitRepo) return explicitRepo;

  const provider = typeof env.VERCEL_GIT_PROVIDER === 'string' ? env.VERCEL_GIT_PROVIDER.trim().toLowerCase() : '';
  const owner = typeof env.VERCEL_GIT_REPO_OWNER === 'string' ? env.VERCEL_GIT_REPO_OWNER.trim() : '';
  const slug = typeof env.VERCEL_GIT_REPO_SLUG === 'string' ? env.VERCEL_GIT_REPO_SLUG.trim() : '';
  if (provider === 'github' && /^[A-Za-z0-9_.-]+$/.test(owner) && /^[A-Za-z0-9_.-]+$/.test(slug)) {
    return { owner, slug };
  }

  return parseGitHubRepoSlug(env.HASSANA_APK_URL);
}

function resolveApkDownloadUrl(options = {}) {
  const env = options.env || process.env;
  const rootDir = options.rootDir || path.resolve(__dirname, '..');

  const explicit = normalizeApkUrl(env && env.HASSANA_APK_URL);
  const githubToken = env && typeof env.HASSANA_GITHUB_TOKEN === 'string' ? env.HASSANA_GITHUB_TOKEN.trim() : '';
  const githubRepo = resolveGitHubRepoInfo(env);
  const isGitHubReleaseUrl = /^https:\/\/github\.com\/[^/]+\/[^/]+\/releases\//i.test(explicit);

  if (githubToken && githubRepo && (!explicit || isGitHubReleaseUrl)) {
    return {
      url: '/api/apk',
      source: 'github_private_release',
      filename: APK_FILENAME,
      owner: githubRepo.owner,
      slug: githubRepo.slug,
    };
  }

  if (explicit) {
    return { url: explicit, source: 'env', filename: APK_FILENAME };
  }

  const localPublicApk = path.join(rootDir, 'public', APK_FILENAME);
  if (fs.existsSync(localPublicApk)) {
    return { url: `/${APK_FILENAME}`, source: 'local', filename: APK_FILENAME };
  }

  if (githubRepo) {
    return {
      url: `https://github.com/${githubRepo.owner}/${githubRepo.slug}/releases/latest/download/${APK_FILENAME}`,
      source: 'github_release',
      filename: APK_FILENAME,
    };
  }

  return { url: '', source: 'none', filename: APK_FILENAME };
}

async function resolvePrivateReleaseSignedUrl(options = {}) {
  const { owner, slug, filename = APK_FILENAME, token, fetchImpl = globalThis.fetch } = options;
  if (!owner || !slug || !token || typeof fetchImpl !== 'function') {
    return '';
  }

  const baseHeaders = {
    Authorization: `Bearer ${token}`,
    'User-Agent': 'hassana-apk-proxy',
    'X-GitHub-Api-Version': '2022-11-28',
  };

  let releaseData = null;
  for (const endpoint of [
    `https://api.github.com/repos/${owner}/${slug}/releases/latest`,
    `https://api.github.com/repos/${owner}/${slug}/releases/tags/apk-latest`,
  ]) {
    const relRes = await fetchImpl(endpoint, {
      method: 'GET',
      headers: { ...baseHeaders, Accept: 'application/vnd.github+json' },
    });
    if (relRes && relRes.ok) {
      releaseData = await relRes.json().catch(() => null);
      if (releaseData) break;
    }
  }

  const assets = releaseData && Array.isArray(releaseData.assets) ? releaseData.assets : [];
  const asset =
    assets.find((a) => a && a.name === filename) ||
    assets.find((a) => a && typeof a.name === 'string' && a.name.toLowerCase().endsWith('.apk'));
  if (!asset || !asset.id) {
    return '';
  }

  const assetRes = await fetchImpl(
    `https://api.github.com/repos/${owner}/${slug}/releases/assets/${asset.id}`,
    {
      method: 'GET',
      redirect: 'manual',
      headers: { ...baseHeaders, Accept: 'application/octet-stream' },
    }
  );
  if (!assetRes || !assetRes.headers || typeof assetRes.headers.get !== 'function') {
    return '';
  }

  const loc = assetRes.headers.get('location') || '';
  return normalizeApkUrl(loc);
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
  resolveGitHubRepoInfo,
  resolveApkDownloadUrl,
  resolvePrivateReleaseSignedUrl,
  injectApkUrlIntoHtml,
};
