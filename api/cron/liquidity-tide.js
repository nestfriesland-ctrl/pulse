/**
 * GET /api/cron/liquidity-tide
 *
 * Vercel cron — runs every 4h. Dispatches the liquidity-tide sensor.
 */
export default async function handler(req, res) {
  const secret = req.headers['authorization']?.replace('Bearer ', '');
  if (process.env.CRON_SECRET && secret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const baseUrl = process.env.VERCEL_URL
      ? `https://${process.env.VERCEL_URL}`
      : 'http://localhost:3000';

    const response = await fetch(`${baseUrl}/api/sensor/liquidity-tide`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ trigger: 'cron' }),
    });

    const result = await response.json();

    return res.status(200).json({
      ok: response.ok,
      regime: result.regime,
      sweeps: result.sweeps?.length ?? 0,
      cycleCount: result.cycleCount,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.error('Cron liquidity-tide error:', err);
    return res.status(500).json({ error: err.message });
  }
}
