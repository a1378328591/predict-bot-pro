#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

const inputPath = process.argv[2];
const mode = process.argv[3] || '--scan-only';

if (!inputPath || !['--scan-only', '--analyze'].includes(mode)) {
  console.error('用法: node scripts/inspect-market-log.js <日志路径> [--scan-only|--analyze]');
  process.exit(2);
}

const resolvedPath = path.resolve(inputPath);
const sensitivePatterns = [
  { name: 'PEM 私钥', pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/i },
  { name: '助记词或 seed', pattern: /(?:mnemonic|seed\s*phrase|recovery\s*phrase|助记词|私钥)\s*[:=]/i },
  { name: '私钥或 secret 字段', pattern: /(?:private[_ -]?key|secret[_ -]?key|api[_ -]?secret|client[_ -]?secret)\s*[:=]/i },
  { name: '访问 token 字段', pattern: /(?:access[_ -]?token|refresh[_ -]?token|id[_ -]?token|authorization)\s*[:=]/i },
  { name: 'Bearer token', pattern: /\bbearer\s+[A-Za-z0-9._~+/=-]{16,}/i },
  { name: 'JWT', pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/ },
  { name: '私钥字段中的 EVM 私钥', pattern: /(?:private[_ -]?key|secret[_ -]?key)\s*[:=]\s*["']?(?:0x)?[a-f0-9]{64}\b/i },
];

function readLines(filePath) {
  return fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
}

function scanLines(lines) {
  const findings = [];
  for (let index = 0; index < lines.length; index += 1) {
    for (const entry of sensitivePatterns) {
      if (entry.pattern.test(lines[index])) {
        findings.push({ name: entry.name, line: index + 1 });
      }
    }
  }
  return findings;
}

function cleanText(value) {
  return String(value)
    .replace(/\s+/g, ' ')
    .replace(/["'`]/g, '')
    .trim()
    .slice(0, 180);
}

function analyze(lines) {
  const losses = new Map();
  const titles = new Map();
  const sellLine = /(?:足球持仓限价卖|紧急平仓按买一全仓限价卖|紧急平仓成本价为0.*限价卖|非紧急持仓限价卖)/;
  const urgentReason = /(?:已开赛|开赛不足|开赛临近|开赛)/;

  function value(line, key) {
    const match = line.match(new RegExp(`${key}=([^\\s]+)`));
    return match ? match[1] : null;
  }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const marketId = value(line, 'marketId');
    if (marketId) {
      const titleMatch = line.match(/title=([^\s].*?)(?:\s+(?:orderSide|orderPrice|outcome|predictBid|polyBid|reason)=|$)/);
      if (titleMatch) titles.set(marketId, cleanText(titleMatch[1]));
    }

    if (!sellLine.test(line) || !marketId) continue;
    const qty = Number(value(line, 'qty'));
    const buy = Number(value(line, 'buyPrice') ?? value(line, 'buy'));
    const sellPrice = Number(value(line, 'sellPrice'));
    if (![qty, buy, sellPrice].every(Number.isFinite) || sellPrice >= buy) continue;

    const current = losses.get(marketId) || {
      count: 0,
      quantity: 0,
      estimatedLoss: 0,
      urgentCount: 0,
      reasons: new Set(),
      lines: [],
    };
    current.count += 1;
    current.quantity += qty;
    current.estimatedLoss += (buy - sellPrice) * qty;
    const reason = line.match(/reason=(.*)$/)?.[1] || '';
    if (urgentReason.test(reason)) {
      current.urgentCount += 1;
      current.reasons.add(cleanText(reason));
    }
    if (current.lines.length < 5) current.lines.push(index + 1);
    losses.set(marketId, current);
  }

  return { losses, titles };
}

try {
  if (!fs.existsSync(resolvedPath)) throw new Error(`文件不存在: ${resolvedPath}`);
  const lines = readLines(resolvedPath);
  const findings = scanLines(lines);

  console.log(`扫描文件: ${resolvedPath}`);
  console.log(`扫描行数: ${lines.length}`);
  if (findings.length > 0) {
    console.log('结果: 发现疑似敏感凭据，已停止，不输出日志内容。');
    const grouped = new Map();
    for (const finding of findings) {
      const current = grouped.get(finding.name) || { count: 0, lines: [] };
      current.count += 1;
      if (current.lines.length < 5) current.lines.push(finding.line);
      grouped.set(finding.name, current);
    }
    for (const [name, value] of grouped) {
      console.log(`- ${name}: ${value.count} 次，示例行 ${value.lines.join(', ')}`);
    }
    process.exit(1);
  }

  console.log('结果: 未命中内置的私钥、助记词、JWT、Bearer/API token 等模式。');
  if (mode === '--scan-only') process.exit(0);

  const result = analyze(lines);
  console.log('\n疑似亏损平仓挂单（按 buy 与 sellPrice 估算，非成交确认）:');
  if (result.losses.size === 0) {
    console.log('- 未识别到 sellPrice 低于 buy/buyPrice 的平仓挂单。');
  } else {
    const sortedLosses = [...result.losses].sort(([, a], [, b]) => b.estimatedLoss - a.estimatedLoss);
    const totalEstimatedLoss = sortedLosses.reduce((total, [, value]) => total + value.estimatedLoss, 0);
    console.log(`- 共 ${sortedLosses.length} 个市场，估算价差损失合计 ${totalEstimatedLoss.toFixed(8)}`);
    for (const [market, value] of sortedLosses) {
      const title = result.titles.get(market);
      const titleSuffix = title ? `，标题 ${title}` : '';
      const reasonSuffix = value.reasons.size ? `，原因 ${[...value.reasons].join(' | ')}` : '';
      console.log(`- marketId=${market}${titleSuffix}: ${value.count} 条，数量 ${value.quantity.toFixed(4)}，估算价差损失 ${value.estimatedLoss.toFixed(8)}，其中开赛相关 ${value.urgentCount} 条${reasonSuffix}，日志行 ${value.lines.join(', ')}`);
    }
  }
} catch (error) {
  console.error(`无法处理日志: ${error.message}`);
  process.exitCode = 2;
}
