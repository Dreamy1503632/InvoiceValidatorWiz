// Invoice Validator Wiz — Extraction API
// Uses Google Vision API for OCR → rule-based parser for field extraction
// No Gemini, no AI quota limits, works 100% reliably

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const visionKey = process.env.GOOGLE_VISION_KEY;
  if (!visionKey) {
    return res.status(500).json({ error: 'GOOGLE_VISION_KEY not set in Vercel environment variables' });
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const { messages } = body;

    // ── Step 1: Collect image data and text content from messages ─────────────
    let imageBase64 = null;
    let imageMimeType = 'image/jpeg';
    let textContent = '';

    for (const msg of messages) {
      const content = msg.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'image' && block.source?.data) {
            imageBase64 = block.source.data;
            imageMimeType = block.source.media_type || 'image/jpeg';
          }
          if (block.type === 'text') {
            textContent += block.text + '\n';
          }
        }
      } else if (typeof content === 'string') {
        textContent += content + '\n';
      }
    }

    // ── Step 2: OCR the image using Google Vision API ─────────────────────────
    let ocrText = '';

    if (imageBase64) {
      const visionRes = await fetch(
        `https://vision.googleapis.com/v1/images:annotate?key=${visionKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            requests: [{
              image: { content: imageBase64 },
              features: [{ type: 'DOCUMENT_TEXT_DETECTION' }]
            }]
          })
        }
      );

      const visionData = await visionRes.json();

      if (visionData.error) {
        return res.status(400).json({
          error: 'Google Vision API error: ' + (visionData.error.message || JSON.stringify(visionData.error))
        });
      }

      ocrText = visionData.responses?.[0]?.fullTextAnnotation?.text || '';
    }

    // For PDFs — text is passed directly in the message content
    // Combine OCR text with any direct text content
    const fullText = (ocrText + '\n' + textContent).trim();

    if (!fullText) {
      return res.status(200).json({
        content: [{ type: 'text', text: JSON.stringify({
          invoiceNumber: `AUTO-${randId()}`,
          invoiceDate: todayStr(),
          sellerName: 'Unknown',
          totalAmount: '0',
          taxAmount: '0',
          currency: 'INR',
          receiptType: 'Other',
          lineItems: '',
          gstNumber: '',
          paymentMode: 'Unknown',
          validationIssues: ['No text could be extracted from document'],
          agentNotes: '',
          confidence: 'LOW'
        })}]
      });
    }

    // ── Step 3: Determine if this is a travel or expense document ─────────────
    const isTravel = /pnr|flight|airline|boarding|check.in|check.out|hotel|lodge|inn|departure|arrival|passenger/i.test(fullText);

    // ── Step 4: Parse fields using rule-based extraction ──────────────────────
    let parsed;
    if (isTravel) {
      parsed = parseTravelDocument(fullText);
    } else {
      parsed = parseExpenseReceipt(fullText);
    }

    return res.status(200).json({
      content: [{ type: 'text', text: JSON.stringify(parsed) }]
    });

  } catch (err) {
    return res.status(500).json({ error: 'Server error: ' + err.message });
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXPENSE RECEIPT PARSER
// ═══════════════════════════════════════════════════════════════════════════════
function parseExpenseReceipt(text) {
  const amount      = extractAmount(text);
  const date        = extractDate(text);
  const seller      = extractSeller(text);
  const invoiceNo   = extractInvoiceNumber(text);
  const gst         = extractGST(text);
  const tax         = extractTax(text);
  const currency    = extractCurrency(text);
  const receiptType = classifyReceipt(text);
  const paymentMode = extractPaymentMode(text);

  const issues = [];
  if (amount === '0') issues.push('Total amount not detected — please enter manually');
  if (!date)          issues.push('Date not detected — please verify');
  if (seller === 'Unknown') issues.push('Seller name not clearly detected');

  return {
    invoiceNumber:    invoiceNo,
    invoiceDate:      date || todayStr(),
    sellerName:       seller,
    totalAmount:      amount,
    taxAmount:        tax,
    currency:         currency,
    receiptType:      receiptType,
    lineItems:        extractLineItems(text),
    gstNumber:        gst,
    paymentMode:      paymentMode,
    validationIssues: issues,
    agentNotes:       `OCR extracted ${text.length} characters`,
    confidence:       amount !== '0' && seller !== 'Unknown' ? 'HIGH' : amount !== '0' ? 'MEDIUM' : 'LOW'
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// TRAVEL DOCUMENT PARSER
// ═══════════════════════════════════════════════════════════════════════════════
function parseTravelDocument(text) {
  const isFlight = /flight|airline|pnr|boarding|depart|arrive|bom|del|maa|blr|hyd|ccu|amd|[A-Z]{2}\d{3,4}/i.test(text);
  const passenger = extractPassengerName(text);
  const pnr       = extractPNR(text);
  const date      = extractDate(text);
  const amount    = extractAmount(text);
  const currency  = extractCurrency(text);
  const invoiceNo = extractPattern(text, [
    /ticket\s*(?:no|number|#)[:\s]*([A-Z0-9\-]{5,15})/i,
    /invoice\s*(?:no|#)[:\s]*([A-Z0-9\-]{5,15})/i
  ]) || pnr || `TRV-${randId()}`;

  if (isFlight) {
    const origin  = extractAirport(text, 'origin');
    const dest    = extractAirport(text, 'dest');
    const flight  = extractPattern(text, [/([A-Z]{2}\s*\d{3,4})/]) || '';
    const cabin   = /business/i.test(text) ? 'Business' : /first\s*class/i.test(text) ? 'First' : /premium/i.test(text) ? 'Premium Economy' : 'Economy';
    const distKm  = estimateDistance(origin, dest);

    return {
      travelType: 'Flight',
      passengerName: passenger,
      nameMatchesEmployee: false,
      nameMatchNote: 'Please verify passenger matches employee',
      flight: {
        origin, destination: dest,
        flightNumber: flight.replace(/\s/g, ''),
        cabinClass: cabin,
        departureDate: date || todayStr(),
        returnDate: null,
        passengers: 1,
        estimatedDistanceKm: distKm,
        flightCategory: classifyFlight(distKm),
        pnr, ticketCost: amount, currency, invoiceNumber: invoiceNo
      },
      hotel: null,
      validationIssues: amount === '0' ? ['Ticket cost not detected — please enter manually'] : [],
      agentNotes: `OCR extracted ${text.length} characters`,
      confidence: origin && dest ? 'HIGH' : amount !== '0' ? 'MEDIUM' : 'LOW'
    };
  }

  // Hotel
  const hotelName = extractPattern(text, [
    /(?:hotel|property|resort|inn|lodge)[:\s]+([A-Za-z &]{3,40})/i,
    /^([A-Z][A-Za-z &]{3,40})\s*(?:hotel|resort|inn)/mi
  ]) || extractSeller(text);
  const city      = extractPattern(text, [/city[:\s]+([A-Za-z ]+)/i, /location[:\s]+([A-Za-z ]+)/i]) || '';
  const checkIn   = date || todayStr();
  const nights    = parseInt(extractPattern(text, [/(\d+)\s*night/i]) || '1');
  const roomType  = extractPattern(text, [/(deluxe|standard|suite|superior|premium)\s*(?:room)?/i]) || 'Standard';

  return {
    travelType: 'Hotel',
    passengerName: passenger,
    nameMatchesEmployee: false,
    nameMatchNote: 'Please verify guest matches employee',
    flight: null,
    hotel: {
      hotelName: hotelName.trim().slice(0, 50),
      city, checkIn,
      checkOut: '',
      nights, roomType,
      guests: 1,
      bookingRef: pnr,
      cost: amount, currency,
      invoiceNumber: invoiceNo
    },
    validationIssues: amount === '0' ? ['Hotel cost not detected — please enter manually'] : [],
    agentNotes: `OCR extracted ${text.length} characters`,
    confidence: hotelName !== 'Unknown' ? 'MEDIUM' : 'LOW'
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// FIELD EXTRACTORS
// ═══════════════════════════════════════════════════════════════════════════════

function extractAmount(text) {
  const lines = text.split('\n');

  // First pass — look for labeled total lines
  const totalLabels = /grand\s*total|total\s*amount|amount\s*paid|net\s*amount|total\s*due|total\s*payable|bill\s*amount|payable\s*amount|^total$/im;
  for (const line of lines) {
    if (totalLabels.test(line)) {
      const nums = line.match(/[\d,]+(?:\.\d{1,2})?/g);
      if (nums) {
        const vals = nums.map(n => parseFloat(n.replace(/,/g, ''))).filter(v => v > 0 && v < 10000000);
        if (vals.length) return String(Math.max(...vals));
      }
    }
  }

  // Second pass — find ₹ or currency amounts, take the largest (likely total)
  const amountPatterns = [
    /₹\s*([\d,]+(?:\.\d{1,2})?)/g,
    /(?:rs\.?|inr)[:\s]*([\d,]+(?:\.\d{1,2})?)/gi,
    /total[^\n\d]*([\d,]+(?:\.\d{1,2})?)/gi,
  ];

  let best = 0;
  for (const pattern of amountPatterns) {
    const matches = [...text.matchAll(pattern)];
    for (const m of matches) {
      const val = parseFloat(m[1].replace(/,/g, ''));
      if (val > best && val < 10000000) best = val;
    }
    if (best > 0) break;
  }

  // Third pass — find standalone large numbers that look like amounts
  if (best === 0) {
    const standaloneNums = [...text.matchAll(/\b(\d{3,6}(?:\.\d{2})?)\b/g)];
    const candidates = standaloneNums
      .map(m => parseFloat(m[1]))
      .filter(v => v >= 10 && v < 500000);
    if (candidates.length) best = Math.max(...candidates);
  }

  return best > 0 ? String(best) : '0';
}

function extractDate(text) {
  const patterns = [
    /\b(\d{4}[-\/]\d{2}[-\/]\d{2})\b/,
    /\b(\d{2}[-\/]\d{2}[-\/]\d{4})\b/,
    /\b(\d{1,2})\s+(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{4})\b/i,
    /\b(\d{1,2})\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+(\d{4})\b/i,
    /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+(\d{1,2}),?\s+(\d{4})\b/i,
    /\b(\d{1,2})[-\/](\d{1,2})[-\/](\d{2,4})\b/,
  ];

  const MONTHS = {
    january:'01', february:'02', march:'03', april:'04', may:'05', june:'06',
    july:'07', august:'08', september:'09', october:'10', november:'11', december:'12',
    jan:'01', feb:'02', mar:'03', apr:'04', jun:'06', jul:'07',
    aug:'08', sep:'09', oct:'10', nov:'11', dec:'12'
  };

  for (const p of patterns) {
    const m = text.match(p);
    if (!m) continue;

    // YYYY-MM-DD
    if (/^\d{4}-\d{2}-\d{2}$/.test(m[1])) return m[1];
    // DD/MM/YYYY
    if (/^\d{2}[-\/]\d{2}[-\/]\d{4}$/.test(m[0])) {
      const parts = m[0].split(/[-\/]/);
      return `${parts[2]}-${parts[1].padStart(2,'0')}-${parts[0].padStart(2,'0')}`;
    }
    // DD Month YYYY
    if (m[2] && MONTHS[m[2]?.toLowerCase()]) {
      return `${m[3]}-${MONTHS[m[2].toLowerCase()]}-${m[1].padStart(2,'0')}`;
    }
    // Month DD YYYY
    if (m[1] && MONTHS[m[1]?.toLowerCase()]) {
      return `${m[3]}-${MONTHS[m[1].toLowerCase()]}-${m[2].padStart(2,'0')}`;
    }
    // DD/MM/YY
    if (m[3] && m[3].length === 2) {
      const yr = parseInt(m[3]) > 50 ? `19${m[3]}` : `20${m[3]}`;
      return `${yr}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`;
    }
  }
  return null;
}

function extractSeller(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 2);

  // Skip common non-name lines
  const skip = /^(tax|invoice|receipt|bill|date|time|amount|total|gst|phone|tel|email|address|thank|welcome|\d|#|www\.|http)/i;

  // First meaningful line is usually the business name
  for (const line of lines.slice(0, 6)) {
    if (!skip.test(line) && line.length >= 3 && line.length <= 60) {
      // Remove common suffixes
      return line.replace(/\s*(pvt\.?\s*ltd\.?|limited|llp|llc|inc\.?)$/i, '').trim();
    }
  }

  // Try labeled fields
  const labeled = extractPattern(text, [
    /(?:merchant|vendor|seller|billed\s*by|sold\s*by)[:\s]+([A-Za-z &']{3,50})/i,
    /(?:restaurant|hotel|store|shop)[:\s]+([A-Za-z &']{3,50})/i,
  ]);
  if (labeled) return labeled;

  return 'Unknown';
}

function extractInvoiceNumber(text) {
  return extractPattern(text, [
    /(?:invoice|bill|receipt)\s*(?:no|#|number|id)[:\s]*([A-Z0-9\-\/]{3,20})/i,
    /(?:order|txn|transaction|ref)\s*(?:id|no|#)[:\s]*([A-Z0-9\-]{5,20})/i,
    /(?:receipt)\s*#\s*([A-Z0-9\-]{3,15})/i,
    /\b([A-Z]{2,4}[-\/]?\d{4,10})\b/,
  ]) || `AUTO-${randId()}`;
}

function extractGST(text) {
  const m = text.match(/(?:gstin?|gst\s*no)[:\s]*([0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1})/i);
  return m ? m[1].toUpperCase() : '';
}

function extractTax(text) {
  const m = text.match(/(?:gst|tax|cgst|sgst|igst)\s*(?:@\s*\d+%)?[:\s₹]*([\d,]+(?:\.\d{1,2})?)/i);
  if (m) {
    const val = parseFloat(m[1].replace(/,/g, ''));
    if (val > 0 && val < 100000) return String(val);
  }
  return '0';
}

function extractCurrency(text) {
  if (/₹|inr|rupee/i.test(text)) return 'INR';
  if (/\$\s*\d|usd|dollar/i.test(text)) return 'USD';
  if (/€|eur|euro/i.test(text)) return 'EUR';
  if (/£|gbp|pound/i.test(text)) return 'GBP';
  if (/aed|dirham/i.test(text)) return 'AED';
  if (/sgd/i.test(text)) return 'SGD';
  return 'INR';
}

function extractPaymentMode(text) {
  if (/upi|gpay|google\s*pay|phonepe|paytm|bhim/i.test(text)) return 'UPI';
  if (/debit\s*card|credit\s*card|visa|mastercard|rupay|amex/i.test(text)) return 'Card';
  if (/net\s*banking|neft|rtgs|imps|bank\s*transfer/i.test(text)) return 'Bank Transfer';
  if (/cash/i.test(text)) return 'Cash';
  return 'Unknown';
}

function classifyReceipt(text) {
  if (/restaurant|food|meal|cafe|coffee|pizza|burger|swiggy|zomato|lunch|dinner|breakfast|biryani|thali/i.test(text)) return 'Food & Beverage';
  if (/uber|ola|taxi|cab|auto|metro|bus|rapido|conveyance|transport/i.test(text)) return 'Conveyance';
  if (/petrol|diesel|fuel|hp\s*petrol|indian\s*oil|bharat\s*petroleum|pump/i.test(text)) return 'Fuel';
  if (/hotel|lodge|inn|stay|accommodation|check.in|room/i.test(text)) return 'Accommodation';
  if (/flight|airfare|airline|indigo|spicejet|airindia|boarding/i.test(text)) return 'Air Travel';
  if (/train|irctc|railway|rail/i.test(text)) return 'Rail Travel';
  if (/parking|toll/i.test(text)) return 'Parking';
  if (/medical|pharmacy|medicine|hospital|clinic|doctor|health/i.test(text)) return 'Medical';
  if (/mobile|recharge|internet|broadband|airtel|jio|vodafone|bsnl/i.test(text)) return 'Telecom';
  if (/office|stationery|print|paper|pen|supplies/i.test(text)) return 'Office Supplies';
  if (/amazon|flipkart|myntra|shopping|purchase/i.test(text)) return 'Other';
  return 'Other';
}

function extractLineItems(text) {
  const lines = text.split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 3 && l.length < 60)
    .filter(l => !/^(total|gst|tax|subtotal|date|time|invoice|receipt|bill|thank|welcome|www\.|address|phone|email)/i.test(l))
    .filter(l => /[a-zA-Z]/.test(l));
  return lines.slice(0, 5).join(', ').slice(0, 200);
}

function extractPassengerName(text) {
  return extractPattern(text, [
    /passenger(?:\s*name)?[:\s]+([A-Za-z ]{3,40})/i,
    /(?:mr\.?|ms\.?|mrs\.?|dr\.?)\s+([A-Za-z ]{3,40})/i,
    /name[:\s]+([A-Za-z ]{3,40})/i,
    /guest[:\s]+([A-Za-z ]{3,40})/i,
  ]) || '';
}

function extractPNR(text) {
  return extractPattern(text, [
    /pnr[:\s#]*([A-Z0-9]{5,8})/i,
    /booking\s*(?:ref|id|no|reference)[:\s#]*([A-Z0-9]{5,12})/i,
    /confirmation[:\s#]*([A-Z0-9]{5,12})/i,
  ]) || '';
}

function extractAirport(text, type) {
  const routeMatch = text.match(/([A-Z]{3})\s*(?:→|->|to|-)\s*([A-Z]{3})/i);
  if (routeMatch) return type === 'origin' ? routeMatch[1].toUpperCase() : routeMatch[2].toUpperCase();

  if (type === 'origin') {
    return extractPattern(text, [
      /(?:from|origin|departure|departing)[:\s]+([A-Z]{3})/i,
      /(?:from|origin|departure)[:\s]+([A-Za-z ]+?)(?:\n|to|→)/i,
    ]) || '';
  }
  return extractPattern(text, [
    /(?:to|destination|arrival|arriving)[:\s]+([A-Z]{3})/i,
    /(?:to|destination|arrival)[:\s]+([A-Za-z ]+?)(?:\n|$)/i,
  ]) || '';
}

function extractPattern(text, patterns) {
  for (const p of patterns) {
    if (p instanceof RegExp) {
      const m = text.match(p);
      if (m?.[1]) return m[1].trim();
    }
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// DISTANCE & CARBON HELPERS
// ═══════════════════════════════════════════════════════════════════════════════
function estimateDistance(origin, dest) {
  const AIRPORTS = {
    'BOM':[19.0896,72.8656],'DEL':[28.5562,77.1000],'BLR':[13.1986,77.7066],
    'MAA':[12.9941,80.1709],'HYD':[17.2403,78.4294],'CCU':[22.6520,88.4463],
    'AMD':[23.0771,72.6347],'GOI':[15.3808,73.8314],'PNQ':[18.5822,73.9197],
    'COK':[10.1520,76.4019],'TRV':[8.4821,76.9201],'JAI':[26.8242,75.8122],
    'LKO':[26.7606,80.8893],'NAG':[21.0922,79.0472],'IXC':[30.6735,76.7885],
    'DXB':[25.2532,55.3657],'AUH':[24.4330,54.6511],'DOH':[25.2731,51.6080],
    'SIN':[1.3644,103.9915],'KUL':[2.7456,101.7099],'BKK':[13.6811,100.7475],
    'HKG':[22.3080,113.9185],'NRT':[35.7720,140.3929],'ICN':[37.4602,126.4407],
    'LHR':[51.4775,-0.4614],'CDG':[49.0097,2.5479],'FRA':[50.0379,8.5622],
    'AMS':[52.3086,4.7639],'ZRH':[47.4582,8.5555],'IST':[40.9769,28.8146],
    'JFK':[40.6413,-73.7781],'LAX':[33.9425,-118.4081],'ORD':[41.9742,-87.9073],
    'SFO':[37.6213,-122.3790],'YYZ':[43.6777,-79.6248],'MEX':[19.4363,-99.0721],
    'SYD':[-33.9399,151.1753],'MEL':[-37.6690,144.8410],'JNB':[-26.1367,28.2411],
    'NBO':[-1.3192,36.9275],'CAI':[30.1219,31.4056],
  };
  const haversine = (a,b,c,d) => {
    const R=6371, dL=(c-a)*Math.PI/180, dO=(d-b)*Math.PI/180;
    const x=Math.sin(dL/2)**2+Math.cos(a*Math.PI/180)*Math.cos(c*Math.PI/180)*Math.sin(dO/2)**2;
    return Math.round(R*2*Math.atan2(Math.sqrt(x),Math.sqrt(1-x)));
  };
  const o=(origin||'').toUpperCase().slice(0,3);
  const d=(dest||'').toUpperCase().slice(0,3);
  return (AIRPORTS[o]&&AIRPORTS[d]) ? haversine(...AIRPORTS[o],...AIRPORTS[d]) : 1000;
}

function classifyFlight(distKm) {
  if (distKm < 500)  return 'Domestic (<500km)';
  if (distKm < 1500) return 'Short-Haul (500-1500km)';
  if (distKm < 4000) return 'Medium-Haul (1500-4000km)';
  return 'Long-Haul (>4000km)';
}

function todayStr() {
  return new Date().toISOString().split('T')[0];
}

function randId() {
  return Math.random().toString(36).slice(2,8).toUpperCase();
}
