export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  
  const apiKey = process.env.ANTHROPIC_API_KEY;
  
  // Test 1: Check if API key exists
  if (!apiKey) {
    return res.status(200).json({ 
      status: 'FAIL',
      problem: 'ANTHROPIC_API_KEY is not set in Vercel environment variables',
      fix: 'Go to Vercel > Your Project > Settings > Environment Variables > Add ANTHROPIC_API_KEY'
    });
  }

  // Test 2: Try a minimal API call
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 50,
        messages: [{ role: 'user', content: 'Reply with just the word: WORKING' }]
      }),
    });

    const data = await response.json();

    if (data.error) {
      return res.status(200).json({
        status: 'FAIL',
        problem: 'API key exists but Anthropic rejected it',
        anthropic_error: data.error,
        fix: 'Check your API key is correct and has credits at console.anthropic.com'
      });
    }

    return res.status(200).json({
      status: 'OK',
      message: 'Everything is working!',
      api_response: data.content?.[0]?.text,
      key_preview: `${apiKey.slice(0,10)}...${apiKey.slice(-4)}`
    });

  } catch (err) {
    return res.status(200).json({
      status: 'FAIL',
      problem: 'Network error reaching Anthropic',
      error: err.message
    });
  }
}
