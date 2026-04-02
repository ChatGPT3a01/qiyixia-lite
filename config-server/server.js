#!/usr/bin/env node
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = 18788;
const CONFIG_PATH = path.join(__dirname, '../data/.openclaw/openclaw.json');
const CONFIG_ENV_PATH = path.join(__dirname, '../data/config.env');
const WHITELIST_PATH = path.join(__dirname, '../data/whitelist.json');
const HMAC_SECRET = 'lobster-ai-hmac-2026-v2';

// ─── config.env helpers ───
function readConfigEnv() {
  if (!fs.existsSync(CONFIG_ENV_PATH)) return {};
  const text = fs.readFileSync(CONFIG_ENV_PATH, 'utf8');
  const config = {};
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq < 0) continue;
    const key = t.substring(0, eq).trim();
    let val = t.substring(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))
      val = val.slice(1, -1);
    config[key] = val;
  }
  return config;
}

function saveConfigEnvValue(key, value) {
  if (!fs.existsSync(CONFIG_ENV_PATH)) fs.writeFileSync(CONFIG_ENV_PATH, '', 'utf8');
  let text = fs.readFileSync(CONFIG_ENV_PATH, 'utf8');
  const pattern = new RegExp('^' + key + '=.*$', 'm');
  const newLine = key + '="' + value + '"';
  text = pattern.test(text) ? text.replace(pattern, newLine) : text.trimEnd() + '\n' + newLine + '\n';
  fs.writeFileSync(CONFIG_ENV_PATH, text, 'utf8');
}

function readWhitelist() {
  if (!fs.existsSync(WHITELIST_PATH)) return {};
  return JSON.parse(fs.readFileSync(WHITELIST_PATH, 'utf8'));
}

function hashEmail(email) {
  return crypto.createHash('sha256').update(email.trim().toLowerCase(), 'utf-8').digest('hex');
}

const server = http.createServer((req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  // API: Get config
  if (req.url === '/api/config' && req.method === 'GET') {
    try {
      const config = fs.existsSync(CONFIG_PATH)
        ? JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
        : {};
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(config));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // API: Save config
  if (req.url === '/api/config' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const config = JSON.parse(body);
        const dir = path.dirname(CONFIG_PATH);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // API: Check activation status
  if (req.url === '/api/check-activation' && req.method === 'GET') {
    try {
      const cfg = readConfigEnv();
      const whitelist = readWhitelist();
      const hasWhitelist = Object.keys(whitelist).length > 0;
      const activated = cfg.DEVICE_READY === 'true' && !!cfg.BOUND_EMAIL;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ activated, hasWhitelist, boundEmail: cfg.BOUND_EMAIL || '' }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // API: Activate with email (whitelist check)
  if (req.url === '/api/activate' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { email } = JSON.parse(body);
        if (!email) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: '請輸入 Email' }));
          return;
        }
        const whitelist = readWhitelist();
        const hash = hashEmail(email);
        const raw = whitelist[hash];
        if (raw === undefined || raw === null || raw === false) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: '此 Email 未在授權名單中' }));
          return;
        }
        // Activate
        saveConfigEnvValue('BOUND_EMAIL', email.trim().toLowerCase());
        saveConfigEnvValue('DEVICE_READY', 'true');
        // Ensure DEVICE_TOKEN
        const cfg = readConfigEnv();
        if (!cfg.DEVICE_TOKEN) {
          const token = crypto.randomUUID();
          const hmac = crypto.createHmac('sha256', HMAC_SECRET).update(token, 'utf-8').digest('base64');
          saveConfigEnvValue('DEVICE_TOKEN', token);
          saveConfigEnvValue('DEVICE_TOKEN_HMAC', hmac);
        }
        const customerName = (typeof raw === 'string' && raw) ? raw : '客戶';
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, customerName }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    });
    return;
  }

  // Serve static files
  const filePath = req.url === '/'
    ? path.join(__dirname, 'public/index.html')
    : path.join(__dirname, 'public', req.url);

  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    const ext = path.extname(filePath);
    const contentType = {
      '.html': 'text/html',
      '.css': 'text/css',
      '.js': 'application/javascript',
      '.json': 'application/json'
    }[ext] || 'text/plain';

    res.writeHead(200, { 'Content-Type': contentType });
    fs.createReadStream(filePath).pipe(res);
  } else {
    res.writeHead(404);
    res.end('Not Found');
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n🦞 起易蝦 Config Center`);
  console.log(`   http://127.0.0.1:${PORT}`);
  console.log(`\n   Config file: ${CONFIG_PATH}\n`);
});
