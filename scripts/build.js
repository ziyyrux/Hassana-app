const fs = require('node:fs');
const path = require('node:path');

function buildStaticDist(rootDir = path.resolve(__dirname, '..')) {
  const distDir = path.join(rootDir, 'dist');
  const publicDir = path.join(rootDir, 'public');

  fs.rmSync(distDir, { recursive: true, force: true });
  fs.mkdirSync(distDir, { recursive: true });

  if (fs.existsSync(publicDir)) {
    fs.cpSync(publicDir, distDir, { recursive: true });
  }

  fs.copyFileSync(path.join(rootDir, 'index.html'), path.join(distDir, 'index.html'));
  fs.copyFileSync(path.join(rootDir, 'sw.js'), path.join(distDir, 'sw.js'));

  const distLibDir = path.join(distDir, 'lib');
  fs.mkdirSync(distLibDir, { recursive: true });
  fs.copyFileSync(path.join(rootDir, 'lib', 'zad-format.js'), path.join(distLibDir, 'zad-format.js'));
  fs.copyFileSync(path.join(rootDir, 'lib', 'zad-history.js'), path.join(distLibDir, 'zad-history.js'));
  fs.copyFileSync(path.join(rootDir, 'lib', 'zad-usage.js'), path.join(distLibDir, 'zad-usage.js'));

  return distDir;
}

if (require.main === module) {
  const out = buildStaticDist();
  console.log(`Built Vercel static output at ${out}`);
}

module.exports = { buildStaticDist };
