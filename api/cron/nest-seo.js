/**
 * GET /api/cron/nest-seo
 *
 * Vercel cron — runs daily 06:00Z. Dispatches the nest-seo sensor.
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

    const response = await fetch(`${baseUrl}/api/sensor/nest-seo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ trigger: 'cron' }),
    });

    const result = await response.json();

    return res.status(200).json({
      ok: response.ok,
      regime: result.regime,
      blocked: result.blocked,
      dr: result.dr,
      refdomains: result.refdomains,
      drDelta7d: result.drDelta7d,
      refdomainsNet7d: result.refdomainsNet7d,
      cycleCount: result.cycleCount,
      written: result.written,
      errors: result.errors,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.error('Cron nest-seo error:', err);
    return res.status(500).json({ error: err.message });
  }
}
