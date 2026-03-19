import { useState, useRef, useEffect } from "react";

// ─── Constants ────────────────────────────────────────────────────────────────
const SERVICE_LINES = ["Oracle", "Digital", "Data", "Others"];
const COST_CENTRES  = ["Oracle SL", "Digital SL", "Data SL", "Others"];
const CURRENCIES    = ["INR", "USD", "EUR", "GBP", "AED", "SGD", "JPY"];
const RECEIPT_TYPES = ["Food & Beverage","Conveyance","Accommodation","Air Travel","Rail Travel","Fuel","Parking","Office Supplies","Telecom","Medical","Entertainment","Other"];
const CABIN_CLASSES = ["Economy","Premium Economy","Business","First"];
const FLIGHT_EF     = {"Domestic (<500km)":0.255,"Short-Haul (500-1500km)":0.156,"Medium-Haul (1500-4000km)":0.131,"Long-Haul (>4000km)":0.148};
const CABIN_MULT    = {"Economy":1,"Premium Economy":1.6,"Business":2.9,"First":4};

const FLAG_STYLE = {
  "OK":                                   { bg:"#d1fae5", text:"#065f46", border:"#6ee7b7" },
  "Duplicate Receipt":                    { bg:"#fee2e2", text:"#991b1b", border:"#fca5a5" },
  "Duplicated record from different user":{ bg:"#fef3c7", text:"#92400e", border:"#fcd34d" },
  "Suspiciously Round Amount":            { bg:"#ede9fe", text:"#5b21b6", border:"#c4b5fd" },
};
const APPROVAL_STYLE = {
  "Pending Review":  { bg:"#1e3a5f", text:"#60a5fa", border:"#2563eb" },
  "Approved":        { bg:"#d1fae5", text:"#065f46", border:"#6ee7b7" },
  "Rejected":        { bg:"#fee2e2", text:"#991b1b", border:"#fca5a5" },
  "Needs Correction":{ bg:"#fef3c7", text:"#92400e", border:"#fcd34d" },
};
const CLAIM_STYLE = {
  "Unclaimed":       { bg:"#1e293b", text:"#64748b", border:"#334155" },
  "Claim Submitted": { bg:"#1e3a5f", text:"#60a5fa", border:"#2563eb" },
  "Claim Approved":  { bg:"#d1fae5", text:"#065f46", border:"#6ee7b7" },
  "Claim Rejected":  { bg:"#fee2e2", text:"#991b1b", border:"#fca5a5" },
};

// ─── Storage ──────────────────────────────────────────────────────────────────
const SK = { users:"ivw_users_v4", exp:"ivw_exp_v4", trv:"ivw_trv_v4" };
const load  = k => { try { return JSON.parse(localStorage.getItem(k)||"[]"); } catch { return []; } };
const save  = (k,v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
const uid   = () => Math.random().toString(36).slice(2,10).toUpperCase();
const today = () => new Date().toISOString().split("T")[0];
const toB64 = f  => new Promise((res,rej) => { const r=new FileReader(); r.onload=()=>res(r.result.split(",")[1]); r.onerror=rej; r.readAsDataURL(f); });
const dlCSV = (rows,name) => {
  const csv = rows.map(r=>r.map(c=>`"${String(c||"").replace(/"/g,'""')}"`).join(",")).join("\n");
  const a=document.createElement("a"); a.href=URL.createObjectURL(new Blob([csv],{type:"text/csv"})); a.download=name; a.click();
};
const hashPwd = s => btoa(s+":ivw-salt-2024");

// ─── Flag logic ───────────────────────────────────────────────────────────────
const isRound  = n => { const v=parseFloat(n); return !isNaN(v)&&v>0&&(v%500===0||v%1000===0); };
const getFlag  = (invoiceNum, amount, submitterId, allRecords) => {
  const prev = allRecords.filter(r=>r.invoiceNumber===invoiceNum);
  if (prev.find(r=>r.submitterId===submitterId))  return "Duplicate Receipt";
  if (prev.find(r=>r.submitterId!==submitterId))  return "Duplicated record from different user";
  if (isRound(amount))                             return "Suspiciously Round Amount";
  return "OK";
};

// ─── Claude API ───────────────────────────────────────────────────────────────
// Detect if running on Vercel/production or in Claude artifact sandbox
const API_URL = (typeof window !== "undefined" && window.location.hostname !== "localhost" && !window.location.hostname.includes("claude.ai") && !window.location.hostname.includes("anthropic"))
  ? "/api/claude"
  : "https://api.anthropic.com/v1/messages";

async function claudeCall(messages, tools=[]) {
  const body = { model:"claude-sonnet-4-20250514", max_tokens:2000, messages };
  if (tools.length) body.tools = tools;
  const res = await fetch(API_URL, {
    method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(body)
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`API error ${res.status}: ${errText.slice(0,200)}`);
  }
  const d = await res.json();
  if (d.error) throw new Error(d.error.message || d.error);
  const allText = (d.content||[]).filter(b=>b.type==="text").map(b=>b.text).join("");
  const cleaned = allText.replace(/```json\n?|```/g,"").trim();
  if (!cleaned) throw new Error("Empty response from AI");
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("No JSON found in response");
  return JSON.parse(jsonMatch[0]);
}

// Multi-turn call that handles tool_use blocks by continuing the conversation
async function claudeCallWithTools(messages) {
  const body = {
    model:"claude-sonnet-4-20250514", max_tokens:2000, messages,
    tools:[{ type:"web_search_20250305", name:"web_search" }]
  };
  const res = await fetch(API_URL, {
    method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(body)
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`API error ${res.status}: ${errText.slice(0,200)}`);
  }
  const d = await res.json();
  if (d.error) throw new Error(d.error.message || d.error);
  const allText = (d.content||[]).filter(b=>b.type==="text").map(b=>b.text).join("");
  const cleaned = allText.replace(/```json\n?|```/g,"").trim();
  if (!cleaned) throw new Error("Empty response");
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("No JSON in response");
  return JSON.parse(jsonMatch[0]);
}

async function agentExtractExpense(file, b64) {
  const isImage = file.type.startsWith("image/");
  const prompt = `You are a corporate expense receipt parser. Analyze this receipt and extract all information. Return ONLY raw JSON:
{
  "invoiceNumber":"<receipt/invoice number or AUTO-XXXX>",
  "invoiceDate":"<YYYY-MM-DD>",
  "sellerName":"<merchant/vendor>",
  "totalAmount":"<numeric only>",
  "taxAmount":"<numeric or 0>",
  "currency":"<INR/USD/EUR etc>",
  "receiptType":"<Food & Beverage|Conveyance|Accommodation|Air Travel|Rail Travel|Fuel|Parking|Office Supplies|Telecom|Medical|Entertainment|Other>",
  "lineItems":"<brief summary of items>",
  "gstNumber":"<GST/VAT if present, else empty>",
  "paymentMode":"<Cash|Card|UPI|Bank Transfer|Other|Unknown>",
  "validationIssues":["<any data quality problems>"],
  "agentNotes":"<observations>",
  "confidence":"HIGH|MEDIUM|LOW"
}`;
  try {
    let msgContent;
    if (isImage) {
      msgContent = [
        { type:"image", source:{ type:"base64", media_type:file.type, data:b64 }},
        { type:"text", text:prompt }
      ];
    } else {
      // PDF — use PDF.js to extract real text content
      const pdfText = await extractPDFText(file);
      const pdfContent = pdfText.length > 50
        ? `\n\nDOCUMENT CONTENT:\n---\n${pdfText.slice(0,3000)}\n---`
        : `\n\n[PDF: ${file.name} — no text extracted]`;
      msgContent = [{ type:"text", text: prompt + pdfContent }];
    }
    return await claudeCall([{ role:"user", content: msgContent }]);
  } catch {
    return { invoiceNumber:`AUTO-${uid()}`, invoiceDate:today(), sellerName:"Unknown", totalAmount:"0", taxAmount:"0", currency:"INR", receiptType:"Other", lineItems:"", gstNumber:"", paymentMode:"Unknown", validationIssues:["Extraction failed"], agentNotes:"", confidence:"LOW" };
  }
}

async function agentExtractTravel(file, b64, employeeName) {
  const isImage = file.type.startsWith("image/");

  // Carbon emission constants
  const FLIGHT_EF_MAP = {
    "Domestic (<500km)": 0.255,
    "Short-Haul (500-1500km)": 0.156,
    "Medium-Haul (1500-4000km)": 0.131,
    "Long-Haul (>4000km)": 0.148
  };
  const CABIN_EF = { "Economy":1, "Premium Economy":1.6, "Business":2.9, "First":4 };

  const calcCarbon = (ext) => {
    try {
      if (ext.travelType === "Flight" && ext.flight) {
        const f = ext.flight;
        const ef = FLIGHT_EF_MAP[f.flightCategory] || 0.15;
        const cm = CABIN_EF[f.cabinClass] || 1;
        const dist = parseFloat(f.estimatedDistanceKm) || 1000;
        const pax  = parseInt(f.passengers) || 1;
        const co2  = Math.round(ef * cm * dist * pax);
        return {
          co2_kg: co2,
          co2_per_person_kg: Math.round(co2 / pax),
          methodology: `ICAO ${f.flightCategory} (${ef} kg/km) × ${f.cabinClass} ${cm}x × ${dist}km × ${pax} pax`,
          offset_cost_usd: Math.round(co2 / 1000 * 15 * 100) / 100,
          equivalent: `≈ driving ${Math.round(co2 * 4)} km by car`
        };
      } else if (ext.travelType === "Hotel" && ext.hotel) {
        const nights = parseInt(ext.hotel.nights) || 1;
        const guests = parseInt(ext.hotel.guests) || 1;
        const co2 = 22 * nights * guests;
        return {
          co2_kg: co2,
          co2_per_person_kg: Math.round(co2 / guests),
          methodology: `Green Key: 22 kg CO₂/room/night × ${nights} nights × ${guests} guest(s)`,
          offset_cost_usd: Math.round(co2 / 1000 * 15 * 100) / 100,
          equivalent: `≈ driving ${Math.round(co2 * 4)} km by car`
        };
      }
    } catch {}
    return { co2_kg:0, co2_per_person_kg:0, methodology:"Insufficient data", offset_cost_usd:0, equivalent:"—" };
  };

  const prompt = `You are a corporate travel document parser. The logged-in employee is: "${employeeName}".

Analyze this travel document carefully — it may be a flight e-ticket, boarding pass, hotel booking confirmation, or travel itinerary.
Return ONLY a raw JSON object. No markdown, no code fences, no explanation — just the JSON.

{
  "travelType": "Flight or Hotel",
  "passengerName": "exact full name as printed on document, empty string if not found",
  "nameMatchesEmployee": true or false (true if passenger name matches or is a close match to ${employeeName}),
  "nameMatchNote": "brief reason",
  "flight": {
    "origin": "departure city or IATA airport code",
    "destination": "arrival city or IATA airport code",
    "flightNumber": "e.g. AI302 or 6E441",
    "cabinClass": "Economy or Premium Economy or Business or First",
    "departureDate": "YYYY-MM-DD",
    "returnDate": "YYYY-MM-DD or null",
    "passengers": 1,
    "estimatedDistanceKm": 1200,
    "flightCategory": "Domestic (<500km) or Short-Haul (500-1500km) or Medium-Haul (1500-4000km) or Long-Haul (>4000km)",
    "pnr": "booking reference",
    "ticketCost": "1234.00",
    "currency": "INR",
    "invoiceNumber": "ticket or booking number"
  },
  "hotel": {
    "hotelName": "hotel name",
    "city": "city",
    "checkIn": "YYYY-MM-DD",
    "checkOut": "YYYY-MM-DD",
    "nights": 2,
    "roomType": "Standard",
    "guests": 1,
    "bookingRef": "reference",
    "cost": "5000.00",
    "currency": "INR",
    "invoiceNumber": "booking number"
  },
  "validationIssues": [],
  "agentNotes": "any observations",
  "confidence": "HIGH or MEDIUM or LOW"
}

Critical rules:
1. Set flight to null for hotel documents. Set hotel to null for flight documents.
2. estimatedDistanceKm: estimate the great-circle flying distance between the two cities in km.
3. If the document name does not match "${employeeName}", add a name mismatch entry to validationIssues.
4. Even if data is partial, fill every field you can — do not leave fields blank if you can infer them.`;

  try {
    let msgContent;

    if (isImage) {
      // Images: send as base64 image
      msgContent = [
        { type:"image", source:{ type:"base64", media_type:file.type, data:b64 }},
        { type:"text", text:prompt }
      ];
    } else {
      // PDF — use PDF.js to extract real text content
      const pdfText = await extractPDFText(file);

      const pdfContent = pdfText.length > 100
        ? `\n\nDOCUMENT CONTENT FROM PDF:\n---\n${pdfText.slice(0, 4000)}\n---`
        : `\n\n[PDF file: ${file.name} — no readable text could be extracted]`;

      msgContent = [{ type:"text", text: prompt + pdfContent }];
    }

    const ext = await claudeCall([{ role:"user", content: msgContent }]);

    // Always recalculate carbon locally for accuracy — override AI carbon
    ext.carbon = calcCarbon(ext);

    // Name validation
    const issues = Array.isArray(ext.validationIssues) ? ext.validationIssues : [];
    if (ext.passengerName && !ext.nameMatchesEmployee) {
      const alreadyFlagged = issues.some(i => i.toLowerCase().includes("name"));
      if (!alreadyFlagged) {
        issues.push(`Name mismatch: document shows "${ext.passengerName}" but logged-in employee is "${employeeName}"`);
      }
    }
    ext.validationIssues = issues;
    return ext;

  } catch(err) {
    return {
      travelType:"Flight", passengerName:"", nameMatchesEmployee:false,
      nameMatchNote:"Extraction failed: " + (err.message||"unknown error"),
      flight:null, hotel:null,
      carbon:{ co2_kg:0, co2_per_person_kg:0, methodology:"Failed", offset_cost_usd:0, equivalent:"—" },
      validationIssues:["AI extraction failed — please fill in the details manually and submit"],
      agentNotes:"", confidence:"LOW"
    };
  }
}


// ─── PDF text extractor using PDF.js ─────────────────────────────────────────
async function extractPDFText(file) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = async (e) => {
      try {
        // Load PDF.js from CDN if not already loaded
        if (!window.pdfjsLib) {
          await new Promise((res, rej) => {
            const script = document.createElement("script");
            script.src = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
            script.onload = res; script.onerror = rej;
            document.head.appendChild(script);
          });
          window.pdfjsLib.GlobalWorkerOptions.workerSrc =
            "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
        }
        const pdf = await window.pdfjsLib.getDocument({ data: e.target.result }).promise;
        let fullText = "";
        for (let p = 1; p <= pdf.numPages; p++) {
          const page = await pdf.getPage(p);
          const content = await page.getTextContent();
          fullText += content.items.map(i => i.str).join(" ") + "\n";
        }
        resolve(fullText.trim());
      } catch (err) {
        resolve(""); // fallback — will let Claude handle gracefully
      }
    };
    reader.onerror = () => resolve("");
    reader.readAsArrayBuffer(file);
  });
}
const SEED_USERS = [
  { id:"ADM001", username:"admin", password:hashPwd("admin123"), role:"admin", name:"System Admin", serviceLine:"Others", costCentre:"Others", projectWBS:"", email:"admin@company.com", managerId:"" },
];

// ─── UI Components ────────────────────────────────────────────────────────────
const CARD = { background:"linear-gradient(145deg,#070d1c,#050a14)", borderRadius:14, border:"1px solid #111c30", padding:22 };
const Btn = ({ children, onClick, color="#1d4ed8", disabled, small, outline, full }) => (
  <button onClick={onClick} disabled={disabled} style={{
    padding:small?"6px 14px":"9px 20px", borderRadius:8, border:outline?`1px solid ${color}`:"none",
    background:disabled?"#0c1424":outline?"transparent":color,
    color:disabled?"#334155":outline?color:"#fff",
    fontSize:small?11:12, fontWeight:700, cursor:disabled?"not-allowed":"pointer",
    width:full?"100%":"auto", letterSpacing:"0.03em", transition:"all 0.15s", whiteSpace:"nowrap"
  }}>{children}</button>
);
const Badge = ({ label, style:s }) => (
  <span style={{ padding:"2px 9px", borderRadius:20, background:s?.bg||"#1e293b", color:s?.text||"#64748b", border:`1px solid ${s?.border||"#334155"}`, fontSize:10, fontWeight:700, whiteSpace:"nowrap" }}>{label}</span>
);
const Inp = ({ label, value, onChange, type="text", options, placeholder, readOnly, req, warn, ok, small }) => (
  <div>
    <div style={{ fontSize:9, color:ok?"#4ade80":warn?"#fbbf24":"#3d5a80", marginBottom:3, fontWeight:700, letterSpacing:"0.07em", textTransform:"uppercase", display:"flex", gap:4 }}>
      {ok&&"✅"}{warn&&"⚠️"}{label}{req&&<span style={{color:"#f87171"}}>*</span>}
    </div>
    {options
      ? <select value={value} onChange={e=>onChange(e.target.value)} disabled={readOnly} style={{ width:"100%", padding:small?"6px 9px":"8px 11px", borderRadius:7, background:readOnly?"#030610":"#06090f", border:`1px solid ${ok?"#14532d":warn?"#713f12":"#1a2a40"}`, color:value?"#dde4f0":"#475569", fontSize:12, outline:"none" }}>
          <option value="">Select…</option>
          {options.map(o=><option key={o} value={o}>{o}</option>)}
        </select>
      : <input type={type} value={value} onChange={e=>onChange(e.target.value)} placeholder={placeholder} readOnly={readOnly}
          style={{ width:"100%", padding:small?"6px 9px":"8px 11px", borderRadius:7, background:readOnly?"#030610":"#06090f", border:`1px solid ${ok?"#14532d":warn?"#713f12":"#1a2a40"}`, color:"#dde4f0", fontSize:12, outline:"none", boxSizing:"border-box" }} />
    }
  </div>
);

// ─── MAIN APP ─────────────────────────────────────────────────────────────────
export default function App() {
  const [users,    setUsers]    = useState(() => { const u=load(SK.users); return u.length?u:SEED_USERS; });
  const [expenses, setExpenses] = useState(() => load(SK.exp));
  const [travels,  setTravels]  = useState(() => load(SK.trv));
  const [session,  setSession]  = useState(null); // { userId, role:"employee"|"manager"|"admin" }
  const [loginForm,setLoginForm]= useState({ username:"", password:"", error:"" });
  const [showPwdModal, setShowPwdModal] = useState(false);
  const [pwdForm, setPwdForm] = useState({current:"", next:"", confirm:"", error:"", success:""});

  const saveUsers    = u => { setUsers(u);    save(SK.users,u); };
  const saveExpenses = e => { setExpenses(e); save(SK.exp,e);   };
  const saveTravels  = t => { setTravels(t);  save(SK.trv,t);   };

  const currentUser = users.find(u=>u.id===session?.userId);
  const isManager   = session?.role==="manager" || session?.role==="admin";
  const isAdmin     = session?.role==="admin";

  // ── Login ─────────────────────────────────────────────────────────────────
  const login = () => {
    const u = users.find(u=>u.username===loginForm.username && u.password===hashPwd(loginForm.password));
    if (!u) { setLoginForm(p=>({...p,error:"Invalid username or password"})); return; }
    setSession({ userId:u.id, role:u.role });
    setLoginForm({ username:"", password:"", error:"" });
  };
  const logout = () => setSession(null);

  // ── Tabs (role-based) ─────────────────────────────────────────────────────
  const [tab, setTab] = useState("expense");
  useEffect(() => { if (isManager && !["approvals","records","admin"].includes(tab)) setTab("approvals"); }, [session]);

  // ── Expense agent ─────────────────────────────────────────────────────────
  const [expFiles, setExpFiles] = useState([]);
  const [expQueue, setExpQueue] = useState([]);
  const [expBusy,  setExpBusy]  = useState(false);
  const [expLog,   setExpLog]   = useState([]);
  const expFileRef = useRef();

  const runExpAgent = async () => {
    if (!expFiles.length) return;
    setExpBusy(true); setExpLog([]); setExpQueue([]);
    const log = m => setExpLog(p=>[...p,m]);
    log("🤖 Agent starting expense extraction…");
    const allPrev = [...expenses,...travels].map(r=>({invoiceNumber:r.invoiceNumber,submitterId:r.submitterId}));
    const items = [];
    for (let i=0;i<expFiles.length;i++) {
      const f=expFiles[i];
      log(`\n📄 [${i+1}/${expFiles.length}] ${f.name}`);
      try {
        const b64 = await toB64(f);
        const ext  = await agentExtractExpense(f,b64);
        log(`✅ ${ext.sellerName} | ${ext.currency} ${ext.totalAmount} | Invoice: ${ext.invoiceNumber} [${ext.confidence}]`);
        if (ext.validationIssues?.length) ext.validationIssues.forEach(v=>log(`⚠️ ${v}`));
        const flag = getFlag(ext.invoiceNumber, ext.totalAmount, currentUser.id, allPrev);
        items.push({
          _id:uid(), _status:"review", _flag:flag, _confidence:ext.confidence,
          _agentNotes:ext.agentNotes, _validationIssues:ext.validationIssues||[], _file:f.name,
          submitterId:currentUser.id, submitterName:currentUser.name,
          serviceLine:currentUser.serviceLine, costCentre:currentUser.costCentre,
          projectWBS:currentUser.projectWBS||"", approvalStatus:"Pending Review",
          managerComment:"",
          invoiceNumber:ext.invoiceNumber, invoiceDate:ext.invoiceDate,
          sellerName:ext.sellerName, totalAmount:ext.totalAmount,
          taxAmount:ext.taxAmount, currency:ext.currency,
          receiptType:ext.receiptType, lineItems:ext.lineItems,
          gstNumber:ext.gstNumber, paymentMode:ext.paymentMode,
          mealLimitCheck:ext.receiptType==="Food & Beverage"&&parseFloat(ext.totalAmount)>500?"⚠️ Exceeds ₹500":"OK",
          fileName:f.name, fileSize:`${(f.size/1024).toFixed(1)} KB`,
          uploadedAt:new Date().toISOString(),
        });
      } catch(e) { log(`❌ ${f.name}: ${e.message}`); }
    }
    log(`\n✨ ${items.length} receipt${items.length!==1?"s":""} ready for review`);
    setExpQueue(items); setExpBusy(false);
  };

  const updateExp = (id,f,v) => setExpQueue(p=>p.map(i=>i._id===id?{...i,[f]:v}:i));
  const submitExp = id => {
    const item = expQueue.find(i=>i._id===id); if (!item) return;
    const allPrev = [...expenses,...travels].map(r=>({invoiceNumber:r.invoiceNumber,submitterId:r.submitterId}));
    const flag = getFlag(item.invoiceNumber, item.totalAmount, item.submitterId, allPrev);
    const record = { ...item, _status:"submitted", _flag:flag, id:`EXP-${uid()}`, submittedAt:new Date().toISOString(), approvalStatus:"Pending Review" };
    saveExpenses([...expenses,record]);
    setExpQueue(p=>p.map(i=>i._id===id?{...i,_status:"submitted",_flag:flag}:i));
  };
  const submitAllExp = () => expQueue.filter(i=>i._status==="review").forEach(i=>submitExp(i._id));

  // ── Travel agent ─────────────────────────────────────────────────────────
  const [trvFiles, setTrvFiles] = useState([]);
  const [trvQueue, setTrvQueue] = useState([]);
  const [trvBusy,  setTrvBusy]  = useState(false);
  const [trvLog,   setTrvLog]   = useState([]);
  const trvFileRef = useRef();

  const runTrvAgent = async () => {
    if (!trvFiles.length) return;
    setTrvBusy(true); setTrvLog([]); setTrvQueue([]);
    const log = m => setTrvLog(p=>[...p,m]);
    log("🤖 Travel agent reading documents…");
    const allPrev = [...expenses,...travels].map(r=>({invoiceNumber:r.invoiceNumber,submitterId:r.submitterId}));
    const items = [];
    for (let i=0;i<trvFiles.length;i++) {
      const f=trvFiles[i];
      log(`\n🎫 [${i+1}/${trvFiles.length}] ${f.name}`);
      try {
        const b64 = await toB64(f);
        const ext  = await agentExtractTravel(f, b64, currentUser.name);
        const isFl = ext.travelType==="Flight";
        const seg  = isFl?ext.flight:ext.hotel;
        const co2  = ext.carbon||{};
        log(`✅ ${isFl?`✈️ ${ext.flight?.origin||"?"}→${ext.flight?.destination||"?"}`:`🏨 ${ext.hotel?.hotelName||"?"}, ${ext.hotel?.city||"?"}`}`);
        // Name validation
        if (ext.passengerName) {
          if (ext.nameMatchesEmployee) {
            log(`👤 Name match ✅: "${ext.passengerName}" = ${currentUser.name}`);
          } else {
            log(`👤 Name MISMATCH ❌: Document shows "${ext.passengerName}" but employee is "${currentUser.name}"`);
          }
        }
        log(`🌿 CO₂: ${co2.co2_kg}kg — ${co2.methodology||"ICAO/Green Key"} (${co2.equivalent})`);
        if (ext.validationIssues?.length) ext.validationIssues.forEach(v=>log(`⚠️ ${v}`));
        const invNum  = seg?.invoiceNumber||seg?.pnr||seg?.bookingRef||`TRV-${uid()}`;
        const amount  = seg?.ticketCost||seg?.cost||"0";
        const flag    = getFlag(invNum,amount,currentUser.id,allPrev);
        items.push({
          _id:uid(), _status:"review", _flag:flag, _confidence:ext.confidence,
          _agentNotes:ext.agentNotes, _validationIssues:ext.validationIssues||[], _file:f.name,
          _passengerName:ext.passengerName||"", _nameMatchesEmployee:ext.nameMatchesEmployee, _nameMatchNote:ext.nameMatchNote||"",
          submitterId:currentUser.id, submitterName:currentUser.name,
          serviceLine:currentUser.serviceLine, costCentre:currentUser.costCentre,
          projectWBS:currentUser.projectWBS||"", approvalStatus:"Pending Review",
          managerComment:"",
          travelType:ext.travelType,
          invoiceNumber:invNum,
          origin:ext.flight?.origin||"", destination:ext.flight?.destination||"",
          flightNumber:ext.flight?.flightNumber||"",
          cabinClass:ext.flight?.cabinClass||"Economy",
          travelDate:ext.flight?.departureDate||ext.hotel?.checkIn||"",
          returnDate:ext.flight?.returnDate||ext.hotel?.checkOut||"",
          passengers:String(ext.flight?.passengers||ext.hotel?.guests||1),
          distanceKm:String(ext.flight?.estimatedDistanceKm||""),
          flightCategory:ext.flight?.flightCategory||"Short-Haul (500-1500km)",
          bookingRef:ext.flight?.pnr||ext.hotel?.bookingRef||"",
          hotelName:ext.hotel?.hotelName||"", hotelCity:ext.hotel?.city||"",
          nights:String(ext.hotel?.nights||1), roomType:ext.hotel?.roomType||"Standard",
          cost:amount, currency:ext.flight?.currency||ext.hotel?.currency||"INR",
          co2_kg:co2.co2_kg||0, co2_per_person_kg:co2.co2_per_person_kg||0,
          co2_methodology:co2.methodology||"", co2_offset_usd:co2.offset_cost_usd||0,
          co2_equivalent:co2.equivalent||"",
          claimAmount:"", claimCurrency:"INR", claimDescription:"",
          claimStatus:"Unclaimed", claimSubmittedAt:"", claimApprovedAt:"",
          uploadedAt:new Date().toISOString(),
        });
      } catch(e) { log(`❌ ${f.name}: ${e.message}`); }
    }
    log(`\n✨ ${items.length} record${items.length!==1?"s":""} ready for review`);
    setTrvQueue(items); setTrvBusy(false);
  };

  const updateTrv = (id,f,v) => setTrvQueue(p=>p.map(i=>i._id===id?{...i,[f]:v}:i));
  const submitTrv = id => {
    const item=trvQueue.find(i=>i._id===id); if(!item) return;
    const allPrev=[...expenses,...travels].map(r=>({invoiceNumber:r.invoiceNumber,submitterId:r.submitterId}));
    const flag=getFlag(item.invoiceNumber,item.cost,item.submitterId,allPrev);
    const record={...item,_status:"submitted",_flag:flag,id:`TRV-${uid()}`,submittedAt:new Date().toISOString(),approvalStatus:"Pending Review",
      _passengerName:item._passengerName||"", _nameMatchesEmployee:item._nameMatchesEmployee, _nameMatchNote:item._nameMatchNote||""};
    saveTravels([...travels,record]);
    setTrvQueue(p=>p.map(i=>i._id===id?{...i,_status:"submitted",_flag:flag}:i));
  };
  const submitAllTrv = () => trvQueue.filter(i=>i._status==="review").forEach(i=>submitTrv(i._id));

  // ── Manager approval actions ──────────────────────────────────────────────
  const approveRecord = (type,id,comment="") => {
    if(type==="exp") saveExpenses(expenses.map(r=>r.id===id?{...r,approvalStatus:"Approved",managerComment:comment,approvedBy:currentUser.id,approvedAt:new Date().toISOString()}:r));
    else saveTravels(travels.map(r=>r.id===id?{...r,approvalStatus:"Approved",managerComment:comment,approvedBy:currentUser.id,approvedAt:new Date().toISOString()}:r));
  };
  const rejectRecord  = (type,id,comment="") => {
    if(type==="exp") saveExpenses(expenses.map(r=>r.id===id?{...r,approvalStatus:"Rejected",managerComment:comment,approvedBy:currentUser.id,approvedAt:new Date().toISOString()}:r));
    else saveTravels(travels.map(r=>r.id===id?{...r,approvalStatus:"Rejected",managerComment:comment,approvedBy:currentUser.id,approvedAt:new Date().toISOString()}:r));
  };
  const requestCorrection=(type,id,comment)=>{
    if(type==="exp") saveExpenses(expenses.map(r=>r.id===id?{...r,approvalStatus:"Needs Correction",managerComment:comment,approvedBy:currentUser.id,approvedAt:new Date().toISOString()}:r));
    else saveTravels(travels.map(r=>r.id===id?{...r,approvalStatus:"Needs Correction",managerComment:comment,approvedBy:currentUser.id,approvedAt:new Date().toISOString()}:r));
  };
  const [approvalComments,setApprovalComments]=useState({});

  // ── Claim actions ─────────────────────────────────────────────────────────
  const submitClaim  = id => saveTravels(travels.map(r=>r.id===id?{...r,claimStatus:"Claim Submitted",claimSubmittedAt:new Date().toISOString()}:r));
  const approveClaim = id => saveTravels(travels.map(r=>r.id===id?{...r,claimStatus:"Claim Approved",claimApprovedAt:new Date().toISOString()}:r));
  const rejectClaim  = id => saveTravels(travels.map(r=>r.id===id?{...r,claimStatus:"Claim Rejected",claimApprovedAt:new Date().toISOString()}:r));

  // ── Delete ────────────────────────────────────────────────────────────────
  const [confirmDel, setConfirmDel] = useState(null);
  const deleteExp = id => { saveExpenses(expenses.filter(r=>r.id!==id)); setConfirmDel(null); };
  const deleteTrv = id => { saveTravels(travels.filter(r=>r.id!==id));   setConfirmDel(null); };

  // ── Admin: user management ────────────────────────────────────────────────
  const [newUser, setNewUser] = useState({ name:"",username:"",password:"",role:"employee",serviceLine:"",costCentre:"",projectWBS:"",email:"",managerId:"" });
  const [userError, setUserError] = useState("");
  const [showNewPwd, setShowNewPwd] = useState(false);
  const addUser = () => {
    if (!newUser.name||!newUser.username||!newUser.password||!newUser.serviceLine||!newUser.costCentre) {
      setUserError("Please fill in all required fields: Name, Username, Password, Service Line, Cost Centre"); return;
    }
    if (users.find(u=>u.username===newUser.username)) {
      setUserError(`Username "${newUser.username}" already exists — choose a different one`); return;
    }
    setUserError("");
    saveUsers([...users,{...newUser,id:`USR-${uid()}`,password:hashPwd(newUser.password)}]);
    setNewUser({name:"",username:"",password:"",role:"employee",serviceLine:"",costCentre:"",projectWBS:"",email:"",managerId:""});
  };
  const deleteUser = id => saveUsers(users.filter(u=>u.id!==id));
  const empCSVRef  = useRef();
  const importCSV  = e => {
    const file=e.target.files[0]; if(!file) return;
    const r=new FileReader();
    r.onload=ev=>{
      const rows=ev.target.result.split("\n").slice(1).filter(Boolean);
      const parsed=rows.map(row=>{
        const c=row.split(",").map(x=>x.replace(/^"|"$/g,"").trim());
        const managerUsername = c[8]||"";
        const managerUser = users.find(u=>u.username===managerUsername);
        return {id:`USR-${uid()}`,name:c[0]||"",username:c[1]||c[0]?.toLowerCase().replace(/\s+/g,"."),password:hashPwd(c[2]||"pass123"),role:c[3]||"employee",serviceLine:c[4]||"Others",costCentre:c[5]||"Others",projectWBS:c[6]||"",email:c[7]||"",managerId:managerUser?.id||""};
      }).filter(u=>u.name&&u.username);
      saveUsers([...users,...parsed]);
    };
    r.readAsText(file); e.target.value="";
  };

  // ── Exports ───────────────────────────────────────────────────────────────
  const exportPendingReport = () => {
    const pendingExp = (isAdmin ? expenses : expenses.filter(r=>managedIds.includes(r.submitterId))).filter(r=>r.approvalStatus==="Pending Review");
    const pendingTrv = (isAdmin ? travels  : travels.filter(r=>managedIds.includes(r.submitterId))).filter(r=>r.approvalStatus==="Pending Review");
    const rows = [
      ["INVOICE VALIDATOR WIZ — PENDING APPROVALS REPORT"],
      [`Generated: ${new Date().toLocaleString()}  |  Manager: ${currentUser?.name}  |  Total Pending: ${pendingExp.length + pendingTrv.length}`],
      [],
      ["── EXPENSE RECEIPTS ──────────────────────────────────────────────────"],
      ["#","Invoice #","Date","Employee","Service Line","Cost Centre","Project/WBS","Seller","Amount","Currency","Receipt Type","Meal Check","Flag","AI Confidence","Submitted At","File"],
      ...pendingExp.map((r,i)=>[i+1,r.invoiceNumber,r.invoiceDate,r.submitterName,r.serviceLine,r.costCentre,r.projectWBS||"—",r.sellerName,r.totalAmount,r.currency,r.receiptType,r.mealLimitCheck,r._flag,r._confidence,r.submittedAt,r.fileName]),
      [],
      ["── COMPANY TRAVEL ────────────────────────────────────────────────────"],
      ["#","Type","Invoice #","Date","Employee","Service Line","Cost Centre","Route / Hotel","Cabin / Room","Cost","Currency","CO2 (kg)","CO2/Person","Offset USD","Carbon Equiv.","Claim Amount","Flag","Confidence","Submitted At"],
      ...pendingTrv.map((r,i)=>[i+1,r.travelType,r.invoiceNumber,r.travelDate,r.submitterName,r.serviceLine,r.costCentre,r.travelType==="Flight"?`${r.origin} → ${r.destination}`:`${r.hotelName}, ${r.hotelCity}`,r.travelType==="Flight"?r.cabinClass:r.roomType,r.cost,r.currency,r.co2_kg,r.co2_per_person_kg,r.co2_offset_usd,r.co2_equivalent,r.claimAmount?`${r.claimCurrency} ${r.claimAmount}`:"—",r._flag,r._confidence,r.submittedAt]),
      [],
      ["── SUMMARY ───────────────────────────────────────────────────────────"],
      ["Expenses Pending", pendingExp.length],
      ["Travel Pending",   pendingTrv.length],
      ["Flagged Items",    [...pendingExp,...pendingTrv].filter(r=>r._flag!=="OK").length],
      ["Meal Limit Alerts",pendingExp.filter(r=>r.mealLimitCheck!=="OK").length],
      ["Total CO2 Pending (kg)", pendingTrv.reduce((s,r)=>s+(parseFloat(r.co2_kg)||0),0).toFixed(1)],
    ];
    dlCSV(rows, `IVW_PendingApprovals_${currentUser?.name?.replace(/\s+/g,"_")}_${today()}.csv`);
  };

  const exportExpenses = () => dlCSV([
    ["ID","Invoice #","Date","Employee","SL","CC","WBS","Seller","Amount","Currency","Tax","GST","Type","Payment","Meal","Flag","Approval Status","Manager Comment","File","Submitted At"],
    ...expenses.map(r=>[r.id,r.invoiceNumber,r.invoiceDate,r.submitterName,r.serviceLine,r.costCentre,r.projectWBS,r.sellerName,r.totalAmount,r.currency,r.taxAmount,r.gstNumber,r.receiptType,r.paymentMode,r.mealLimitCheck,r._flag,r.approvalStatus,r.managerComment,r.fileName,r.submittedAt])
  ],`IVW_Expenses_${today()}.csv`);
  const exportTravel = () => dlCSV([
    ["ID","Type","Invoice #","Employee","SL","CC","Route/Hotel","Date","Cost","Currency","CO2 kg","CO2/Person","Offset $","Claim Status","Flag","Approval"],
    ...travels.map(r=>[r.id,r.travelType,r.invoiceNumber,r.submitterName,r.serviceLine,r.costCentre,r.travelType==="Flight"?`${r.origin}→${r.destination}`:`${r.hotelName},${r.hotelCity}`,r.travelDate,r.cost,r.currency,r.co2_kg,r.co2_per_person_kg,r.co2_offset_usd,r.claimStatus,r._flag,r.approvalStatus])
  ],`IVW_Travel_${today()}.csv`);

  // ── Derived stats ─────────────────────────────────────────────────────────
  const myExpenses = expenses.filter(r=>r.submitterId===session?.userId);
  const myTravels  = travels.filter(r=>r.submitterId===session?.userId);
  const pendingApprovals = [...expenses,...travels].filter(r=>r.approvalStatus==="Pending Review");
  const managedUsers  = isAdmin ? users.filter(u=>u.id!==session?.userId) : users.filter(u=>u.managerId===session?.userId);
  const managedIds    = managedUsers.map(u=>u.id);
  const pendingForMe  = isAdmin ? pendingApprovals : pendingApprovals.filter(r=>managedIds.includes(r.submitterId));
  const totalCO2      = travels.reduce((s,r)=>s+(parseFloat(r.co2_kg)||0),0);

  // ═══════════════════════════════════════════════════════════════════════════
  // LOGIN SCREEN
  // ═══════════════════════════════════════════════════════════════════════════
  if (!session) return (
    <div style={{minHeight:"100vh",background:"radial-gradient(ellipse at 20% 0%,#0c1a38,#020810)",display:"flex",alignItems:"center",justifyContent:"center",fontFamily:"'DM Sans','Segoe UI',sans-serif"}}>
      <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=DM+Mono:wght@400;500&display=swap" rel="stylesheet"/>
      <div style={{width:380}}>
        <div style={{textAlign:"center",marginBottom:32}}>
          <div style={{width:56,height:56,borderRadius:14,background:"linear-gradient(135deg,#1d4ed8,#7c3aed)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:24,margin:"0 auto 14px",boxShadow:"0 0 30px rgba(29,78,216,0.4)"}}>🧾</div>
          <div style={{fontSize:22,fontWeight:700,color:"#e8eeff",letterSpacing:"-0.3px"}}>Invoice Validator Wiz</div>
          <div style={{fontSize:11,color:"#1e3a5f",marginTop:4,letterSpacing:"0.08em",textTransform:"uppercase"}}>Agentic · SAP Ariba · Sustainability</div>
        </div>
        <div style={{...CARD}}>
          <div style={{fontSize:11,color:"#2d4a80",fontWeight:700,letterSpacing:"0.08em",marginBottom:16}}>SIGN IN</div>
          <div style={{marginBottom:14}}>
            <Inp label="Username" value={loginForm.username} onChange={v=>setLoginForm(p=>({...p,username:v,error:""}))} placeholder="your.username"/>
          </div>
          <div style={{marginBottom:20}}>
            <Inp label="Password" value={loginForm.password} onChange={v=>setLoginForm(p=>({...p,password:v,error:""}))} type="password" placeholder="••••••••"/>
          </div>
          {loginForm.error&&<div style={{marginBottom:14,padding:"8px 12px",background:"rgba(239,68,68,0.1)",borderRadius:7,border:"1px solid #7f1d1d",fontSize:12,color:"#f87171"}}>{loginForm.error}</div>}
          <Btn onClick={login} color="#1d4ed8" full>Sign In →</Btn>
          <div style={{marginTop:16,padding:"12px",background:"rgba(29,78,216,0.06)",borderRadius:8,border:"1px solid #1a2d50"}}>
            <div style={{fontSize:10,color:"#2d4a80",fontWeight:700,marginBottom:6}}>DEFAULT CREDENTIALS</div>
            <div style={{fontFamily:"'DM Mono',monospace",fontSize:10,color:"#334155",lineHeight:1.8}}>
              Admin: admin / admin123<br/>
              <span style={{color:"#2d4a80"}}>Employees & managers added in Admin panel</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );

  // ── Password change ───────────────────────────────────────────────────────
  const changePassword = () => {
    if (hashPwd(pwdForm.current) !== currentUser?.password) { setPwdForm(p=>({...p,error:"Current password is incorrect",success:""})); return; }
    if (pwdForm.next.length < 6) { setPwdForm(p=>({...p,error:"New password must be at least 6 characters",success:""})); return; }
    if (pwdForm.next !== pwdForm.confirm) { setPwdForm(p=>({...p,error:"Passwords don't match",success:""})); return; }
    saveUsers(users.map(u=>u.id===session.userId?{...u,password:hashPwd(pwdForm.next)}:u));
    setPwdForm({current:"",next:"",confirm:"",error:"",success:"✅ Password changed successfully"});
  };

  // ═══════════════════════════════════════════════════════════════════════════
  // MAIN APP (authenticated)
  // ═══════════════════════════════════════════════════════════════════════════
  const EMPLOYEE_TABS = [
    { k:"expense",  ic:"🧾", l:"Submit Expenses" },
    { k:"travel",   ic:"✈️", l:"Submit Travel" },
    { k:"myrecords",ic:"📋", l:`My Records (${myExpenses.length+myTravels.length})` },
  ];
  const MANAGER_TABS = [
    { k:"approvals",ic:"✅", l:`Approvals (${pendingForMe.length})` },
    { k:"records",  ic:"📊", l:`All Records (${expenses.length+travels.length})` },
  ];
  const ADMIN_TABS = [
    { k:"approvals",ic:"✅", l:`Approvals (${pendingApprovals.length})` },
    { k:"records",  ic:"📊", l:"All Records" },
    { k:"users",    ic:"👥", l:`Users (${users.length})` },
  ];
  const TABS = isAdmin ? [...EMPLOYEE_TABS,...ADMIN_TABS] : isManager ? [...EMPLOYEE_TABS,...MANAGER_TABS] : EMPLOYEE_TABS;

  return (
    <div style={{minHeight:"100vh",background:"radial-gradient(ellipse at 15% 0%,#0a1630,#020810)",fontFamily:"'DM Sans','Segoe UI',sans-serif",color:"#dde4f0"}}>
      <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600;700&family=DM+Mono:wght@400;500&display=swap" rel="stylesheet"/>

      {/* ── Header ── */}
      <header style={{background:"rgba(2,8,16,0.92)",backdropFilter:"blur(16px)",borderBottom:"1px solid #0e1c30",padding:"10px 20px",display:"flex",alignItems:"center",justifyContent:"space-between",position:"sticky",top:0,zIndex:100}}>
        <div style={{display:"flex",alignItems:"center",gap:10}}>
          <div style={{width:34,height:34,borderRadius:8,background:"linear-gradient(135deg,#1d4ed8,#7c3aed)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:15,boxShadow:"0 0 16px rgba(29,78,216,0.35)"}}>🧾</div>
          <div>
            <div style={{fontSize:14,fontWeight:700,color:"#e8eeff",letterSpacing:"-0.2px"}}>Invoice Validator Wiz</div>
            <div style={{fontSize:9,color:"#1e3a5f",letterSpacing:"0.09em",textTransform:"uppercase"}}>Agentic · SAP Ariba · Sustainability</div>
          </div>
        </div>
        <nav style={{display:"flex",gap:2}}>
          {TABS.map(t=>(
            <button key={t.k} onClick={()=>setTab(t.k)} style={{padding:"5px 12px",borderRadius:7,border:"none",cursor:"pointer",fontSize:11,fontWeight:600,background:tab===t.k?"rgba(29,78,216,0.2)":"transparent",color:tab===t.k?"#93c5fd":"#2d4a80",borderBottom:`2px solid ${tab===t.k?"#2563eb":"transparent"}`,transition:"all 0.15s"}}>
              {t.ic} {t.l}
            </button>
          ))}
        </nav>
        <div style={{display:"flex",alignItems:"center",gap:12}}>
          {isManager&&<span style={{fontSize:10,color:"#fbbf24",fontWeight:700}}>🔑 {isAdmin?"ADMIN":"MANAGER"}</span>}
          <div style={{fontSize:11,color:"#2d4a80"}}>
            <span style={{color:"#93c5fd",fontWeight:600}}>{currentUser?.name}</span>
            {currentUser?.serviceLine&&<span> · {currentUser.serviceLine}</span>}
          </div>
          {isAdmin&&<span style={{fontSize:10,color:"#4ade80"}}>🌿 {Math.round(totalCO2)}kg CO₂</span>}
          <Btn onClick={()=>{setShowPwdModal(true);setPwdForm({current:"",next:"",confirm:"",error:"",success:""});}} outline color="#334155" small>🔒 Change Password</Btn>
          <Btn onClick={logout} outline color="#334155" small>Sign Out</Btn>
        </div>
      </header>

      {/* ── Change Password Modal ── */}
      {showPwdModal&&(
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.7)",backdropFilter:"blur(4px)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:200}} onClick={e=>{if(e.target===e.currentTarget)setShowPwdModal(false);}}>
          <div style={{...CARD,width:360,border:"1px solid #1d4ed8"}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:20}}>
              <h3 style={{margin:0,color:"#e8eeff",fontSize:16}}>🔒 Change Password</h3>
              <button onClick={()=>setShowPwdModal(false)} style={{background:"none",border:"none",color:"#4a6fa5",cursor:"pointer",fontSize:18}}>✕</button>
            </div>
            <div style={{marginBottom:12}}><Inp label="Current Password" value={pwdForm.current} onChange={v=>setPwdForm(p=>({...p,current:v,error:"",success:""}))} type="password" placeholder="Your current password"/></div>
            <div style={{marginBottom:12}}><Inp label="New Password" value={pwdForm.next} onChange={v=>setPwdForm(p=>({...p,next:v,error:"",success:""}))} type="password" placeholder="At least 6 characters"/></div>
            <div style={{marginBottom:16}}><Inp label="Confirm New Password" value={pwdForm.confirm} onChange={v=>setPwdForm(p=>({...p,confirm:v,error:"",success:""}))} type="password" placeholder="Repeat new password"/></div>
            {pwdForm.error&&<div style={{marginBottom:12,padding:"8px 12px",background:"rgba(239,68,68,0.1)",borderRadius:7,border:"1px solid #7f1d1d",fontSize:12,color:"#f87171"}}>{pwdForm.error}</div>}
            {pwdForm.success&&<div style={{marginBottom:12,padding:"8px 12px",background:"rgba(74,222,128,0.1)",borderRadius:7,border:"1px solid #14532d",fontSize:12,color:"#4ade80"}}>{pwdForm.success}</div>}
            <div style={{display:"flex",gap:8,justifyContent:"flex-end"}}>
              <Btn onClick={()=>setShowPwdModal(false)} outline color="#334155" small>Cancel</Btn>
              <Btn onClick={changePassword} color="#1d4ed8" small>Update Password</Btn>
            </div>
          </div>
        </div>
      )}

      <main style={{maxWidth:1100,margin:"0 auto",padding:"22px 16px"}}>

        {/* ══════════ SUBMIT EXPENSES ══════════ */}
        {tab==="expense"&&(
          <div>
            <div style={{marginBottom:18}}>
              <h2 style={{margin:"0 0 3px",fontSize:19,color:"#e8eeff",fontWeight:700}}>🤖 Submit Expense Receipts</h2>
              <p style={{margin:0,color:"#2d4a80",fontSize:12}}>Upload receipts → Agent extracts all details automatically → Review once → Submit for approval</p>
            </div>

            {!expQueue.length&&(
              <div style={{...CARD,marginBottom:14}}>
                <div onDragOver={e=>e.preventDefault()} onDrop={e=>{e.preventDefault();setExpFiles(p=>[...p,...Array.from(e.dataTransfer.files).filter(f=>f.type.startsWith("image/")||f.type==="application/pdf")]);}} onClick={()=>expFileRef.current?.click()}
                  style={{border:"2px dashed #1a2d50",borderRadius:10,padding:"40px 20px",textAlign:"center",cursor:"pointer",background:"rgba(2,5,12,0.5)",marginBottom:expFiles.length?14:0}}>
                  <div style={{fontSize:38,marginBottom:8}}>📂</div>
                  <div style={{fontSize:14,fontWeight:700,color:"#c7d8ff",marginBottom:4}}>Drop receipts here — Agent does the rest</div>
                  <div style={{fontSize:11,color:"#2d4a80"}}>JPG · PNG · PDF · Multiple files at once</div>
                  <input ref={expFileRef} type="file" multiple accept="image/*,.pdf" onChange={e=>setExpFiles(p=>[...p,...Array.from(e.target.files)])} style={{display:"none"}}/>
                </div>
                {expFiles.length>0&&(
                  <>
                    {expFiles.map((f,i)=>(
                      <div key={i} style={{display:"flex",justifyContent:"space-between",alignItems:"center",background:"#04080f",borderRadius:7,padding:"8px 12px",marginBottom:4,border:"1px solid #0d1a2a"}}>
                        <span style={{fontSize:12,color:"#93c5fd"}}>{f.type.startsWith("image/")?"🖼️":"📄"} {f.name} <span style={{color:"#2d4a80"}}>({(f.size/1024).toFixed(1)} KB)</span></span>
                        <button onClick={()=>setExpFiles(p=>p.filter((_,j)=>j!==i))} style={{background:"none",border:"none",color:"#ef4444",cursor:"pointer"}}>✕</button>
                      </div>
                    ))}
                    <div style={{display:"flex",justifyContent:"flex-end",marginTop:10,gap:8}}>
                      <Btn onClick={()=>setExpFiles([])} outline color="#334155" small>Clear</Btn>
                      <Btn onClick={runExpAgent} disabled={expBusy} color="#4f46e5">{expBusy?"⏳ Extracting…":`🤖 Run Agent on ${expFiles.length} Receipt${expFiles.length!==1?"s":""}`}</Btn>
                    </div>
                  </>
                )}
                {expBusy&&<div style={{marginTop:12,background:"#020508",borderRadius:8,padding:12,fontFamily:"'DM Mono',monospace",fontSize:10,lineHeight:1.9,maxHeight:220,overflowY:"auto",border:"1px solid #0d1a2a"}}>
                  {expLog.map((l,i)=><div key={i} style={{color:l.includes("✅")?"#4ade80":l.includes("❌")?"#f87171":l.includes("⚠️")?"#fbbf24":l.includes("✨")?"#60a5fa":"#2d4a80"}}>{l}</div>)}
                  <div style={{color:"#2563eb"}}>▋</div>
                </div>}
              </div>
            )}

            {expQueue.length>0&&(
              <div>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
                  <div>
                    <h3 style={{margin:"0 0 2px",fontSize:15,color:"#e8eeff"}}>📋 Review & Submit — {expQueue.filter(i=>i._status==="review").length} receipts</h3>
                    <div style={{fontSize:11,color:"#2d4a80"}}>Agent pre-filled all fields from your receipts. Correct anything if needed, then submit for manager approval.</div>
                  </div>
                  <div style={{display:"flex",gap:8}}>
                    <Btn onClick={()=>{setExpQueue([]);setExpFiles([]);setExpLog([]);}} outline color="#334155" small>Start Over</Btn>
                    {expQueue.some(i=>i._status==="review")&&<Btn onClick={submitAllExp} color="#059669">✅ Submit All for Approval</Btn>}
                  </div>
                </div>

                {expQueue.map(item=>{
                  const fs=FLAG_STYLE[item._flag]||FLAG_STYLE["OK"];
                  const done=item._status==="submitted";
                  return(
                    <div key={item._id} style={{...CARD,marginBottom:12,border:`1px solid ${done?"#14532d":item._flag!=="OK"?"#7c2d12":"#111c30"}`}}>
                      <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:12}}>
                        <div style={{display:"flex",gap:10,alignItems:"center"}}>
                          <span style={{fontSize:16}}>{done?"✅":"📄"}</span>
                          <div>
                            <div style={{fontSize:12,fontWeight:700,color:"#e8eeff"}}>{item.fileName}</div>
                            <div style={{display:"flex",gap:6,marginTop:3,flexWrap:"wrap",alignItems:"center"}}>
                              <Badge label={item._flag} style={fs}/>
                              <span style={{fontSize:10,color:item._confidence==="HIGH"?"#4ade80":item._confidence==="MEDIUM"?"#fbbf24":"#f87171"}}>● AI {item._confidence}</span>
                            </div>
                          </div>
                        </div>
                        {!done&&<div style={{display:"flex",gap:6}}>
                          <Btn onClick={()=>setExpQueue(p=>p.map(i=>i._id===item._id?{...i,_status:"skipped"}:i))} outline color="#334155" small>Skip</Btn>
                          <Btn onClick={()=>submitExp(item._id)} color="#059669" small>✅ Submit for Approval</Btn>
                        </div>}
                        {done&&<span style={{fontSize:11,color:"#4ade80",fontWeight:700}}>✅ Sent to manager</span>}
                      </div>
                      {item._validationIssues?.length>0&&<div style={{marginBottom:10,padding:"7px 11px",background:"rgba(251,191,36,0.07)",borderRadius:6,border:"1px solid #713f12"}}>
                        {item._validationIssues.map((v,i)=><div key={i} style={{fontSize:11,color:"#fbbf24"}}>⚠️ {v}</div>)}
                      </div>}
                      {/* Employee info (read-only — from session) */}
                      <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:8,marginBottom:8}}>
                        <Inp label="Employee" value={item.submitterName} onChange={()=>{}} readOnly ok/>
                        <Inp label="Service Line" value={item.serviceLine} onChange={()=>{}} readOnly ok/>
                        <Inp label="Cost Centre" value={item.costCentre} onChange={()=>{}} readOnly ok/>
                        <Inp label="Project/WBS" value={item.projectWBS} onChange={v=>updateExp(item._id,"projectWBS",v)} readOnly={done}/>
                      </div>
                      {/* Invoice fields (editable) */}
                      <div style={{display:"grid",gridTemplateColumns:"repeat(5,1fr)",gap:8}}>
                        <Inp label="Invoice #" value={item.invoiceNumber} onChange={v=>updateExp(item._id,"invoiceNumber",v)} readOnly={done} ok={!!item.invoiceNumber}/>
                        <Inp label="Date" value={item.invoiceDate} onChange={v=>updateExp(item._id,"invoiceDate",v)} type="date" readOnly={done} ok={!!item.invoiceDate} warn={!item.invoiceDate}/>
                        <Inp label="Seller" value={item.sellerName} onChange={v=>updateExp(item._id,"sellerName",v)} readOnly={done} ok={item.sellerName!=="Unknown"}/>
                        <Inp label="Amount" value={item.totalAmount} onChange={v=>updateExp(item._id,"totalAmount",v)} type="number" readOnly={done} ok={parseFloat(item.totalAmount)>0} warn={parseFloat(item.totalAmount)===0}/>
                        <Inp label="Currency" value={item.currency} onChange={v=>updateExp(item._id,"currency",v)} options={CURRENCIES} readOnly={done}/>
                      </div>
                      {item._agentNotes&&<div style={{marginTop:6,fontSize:10,color:"#2d4a80",fontStyle:"italic"}}>🤖 {item._agentNotes}</div>}
                    </div>
                  );
                })}
                {expLog.length>0&&<details style={{...CARD,padding:10,marginTop:8}}><summary style={{cursor:"pointer",fontSize:10,color:"#2d4a80",fontWeight:700}}>🔍 Agent Log</summary>
                  <div style={{marginTop:8,fontFamily:"'DM Mono',monospace",fontSize:10,lineHeight:1.8,maxHeight:180,overflowY:"auto"}}>
                    {expLog.map((l,i)=><div key={i} style={{color:l.includes("✅")?"#4ade80":l.includes("❌")?"#f87171":l.includes("⚠️")?"#fbbf24":"#2d4a80"}}>{l}</div>)}
                  </div>
                </details>}
              </div>
            )}
          </div>
        )}

        {/* ══════════ SUBMIT TRAVEL ══════════ */}
        {tab==="travel"&&(
          <div>
            <div style={{marginBottom:18}}>
              <h2 style={{margin:"0 0 3px",fontSize:19,color:"#e8eeff",fontWeight:700}}>🤖 Submit Company Travel</h2>
              <p style={{margin:0,color:"#2d4a80",fontSize:12}}>Upload flight tickets, boarding passes, hotel bookings → Agent extracts details + carbon footprint → Review & submit for approval</p>
            </div>

            {!trvQueue.length&&(
              <div style={{...CARD,marginBottom:14}}>
                <div onDragOver={e=>e.preventDefault()} onDrop={e=>{e.preventDefault();setTrvFiles(p=>[...p,...Array.from(e.dataTransfer.files).filter(f=>f.type.startsWith("image/")||f.type==="application/pdf")]);}} onClick={()=>trvFileRef.current?.click()}
                  style={{border:"2px dashed #1a2d50",borderRadius:10,padding:"40px 20px",textAlign:"center",cursor:"pointer",background:"rgba(2,5,12,0.5)",marginBottom:trvFiles.length?14:0}}>
                  <div style={{fontSize:38,marginBottom:8}}>🎫</div>
                  <div style={{fontSize:14,fontWeight:700,color:"#c7d8ff",marginBottom:4}}>Drop flight tickets, hotel bookings, boarding passes</div>
                  <div style={{fontSize:11,color:"#2d4a80"}}>Agent extracts route, dates, cost · Calculates carbon footprint (ICAO/Green Key) automatically</div>
                  <input ref={trvFileRef} type="file" multiple accept="image/*,.pdf" onChange={e=>setTrvFiles(p=>[...p,...Array.from(e.target.files)])} style={{display:"none"}}/>
                </div>
                {trvFiles.length>0&&(
                  <>
                    {trvFiles.map((f,i)=>(
                      <div key={i} style={{display:"flex",justifyContent:"space-between",alignItems:"center",background:"#04080f",borderRadius:7,padding:"8px 12px",marginBottom:4,border:"1px solid #0d1a2a"}}>
                        <span style={{fontSize:12,color:"#93c5fd"}}>{f.type.startsWith("image/")?"🖼️":"📄"} {f.name}</span>
                        <button onClick={()=>setTrvFiles(p=>p.filter((_,j)=>j!==i))} style={{background:"none",border:"none",color:"#ef4444",cursor:"pointer"}}>✕</button>
                      </div>
                    ))}
                    <div style={{display:"flex",justifyContent:"flex-end",marginTop:10,gap:8}}>
                      <Btn onClick={()=>setTrvFiles([])} outline color="#334155" small>Clear</Btn>
                      <Btn onClick={runTrvAgent} disabled={trvBusy} color="#4f46e5">{trvBusy?"⏳ Extracting…":`🤖 Run Agent on ${trvFiles.length} Document${trvFiles.length!==1?"s":""}`}</Btn>
                    </div>
                  </>
                )}
                {trvBusy&&<div style={{marginTop:12,background:"#020508",borderRadius:8,padding:12,fontFamily:"'DM Mono',monospace",fontSize:10,lineHeight:1.9,maxHeight:220,overflowY:"auto",border:"1px solid #0d1a2a"}}>
                  {trvLog.map((l,i)=><div key={i} style={{color:l.includes("✅")?"#4ade80":l.includes("❌")?"#f87171":l.includes("⚠️")?"#fbbf24":l.includes("🌿")?"#4ade80":l.includes("✨")?"#60a5fa":"#2d4a80"}}>{l}</div>)}
                  <div style={{color:"#2563eb"}}>▋</div>
                </div>}
              </div>
            )}

            {trvQueue.length>0&&(
              <div>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
                  <div>
                    <h3 style={{margin:"0 0 2px",fontSize:15,color:"#e8eeff"}}>📋 Review & Submit — {trvQueue.filter(i=>i._status==="review").length} travel records</h3>
                    <div style={{fontSize:11,color:"#2d4a80"}}>Carbon footprint pre-calculated. Add claim details if needed, then submit for manager approval.</div>
                  </div>
                  <div style={{display:"flex",gap:8}}>
                    <Btn onClick={()=>{setTrvQueue([]);setTrvFiles([]);setTrvLog([]);}} outline color="#334155" small>Start Over</Btn>
                    {trvQueue.some(i=>i._status==="review")&&<Btn onClick={submitAllTrv} color="#059669">✅ Submit All for Approval</Btn>}
                  </div>
                </div>

                {trvQueue.map(item=>{
                  const fs=FLAG_STYLE[item._flag]||FLAG_STYLE["OK"];
                  const done=item._status==="submitted";
                  const isFl=item.travelType==="Flight";
                  return(
                    <div key={item._id} style={{...CARD,marginBottom:12,border:`1px solid ${done?"#14532d":(!item._nameMatchesEmployee&&item._passengerName)?"#7c1d1d":item._flag!=="OK"?"#7c2d12":"#111c30"}`}}>
                      <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:12}}>
                        <div style={{display:"flex",gap:10,alignItems:"center"}}>
                          <span style={{fontSize:20}}>{isFl?"✈️":"🏨"}</span>
                          <div>
                            <div style={{fontSize:13,fontWeight:700,color:"#e8eeff"}}>
                              {isFl?`${item.origin} → ${item.destination}`:`${item.hotelName}, ${item.hotelCity}`}
                              <span style={{fontSize:11,color:"#4a6fa5",fontWeight:400,marginLeft:8}}>{item.travelDate}</span>
                            </div>
                            <div style={{display:"flex",gap:6,marginTop:3,flexWrap:"wrap",alignItems:"center"}}>
                              <Badge label={item._flag} style={fs}/>
                              <span style={{fontSize:10,color:"#4ade80",fontWeight:600}}>🌿 {item.co2_kg} kg CO₂</span>
                              <span style={{fontSize:10,color:"#fbbf24"}}>Offset: ${item.co2_offset_usd}</span>
                              <span style={{fontSize:10,color:item._confidence==="HIGH"?"#4ade80":item._confidence==="MEDIUM"?"#fbbf24":"#f87171"}}>● AI {item._confidence}</span>
                            </div>
                          </div>
                        </div>
                        {!done&&<div style={{display:"flex",gap:6}}>
                          <Btn onClick={()=>setTrvQueue(p=>p.map(i=>i._id===item._id?{...i,_status:"skipped"}:i))} outline color="#334155" small>Skip</Btn>
                          <Btn onClick={()=>submitTrv(item._id)} color="#059669" small disabled={!item._nameMatchesEmployee&&!!item._passengerName}>✅ Submit for Approval</Btn>
                        </div>}
                        {done&&<span style={{fontSize:11,color:"#4ade80",fontWeight:700}}>✅ Sent to manager</span>}
                      </div>

                      {/* Name validation — prominent banner */}
                      {item._passengerName&&(
                        <div style={{marginBottom:10,padding:"10px 14px",borderRadius:8,border:`1px solid ${item._nameMatchesEmployee?"#14532d":"#7f1d1d"}`,background:item._nameMatchesEmployee?"rgba(20,83,45,0.15)":"rgba(127,29,29,0.2)",display:"flex",alignItems:"center",gap:10}}>
                          <span style={{fontSize:18}}>{item._nameMatchesEmployee?"✅":"❌"}</span>
                          <div>
                            <div style={{fontSize:12,fontWeight:700,color:item._nameMatchesEmployee?"#4ade80":"#f87171"}}>
                              {item._nameMatchesEmployee?"Name Verified":"Name Mismatch — Cannot Submit"}
                            </div>
                            <div style={{fontSize:11,color:item._nameMatchesEmployee?"#6ee7b7":"#fca5a5",marginTop:2}}>
                              Document: <strong>"{item._passengerName}"</strong> &nbsp;·&nbsp; Employee: <strong>"{item.submitterName}"</strong>
                              {item._nameMatchNote&&<span style={{color:"#64748b"}}> — {item._nameMatchNote}</span>}
                            </div>
                          </div>
                        </div>
                      )}

                      {item._validationIssues?.length>0&&<div style={{marginBottom:10,padding:"7px 11px",background:"rgba(251,191,36,0.07)",borderRadius:6,border:"1px solid #713f12"}}>
                        {item._validationIssues.map((v,i)=><div key={i} style={{fontSize:11,color:"#fbbf24"}}>⚠️ {v}</div>)}
                      </div>}
                      {/* Employee (locked) */}
                      <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:8,marginBottom:8}}>
                        <Inp label="Employee" value={item.submitterName} onChange={()=>{}} readOnly ok/>
                        <Inp label="Service Line" value={item.serviceLine} onChange={()=>{}} readOnly ok/>
                        <Inp label="Cost Centre" value={item.costCentre} onChange={()=>{}} readOnly ok/>
                        <Inp label="Project/WBS" value={item.projectWBS} onChange={v=>updateTrv(item._id,"projectWBS",v)} readOnly={done}/>
                      </div>
                      {/* Travel fields */}
                      {isFl?(
                        <div style={{display:"grid",gridTemplateColumns:"repeat(5,1fr)",gap:8,marginBottom:8}}>
                          <Inp label="Origin"      value={item.origin}      onChange={v=>updateTrv(item._id,"origin",v)}      readOnly={done} ok={!!item.origin}/>
                          <Inp label="Destination" value={item.destination} onChange={v=>updateTrv(item._id,"destination",v)} readOnly={done} ok={!!item.destination}/>
                          <Inp label="Depart Date" value={item.travelDate}  onChange={v=>updateTrv(item._id,"travelDate",v)}  type="date" readOnly={done}/>
                          <Inp label="Cabin Class" value={item.cabinClass}  onChange={v=>updateTrv(item._id,"cabinClass",v)}  options={CABIN_CLASSES} readOnly={done}/>
                          <Inp label="PNR / Ref"   value={item.bookingRef}  onChange={v=>updateTrv(item._id,"bookingRef",v)}  readOnly={done}/>
                        </div>
                      ):(
                        <div style={{display:"grid",gridTemplateColumns:"repeat(5,1fr)",gap:8,marginBottom:8}}>
                          <Inp label="Hotel"     value={item.hotelName}  onChange={v=>updateTrv(item._id,"hotelName",v)}  readOnly={done} ok={!!item.hotelName}/>
                          <Inp label="City"      value={item.hotelCity}  onChange={v=>updateTrv(item._id,"hotelCity",v)}  readOnly={done}/>
                          <Inp label="Check-in"  value={item.travelDate} onChange={v=>updateTrv(item._id,"travelDate",v)} type="date" readOnly={done}/>
                          <Inp label="Check-out" value={item.returnDate} onChange={v=>updateTrv(item._id,"returnDate",v)} type="date" readOnly={done}/>
                          <Inp label="Nights"    value={item.nights}     onChange={v=>updateTrv(item._id,"nights",v)}     type="number" readOnly={done}/>
                        </div>
                      )}
                      <div style={{display:"grid",gridTemplateColumns:"2fr 1fr 1fr 1fr 1fr",gap:8,marginBottom:done?0:8}}>
                        <Inp label="Invoice #" value={item.invoiceNumber} onChange={v=>updateTrv(item._id,"invoiceNumber",v)} readOnly={done} ok={!!item.invoiceNumber}/>
                        <Inp label="Cost"      value={item.cost}          onChange={v=>updateTrv(item._id,"cost",v)}          type="number" readOnly={done}/>
                        <Inp label="Currency"  value={item.currency}      onChange={v=>updateTrv(item._id,"currency",v)}      options={CURRENCIES} readOnly={done}/>
                        <div style={{background:"#03060e",borderRadius:7,padding:"7px 9px",border:"1px solid #0d1a2a"}}>
                          <div style={{fontSize:9,color:"#2d4a80",fontWeight:700,marginBottom:2}}>CO₂</div>
                          <div style={{fontSize:15,fontWeight:700,color:item.co2_kg>500?"#f87171":item.co2_kg>200?"#fbbf24":"#4ade80"}}>{item.co2_kg} kg</div>
                        </div>
                        <div style={{background:"#03060e",borderRadius:7,padding:"7px 9px",border:"1px solid #0d1a2a"}}>
                          <div style={{fontSize:9,color:"#2d4a80",fontWeight:700,marginBottom:2}}>OFFSET</div>
                          <div style={{fontSize:14,fontWeight:700,color:"#fbbf24"}}>${item.co2_offset_usd}</div>
                        </div>
                      </div>
                      {/* Claim (only before submit) */}
                      {!done&&<div style={{padding:"10px 12px",background:"rgba(234,179,8,0.05)",borderRadius:7,border:"1px solid #2a1f00"}}>
                        <div style={{fontSize:9,color:"#ca8a04",fontWeight:700,letterSpacing:"0.07em",marginBottom:7}}>💰 CLAIM DETAILS (optional — for out-of-pocket expenses related to this trip)</div>
                        <div style={{display:"grid",gridTemplateColumns:"2fr 1fr 3fr",gap:8}}>
                          <Inp label="Claim Amount" value={item.claimAmount} onChange={v=>updateTrv(item._id,"claimAmount",v)} type="number"/>
                          <Inp label="Currency" value={item.claimCurrency} onChange={v=>updateTrv(item._id,"claimCurrency",v)} options={CURRENCIES}/>
                          <Inp label="Description" value={item.claimDescription} onChange={v=>updateTrv(item._id,"claimDescription",v)} placeholder="Cab, baggage fee, airport meals…"/>
                        </div>
                      </div>}
                      {item._agentNotes&&<div style={{marginTop:6,fontSize:10,color:"#2d4a80",fontStyle:"italic"}}>🤖 {item._agentNotes}</div>}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* ══════════ MY RECORDS ══════════ */}
        {tab==="myrecords"&&(
          <div>
            <h2 style={{margin:"0 0 18px",fontSize:19,color:"#e8eeff"}}>📋 My Submissions</h2>
            {/* My expense records */}
            <div style={{...CARD,padding:0,overflow:"hidden",marginBottom:16}}>
              <div style={{padding:"11px 16px",borderBottom:"1px solid #0d1a2a",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                <h3 style={{margin:0,color:"#e8eeff",fontSize:13}}>🧾 My Expense Receipts ({myExpenses.length})</h3>
              </div>
              {myExpenses.length===0?<div style={{padding:28,textAlign:"center",color:"#2d4a80",fontSize:12}}>No expense records yet</div>:(
                <div style={{overflowX:"auto"}}>
                  <table style={{width:"100%",borderCollapse:"collapse",fontSize:11}}>
                    <thead><tr style={{background:"#02050a"}}>{["Invoice","Date","Seller","Amount","Type","Meal","Flag","Approval","Manager Note"].map(h=><th key={h} style={{padding:"7px 10px",textAlign:"left",color:"#2d4a80",fontWeight:700,borderBottom:"1px solid #0d1a2a",whiteSpace:"nowrap"}}>{h}</th>)}</tr></thead>
                    <tbody>{myExpenses.map((r,i)=>(
                      <tr key={i} style={{borderBottom:"1px solid #04080f",background:i%2===0?"rgba(2,5,10,0.4)":"transparent"}}>
                        <td style={{padding:"7px 10px",color:"#93c5fd",fontWeight:600}}>{r.invoiceNumber}</td>
                        <td style={{padding:"7px 10px",color:"#4a6fa5"}}>{r.invoiceDate}</td>
                        <td style={{padding:"7px 10px",color:"#cbd5e1"}}>{r.sellerName}</td>
                        <td style={{padding:"7px 10px",color:"#4ade80",fontWeight:600}}>{r.currency} {r.totalAmount}</td>
                        <td style={{padding:"7px 10px",color:"#4a6fa5"}}>{r.receiptType}</td>
                        <td style={{padding:"7px 10px",color:r.mealLimitCheck==="OK"?"#4ade80":"#fbbf24",fontSize:10}}>{r.mealLimitCheck}</td>
                        <td style={{padding:"7px 10px"}}><Badge label={r._flag} style={FLAG_STYLE[r._flag]||FLAG_STYLE["OK"]}/></td>
                        <td style={{padding:"7px 10px"}}><Badge label={r.approvalStatus} style={APPROVAL_STYLE[r.approvalStatus]||APPROVAL_STYLE["Pending Review"]}/></td>
                        <td style={{padding:"7px 10px",color:"#fbbf24",fontSize:10,fontStyle:"italic"}}>{r.managerComment||"—"}</td>
                      </tr>
                    ))}</tbody>
                  </table>
                </div>
              )}
            </div>
            {/* My travel records */}
            <div style={{...CARD,padding:0,overflow:"hidden"}}>
              <div style={{padding:"11px 16px",borderBottom:"1px solid #0d1a2a"}}><h3 style={{margin:0,color:"#e8eeff",fontSize:13}}>✈️ My Travel Records ({myTravels.length})</h3></div>
              {myTravels.length===0?<div style={{padding:28,textAlign:"center",color:"#2d4a80",fontSize:12}}>No travel records yet</div>:(
                <div style={{overflowX:"auto"}}>
                  <table style={{width:"100%",borderCollapse:"collapse",fontSize:11}}>
                    <thead><tr style={{background:"#02050a"}}>{["Type","Route/Hotel","Date","Cost","CO₂","Claim","Claim Status","Flag","Approval","Action"].map(h=><th key={h} style={{padding:"7px 10px",textAlign:"left",color:"#2d4a80",fontWeight:700,borderBottom:"1px solid #0d1a2a",whiteSpace:"nowrap"}}>{h}</th>)}</tr></thead>
                    <tbody>{myTravels.map((r,i)=>(
                      <tr key={i} style={{borderBottom:"1px solid #04080f",background:i%2===0?"rgba(2,5,10,0.4)":"transparent"}}>
                        <td style={{padding:"7px 10px",color:r.travelType==="Flight"?"#60a5fa":"#c084fc",fontWeight:600}}>{r.travelType==="Flight"?"✈️":"🏨"} {r.travelType}</td>
                        <td style={{padding:"7px 10px",color:"#93c5fd"}}>{r.travelType==="Flight"?`${r.origin}→${r.destination}`:`${r.hotelName},${r.hotelCity}`}</td>
                        <td style={{padding:"7px 10px",color:"#4a6fa5"}}>{r.travelDate}</td>
                        <td style={{padding:"7px 10px",color:"#4ade80",fontWeight:600}}>{r.currency} {r.cost}</td>
                        <td style={{padding:"7px 10px",color:parseFloat(r.co2_kg)>500?"#f87171":parseFloat(r.co2_kg)>200?"#fbbf24":"#4ade80",fontWeight:700}}>{r.co2_kg} kg</td>
                        <td style={{padding:"7px 10px",color:"#fbbf24"}}>{r.claimAmount?`${r.claimCurrency} ${r.claimAmount}`:"—"}</td>
                        <td style={{padding:"7px 10px"}}><Badge label={r.claimStatus||"Unclaimed"} style={CLAIM_STYLE[r.claimStatus||"Unclaimed"]}/></td>
                        <td style={{padding:"7px 10px"}}><Badge label={r._flag} style={FLAG_STYLE[r._flag]||FLAG_STYLE["OK"]}/></td>
                        <td style={{padding:"7px 10px"}}><Badge label={r.approvalStatus} style={APPROVAL_STYLE[r.approvalStatus]||APPROVAL_STYLE["Pending Review"]}/></td>
                        <td style={{padding:"7px 10px"}}>
                          {r.claimAmount&&r.claimStatus==="Unclaimed"&&r.approvalStatus==="Approved"&&
                            <button onClick={()=>submitClaim(r.id)} style={{padding:"3px 8px",borderRadius:5,border:"none",background:"#854d0e",color:"#fef08a",fontSize:10,cursor:"pointer",fontWeight:700}}>📤 Claim</button>}
                        </td>
                      </tr>
                    ))}</tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        )}

        {/* ══════════ APPROVALS (Manager/Admin) ══════════ */}
        {tab==="approvals"&&isManager&&(
          <div>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:18}}>
              <div>
                <h2 style={{margin:"0 0 3px",fontSize:19,color:"#e8eeff"}}>✅ Approval Queue</h2>
                <p style={{margin:0,color:"#2d4a80",fontSize:12}}>{pendingForMe.length} record{pendingForMe.length!==1?"s":""} awaiting your review — approve in-app or export for email</p>
              </div>
              <Btn onClick={exportPendingReport} color="#7c3aed" disabled={pendingForMe.length===0}>
                📧 Export Pending Report for Email
              </Btn>
            </div>

            {/* Summary strip */}
            {pendingForMe.length>0&&(
              <div style={{display:"grid",gridTemplateColumns:"repeat(5,1fr)",gap:10,marginBottom:18}}>
                {[
                  ["Pending",   pendingForMe.length,                                                              "⏳","#60a5fa"],
                  ["Expenses",  (isAdmin?expenses:expenses.filter(r=>managedIds.includes(r.submitterId))).filter(r=>r.approvalStatus==="Pending Review").length, "🧾","#3b82f6"],
                  ["Travel",    (isAdmin?travels:travels.filter(r=>managedIds.includes(r.submitterId))).filter(r=>r.approvalStatus==="Pending Review").length,   "✈️","#818cf8"],
                  ["Flagged",   pendingForMe.filter(r=>r._flag!=="OK").length,                                    "🚩","#f87171"],
                  ["Meal Alerts",expenses.filter(r=>managedIds.includes(r.submitterId)&&r.approvalStatus==="Pending Review"&&r.mealLimitCheck!=="OK").length,"🍽️","#fbbf24"],
                ].map(([l,v,ic,c])=>(
                  <div key={l} style={{...CARD,padding:"12px 14px",display:"flex",alignItems:"center",gap:10}}>
                    <span style={{fontSize:20}}>{ic}</span>
                    <div><div style={{fontSize:18,fontWeight:700,color:c}}>{v}</div><div style={{fontSize:10,color:"#2d4a80"}}>{l}</div></div>
                  </div>
                ))}
              </div>
            )}

            {pendingForMe.length===0&&(
              <div style={{...CARD,textAlign:"center",padding:48}}>
                <div style={{fontSize:40,marginBottom:12}}>✅</div>
                <div style={{fontSize:15,color:"#334155",fontWeight:600}}>All clear — nothing pending</div>
              </div>
            )}

            {/* Pending expenses */}
            {(isAdmin?expenses:expenses.filter(r=>managedIds.includes(r.submitterId))).filter(r=>r.approvalStatus==="Pending Review").map(r=>{
              const fs=FLAG_STYLE[r._flag]||FLAG_STYLE["OK"];
              const comment=approvalComments[r.id]||"";
              return(
                <div key={r.id} style={{...CARD,marginBottom:12,border:`1px solid ${r._flag!=="OK"?"#7c2d12":"#111c30"}`}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:12}}>
                    <div>
                      <div style={{fontSize:13,fontWeight:700,color:"#e8eeff"}}>🧾 Expense — {r.submitterName} <span style={{color:"#4a6fa5",fontWeight:400}}>· {r.sellerName} · {r.currency} {r.totalAmount}</span></div>
                      <div style={{display:"flex",gap:6,marginTop:4,flexWrap:"wrap",alignItems:"center"}}>
                        <Badge label={r._flag} style={fs}/>
                        <span style={{fontSize:10,color:"#4a6fa5"}}>{r.serviceLine} · {r.costCentre}{r.projectWBS?` · ${r.projectWBS}`:""}</span>
                        <span style={{fontSize:10,color:"#334155"}}>📅 {r.invoiceDate} · {r.receiptType}</span>
                        {r.mealLimitCheck!=="OK"&&<span style={{fontSize:10,color:"#fbbf24"}}>{r.mealLimitCheck}</span>}
                      </div>
                    </div>
                  </div>
                  <div style={{display:"grid",gridTemplateColumns:"1fr auto",gap:10,alignItems:"end"}}>
                    <Inp label="Comment (optional)" value={comment} onChange={v=>setApprovalComments(p=>({...p,[r.id]:v}))} placeholder="Add note for employee…"/>
                    <div style={{display:"flex",gap:6,paddingBottom:1}}>
                      <Btn onClick={()=>approveRecord("exp",r.id,comment)} color="#059669" small>✅ Approve</Btn>
                      <Btn onClick={()=>requestCorrection("exp",r.id,comment||"Please review and resubmit")} color="#d97706" small>🔁 Request Fix</Btn>
                      <Btn onClick={()=>rejectRecord("exp",r.id,comment||"Rejected")} color="#dc2626" small>❌ Reject</Btn>
                    </div>
                  </div>
                </div>
              );
            })}

            {/* Pending travel */}
            {(isAdmin?travels:travels.filter(r=>managedIds.includes(r.submitterId))).filter(r=>r.approvalStatus==="Pending Review").map(r=>{
              const fs=FLAG_STYLE[r._flag]||FLAG_STYLE["OK"];
              const isFl=r.travelType==="Flight";
              const comment=approvalComments[r.id]||"";
              return(
                <div key={r.id} style={{...CARD,marginBottom:12,border:`1px solid ${r._flag!=="OK"?"#7c2d12":"#111c30"}`}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:12}}>
                    <div>
                      <div style={{fontSize:13,fontWeight:700,color:"#e8eeff"}}>
                        {isFl?"✈️":"🏨"} {isFl?`${r.origin} → ${r.destination}`:`${r.hotelName}, ${r.hotelCity}`}
                        <span style={{color:"#4a6fa5",fontWeight:400,fontSize:12,marginLeft:8}}>{r.submitterName} · {r.travelDate}</span>
                      </div>
                      <div style={{display:"flex",gap:6,marginTop:4,flexWrap:"wrap",alignItems:"center"}}>
                        <Badge label={r._flag} style={fs}/>
                        <span style={{fontSize:10,color:"#4ade80",fontWeight:600}}>🌿 {r.co2_kg} kg CO₂</span>
                        <span style={{fontSize:10,color:"#fbbf24"}}>Offset: ${r.co2_offset_usd}</span>
                        <span style={{fontSize:10,color:"#4a6fa5"}}>{r.currency} {r.cost}</span>
                        {isFl&&<span style={{fontSize:10,color:"#4a6fa5"}}>{r.cabinClass}</span>}
                        {!isFl&&<span style={{fontSize:10,color:"#4a6fa5"}}>{r.nights} nights · {r.roomType}</span>}
                        {r.claimAmount&&<span style={{fontSize:10,color:"#fbbf24"}}>💰 Claim: {r.claimCurrency} {r.claimAmount}</span>}
                      </div>
                    </div>
                  </div>
                  <div style={{display:"grid",gridTemplateColumns:"1fr auto",gap:10,alignItems:"end"}}>
                    <Inp label="Comment (optional)" value={comment} onChange={v=>setApprovalComments(p=>({...p,[r.id]:v}))} placeholder="Add note for employee…"/>
                    <div style={{display:"flex",gap:6,paddingBottom:1}}>
                      <Btn onClick={()=>approveRecord("trv",r.id,comment)} color="#059669" small>✅ Approve</Btn>
                      <Btn onClick={()=>requestCorrection("trv",r.id,comment||"Please review and resubmit")} color="#d97706" small>🔁 Request Fix</Btn>
                      <Btn onClick={()=>rejectRecord("trv",r.id,comment||"Rejected")} color="#dc2626" small>❌ Reject</Btn>
                    </div>
                  </div>
                  {r.claimStatus==="Claim Submitted"&&<div style={{marginTop:10,display:"flex",gap:8,alignItems:"center"}}>
                    <span style={{fontSize:11,color:"#fbbf24"}}>💰 Claim awaiting action:</span>
                    <Btn onClick={()=>approveClaim(r.id)} color="#059669" small>✅ Approve Claim</Btn>
                    <Btn onClick={()=>rejectClaim(r.id)}  color="#dc2626" small>❌ Reject Claim</Btn>
                  </div>}
                </div>
              );
            })}
          </div>
        )}

        {/* ══════════ ALL RECORDS (Manager/Admin) ══════════ */}
        {tab==="records"&&isManager&&(
          <div>
            <div style={{display:"grid",gridTemplateColumns:"repeat(5,1fr)",gap:12,marginBottom:20}}>
              {[["Expenses",expenses.length,"🧾","#3b82f6"],["Approved",[...expenses,...travels].filter(r=>r.approvalStatus==="Approved").length,"✅","#4ade80"],["Pending",pendingApprovals.length,"⏳","#fbbf24"],["Travel",travels.length,"✈️","#60a5fa"],["Total CO₂",`${Math.round(totalCO2)}kg`,"🌿","#4ade80"]].map(([l,v,ic,c])=>(
                <div key={l} style={{...CARD,padding:14,textAlign:"center"}}><div style={{fontSize:18}}>{ic}</div><div style={{fontSize:20,fontWeight:700,color:c}}>{v}</div><div style={{fontSize:10,color:"#2d4a80"}}>{l}</div></div>
              ))}
            </div>
            <div style={{...CARD,padding:0,overflow:"hidden",marginBottom:14}}>
              <div style={{padding:"11px 16px",borderBottom:"1px solid #0d1a2a",display:"flex",justifyContent:"space-between"}}>
                <h3 style={{margin:0,color:"#e8eeff",fontSize:13}}>🧾 All Expenses ({expenses.length})</h3>
                <Btn onClick={exportExpenses} color="#059669" small>📥 Export</Btn>
              </div>
              {expenses.length===0?<div style={{padding:28,textAlign:"center",color:"#2d4a80",fontSize:12}}>No records</div>:(
                <div style={{overflowX:"auto"}}><table style={{width:"100%",borderCollapse:"collapse",fontSize:11}}>
                  <thead><tr style={{background:"#02050a"}}>{["#","Invoice","Date","Employee","SL","Seller","Amount","Type","Flag","Approval",""].map(h=><th key={h} style={{padding:"7px 10px",textAlign:"left",color:"#2d4a80",fontWeight:700,borderBottom:"1px solid #0d1a2a",whiteSpace:"nowrap"}}>{h}</th>)}</tr></thead>
                  <tbody>{expenses.map((r,i)=>(
                    <tr key={i} style={{borderBottom:"1px solid #04080f",background:i%2===0?"rgba(2,5,10,0.4)":"transparent"}}>
                      <td style={{padding:"7px 10px",color:"#2d4a80"}}>{i+1}</td>
                      <td style={{padding:"7px 10px",color:"#93c5fd",fontWeight:600}}>{r.invoiceNumber}</td>
                      <td style={{padding:"7px 10px",color:"#4a6fa5"}}>{r.invoiceDate}</td>
                      <td style={{padding:"7px 10px",color:"#cbd5e1"}}>{r.submitterName}</td>
                      <td style={{padding:"7px 10px",color:"#4a6fa5"}}>{r.serviceLine}</td>
                      <td style={{padding:"7px 10px",color:"#cbd5e1"}}>{r.sellerName}</td>
                      <td style={{padding:"7px 10px",color:"#4ade80",fontWeight:600}}>{r.currency} {r.totalAmount}</td>
                      <td style={{padding:"7px 10px",color:"#4a6fa5"}}>{r.receiptType}</td>
                      <td style={{padding:"7px 10px"}}><Badge label={r._flag} style={FLAG_STYLE[r._flag]||FLAG_STYLE["OK"]}/></td>
                      <td style={{padding:"7px 10px"}}><Badge label={r.approvalStatus} style={APPROVAL_STYLE[r.approvalStatus]||APPROVAL_STYLE["Pending Review"]}/></td>
                      <td style={{padding:"7px 10px"}}>{confirmDel?.id===r.id
                        ?<div style={{display:"flex",gap:3}}><button onClick={()=>deleteExp(r.id)} style={{padding:"2px 6px",borderRadius:4,border:"none",background:"#7f1d1d",color:"#fca5a5",fontSize:10,cursor:"pointer"}}>Yes</button><button onClick={()=>setConfirmDel(null)} style={{padding:"2px 6px",borderRadius:4,border:"1px solid #334155",background:"transparent",color:"#64748b",fontSize:10,cursor:"pointer"}}>No</button></div>
                        :<button onClick={()=>setConfirmDel({id:r.id})} style={{background:"none",border:"1px solid #3a1010",color:"#7f1d1d",borderRadius:4,padding:"2px 7px",cursor:"pointer",fontSize:11}}>🗑</button>}
                      </td>
                    </tr>
                  ))}</tbody>
                </table></div>
              )}
            </div>
            <div style={{...CARD,padding:0,overflow:"hidden",marginBottom:12}}>
              <div style={{padding:"11px 16px",borderBottom:"1px solid #0d1a2a",display:"flex",justifyContent:"space-between"}}>
                <h3 style={{margin:0,color:"#e8eeff",fontSize:13}}>✈️ All Travel ({travels.length})</h3>
                <Btn onClick={exportTravel} color="#059669" small>📥 Export</Btn>
              </div>
              {travels.length===0?<div style={{padding:28,textAlign:"center",color:"#2d4a80",fontSize:12}}>No records</div>:(
                <div style={{overflowX:"auto"}}><table style={{width:"100%",borderCollapse:"collapse",fontSize:11}}>
                  <thead><tr style={{background:"#02050a"}}>{["#","Type","Employee","Route/Hotel","Date","Cost","CO₂","Claim","Flag","Approval",""].map(h=><th key={h} style={{padding:"7px 10px",textAlign:"left",color:"#2d4a80",fontWeight:700,borderBottom:"1px solid #0d1a2a",whiteSpace:"nowrap"}}>{h}</th>)}</tr></thead>
                  <tbody>{travels.map((r,i)=>(
                    <tr key={i} style={{borderBottom:"1px solid #04080f",background:i%2===0?"rgba(2,5,10,0.4)":"transparent"}}>
                      <td style={{padding:"7px 10px",color:"#2d4a80"}}>{i+1}</td>
                      <td style={{padding:"7px 10px",color:r.travelType==="Flight"?"#60a5fa":"#c084fc",fontWeight:600}}>{r.travelType==="Flight"?"✈️":"🏨"}</td>
                      <td style={{padding:"7px 10px",color:"#cbd5e1"}}>{r.submitterName}</td>
                      <td style={{padding:"7px 10px",color:"#93c5fd"}}>{r.travelType==="Flight"?`${r.origin}→${r.destination}`:`${r.hotelName},${r.hotelCity}`}</td>
                      <td style={{padding:"7px 10px",color:"#4a6fa5"}}>{r.travelDate}</td>
                      <td style={{padding:"7px 10px",color:"#4ade80",fontWeight:600}}>{r.currency} {r.cost}</td>
                      <td style={{padding:"7px 10px",color:parseFloat(r.co2_kg)>500?"#f87171":parseFloat(r.co2_kg)>200?"#fbbf24":"#4ade80",fontWeight:700}}>{r.co2_kg}kg</td>
                      <td style={{padding:"7px 10px",color:"#fbbf24"}}>{r.claimAmount?`${r.claimCurrency} ${r.claimAmount}`:"—"}</td>
                      <td style={{padding:"7px 10px"}}><Badge label={r._flag} style={FLAG_STYLE[r._flag]||FLAG_STYLE["OK"]}/></td>
                      <td style={{padding:"7px 10px"}}><Badge label={r.approvalStatus} style={APPROVAL_STYLE[r.approvalStatus]||APPROVAL_STYLE["Pending Review"]}/></td>
                      <td style={{padding:"7px 10px"}}>{confirmDel?.id===r.id
                        ?<div style={{display:"flex",gap:3}}><button onClick={()=>deleteTrv(r.id)} style={{padding:"2px 6px",borderRadius:4,border:"none",background:"#7f1d1d",color:"#fca5a5",fontSize:10,cursor:"pointer"}}>Yes</button><button onClick={()=>setConfirmDel(null)} style={{padding:"2px 6px",borderRadius:4,border:"1px solid #334155",background:"transparent",color:"#64748b",fontSize:10,cursor:"pointer"}}>No</button></div>
                        :<button onClick={()=>setConfirmDel({id:r.id})} style={{background:"none",border:"1px solid #3a1010",color:"#7f1d1d",borderRadius:4,padding:"2px 7px",cursor:"pointer",fontSize:11}}>🗑</button>}
                      </td>
                    </tr>
                  ))}</tbody>
                </table></div>
              )}
            </div>
          </div>
        )}

        {/* ══════════ USER MANAGEMENT (Admin only) ══════════ */}
        {tab==="users"&&isAdmin&&(
          <div>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:18}}>
              <div>
                <h2 style={{margin:"0 0 3px",fontSize:19,color:"#e8eeff"}}>👥 User Management</h2>
                <p style={{margin:0,color:"#2d4a80",fontSize:12}}>Add employees and managers · Each user gets their own login · {users.length} user{users.length!==1?"s":""} registered</p>
              </div>
              <div style={{display:"flex",gap:8}}>
                <input ref={empCSVRef} type="file" accept=".csv" style={{display:"none"}} onChange={importCSV}/>
                <Btn onClick={()=>empCSVRef.current?.click()} outline color="#2563eb" small>📥 Import CSV</Btn>
                <Btn onClick={()=>dlCSV([["Name","Username","Password","Role (employee/manager/admin)","Service Line","Cost Centre","Project WBS","Email","Manager Username"]],`IVW_Users_Template.csv`)} outline color="#334155" small>📤 CSV Template</Btn>
              </div>
            </div>

            {/* CSV hint */}
            <div style={{...CARD,marginBottom:16,padding:"12px 16px",border:"1px solid #1a2d50"}}>
              <div style={{fontSize:9,color:"#2d4a80",fontWeight:700,marginBottom:4,letterSpacing:"0.07em"}}>CSV FORMAT — Name, Username, Password, Role, Service Line, Cost Centre, Project WBS, Email, Manager Username</div>
              <div style={{fontFamily:"'DM Mono',monospace",fontSize:10,color:"#334155"}}>Priya Sharma, priya.sharma, Pass@123, employee, Oracle, Oracle SL, WBS-001, priya@co.com, raj.kumar</div>
            </div>

            {/* Add user form */}
            <div style={{...CARD,marginBottom:16,border:"1px solid #1d3a6b"}}>
              <div style={{fontSize:12,color:"#60a5fa",fontWeight:700,marginBottom:16,display:"flex",alignItems:"center",gap:8}}>
                ➕ Add New User
                <span style={{fontSize:10,color:"#2d4a80",fontWeight:400}}>— all fields marked * are required</span>
              </div>

              {/* Row 1 */}
              <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:12,marginBottom:12}}>
                {/* Name */}
                <div>
                  <div style={{fontSize:10,color:"#60a5fa",marginBottom:4,fontWeight:700}}>FULL NAME *</div>
                  <input
                    value={newUser.name}
                    onChange={e=>{setNewUser(p=>({...p,name:e.target.value}));setUserError("");}}
                    placeholder="e.g. Priya Sharma"
                    style={{width:"100%",padding:"9px 12px",borderRadius:8,background:"#06090f",border:`1px solid ${newUser.name?"#2563eb":"#1a2a40"}`,color:"#dde4f0",fontSize:13,outline:"none",boxSizing:"border-box"}}
                  />
                </div>
                {/* Username */}
                <div>
                  <div style={{fontSize:10,color:"#60a5fa",marginBottom:4,fontWeight:700}}>USERNAME *</div>
                  <input
                    value={newUser.username}
                    onChange={e=>{setNewUser(p=>({...p,username:e.target.value.toLowerCase().replace(/\s/g,".")}));setUserError("");}}
                    placeholder="e.g. priya.sharma"
                    style={{width:"100%",padding:"9px 12px",borderRadius:8,background:"#06090f",border:`1px solid ${newUser.username?"#2563eb":"#1a2a40"}`,color:"#dde4f0",fontSize:13,outline:"none",boxSizing:"border-box"}}
                  />
                </div>
                {/* Password */}
                <div>
                  <div style={{fontSize:10,color:"#60a5fa",marginBottom:4,fontWeight:700}}>PASSWORD *</div>
                  <div style={{position:"relative"}}>
                    <input
                      type={showNewPwd?"text":"password"}
                      value={newUser.password}
                      onChange={e=>{setNewUser(p=>({...p,password:e.target.value}));setUserError("");}}
                      placeholder="Min 6 characters"
                      autoComplete="new-password"
                      style={{width:"100%",padding:"9px 36px 9px 12px",borderRadius:8,background:"#06090f",border:`1px solid ${newUser.password?"#2563eb":"#1a2a40"}`,color:"#dde4f0",fontSize:13,outline:"none",boxSizing:"border-box"}}
                    />
                    <button
                      onClick={()=>setShowNewPwd(p=>!p)}
                      style={{position:"absolute",right:8,top:"50%",transform:"translateY(-50%)",background:"none",border:"none",color:"#4a6fa5",cursor:"pointer",fontSize:14,padding:"2px"}}
                    >{showNewPwd?"🙈":"👁"}</button>
                  </div>
                </div>
              </div>

              {/* Row 2 */}
              <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:12,marginBottom:12}}>
                {/* Role */}
                <div>
                  <div style={{fontSize:10,color:"#60a5fa",marginBottom:4,fontWeight:700}}>ROLE *</div>
                  <select
                    value={newUser.role}
                    onChange={e=>{setNewUser(p=>({...p,role:e.target.value}));setUserError("");}}
                    style={{width:"100%",padding:"9px 12px",borderRadius:8,background:"#06090f",border:"1px solid #2563eb",color:"#dde4f0",fontSize:13,outline:"none"}}
                  >
                    <option value="employee">Employee</option>
                    <option value="manager">Manager</option>
                    <option value="admin">Admin</option>
                  </select>
                </div>
                {/* Service Line */}
                <div>
                  <div style={{fontSize:10,color:"#60a5fa",marginBottom:4,fontWeight:700}}>SERVICE LINE *</div>
                  <select
                    value={newUser.serviceLine}
                    onChange={e=>{setNewUser(p=>({...p,serviceLine:e.target.value}));setUserError("");}}
                    style={{width:"100%",padding:"9px 12px",borderRadius:8,background:"#06090f",border:`1px solid ${newUser.serviceLine?"#2563eb":"#1a2a40"}`,color:newUser.serviceLine?"#dde4f0":"#475569",fontSize:13,outline:"none"}}
                  >
                    <option value="">Select service line…</option>
                    {SERVICE_LINES.map(s=><option key={s} value={s}>{s}</option>)}
                  </select>
                </div>
                {/* Cost Centre */}
                <div>
                  <div style={{fontSize:10,color:"#60a5fa",marginBottom:4,fontWeight:700}}>COST CENTRE *</div>
                  <select
                    value={newUser.costCentre}
                    onChange={e=>{setNewUser(p=>({...p,costCentre:e.target.value}));setUserError("");}}
                    style={{width:"100%",padding:"9px 12px",borderRadius:8,background:"#06090f",border:`1px solid ${newUser.costCentre?"#2563eb":"#1a2a40"}`,color:newUser.costCentre?"#dde4f0":"#475569",fontSize:13,outline:"none"}}
                  >
                    <option value="">Select cost centre…</option>
                    {COST_CENTRES.map(c=><option key={c} value={c}>{c}</option>)}
                  </select>
                </div>
              </div>

              {/* Row 3 */}
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:12,marginBottom:16}}>
                {/* Project WBS */}
                <div>
                  <div style={{fontSize:10,color:"#4a6fa5",marginBottom:4,fontWeight:700}}>PROJECT / WBS CODE</div>
                  <input
                    value={newUser.projectWBS}
                    onChange={e=>setNewUser(p=>({...p,projectWBS:e.target.value}))}
                    placeholder="e.g. WBS-PRJ-001"
                    style={{width:"100%",padding:"9px 12px",borderRadius:8,background:"#06090f",border:"1px solid #1a2a40",color:"#dde4f0",fontSize:13,outline:"none",boxSizing:"border-box"}}
                  />
                </div>
                {/* Email */}
                <div>
                  <div style={{fontSize:10,color:"#4a6fa5",marginBottom:4,fontWeight:700}}>EMAIL</div>
                  <input
                    value={newUser.email}
                    onChange={e=>setNewUser(p=>({...p,email:e.target.value}))}
                    placeholder="priya@company.com"
                    style={{width:"100%",padding:"9px 12px",borderRadius:8,background:"#06090f",border:"1px solid #1a2a40",color:"#dde4f0",fontSize:13,outline:"none",boxSizing:"border-box"}}
                  />
                </div>
                {/* Manager */}
                <div>
                  <div style={{fontSize:10,color:"#4a6fa5",marginBottom:4,fontWeight:700}}>MANAGER (assign reporting line)</div>
                  <select
                    value={newUser.managerId}
                    onChange={e=>setNewUser(p=>({...p,managerId:e.target.value}))}
                    style={{width:"100%",padding:"9px 12px",borderRadius:8,background:"#06090f",border:"1px solid #1a2a40",color:newUser.managerId?"#dde4f0":"#475569",fontSize:13,outline:"none"}}
                  >
                    <option value="">No manager assigned</option>
                    {users.filter(u=>(u.role==="manager"||u.role==="admin")&&u.id!==session?.userId).map(u=>(
                      <option key={u.id} value={u.id}>{u.name} ({u.role})</option>
                    ))}
                  </select>
                </div>
              </div>

              {/* Error message */}
              {userError&&(
                <div style={{marginBottom:14,padding:"10px 14px",background:"rgba(239,68,68,0.1)",borderRadius:8,border:"1px solid #7f1d1d",fontSize:12,color:"#f87171",display:"flex",alignItems:"center",gap:8}}>
                  ⚠️ {userError}
                </div>
              )}

              {/* Submit row */}
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                <div style={{fontSize:11,color:"#2d4a80"}}>
                  {newUser.name&&newUser.username&&newUser.password&&newUser.serviceLine&&newUser.costCentre
                    ? <span style={{color:"#4ade80"}}>✅ Ready to add</span>
                    : <span>Fill required fields to enable</span>}
                </div>
                <button
                  onClick={addUser}
                  style={{
                    padding:"10px 28px",borderRadius:9,border:"none",
                    background: newUser.name&&newUser.username&&newUser.password&&newUser.serviceLine&&newUser.costCentre
                      ? "linear-gradient(135deg,#1d4ed8,#2563eb)" : "#0c1424",
                    color: newUser.name&&newUser.username&&newUser.password&&newUser.serviceLine&&newUser.costCentre
                      ? "#fff" : "#334155",
                    fontSize:13,fontWeight:700,cursor:"pointer",letterSpacing:"0.03em",
                    boxShadow: newUser.name&&newUser.username&&newUser.password&&newUser.serviceLine&&newUser.costCentre
                      ? "0 0 16px rgba(29,78,216,0.35)" : "none"
                  }}
                >
                  ➕ Add User
                </button>
              </div>
            </div>

            {/* User list */}
            {users.length===0?(
              <div style={{...CARD,textAlign:"center",padding:40,color:"#2d4a80"}}>
                <div style={{fontSize:36,marginBottom:10}}>👤</div>
                <div style={{fontSize:13,color:"#334155",fontWeight:600,marginBottom:4}}>No users yet</div>
                <div style={{fontSize:12}}>Add your first user above or import a CSV file.</div>
              </div>
            ):(
              <div style={{...CARD,padding:0,overflow:"hidden"}}>
                <div style={{padding:"12px 16px",borderBottom:"1px solid #0d1a2a",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                  <span style={{fontSize:13,color:"#e8eeff",fontWeight:600}}>{users.length} user{users.length!==1?"s":""}</span>
                  <span style={{fontSize:11,color:"#2d4a80"}}>
                    {users.filter(u=>u.role==="employee").length} employees ·{" "}
                    {users.filter(u=>u.role==="manager").length} managers ·{" "}
                    {users.filter(u=>u.role==="admin").length} admins
                  </span>
                </div>
                <div style={{overflowX:"auto"}}>
                  <table style={{width:"100%",borderCollapse:"collapse",fontSize:11}}>
                    <thead>
                      <tr style={{background:"#02050a"}}>
                        {["#","Name","Username","Role","Service Line","Cost Centre","Manager","Email",""].map(h=>(
                          <th key={h} style={{padding:"8px 12px",textAlign:"left",color:"#2d4a80",fontWeight:700,borderBottom:"1px solid #0d1a2a",whiteSpace:"nowrap"}}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {users.map((u,i)=>{
                        const mgr=users.find(m=>m.id===u.managerId);
                        return(
                          <tr key={u.id} style={{borderBottom:"1px solid #04080f",background:i%2===0?"rgba(2,5,10,0.4)":"transparent"}}>
                            <td style={{padding:"8px 12px",color:"#2d4a80"}}>{i+1}</td>
                            <td style={{padding:"8px 12px",color:"#e8eeff",fontWeight:600}}>{u.name}</td>
                            <td style={{padding:"8px 12px",color:"#93c5fd",fontFamily:"'DM Mono',monospace"}}>{u.username}</td>
                            <td style={{padding:"8px 12px"}}>
                              <span style={{padding:"2px 9px",borderRadius:20,fontSize:10,fontWeight:700,
                                background:u.role==="admin"?"#3b0764":u.role==="manager"?"#1e3a5f":"#1e293b",
                                color:u.role==="admin"?"#e879f9":u.role==="manager"?"#60a5fa":"#94a3b8",
                                border:`1px solid ${u.role==="admin"?"#7c3aed":u.role==="manager"?"#2563eb":"#334155"}`
                              }}>{u.role}</span>
                            </td>
                            <td style={{padding:"8px 12px",color:"#4a6fa5"}}>{u.serviceLine}</td>
                            <td style={{padding:"8px 12px",color:"#4a6fa5"}}>{u.costCentre}</td>
                            <td style={{padding:"8px 12px",color:"#334155"}}>{mgr?.name||<span style={{color:"#1e293b"}}>—</span>}</td>
                            <td style={{padding:"8px 12px",color:"#334155"}}>{u.email||<span style={{color:"#1e293b"}}>—</span>}</td>
                            <td style={{padding:"8px 12px"}}>
                              {u.id!==session.userId&&(
                                <button onClick={()=>deleteUser(u.id)} style={{background:"none",border:"1px solid #3a1010",color:"#7f1d1d",borderRadius:5,padding:"3px 9px",cursor:"pointer",fontSize:10,fontWeight:600}}>🗑 Remove</button>
                              )}
                              {u.id===session.userId&&(
                                <span style={{fontSize:10,color:"#1e293b",fontStyle:"italic"}}>you</span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        )}

      </main>
    </div>
  );
}
