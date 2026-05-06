export default async function handler(req, res) {
  const { path } = req.query;

  if (!path) {
    return res.status(400).json({ error: 'path parameter required' });
  }

  const PAT = process.env.GITHUB_PAT;
  if (!PAT) {
    return res.status(500).json({ error: 'GITHUB_PAT not configured' });
  }

  const baseUrl = 'https://api.github.com/repos/nestfriesland-ctrl/wiki';

  try {
    let url;
    if (path === '_tree') {
      url = `${baseUrl}/git/trees/main?recursive=1`;
    } else if (path === '_sensors') {
      url = `${baseUrl}/contents/sensors?ref=main`;
    } else if (path === '_history') {
      const file = req.query.file;
      if (!file) {
        return res.status(400).json({ error: 'file query param required for _history' });
      }
      const days = Math.min(60, Math.max(1, parseInt(req.query.days || '30', 10)));
      const sinceIso = new Date(Date.now() - days * 86400000).toISOString();
      url = `${baseUrl}/commits?path=${encodeURIComponent(file)}&since=${encodeURIComponent(sinceIso)}&per_page=100`;
    } else {
      url = `${baseUrl}/contents/${path}?ref=main`;
    }

    const response = await fetch(url, {
      headers: {
        'Authorization': `token ${PAT}`,
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'pulse-dashboard'
      }
    });

    if (!response.ok) {
      return res.status(response.status).json({
        error: `GitHub API returned ${response.status}`
      });
    }

    const data = await response.json();

    // _history: collapse commit array to a deduplicated list of YYYY-MM-DD dates.
    if (path === '_history') {
      const dates = Array.isArray(data)
        ? Array.from(new Set(
            data
              .map(c => c && c.commit && c.commit.author && c.commit.author.date)
              .filter(Boolean)
              .map(d => String(d).slice(0, 10))
          ))
        : [];
      res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate');
      return res.status(200).json(dates);
    }

    // Decode base64 content for file requests
    if (data.content && data.encoding === 'base64') {
      data.decoded_content = Buffer.from(data.content, 'base64').toString('utf-8');
    }

    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate');
    return res.status(200).json(data);
  } catch (error) {
    return res.status(500).json({ error: 'Failed to fetch from GitHub' });
  }
}
