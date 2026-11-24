import fs from 'node:fs';

const SUP_FILE = 'Sup.txt';
const EXTRA_SUBS_FILE = 'external_subs.txt';
const OUTPUT_FILE = 'stats.json';
const CONCURRENCY = 12;
const TIMEOUT_MS = 5000;

const CONFIG_PREFIXES = ['vless://', 'vmess://', 'trojan://', 'ss://', 'ssr://', 'hy2://', 'hysteria2://', 'tuic://', 'wg://'];

function parseUserInfoString(str) {
  if (!str) return null;
  const parts = str.split(';').map(p => p.trim());
  const data = {};
  for (const part of parts) {
    const [k, v] = part.split('=').map(s => s.trim());
    if (k && v !== undefined && !Number.isNaN(Number(v))) {
      data[k.toLowerCase()] = Number(v);
    }
  }
  return data;
}

function analyzeSupFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return { configCount: 0, headerQuota: null };
  }
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split(/\r?\n/);

  let configCount = 0;
  let headerQuota = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    if (line.startsWith('#subscription-userinfo:')) {
      const val = line.replace('#subscription-userinfo:', '').trim();
      headerQuota = parseUserInfoString(val);
      continue;
    }

    const lower = line.toLowerCase();
    if (CONFIG_PREFIXES.some(prefix => lower.startsWith(prefix))) {
      configCount++;
    }
  }

  return { configCount, headerQuota };
}

async function fetchSubscriptionInfo(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    let res = await fetch(url, {
      method: 'HEAD',
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'User-Agent': 'HiddifyNext/2.0 (Subscription Checker)' }
    });

    let infoHeader = res.headers.get('subscription-userinfo');
    if (!infoHeader) {
      res = await fetch(url, {
        method: 'GET',
        redirect: 'follow',
        signal: controller.signal,
        headers: { 'User-Agent': 'HiddifyNext/2.0 (Subscription Checker)' }
      });
      infoHeader = res.headers.get('subscription-userinfo');
    }

    const parsed = parseUserInfoString(infoHeader);
    if (!parsed || typeof parsed.total !== 'number' || parsed.total <= 0) {
      return { hasQuota: false, totalBytes: 0, usedBytes: 0 };
    }

    const usedBytes = (parsed.upload || 0) + (parsed.download || 0);
    return {
      hasQuota: true,
      totalBytes: parsed.total,
      usedBytes: Math.max(0, usedBytes)
    };
  } catch {
    return { hasQuota: false, totalBytes: 0, usedBytes: 0 };
  } finally {
    clearTimeout(timer);
  }
}

async function run() {
  const { configCount, headerQuota } = analyzeSupFile(SUP_FILE);

  let totalBytes = 0;
  let usedBytes = 0;
  let meteredCount = 0;

  if (headerQuota && typeof headerQuota.total === 'number' && headerQuota.total > 0) {
    meteredCount++;
    totalBytes += headerQuota.total;
    usedBytes += Math.max(0, (headerQuota.upload || 0) + (headerQuota.download || 0));
  }

  if (fs.existsSync(EXTRA_SUBS_FILE)) {
    const raw = fs.readFileSync(EXTRA_SUBS_FILE, 'utf8');
    const urls = raw
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(line => line && !line.startsWith('#') && /^https?:\/\//i.test(line));

    let index = 0;
    async function worker() {
      while (index < urls.length) {
        const currentUrl = urls[index++];
        const r = await fetchSubscriptionInfo(currentUrl);
        if (r.hasQuota) {
          meteredCount++;
          totalBytes += r.totalBytes;
          usedBytes += r.usedBytes;
        }
      }
    }

    const workers = Array.from({ length: Math.min(CONCURRENCY, urls.length || 1) }, worker);
    await Promise.all(workers);
  }

  const isUnlimited = totalBytes <= 0;
  const remainingBytes = isUnlimited ? 0 : Math.max(0, totalBytes - usedBytes);
  const usedPercent = isUnlimited ? 0 : Math.min(100, Math.round((usedBytes / totalBytes) * 100));
  const remainingPercent = isUnlimited ? 100 : Math.max(0, 100 - usedPercent);

  const output = {
    updatedAt: new Date().toISOString(),
    configCount,
    meteredCount,
    isUnlimited,
    totalBytes,
    usedBytes,
    remainingBytes,
    usedPercent,
    remainingPercent
  };

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2), 'utf8');
  console.log('Saved stats.json:', output);
}

run();
