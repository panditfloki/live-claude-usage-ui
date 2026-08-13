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

// ── Bars ────────────────────────────────────────────────────────────────────
// The status bar takes plain text — no HTML, and no per-character colour. The
// only way to get real colour there is coloured emoji, so the filled segments
// are emoji squares and the empty track is the neutral one.
//
// Bars show what is LEFT, never what is used: a bar that fills up as you burn
// quota would read as "healthy" at exactly the moment you are out. Claude and
// Codex publish "used" and are inverted here; Gemini publishes remaining and
// carries remaining:true. Same rule as the dashboard gauges.
const SEGMENTS = 4;
const FILLED = { ok: '🟩', tight: '🟨', over: '🟥' };
const EMPTY = '⬜';

function leftPercent(limit) {
  if (typeof limit?.percent !== 'number') return null;
  const left = limit.remaining ? limit.percent : 100 - limit.percent;
  return Math.max(0, Math.min(100, Math.round(left)));
}

function toneOf(left) {
  return left <= 10 ? 'over' : left <= 30 ? 'tight' : 'ok';
}

function bar(limit) {
  const left = leftPercent(limit);
  if (left === null) return '—';
  const filled = Math.round((left / 100) * SEGMENTS);
  return FILLED[toneOf(left)].repeat(filled) + EMPTY.repeat(SEGMENTS - filled);
}

// "C 🟩🟩🟩🟩 83%" — the percentage is LEFT, matching the bar it sits beside.
// With no reading at all, collapse to a single "—" rather than printing an
// empty bar and a second dash beside it.
function leg(name, limit) {
  const left = leftPercent(limit);
  if (left === null) return `${name} —`;
  return `${name} ${bar(limit)} ${left}%`;
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

// The Gemini 5-hour window is the one that actually bites during a work
// session; the weekly and the "other models" legs stay in the hover card.
function primaryGeminiLimit(geminiData) {
  const limits = geminiData?.quota?.limits || [];
  return limits.find(l => l.kind === 'gemini' && l.group === 'session')
    || limits.find(l => l.kind === 'gemini')
    || limits[0] || null;
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
    if (options.bars !== false) {
      // Bars carry their own percentage (left), so the reset countdown is the
      // only thing displayMode still adds here.
      label = [
        leg('C', claudeSession) + suffix(claudeSession),
        leg('X', codexPrimary) + suffix(codexPrimary),
        leg('G', geminiPrimary) + suffix(geminiPrimary),
      ].join(' · ');
    } else {
      label = `C ${percent(claudeSession)}${suffix(claudeSession)} · X ${percent(codexPrimary)}${suffix(codexPrimary)} · G ${percent(geminiPrimary)}${suffix(geminiPrimary)}`;
    }
  } else if (metric === 'today') {
    // Gemini cost is unmeasurable (undocumented protobuf) — "—", never "$0",
    // which would read as a measured zero.
    const gCost = gToday && gToday.cost != null ? usd(gToday.cost) : '—';
    label = `C ${usd(cToday?.cost || 0)} · X ${usd(xToday?.cost || 0)} · G ${gCost} today`;
  } else if (metric === 'total') {
    const gCost = geminiData?.totals?.cost != null ? usd(geminiData.totals.cost) : '—';
    label = `C ${usd(claudeData?.totals?.cost || 0)} · X ${usd(codexData?.totals?.cost || 0)} · G ${gCost} total`;
  } else {
    // Codex and Gemini have separate primary quotas
    const block = claudeData?.block;
    label = `C ${block ? usd(block.cost) : 'idle'} · X ${percent(codexPrimary)} · G ${percent(geminiPrimary)}`;
  }

  // Gemini limits are REMAINING, not used (gemini.js DIRECTION note): 100%
  // means a full tank, which must never trip the warning colour. Invert those
  // before comparing against thresholds that are written in "used" terms.
  const percents = [
    ...(claudeQuota?.limits || []),
    ...(codexData?.quota?.limits || []),
    ...(geminiData?.quota?.limits || []),
  ].map(l => (l.remaining ? 100 - l.percent : l.percent)).filter(Number.isFinite);
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
