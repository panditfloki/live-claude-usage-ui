'use strict';

const usd = n => '$' + (n < 100 ? n.toFixed(2) : Math.round(n).toLocaleString());

function localDay(now = Date.now()) {
  const d = new Date(now);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function percent(limit) {
  return typeof limit?.percent === 'number' ? `${Math.round(limit.percent)}%` : '—';
}

function primaryCodexLimit(codexData) {
  const limits = codexData?.quota?.limits || [];
  return limits.find(l => l.kind === 'primary') || limits[0] || null;
}

function primaryGeminiLimit(geminiData) {
  const limits = geminiData?.quota?.limits || [];
  return limits.find(l => l.kind === 'primary') || limits[0] || null;
}

function codexToday(codexData, now = Date.now()) {
  return (codexData?.daily || []).find(row => row.day === localDay(now)) || null;
}

function geminiToday(geminiData, now = Date.now()) {
  return (geminiData?.daily || []).find(row => row.day === localDay(now)) || null;
}

function statusSummary(metric, claudeData, claudeQuota, codexData, geminiData, now = Date.now()) {
  const claudeSession = claudeQuota?.limits?.find(l => l.kind === 'session') || null;
  const codexPrimary = primaryCodexLimit(codexData);
  const geminiPrimary = primaryGeminiLimit(geminiData);
  const cToday = claudeData?.today;
  const xToday = codexToday(codexData, now);
  const gToday = geminiToday(geminiData, now);

  let label;
  if (metric === 'quota') {
    label = `C ${percent(claudeSession)} · X ${percent(codexPrimary)} · G ${percent(geminiPrimary)}`;
  } else if (metric === 'today') {
    label = `C ${usd(cToday?.cost || 0)} · X ${usd(xToday?.cost || 0)} · G ${usd(gToday?.cost || 0)} today`;
  } else if (metric === 'total') {
    label = `C ${usd(claudeData?.totals?.cost || 0)} · X ${usd(codexData?.totals?.cost || 0)} · G ${usd(geminiData?.totals?.cost || 0)} total`;
  } else {
    // Codex and Gemini have separate primary quotas
    const block = claudeData?.block;
    label = `C ${block ? usd(block.cost) : 'idle'} · X ${percent(codexPrimary)} · G ${percent(geminiPrimary)}`;
  }

  const percents = [
    ...(claudeQuota?.limits || []),
    ...(codexData?.quota?.limits || []),
    ...(geminiData?.quota?.limits || []),
  ].map(l => l.percent).filter(Number.isFinite);

  return {
    label,
    warn: percents.some(p => p >= 80),
    claudeSession,
    codexPrimary,
    geminiPrimary,
    codexToday: xToday,
    geminiToday: gToday,
  };
}

module.exports = { localDay, primaryCodexLimit, primaryGeminiLimit, statusSummary };
