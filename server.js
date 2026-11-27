const express = require('express');
const path = require('path');
const { handleZadConfig, handleZadChat, handleApkDownload } = require('./lib/zad-service');

const app = express();
const PORT = Number(process.env.PORT) || 3000;

app.use(express.json({ limit: '1mb' }));

app.all('/api/zad/config', handleZadConfig);
app.all('/api/apk', (req, res) => handleApkDownload(req, res));
app.all('/api/zad/chat', (req, res) => handleZadChat(req, res));

app.use(express.static(path.join(__dirname, 'public')));

app.get('/sw.js', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(path.join(__dirname, 'sw.js'));
});

app.get('/lib/zad-format.js', (req, res) => {
  res.sendFile(path.join(__dirname, 'lib', 'zad-format.js'));
});

app.get('/lib/zad-history.js', (req, res) => {
  res.sendFile(path.join(__dirname, 'lib', 'zad-history.js'));
});

app.get('/lib/zad-usage.js', (req, res) => {
  res.sendFile(path.join(__dirname, 'lib', 'zad-usage.js'));
});

app.get('/lib/zad-notifications.js', (req, res) => {
  res.sendFile(path.join(__dirname, 'lib', 'zad-notifications.js'));
});

app.get(['/', '/index.html'], (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.use('/api', (req, res) => {
  res.status(404).json({ error: 'المسار غير موجود.' });
});

app.use((req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

if (require.main === module) {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Hassana app listening on http://0.0.0.0:${PORT}`);
  });
}

module.exports = app;
