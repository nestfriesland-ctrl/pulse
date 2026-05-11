// Test confluence handler tegen gemockte wiki-suppliers.
//
// Dekking:
//   - 1 supplier 404 (liquidity-tide.md)
//   - 1 supplier met BOM-prefix in markdown (market.md)
//   - 2 normale suppliers (macro-regime.md, watchlist.md)
//
// Asserties: HTTP 200, regime in toegestane set, errors-array bevat 404-entry,
// en perSupplier-frontmatter is gelezen voor de BOM-supplier.

const path = require('path');
const handlerPath = path.resolve(__dirname, '../api/sensor/confluence.js');

const ALLOWED_REGIMES = new Set(['ALIGNED_LONG', 'ALIGNED_SHORT', 'DIVERGENT', 'WAIT']);

const NOW = new Date().toISOString();
const FRESH_TS = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1u oud

function mdMarket() {
  // BOM-prefix: U+FEFF aan het begin van het document.
  return '﻿---\nsensor: market\nregime: BULL_4H\nlast_successful_at: ' + FRESH_TS + '\n---\n\n# market\n';
}
function mdMacro() {
  return '---\nsensor: macro-regime\nregime: RISK-ON\nliquidity_regime: M2-EXPANDING\nreal_yield_regime: REAL-EASING\nlast_successful_at: ' + FRESH_TS + '\n---\n\n# macro\n';
}
function mdWatchlist() {
  return '---\nsensor: watchlist\nregime: NEUTRAL\nlast_successful_at: ' + FRESH_TS + '\n---\n\n# watchlist\n';
}

function b64(s) { return Buffer.from(s, 'utf-8').toString('base64'); }

const MOCK_RESPONSES = {
  // GET supplier files
  'sensors/market.md': { ok: true, body: { content: b64(mdMarket()), sha: 'sha-market' } },
  'sensors/macro-regime.md': { ok: true, body: { content: b64(mdMacro()), sha: 'sha-macro' } },
  'sensors/watchlist.md': { ok: true, body: { content: b64(mdWatchlist()), sha: 'sha-watch' } },
  'sensors/liquidity-tide.md': { ok: false, status: 404 },
  // GET prev confluence.md (first run: 404)
  'sensors/confluence.md': { ok: false, status: 404 },
};

let writeCalled = false;
let writePayload = null;

global.fetch = async (url, opts = {}) => {
  // GET contents endpoint matchen op pad-suffix.
  for (const key of Object.keys(MOCK_RESPONSES)) {
    if (url.includes('/contents/' + key)) {
      const m = MOCK_RESPONSES[key];
      if ((opts.method || 'GET') === 'PUT') {
        writeCalled = true;
        writePayload = JSON.parse(opts.body);
        return { ok: true, status: 200, json: async () => ({ content: { sha: 'new-sha' } }) };
      }
      return {
        ok: m.ok,
        status: m.status || (m.ok ? 200 : 500),
        json: async () => m.body || { message: 'mock error' },
      };
    }
  }
  throw new Error('unmocked fetch: ' + url);
};

process.env.GITHUB_PAT = 'mock_pat_for_test';

function assert(cond, msg) {
  if (!cond) { console.error('FAIL:', msg); process.exit(1); }
  console.log('PASS:', msg);
}

(async () => {
  const mod = await import(handlerPath);
  const handler = mod.default;

  let captured = null;
  const req = { method: 'POST', headers: {}, body: { trigger: 'test' } };
  const res = {
    setHeader: () => {},
    status(code) {
      return { json(data) { captured = { code, data }; return data; } };
    },
  };

  await handler(req, res);

  assert(captured != null, 'handler called res.status().json()');
  assert(captured.code === 200, 'HTTP 200 (got ' + captured.code + ')');
  assert(ALLOWED_REGIMES.has(captured.data.regime), 'regime in {ALIGNED_LONG, ALIGNED_SHORT, DIVERGENT, WAIT} (got ' + captured.data.regime + ')');
  assert(Array.isArray(captured.data.errors), 'errors is array');
  assert(captured.data.errors.some(e => e.includes('liquidity-tide.md') && e.includes('404')), 'errors bevat liquidity-tide 404-entry');

  const ps = captured.data.snapshot.perSupplier;
  assert(ps['market.md'].regime === 'BULL_4H', 'BOM-prefixed market.md frontmatter geparsed (regime=BULL_4H)');
  assert(ps['market.md'].fresh === true, 'BOM-prefixed market.md is fresh');
  assert(ps['liquidity-tide.md'].fresh === false, 'liquidity-tide.md is stale (404)');
  assert(ps['liquidity-tide.md'].score === null, 'liquidity-tide.md score is null');

  assert(writeCalled, 'wiki write attempted');
  assert(writePayload && typeof writePayload.content === 'string', 'wiki write payload bevat content');

  console.log('\nALL TESTS PASSED');
})().catch(e => { console.error('TEST CRASH:', e.message); console.error(e.stack); process.exit(1); });
