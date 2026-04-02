#!/usr/bin/env node
/**
 * 起易蝦 授權模組 (auth.mjs)
 *
 * 功能：
 * - DEVICE_TOKEN 生成與 HMAC-SHA256 簽章驗證
 * - AES-256-CBC 加密/解密敏感欄位
 * - 授權類型與到期日檢查
 * - 續約碼生成與驗證
 * - 白名單 Email 驗證
 * - USB 偵測
 *
 * 密鑰常量與黃仁蝦版本共用，確保互通。
 */

import { createHmac, createHash, randomBytes, randomUUID, createCipheriv, createDecipheriv } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, readdirSync, accessSync, constants as fsConst } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { platform } from 'node:os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ─── 密鑰常量（與黃仁蝦版本一致）───
const HMAC_SECRET = 'lobster-ai-hmac-2026-v2';
const AES_SALT = 'lobster-aes-2026';
const RENEWAL_HMAC_KEY = 'lobster-renew-2026-v2';

// ─── config.env 路徑 ───
function findDataDir() {
  // 優先：portable/data/
  const portableData = join(__dirname, '..', '..', 'data');
  if (existsSync(join(portableData, 'config.env'))) return portableData;
  // 其次：與 auth.mjs 同級的 ../../data/
  return portableData;
}

// ═══════════════════════════════════════
// config.env 讀寫
// ═══════════════════════════════════════

export function readConfig(configPath) {
  if (!configPath) configPath = join(findDataDir(), 'config.env');
  if (!existsSync(configPath)) return {};
  const text = readFileSync(configPath, 'utf-8');
  const config = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx < 0) continue;
    const key = trimmed.substring(0, eqIdx).trim();
    let val = trimmed.substring(eqIdx + 1).trim();
    // 去除引號
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    config[key] = val;
  }
  return config;
}

export function saveConfigValue(key, value, configPath) {
  if (!configPath) configPath = join(findDataDir(), 'config.env');
  if (!existsSync(configPath)) {
    writeFileSync(configPath, '', 'utf-8');
  }
  let text = readFileSync(configPath, 'utf-8');
  const pattern = new RegExp(`^${key}=.*$`, 'm');
  const newLine = `${key}="${value}"`;
  if (pattern.test(text)) {
    text = text.replace(pattern, newLine);
  } else {
    text = text.trimEnd() + '\n' + newLine + '\n';
  }
  // UTF-8 BOM for PowerShell compatibility
  const bom = '\uFEFF';
  if (!text.startsWith(bom)) text = bom + text;
  writeFileSync(configPath, text, 'utf-8');
}

// ═══════════════════════════════════════
// DEVICE_TOKEN + HMAC-SHA256
// ═══════════════════════════════════════

export function generateDeviceToken() {
  return randomUUID();
}

export function computeHmac(token) {
  return createHmac('sha256', HMAC_SECRET).update(token, 'utf-8').digest('base64');
}

export function verifyHmac(token, storedHmac) {
  const expected = computeHmac(token);
  return expected === storedHmac;
}

/**
 * 確保 DEVICE_TOKEN 存在且 HMAC 正確
 * @returns {{ token: string, isNew: boolean }}
 * @throws 若 HMAC 被竄改
 */
export function ensureDeviceToken(configPath) {
  const config = readConfig(configPath);
  let token = config.DEVICE_TOKEN || '';
  let isNew = false;

  if (!token) {
    token = generateDeviceToken();
    saveConfigValue('DEVICE_TOKEN', token, configPath);
    const hmac = computeHmac(token);
    saveConfigValue('DEVICE_TOKEN_HMAC', hmac, configPath);
    isNew = true;
    return { token, isNew };
  }

  const storedHmac = config.DEVICE_TOKEN_HMAC || '';
  if (storedHmac) {
    if (!verifyHmac(token, storedHmac)) {
      throw new Error('系統偵測到 DEVICE_TOKEN 被竄改。此為安全違規，系統拒絕啟動。');
    }
  } else {
    // 首次：自動補上 HMAC
    const hmac = computeHmac(token);
    saveConfigValue('DEVICE_TOKEN_HMAC', hmac, configPath);
  }

  return { token, isNew };
}

// ═══════════════════════════════════════
// AES-256-CBC 加密/解密
// ═══════════════════════════════════════

export function deriveEncryptionKey(deviceToken, masterPassword) {
  const material = `${deviceToken}:${masterPassword}:${AES_SALT}`;
  return createHash('sha256').update(material, 'utf-8').digest();
}

export function encryptValue(plainText, keyBuffer) {
  const iv = randomBytes(16);
  const cipher = createCipheriv('aes-256-cbc', keyBuffer, iv);
  const encrypted = Buffer.concat([cipher.update(plainText, 'utf-8'), cipher.final()]);
  const combined = Buffer.concat([iv, encrypted]);
  return 'ENC:' + combined.toString('base64');
}

export function decryptValue(cipherText, keyBuffer) {
  if (!cipherText.startsWith('ENC:')) return cipherText;
  const data = Buffer.from(cipherText.substring(4), 'base64');
  const iv = data.subarray(0, 16);
  const encrypted = data.subarray(16);
  const decipher = createDecipheriv('aes-256-cbc', keyBuffer, iv);
  return decipher.update(encrypted) + decipher.final('utf-8');
}

// ═══════════════════════════════════════
// 授權檢查
// ═══════════════════════════════════════

/**
 * 檢查授權是否有效
 * @returns {{ valid: boolean, type: string, expiresAt: string, daysRemaining: number, message: string }}
 */
export function checkLicense(configPath) {
  const config = readConfig(configPath);
  const licenseType = config.LICENSE_TYPE || 'perpetual';
  const expiresAt = config.LICENSE_EXPIRES_AT || '';

  const result = {
    valid: true,
    type: licenseType,
    expiresAt,
    daysRemaining: -1,
    message: ''
  };

  if (licenseType === 'perpetual') {
    result.message = '永久授權';
    return result;
  }

  if (!expiresAt) {
    result.message = '授權有效（無到期日）';
    return result;
  }

  const expiry = new Date(expiresAt + 'T23:59:59');
  const now = new Date();
  const diffMs = expiry.getTime() - now.getTime();
  const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));

  result.daysRemaining = diffDays;

  if (diffDays < 0) {
    result.valid = false;
    result.message = `授權已於 ${expiresAt} 到期。請聯絡 3a01chatgpt@gmail.com 取得續約碼。`;
  } else if (diffDays <= 7) {
    result.message = `授權將於 ${diffDays} 天後到期（${expiresAt}）`;
  } else {
    result.message = `授權有效，到期日：${expiresAt}（剩餘 ${diffDays} 天）`;
  }

  return result;
}

// ═══════════════════════════════════════
// 續約碼
// ═══════════════════════════════════════

export function generateRenewalCode(email, licenseType, expiresAt = '') {
  const nonce = Math.floor(Date.now() / 1000).toString();
  const payload = `${email}|${licenseType}|${expiresAt}|${nonce}`;
  const sig = createHmac('sha256', RENEWAL_HMAC_KEY)
    .update(payload, 'utf-8')
    .digest('base64')
    .substring(0, 16);
  const full = `${payload}|${sig}`;
  const encoded = Buffer.from(full, 'utf-8').toString('base64');
  return `RENEW-${encoded}`;
}

export function verifyRenewalCode(code) {
  try {
    if (!code.startsWith('RENEW-')) return null;
    const decoded = Buffer.from(code.substring(6), 'base64').toString('utf-8');
    const parts = decoded.split('|');
    if (parts.length < 5) return null;

    const [email, licenseType, expiresAt, nonce, sig] = parts;
    const payload = `${email}|${licenseType}|${expiresAt}|${nonce}`;
    const expectedSig = createHmac('sha256', RENEWAL_HMAC_KEY)
      .update(payload, 'utf-8')
      .digest('base64')
      .substring(0, 16);

    if (sig !== expectedSig) return null;
    return { email, licenseType, expiresAt };
  } catch {
    return null;
  }
}

function getCodeFingerprint(code) {
  return createHash('sha256').update(code, 'utf-8').digest('hex').substring(0, 16);
}

export function applyRenewalCode(code, configPath) {
  const info = verifyRenewalCode(code);
  if (!info) throw new Error('續約碼無效。請確認是否輸入正確，或聯絡賣家重新產生。');

  const config = readConfig(configPath);

  // 防重放
  const fingerprint = getCodeFingerprint(code);
  const usedCodes = config.USED_RENEWAL_CODES || '';
  if (usedCodes && usedCodes.split(',').includes(fingerprint)) {
    throw new Error('此續約碼已使用過，無法重複使用。');
  }

  // Email 驗證
  const boundEmail = (config.BOUND_EMAIL || '').toLowerCase();
  if (boundEmail && info.email && info.email.toLowerCase() !== boundEmail) {
    throw new Error('續約碼的 Email 與此裝置綁定的帳號不符。');
  }

  // 套用
  saveConfigValue('LICENSE_TYPE', info.licenseType, configPath);
  if (info.expiresAt) {
    saveConfigValue('LICENSE_EXPIRES_AT', info.expiresAt, configPath);
  } else if (info.licenseType === 'perpetual') {
    saveConfigValue('LICENSE_EXPIRES_AT', '', configPath);
  }

  // 記錄已使用
  const newUsed = usedCodes ? `${usedCodes},${fingerprint}` : fingerprint;
  saveConfigValue('USED_RENEWAL_CODES', newUsed, configPath);

  return info;
}

// ═══════════════════════════════════════
// 白名單 Email 驗證
// ═══════════════════════════════════════

export function hashEmail(email) {
  return createHash('sha256')
    .update(email.trim().toLowerCase(), 'utf-8')
    .digest('hex');
}

export function readWhitelist(dataDir) {
  if (!dataDir) dataDir = findDataDir();
  const wlPath = join(dataDir, 'whitelist.json');
  if (!existsSync(wlPath)) return {};
  return JSON.parse(readFileSync(wlPath, 'utf-8'));
}

export function checkWhitelistEmail(email, dataDir) {
  const hash = hashEmail(email);
  const whitelist = readWhitelist(dataDir);
  return whitelist[hash] || null;
}

export function addToWhitelist(email, customerName, dataDir) {
  if (!dataDir) dataDir = findDataDir();
  const wlPath = join(dataDir, 'whitelist.json');
  const whitelist = existsSync(wlPath) ? JSON.parse(readFileSync(wlPath, 'utf-8')) : {};
  whitelist[hashEmail(email)] = customerName;
  writeFileSync(wlPath, JSON.stringify(whitelist, null, 2), 'utf-8');
}

// ═══════════════════════════════════════
// USB 偵測
// ═══════════════════════════════════════

export function getDriveRoots() {
  const os = platform();
  const roots = [];

  if (os === 'win32') {
    for (let i = 65; i <= 90; i++) {
      const letter = String.fromCharCode(i);
      const root = `${letter}:\\`;
      try {
        accessSync(root, fsConst.R_OK);
        roots.push(root);
      } catch { /* skip */ }
    }
  } else if (os === 'darwin') {
    try {
      for (const entry of readdirSync('/Volumes')) {
        roots.push(join('/Volumes', entry));
      }
    } catch { /* skip */ }
  } else {
    const username = require('os').userInfo().username;
    for (const base of [`/media/${username}`, '/mnt']) {
      try {
        for (const entry of readdirSync(base)) {
          roots.push(join(base, entry));
        }
      } catch { /* skip */ }
    }
  }
  return roots;
}

/**
 * 找到帶有匹配 DEVICE_TOKEN 的 USB
 * @param {string} deviceToken
 * @param {string} productDir - USB 上的產品資料夾名稱
 */
export function findUsbWithToken(deviceToken, productDir = '起易蝦') {
  const roots = getDriveRoots();
  for (const root of roots) {
    const candidates = [root, join(root, productDir)];
    for (const candidate of candidates) {
      const configPath = join(candidate, 'data', 'config.env');
      try {
        const config = readConfig(configPath);
        if (config.DEVICE_TOKEN === deviceToken) return candidate;
      } catch { /* skip */ }
    }
  }
  return null;
}

// ═══════════════════════════════════════
// CLI 入口（直接執行 auth.mjs 時）
// ═══════════════════════════════════════

const COMMANDS = {
  check: cmdCheck,
  activate: cmdActivate,
  'generate-renewal': cmdGenerateRenewal,
  'apply-renewal': cmdApplyRenewal,
  'check-usb': cmdCheckUsb,
};

async function cmdCheck() {
  const configPath = process.argv[3] || join(findDataDir(), 'config.env');
  try {
    const { token } = ensureDeviceToken(configPath);
    const license = checkLicense(configPath);
    if (!license.valid) {
      console.error(`[授權錯誤] ${license.message}`);
      process.exit(2);
    }
    if (license.daysRemaining >= 0 && license.daysRemaining <= 7) {
      console.error(`[授權警告] ${license.message}`);
    }
    console.log(JSON.stringify({ ok: true, token, license }));
    process.exit(0);
  } catch (e) {
    console.error(`[授權錯誤] ${e.message}`);
    process.exit(1);
  }
}

async function cmdActivate() {
  const configPath = process.argv[3] || join(findDataDir(), 'config.env');
  const email = process.argv[4];
  if (!email) {
    console.error('用法: auth.mjs activate <config-path> <email>');
    process.exit(1);
  }

  const dataDir = dirname(configPath);
  const customerName = checkWhitelistEmail(email, dataDir);
  if (!customerName) {
    console.error(JSON.stringify({ ok: false, error: 'Email 不在授權名單中' }));
    process.exit(2);
  }

  const { token } = ensureDeviceToken(configPath);
  saveConfigValue('BOUND_EMAIL', email.trim().toLowerCase(), configPath);
  saveConfigValue('DEVICE_READY', 'true', configPath);

  console.log(JSON.stringify({ ok: true, customerName, token }));
  process.exit(0);
}

async function cmdGenerateRenewal() {
  const email = process.argv[3];
  const licenseType = process.argv[4];
  const expiresAt = process.argv[5] || '';
  if (!email || !licenseType) {
    console.error('用法: auth.mjs generate-renewal <email> <licenseType> [expiresAt]');
    process.exit(1);
  }
  const code = generateRenewalCode(email, licenseType, expiresAt);
  console.log(JSON.stringify({ ok: true, code }));
}

async function cmdApplyRenewal() {
  const configPath = process.argv[3] || join(findDataDir(), 'config.env');
  const code = process.argv[4];
  if (!code) {
    console.error('用法: auth.mjs apply-renewal <config-path> <renewal-code>');
    process.exit(1);
  }
  try {
    const info = applyRenewalCode(code, configPath);
    console.log(JSON.stringify({ ok: true, ...info }));
  } catch (e) {
    console.error(JSON.stringify({ ok: false, error: e.message }));
    process.exit(2);
  }
}

async function cmdCheckUsb() {
  const configPath = process.argv[3] || join(findDataDir(), 'config.env');
  const config = readConfig(configPath);
  const token = config.DEVICE_TOKEN || '';
  if (!token) {
    console.log(JSON.stringify({ ok: false, error: 'DEVICE_TOKEN 未設定' }));
    process.exit(1);
  }
  const usbPath = findUsbWithToken(token);
  console.log(JSON.stringify({ ok: !!usbPath, usbPath }));
  process.exit(usbPath ? 0 : 1);
}

// 如果直接執行
if (process.argv[1] && process.argv[1].endsWith('auth.mjs')) {
  const cmd = process.argv[2];
  if (cmd && COMMANDS[cmd]) {
    COMMANDS[cmd]();
  } else {
    console.log('起易蝦 授權模組');
    console.log('用法:');
    console.log('  node auth.mjs check [config-path]              — 檢查授權');
    console.log('  node auth.mjs activate <config-path> <email>   — 啟動帳號');
    console.log('  node auth.mjs generate-renewal <email> <type> [expires] — 產生續約碼');
    console.log('  node auth.mjs apply-renewal <config-path> <code>        — 套用續約碼');
    console.log('  node auth.mjs check-usb [config-path]          — 檢查 USB 是否在線');
    process.exit(0);
  }
}
