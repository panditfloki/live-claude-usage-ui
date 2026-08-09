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

function codexToday(codexData, now = Date.now()) {
  return (codexData?.daily || []).find(row => row.day === localDay(now)) || null;
}

function statusSummary(metric, claudeData, claudeQuota, codexData, now = Date.now()) {
  const claudeSession = claudeQuota?.limits?.find(l => l.kind === 'session') || null;
  const codexPrimary = primaryCodexLimit(codexData);
  const cToday = claudeData?.today;
  const xToday = codexToday(codexData, now);

  let label;
  if (metric === 'quota') {
    label = `C ${percent(claudeSession)} · X ${percent(codexPrimary)}`;
  } else if (metric === 'today') {
    label = `C ${usd(cToday?.cost || 0)} · X ${usd(xToday?.cost || 0)} today`;
  } else if (metric === 'total') {
    label = `C ${usd(claudeData?.totals?.cost || 0)} · X ${usd(codexData?.totals?.cost || 0)} total`;
  } else {
    // Codex has no aligned local 5-hour cost bucket. Its real primary quota is
    // more honest than fabricating one from calendar-day ccusage data.
    const block = claudeData?.block;
    label = `C ${block ? usd(block.cost) : 'idle'} · X ${percent(codexPrimary)}`;
  }

  const percents = [
    ...(claudeQuota?.limits || []),
    ...(codexData?.quota?.limits || []),
  ].map(l => l.percent).filter(Number.isFinite);

  return {
    label,
    warn: percents.some(p => p >= 80),
    claudeSession,
    codexPrimary,
    codexToday: xToday,
  };
}

module.exports = { localDay, primaryCodexLimit, statusSummary };
