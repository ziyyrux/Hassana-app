const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { buildStaticDist } = require('./build');

function normalizeApiOrigin(raw) {
  if (typeof raw !== 'string') return '';
  const trimmed = raw.trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return '';
    }
    return parsed.origin;
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

function injectApiOriginIntoHtml(html, apiOrigin) {
  const cleanOrigin = normalizeApiOrigin(apiOrigin);
  if (!cleanOrigin || typeof html !== 'string') return html;
  const metaTag = `<meta name="zad-api-origin" content="${escapeAttr(cleanOrigin)}">`;
  if (/<meta\s+name="zad-api-origin"\s+content="[^"]*"\s*>/i.test(html)) {
    return html.replace(/<meta\s+name="zad-api-origin"\s+content="[^"]*"\s*>/i, metaTag);
  }
  return html.replace('</head>', `${metaTag}\n</head>`);
}

function patchAndroidManifestXml(xml) {
  if (typeof xml !== 'string' || !xml.trim()) return xml;
  let next = xml;

  const permissions = [
    'android.permission.INTERNET',
    'android.permission.ACCESS_COARSE_LOCATION',
    'android.permission.ACCESS_FINE_LOCATION',
  ];

  const missingPerms = permissions.filter((perm) => !next.includes(perm));
  if (missingPerms.length > 0) {
    const permBlock = missingPerms
      .map((perm) => `    <uses-permission android:name="${perm}" />`)
      .join('\n');
    if (next.includes('</manifest>')) {
      next = next.replace('</manifest>', `${permBlock}\n</manifest>`);
    }
  }

  if (!/android:supportsRtl\s*=/.test(next)) {
    next = next.replace(/<application(\s)/, '<application android:supportsRtl="true"$1');
  }

  return next;
}

function prepareApkDist(rootDir = path.resolve(__dirname, '..'), apiOrigin = process.env.HASSANA_API_ORIGIN || '') {
  const distDir = buildStaticDist(rootDir);
  const cleanOrigin = normalizeApiOrigin(apiOrigin);
  if (cleanOrigin) {
    const indexPath = path.join(distDir, 'index.html');
    const html = fs.readFileSync(indexPath, 'utf8');
    fs.writeFileSync(indexPath, injectApiOriginIntoHtml(html, cleanOrigin), 'utf8');
  }
  return { distDir, apiOrigin: cleanOrigin };
}

function resizePng(srcPath, destPath, size) {
  try {
    execFileSync('convert', [srcPath, '-resize', `${size}x${size}`, destPath], { stdio: 'ignore' });
    return true;
  } catch {}
  try {
    execFileSync(
      'python3',
      [
        '-c',
        'import sys; from PIL import Image; im = Image.open(sys.argv[1]); im.resize((int(sys.argv[3]), int(sys.argv[3])), Image.LANCZOS).save(sys.argv[2])',
        srcPath,
        destPath,
        String(size),
      ],
      { stdio: 'ignore' }
    );
    return true;
  } catch {}
  fs.copyFileSync(srcPath, destPath);
  return false;
}

function configureAndroidProject(rootDir = path.resolve(__dirname, '..')) {
  const androidDir = path.join(rootDir, 'android');
  const manifestPath = path.join(androidDir, 'app', 'src', 'main', 'AndroidManifest.xml');
  if (fs.existsSync(manifestPath)) {
    const current = fs.readFileSync(manifestPath, 'utf8');
    const patched = patchAndroidManifestXml(current);
    if (patched !== current) {
      fs.writeFileSync(manifestPath, patched, 'utf8');
    }
  }

  const resDir = path.join(androidDir, 'app', 'src', 'main', 'res');
  const icon512 = path.join(rootDir, 'public', 'icons', 'icon-512.png');
  const icon192 = path.join(rootDir, 'public', 'icons', 'icon-192.png');
  const iconSrc = fs.existsSync(icon512) ? icon512 : icon192;

  if (fs.existsSync(resDir) && fs.existsSync(iconSrc)) {
    const anydpiDir = path.join(resDir, 'mipmap-anydpi-v26');
    if (fs.existsSync(anydpiDir)) {
      fs.rmSync(anydpiDir, { recursive: true, force: true });
    }
    const densities = [
      ['mipmap-mdpi', 48],
      ['mipmap-hdpi', 72],
      ['mipmap-xhdpi', 96],
      ['mipmap-xxhdpi', 144],
      ['mipmap-xxxhdpi', 192],
    ];
    for (const [folder, size] of densities) {
      const targetDir = path.join(resDir, folder);
      fs.mkdirSync(targetDir, { recursive: true });
      const launcherPath = path.join(targetDir, 'ic_launcher.png');
      const roundPath = path.join(targetDir, 'ic_launcher_round.png');
      const fgPath = path.join(targetDir, 'ic_launcher_foreground.png');
      resizePng(iconSrc, launcherPath, size);
      fs.copyFileSync(launcherPath, roundPath);
      fs.copyFileSync(launcherPath, fgPath);
    }
  }

  return androidDir;
}

if (require.main === module) {
  const args = new Set(process.argv.slice(2));
  const rootDir = path.resolve(__dirname, '..');
  if (args.has('--configure-android')) {
    const out = configureAndroidProject(rootDir);
    console.log(`Configured Android project at ${out}`);
  } else {
    const { distDir, apiOrigin } = prepareApkDist(rootDir, process.env.HASSANA_API_ORIGIN || '');
    console.log(`Prepared APK dist at ${distDir}${apiOrigin ? ` (API origin: ${apiOrigin})` : ''}`);
  }
}

module.exports = {
  normalizeApiOrigin,
  injectApiOriginIntoHtml,
  patchAndroidManifestXml,
  prepareApkDist,
  configureAndroidProject,
};
