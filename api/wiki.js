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
