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

function resetSuffix(limit, now) {
  if (!limit?.resetsAt || limit.resetsAt <= now) return '';
  const mins = Math.max(1, Math.ceil((limit.resetsAt - now) / 60_000));
  const days = Math.floor(mins / 1440);
  const hours = Math.floor((mins % 1440) / 60);
  const rest = mins % 60;
  const value = days ? `${days}d${hours ? ` ${hours}h` : ''}`
    : hours ? `${hours}h${rest ? ` ${rest}m` : ''}` : `${rest}m`;
  return ` (${value})`;
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

function statusSummary(metric, claudeData, claudeQuota, codexData, geminiData, now = Date.now(), options = {}) {
  const displayMode = options.displayMode || 'compact';
  const warningThreshold = Number(options.warningThreshold ?? 80);
  const errorThreshold = Number(options.errorThreshold ?? 95);
  const claudeSession = claudeQuota?.limits?.find(l => l.kind === 'session') || null;
  const codexPrimary = primaryCodexLimit(codexData);
  const geminiPrimary = primaryGeminiLimit(geminiData);
  const cToday = claudeData?.today;
  const xToday = codexToday(codexData, now);
  const gToday = geminiToday(geminiData, now);

  let label;
  if (metric === 'quota') {
    const suffix = limit => displayMode === 'full' ? resetSuffix(limit, now) : '';
    label = `C ${percent(claudeSession)}${suffix(claudeSession)} · X ${percent(codexPrimary)}${suffix(codexPrimary)} · G ${percent(geminiPrimary)}${suffix(geminiPrimary)}`;
  } else if (metric === 'today') {
    const gCost = gToday && gToday.cost != null ? usd(gToday.cost) : '$0';
    label = `C ${usd(cToday?.cost || 0)} · X ${usd(xToday?.cost || 0)} · G ${gCost} today`;
  } else if (metric === 'total') {
    const gCost = geminiData?.totals?.cost != null ? usd(geminiData.totals.cost) : '$0';
    label = `C ${usd(claudeData?.totals?.cost || 0)} · X ${usd(codexData?.totals?.cost || 0)} · G ${gCost} total`;
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
  const highest = percents.length ? Math.max(...percents) : null;
  const severity = highest != null && highest >= errorThreshold ? 'error'
    : highest != null && highest >= warningThreshold ? 'warning' : 'normal';

  return {
    label,
    warn: severity !== 'normal',
    severity,
    highestPercent: highest,
    claudeSession,
    codexPrimary,
    geminiPrimary,
    codexToday: xToday,
    geminiToday: gToday,
  };
}

module.exports = { localDay, primaryCodexLimit, primaryGeminiLimit, resetSuffix, statusSummary };
