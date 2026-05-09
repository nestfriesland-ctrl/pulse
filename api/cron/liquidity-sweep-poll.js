/**
 * GET /api/cron/liquidity-sweep-poll
 *
 * Light-weight 15-min poll: pulls spot prices for BTC/ETH/HYPE, compares to
 * sweep_state in the previously-written liquidity-tide.md, and if a cluster is
 * crossed, triggers a fresh full sensor dispatch (so the markdown gets the
 * SWEEP-state Krant/Stelling) before the next 4h cycle.
 *
 * No Hyblock call here — Binance spot fetch only. ~3 outbound HTTPs per run.
 */
import { _internal } from '../sensor/liquidity-tide.js';

export default async function handler(req, res) {
  const secret = req.headers['authorization']?.replace('Bearer ', '');
  if (process.env.CRON_SECRET && secret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { parseSweepState, loadPreviousMarkdown, fetchSpot, ASSETS } = _internal;

  try {
    const prevWrap = await loadPreviousMarkdown();
    if (!prevWrap) {
      return res.status(200).json({ ok: true, action: 'noop', reason: 'no_prior_state' });
    }
    const prev = parseSweepState(prevWrap.content);

    const spots = {};
    await Promise.all(ASSETS.map(async a => {
      try { spots[a.label] = await fetchSpot(a.binanceSymbol); }
      catch (e) { spots[a.label] = null; }
    }));

    const crossed = [];
    for (const a of ASSETS) {
      const p = prev[a.label];
      const s = spots[a.label];
      if (!p || s == null) continue;
      if (p.long != null && s <= p.long) crossed.push({ asset: a.label, side: 'long', price: p.long, spot: s });
      if (p.short != null && s >= p.short) crossed.push({ asset: a.label, side: 'short', price: p.short, spot: s });
    }

    if (crossed.length === 0) {
      return res.status(200).json({ ok: true, action: 'intact', spots, prev });
    }

    // Cluster crossed → trigger full dispatch so MD rebuilds with sweep flag.
    const baseUrl = process.env.VERCEL_URL
      ? `https://${process.env.VERCEL_URL}`
      : 'http://localhost:3000';
    const r = await fetch(`${baseUrl}/api/sensor/liquidity-tide`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ trigger: 'sweep-poll' }),
    });
    const result = await r.json().catch(() => ({}));

    return res.status(200).json({ ok: true, action: 'dispatched', crossed, result });
  } catch (err) {
    console.error('liquidity-sweep-poll error:', err);
    return res.status(500).json({ error: err.message });
  }
}
