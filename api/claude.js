// Invoice Validator Wiz — API Proxy
// Uses Google Vision API for OCR (1000 free/month, no rate limits)
// Then uses Gemini 2.0 Flash to parse the extracted text into structured JSON

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const visionKey = process.env.GOOGLE_VISION_KEY;
  const geminiKey = process.env.GEMINI_API_KEY;

  if (!visionKey && !geminiKey) {
    return res.status(500).json({ error: 'No API keys set. Add GOOGLE_VISION_KEY in Vercel environment variables.' });
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const { messages, max_tokens } = body;

    // ── Step 1: Extract text from images using Google Vision OCR ──────────────
    let extractedText = '';
    let hasImage = false;
    let textOnlyContent = '';

    for (const msg of messages) {
      const content = msg.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'text') {
            textOnlyContent += block.text + '\n';
          } else if (block.type === 'image' && block.source && visionKey) {
            hasImage = true;
            // Call Google Vision API for OCR
            const visionRes = await fetch(
              `https://vision.googleapis.com/v1/images:annotate?key=${visionKey}`,
              {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  requests: [{
                    image: { content: block.source.data },
                    features: [
                      { type: 'DOCUMENT_TEXT_DETECTION', maxResults: 1 },
                    ]
                  }]
                })
              }
            );
            const visionData = await visionRes.json();
            if (visionData.error) {
              return res.status(400).json({ error: 'Vision API error: ' + (visionData.error.message || JSON.stringify(visionData.error)) });
            }
            const ocrText = visionData.responses?.[0]?.fullTextAnnotation?.text || '';
            extractedText += ocrText + '\n';
          }
        }
      } else if (typeof content === 'string') {
        textOnlyContent += content + '\n';
      }
    }

    // Combine OCR text with any text content (PDF text passed directly)
    const fullText = (extractedText + textOnlyContent).trim();

    if (!fullText) {
      return res.status(200).json({
        content: [{ type: 'text', text: '{"error": "no text could be extracted from the document"}' }]
      });
    }

    // ── Step 2: Parse extracted text using Gemini ──────────────────────────────
    // Find the instruction prompt (last text block from messages)
    const allTextBlocks = [];
    for (const msg of messages) {
      const content = msg.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'text') allTextBlocks.push(block.text);
        }
      } else if (typeof content === 'string') {
        allTextBlocks.push(content);
      }
    }
    // The instruction is the last text block (the prompt), OCR text is prepended
    const instruction = allTextBlocks[allTextBlocks.length - 1] || '';

    // Build the parsing prompt with extracted text
    const parsePrompt = hasImage
      ? `${instruction}\n\nEXTRACTED TEXT FROM DOCUMENT (via OCR):\n---\n${fullText}\n---\n\nParse the above extracted text and return the JSON.`
      : fullText; // For PDFs, fullText already contains the prompt + document content

    if (!geminiKey) {
      // No Gemini key — do rule-based parsing as fallback
      const parsed = ruleBasedParse(fullText, instruction);
      return res.status(200).json({
        content: [{ type: 'text', text: JSON.stringify(parsed) }]
      });
    }

    // Call Gemini to parse the structured data from OCR text
    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${geminiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: parsePrompt }] }],
          systemInstruction: {
            parts: [{
              text: 'You are an expert document parser. Always return ONLY a valid raw JSON object. No markdown, no code fences, no explanation. Start with { and end with }.'
            }]
          },
          generationConfig: {
            maxOutputTokens: max_tokens || 2000,
            temperature: 0.1
          }
        })
      }
    );

    const geminiData = await geminiRes.json();

    if (geminiData.error) {
      // Gemini quota hit — fall back to rule-based parsing
      console.log('Gemini error, using rule-based fallback:', geminiData.error.message);
      const parsed = ruleBasedParse(fullText, instruction);
      return res.status(200).json({
        content: [{ type: 'text', text: JSON.stringify(parsed) }]
      });
    }

    const responseText = geminiData.candidates?.[0]?.content?.parts?.[0]?.text || '';

    if (!responseText) {
      const parsed = ruleBasedParse(fullText, instruction);
      return res.status(200).json({
        content: [{ type: 'text', text: JSON.stringify(parsed) }]
      });
    }

    return res.status(200).json({
      content: [{ type: 'text', text: responseText }]
    });

  } catch (err) {
    return res.status(500).json({ error: 'Proxy error: ' + err.message });
  }
}

// ── Rule-based parser fallback (works without any AI) ─────────────────────────
// Used when Gemini quota is exceeded — extracts key fields using regex
function ruleBasedParse(text, instruction) {
  const t = text;
  const isTravel = instruction.toLowerCase().includes('travel') ||
                   instruction.toLowerCase().includes('flight') ||
                   instruction.toLowerCase().includes('hotel') ||
                   /pnr|airline|boarding|check.in|check.out/i.test(t);

  if (isTravel) {
    // Travel document parsing
    const isFlight = /flight|airline|pnr|boarding|depart|arrive|bom|del|maa|blr|hyd|ccu|amd/i.test(t);
    const origin    = extractPattern(t, [/from[:\s]+([A-Z]{3})/i, /origin[:\s]+(\w+)/i, /depart(?:ure)?[:\s]+(\w+)/i, /([A-Z]{3})\s*(?:→|->|to)\s*[A-Z]{3}/i]) || '';
    const dest      = extractPattern(t, [/to[:\s]+([A-Z]{3})/i, /destination[:\s]+(\w+)/i, /arrival[:\s]+(\w+)/i, /[A-Z]{3}\s*(?:→|->|to)\s*([A-Z]{3})/i]) || '';
    const pnr       = extractPattern(t, [/pnr[:\s#]*([A-Z0-9]{5,8})/i, /booking\s*(?:ref|id|no)[:\s#]*([A-Z0-9]{5,10})/i]) || '';
    const flight    = extractPattern(t, [/flight[:\s#]*([A-Z0-9]{2,3}\s*\d{2,4})/i, /([A-Z]{2}\d{3,4})/]) || '';
    const cost      = extractAmount(t);
    const date      = extractDate(t);
    const passenger = extractPattern(t, [/passenger[:\s]+([A-Za-z ]+)/i, /name[:\s]+([A-Za-z ]+)/i, /mr\.?\s+([A-Za-z ]+)/i, /ms\.?\s+([A-Za-z ]+)/i]) || '';
    const invoiceNo = extractPattern(t, [/ticket\s*(?:no|number|#)[:\s]*([A-Z0-9\-]+)/i, /invoice\s*(?:no|#)[:\s]*([A-Z0-9\-]+)/i, pnr]) || `TRV-${randId()}`;

    return {
      travelType: isFlight ? 'Flight' : 'Hotel',
      passengerName: passenger.trim(),
      nameMatchesEmployee: false,
      nameMatchNote: 'Auto-extracted via OCR',
      flight: isFlight ? {
        origin, destination: dest, flightNumber: flight,
        cabinClass: /business/i.test(t) ? 'Business' : 'Economy',
        departureDate: date, returnDate: null,
        passengers: 1,
        estimatedDistanceKm: estimateDistance(origin, dest),
        flightCategory: classifyFlight(origin, dest),
        pnr, ticketCost: cost, currency: extractCurrency(t),
        invoiceNumber: invoiceNo
      } : null,
      hotel: !isFlight ? {
        hotelName: extractPattern(t, [/hotel[:\s]+([A-Za-z ]+)/i, /property[:\s]+([A-Za-z ]+)/i]) || 'Unknown',
        city: extractPattern(t, [/city[:\s]+([A-Za-z ]+)/i, /location[:\s]+([A-Za-z ]+)/i]) || '',
        checkIn: date, checkOut: '',
        nights: parseInt(extractPattern(t, [/(\d+)\s*night/i]) || '1'),
        roomType: extractPattern(t, [/room[:\s]+([A-Za-z ]+)/i, /(deluxe|standard|suite|superior)/i]) || 'Standard',
        guests: 1, bookingRef: pnr, cost, currency: extractCurrency(t),
        invoiceNumber: invoiceNo
      } : null,
      validationIssues: ['Parsed via OCR rule engine — please verify fields'],
      agentNotes: 'Extracted using Google Vision OCR + rule-based parser',
      confidence: cost !== '0' ? 'MEDIUM' : 'LOW'
    };
  }

  // Expense receipt parsing
  const amount    = extractAmount(t);
  const date      = extractDate(t);
  const seller    = extractPattern(t, [/(?:^|\n)([A-Z][A-Za-z &]{2,40})(?:\n|$)/, /restaurant[:\s]+([A-Za-z ]+)/i, /merchant[:\s]+([A-Za-z ]+)/i]) || 'Unknown';
  const invoiceNo = extractPattern(t, [/(?:invoice|bill|receipt)\s*(?:no|#|number)[:\s]*([A-Z0-9\-\/]+)/i, /(?:order|txn|transaction)\s*(?:id|no)[:\s]*([A-Z0-9\-]+)/i]) || `AUTO-${randId()}`;
  const gst       = extractPattern(t, [/gst(?:in)?[:\s]*([A-Z0-9]{15})/i, /gstin[:\s]*([A-Z0-9]{15})/i]) || '';
  const tax       = extractPattern(t, [/(?:gst|tax|sgst|cgst|igst)[:\s₹]*(\d+(?:\.\d{1,2})?)/i]) || '0';
  const currency  = extractCurrency(t);
  const receiptType = classifyReceipt(t);
  const paymentMode = /upi|gpay|phonepe|paytm/i.test(t) ? 'UPI' : /card|visa|master|rupay/i.test(t) ? 'Card' : /cash/i.test(t) ? 'Cash' : 'Unknown';

  return {
    invoiceNumber: invoiceNo,
    invoiceDate: date,
    sellerName: seller.trim().slice(0, 50),
    totalAmount: amount,
    taxAmount: tax,
    currency,
    receiptType,
    lineItems: extractLineItems(t),
    gstNumber: gst,
    paymentMode,
    validationIssues: amount === '0' ? ['Amount not detected — please enter manually'] : [],
    agentNotes: 'Extracted using Google Vision OCR + rule-based parser',
    confidence: amount !== '0' && date ? 'MEDIUM' : 'LOW'
  };
}

// ── Helper functions ───────────────────────────────────────────────────────────
function extractPattern(text, patterns) {
  for (const p of patterns) {
    if (typeof p === 'string' && p) return p;
    if (p instanceof RegExp) {
      const m = text.match(p);
      if (m?.[1]) return m[1].trim();
    }
  }
  return null;
}

function extractAmount(text) {
  // Try to find total/grand total first
  const totalPatterns = [
    /(?:grand\s*total|total\s*amount|amount\s*paid|net\s*amount|total\s*due|total\s*payable|total)[:\s₹$]*(\d+(?:[,\d]*)?(?:\.\d{1,2})?)/gi,
    /₹\s*(\d+(?:[,\d]*)?(?:\.\d{1,2})?)/g,
    /(?:rs\.?|inr)[:\s]*(\d+(?:[,\d]*)?(?:\.\d{1,2})?)/gi,
    /(\d{2,6}(?:\.\d{1,2})?)\s*(?:\/\-|only)/gi,
  ];
  
  let bestAmount = '0';
  let bestValue = 0;
  
  for (const pattern of totalPatterns) {
    const matches = [...text.matchAll(pattern)];
    for (const m of matches) {
      const cleaned = m[1].replace(/,/g, '');
      const val = parseFloat(cleaned);
      if (val > bestValue && val < 10000000) {
        bestValue = val;
        bestAmount = cleaned;
      }
    }
    if (bestValue > 0) break;
  }
  
  return bestAmount;
}

function extractDate(text) {
  const patterns = [
    /(\d{4}[-\/]\d{2}[-\/]\d{2})/,
    /(\d{2}[-\/]\d{2}[-\/]\d{4})/,
    /(\d{1,2})\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+(\d{4})/i,
    /(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+(\d{1,2}),?\s+(\d{4})/i,
  ];
  const months = { jan:'01',feb:'02',mar:'03',apr:'04',may:'05',jun:'06',jul:'07',aug:'08',sep:'09',oct:'10',nov:'11',dec:'12' };
  
  for (const p of patterns) {
    const m = text.match(p);
    if (m) {
      if (m[0].match(/^\d{4}-\d{2}-\d{2}$/)) return m[0];
      if (m[0].match(/^\d{2}[-\/]\d{2}[-\/]\d{4}$/)) {
        const [d, mo, y] = m[0].split(/[-\/]/);
        return `${y}-${mo.padStart(2,'0')}-${d.padStart(2,'0')}`;
      }
      if (m[2] && months[m[2]?.toLowerCase()]) {
        return `${m[3]}-${months[m[2].toLowerCase()]}-${m[1].padStart(2,'0')}`;
      }
      if (m[1] && months[m[1]?.toLowerCase()]) {
        return `${m[3]}-${months[m[1].toLowerCase()]}-${m[2].padStart(2,'0')}`;
      }
    }
  }
  return new Date().toISOString().split('T')[0];
}

function extractCurrency(text) {
  if (/₹|inr|rupee/i.test(text)) return 'INR';
  if (/\$|usd|dollar/i.test(text)) return 'USD';
  if (/€|eur|euro/i.test(text)) return 'EUR';
  if (/£|gbp|pound/i.test(text)) return 'GBP';
  if (/aed|dirham/i.test(text)) return 'AED';
  return 'INR';
}

function classifyReceipt(text) {
  if (/restaurant|food|meal|cafe|pizza|burger|hotel\s*restaurant|swiggy|zomato|lunch|dinner|breakfast/i.test(text)) return 'Food & Beverage';
  if (/uber|ola|taxi|cab|auto|metro|bus|train|rapido|flight|airline/i.test(text)) return 'Conveyance';
  if (/hotel|lodge|inn|stay|accommodation|check.in/i.test(text)) return 'Accommodation';
  if (/air|indigo|spicejet|vistara|airindia|flight|boarding/i.test(text)) return 'Air Travel';
  if (/petrol|diesel|fuel|hp\s*petrol|indian\s*oil|bharat\s*petroleum/i.test(text)) return 'Fuel';
  if (/parking|park/i.test(text)) return 'Parking';
  if (/medical|pharmacy|medicine|hospital|clinic|doctor/i.test(text)) return 'Medical';
  if (/mobile|internet|broadband|airtel|jio|vodafone|bsnl|telecom/i.test(text)) return 'Telecom';
  if (/office|stationery|print|paper|supply/i.test(text)) return 'Office Supplies';
  return 'Other';
}

function extractLineItems(text) {
  const lines = text.split('\n').filter(l => l.trim().length > 2 && l.trim().length < 60);
  return lines.slice(0, 5).join(', ').slice(0, 200);
}

function estimateDistance(origin, dest) {
  const distances = {
    'BOM-DEL': 1150, 'DEL-BOM': 1150,
    'BOM-BLR': 840,  'BLR-BOM': 840,
    'BOM-HYD': 620,  'HYD-BOM': 620,
    'BOM-MAA': 1030, 'MAA-BOM': 1030,
    'DEL-BLR': 1740, 'BLR-DEL': 1740,
    'DEL-HYD': 1250, 'HYD-DEL': 1250,
    'DEL-MAA': 1760, 'MAA-DEL': 1760,
    'DEL-CCU': 1300, 'CCU-DEL': 1300,
    'BOM-CCU': 1650, 'CCU-BOM': 1650,
  };
  const key = `${(origin||'').toUpperCase()}-${(dest||'').toUpperCase()}`;
  return distances[key] || 1000;
}

function classifyFlight(origin, dest) {
  const dist = estimateDistance(origin, dest);
  if (dist < 500)  return 'Domestic (<500km)';
  if (dist < 1500) return 'Short-Haul (500-1500km)';
  if (dist < 4000) return 'Medium-Haul (1500-4000km)';
  return 'Long-Haul (>4000km)';
}

function randId() {
  return Math.random().toString(36).slice(2,8).toUpperCase();
}
