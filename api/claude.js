export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'GEMINI_API_KEY not set in Vercel environment variables' });
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const { messages, max_tokens } = body;

    // Build Gemini parts from Anthropic message format
    const parts = [];
    for (const msg of messages) {
      const content = msg.content;
      if (typeof content === 'string') {
        parts.push({ text: content });
      } else if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'text') {
            parts.push({ text: block.text });
          } else if (block.type === 'image' && block.source) {
            parts.push({
              inlineData: {
                mimeType: block.source.media_type,
                data: block.source.data
              }
            });
          }
        }
      }
    }

    // Try models in order until one works
    const MODELS = [
      'gemini-2.0-flash',
      'gemini-2.0-flash-lite',
      'gemini-1.5-flash-latest',
      'gemini-1.5-flash-8b',
    ];

    let lastError = null;

    for (const model of MODELS) {
      try {
        const geminiRes = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{ role: 'user', parts }],
              generationConfig: {
                maxOutputTokens: max_tokens || 2000,
                temperature: 0.1,
              },
              systemInstruction: {
                parts: [{
                  text: 'You are an expert document parser. Always return ONLY valid raw JSON with no markdown fences, no explanation, no preamble. Just the JSON object starting with { and ending with }.'
                }]
              }
            })
          }
        );

        const geminiData = await geminiRes.json();

        if (geminiData.error) {
          lastError = geminiData.error.message;
          continue; // try next model
        }

        const text = geminiData.candidates?.[0]?.content?.parts?.[0]?.text || '';

        if (!text) {
          lastError = 'Empty response from model ' + model;
          continue;
        }

        // Success — return in Anthropic format
        return res.status(200).json({
          content: [{ type: 'text', text }]
        });

      } catch (modelErr) {
        lastError = modelErr.message;
        continue;
      }
    }

    // All models failed
    return res.status(400).json({ error: 'All Gemini models failed. Last error: ' + lastError });

  } catch (err) {
    return res.status(500).json({ error: 'Proxy error: ' + err.message });
  }
}
