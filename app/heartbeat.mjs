#!/usr/bin/env node
// ============================================================
//  heartbeat.mjs - USB 心跳偵測模組（跨平台）
//  用法: node heartbeat.mjs <DEVICE_TOKEN> <config-env-path> [interval-minutes]
//
//  每隔指定分鐘數掃描所有磁碟，確認包含匹配 DEVICE_TOKEN
//  的 config.env 仍在線上。若 USB 不在線則彈出警告對話框。
// ============================================================

import { execSync } from 'node:child_process';
import { readFileSync, readdirSync, accessSync, constants } from 'node:fs';
import { join } from 'node:path';
import { platform, userInfo } from 'node:os';

// ── 參數解析 ──────────────────────────────────────────────────
const DEVICE_TOKEN = process.argv[2];
const CONFIG_PATH  = process.argv[3];
const INTERVAL_MIN = parseInt(process.argv[4] || '10', 10);

if (!DEVICE_TOKEN) {
  console.error('用法: node heartbeat.mjs <DEVICE_TOKEN> <config-path> [interval-min]');
  process.exit(1);
}

// 產品資料夾名稱（掃描磁碟時用來比對）
const PRODUCT_DIR = '起易蝦';

// ── 取得所有磁碟根目錄 ────────────────────────────────────────
function getDriveRoots() {
  const os = platform();
  const roots = [];

  if (os === 'win32') {
    // Windows: 掃描 A-Z 磁碟代號
    for (let code = 65; code <= 90; code++) {
      const drive = `${String.fromCharCode(code)}:\\`;
      try {
        accessSync(drive, constants.R_OK);
        roots.push(drive);
      } catch {
        // 磁碟不存在或無法存取，跳過
      }
    }
  } else if (os === 'darwin') {
    // macOS: /Volumes/* 下的所有掛載點
    try {
      const entries = readdirSync('/Volumes');
      for (const entry of entries) {
        roots.push(join('/Volumes', entry));
      }
    } catch {
      // /Volumes 讀取失敗
    }
  } else {
    // Linux: /media/$USER/* 和 /mnt/*
    const user = userInfo().username;
    const mediaPaths = [
      join('/media', user),
      '/mnt',
    ];
    for (const base of mediaPaths) {
      try {
        const entries = readdirSync(base);
        for (const entry of entries) {
          roots.push(join(base, entry));
        }
      } catch {
        // 路徑不存在或無法讀取
      }
    }
  }

  return roots;
}

// ── 從 config.env 讀取 DEVICE_TOKEN ──────────────────────────
function readTokenFromConfig(configPath) {
  try {
    const content = readFileSync(configPath, 'utf-8');
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      // 忽略空行與註解
      if (!trimmed || trimmed.startsWith('#')) continue;
      const match = trimmed.match(/^DEVICE_TOKEN\s*=\s*(.+)$/);
      if (match) {
        // 去除前後引號與空白
        return match[1].trim().replace(/^["']|["']$/g, '');
      }
    }
  } catch {
    // 檔案不存在或無法讀取
  }
  return null;
}

// ── 掃描是否有匹配的 USB 在線 ─────────────────────────────────
function isUsbPresent() {
  // 1. 先檢查啟動時指定的 config 路徑
  if (CONFIG_PATH) {
    const token = readTokenFromConfig(CONFIG_PATH);
    if (token === DEVICE_TOKEN) return true;
  }

  // 2. 掃描所有磁碟根目錄
  const roots = getDriveRoots();
  for (const root of roots) {
    // 直接在根目錄找 config.env
    const directConfig = join(root, 'config.env');
    const directToken = readTokenFromConfig(directConfig);
    if (directToken === DEVICE_TOKEN) return true;

    // 在 PRODUCT_DIR 子資料夾找 config.env
    const productConfig = join(root, PRODUCT_DIR, 'config.env');
    const productToken = readTokenFromConfig(productConfig);
    if (productToken === DEVICE_TOKEN) return true;

    // 在 PRODUCT_DIR/data 子資料夾找 config.env
    const dataConfig = join(root, PRODUCT_DIR, 'data', 'config.env');
    const dataToken = readTokenFromConfig(dataConfig);
    if (dataToken === DEVICE_TOKEN) return true;

    // 在 portable 子資料夾找 config.env
    const portableConfig = join(root, PRODUCT_DIR, 'portable', 'config.env');
    const portableToken = readTokenFromConfig(portableConfig);
    if (portableToken === DEVICE_TOKEN) return true;
  }

  return false;
}

// ── 彈出平台特定的警告對話框 ──────────────────────────────────
function showAlert(message, title) {
  const os = platform();

  // 將換行符號 \\n 轉換為實際換行
  const displayMsg = message.replace(/\\n/g, '\n');

  if (os === 'win32') {
    // Windows: 使用 PowerShell + Windows Forms MessageBox
    // 先載入 System.Windows.Forms 組件
    const psMessage = displayMsg.replace(/'/g, "''").replace(/\n/g, '`n');
    const psTitle   = title.replace(/'/g, "''");
    const psCmd = [
      'Add-Type -AssemblyName System.Windows.Forms',
      `[System.Windows.Forms.MessageBox]::Show('${psMessage}', '${psTitle}', 'OK', 'Warning')`,
    ].join('; ');
    try {
      execSync(`powershell -NoProfile -Command "${psCmd.replace(/"/g, '\\"')}"`, { stdio: 'ignore' });
    } catch {
      // 若 MessageBox 失敗，改用 BurntToast 通知或靜默
      console.warn('[heartbeat] 無法顯示 Windows 警告對話框');
    }
  } else if (os === 'darwin') {
    // macOS: osascript display dialog
    const escapedMsg   = displayMsg.replace(/"/g, '\\"').replace(/\n/g, '\\n');
    const escapedTitle = title.replace(/"/g, '\\"');
    try {
      execSync(
        `osascript -e 'display dialog "${escapedMsg}" with title "${escapedTitle}" buttons {"OK"} with icon caution'`,
        { stdio: 'ignore' },
      );
    } catch {
      console.warn('[heartbeat] 無法顯示 macOS 警告對話框');
    }
  } else {
    // Linux: 優先 zenity，備選 kdialog
    const escapedMsg   = displayMsg.replace(/"/g, '\\"');
    const escapedTitle = title.replace(/"/g, '\\"');
    try {
      execSync(`zenity --warning --text="${escapedMsg}" --title="${escapedTitle}"`, { stdio: 'ignore' });
    } catch {
      try {
        execSync(`kdialog --sorry "${escapedMsg}" --title "${escapedTitle}"`, { stdio: 'ignore' });
      } catch {
        console.warn('[heartbeat] 無法顯示 Linux 警告對話框（zenity / kdialog 皆不可用）');
      }
    }
  }
}

// ── 執行一次心跳檢查 ──────────────────────────────────────────
function heartbeatCheck() {
  if (!isUsbPresent()) {
    console.warn(`[${new Date().toLocaleString('zh-TW')}] USB 未偵測到，顯示警告...`);
    showAlert(
      '起易蝦AI需要讀取關鍵設定檔以繼續執行，\\n請插入起易蝦AI USB',
      '起易蝦AI系統',
    );
  } else {
    console.log(`[${new Date().toLocaleString('zh-TW')}] USB 心跳正常`);
  }
}

// ── 啟動定時檢查 ──────────────────────────────────────────────
console.log(`起易蝦 USB 心跳偵測已啟動（每 ${INTERVAL_MIN} 分鐘）`);
console.log(`  DEVICE_TOKEN: ${DEVICE_TOKEN.slice(0, 8)}...`);
console.log(`  CONFIG_PATH:  ${CONFIG_PATH || '(未指定，將掃描所有磁碟)'}`);
console.log(`  平台:         ${platform()}`);
console.log('');

// 啟動時立即檢查一次
heartbeatCheck();

// 定時檢查
setInterval(heartbeatCheck, INTERVAL_MIN * 60 * 1000);
