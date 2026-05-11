/**
 * GET /api/cron/fear-greed
 *
 * Vercel cron — runs daily 04:00Z. Dispatches the fear-greed sensor.
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

    const response = await fetch(`${baseUrl}/api/sensor/fear-greed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ trigger: 'cron' }),
    });

    const result = await response.json();

    return res.status(200).json({
      ok: response.ok,
      regime: result.regime,
      value: result.value,
      delta24h: result.delta24h,
      delta7dSlope: result.delta7dSlope,
      cycleCount: result.cycleCount,
      written: result.written,
      errors: result.errors,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.error('Cron fear-greed error:', err);
    return res.status(500).json({ error: err.message });
  }
}
