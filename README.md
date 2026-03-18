# Invoice Validator Wiz
Agentic expense & travel management platform for SAP Ariba Travel Desk.

## Deploy to Vercel
[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/YOUR_USERNAME/invoice-validator-wiz)

Add your `ANTHROPIC_API_KEY` as an environment variable in Vercel.

## Run locally
npm install
npm run dev
```

Place your `InvoiceValidatorWiz.jsx` inside the `src/` folder.

Also **find and replace** in `InvoiceValidatorWiz.jsx`:
```
"https://api.anthropic.com/v1/messages"
```
→
```
"/api/claude"
