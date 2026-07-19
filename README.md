# Rupantar

**Rupantar** (रूपांतर) — Hindi/Sanskrit for "transformation."

A WhatsApp bot that converts documents between formats. Send it a Word, Excel, PowerPoint, or PDF file; tap a button to choose your output format; get the converted file back — directly in chat. No accounts, no uploads, no storage.

---

## Conversation flow

```
User: [sends report.xlsx]

Bot:  Got it — this is an Excel file. What would you like to convert it to?
      [ PDF ]  [ Word (.docx) ]  [ CSV ]

User: [taps "PDF"]

Bot:  [sends report.pdf]
      Here's your converted file ✅ — Rupantar
```

## Supported conversions

| From | To |
|------|----|
| DOCX | PDF |
| XLSX | PDF, Word (.docx), CSV |
| PPTX | PDF |
| PDF  | Word (.docx) |

---

## Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Node.js 20 + Express |
| Messaging | Meta WhatsApp Cloud API |
| Conversion | [Gotenberg](https://gotenberg.dev) (Dockerized LibreOffice) |
| File handling | Node `Buffer` only — never `fs.writeFile` |
| Session state | In-memory `Map` with TTL sweep |
| Outbound media | In-memory ephemeral endpoint (`GET /file/:token`) |

---

## Setup

### Prerequisites

- Node.js ≥ 18
- Docker (for Gotenberg)
- A Meta Business App with the WhatsApp product added
- ngrok (local dev) or a server with a public domain (prod)

### 1 — Clone and install

```bash
git clone https://github.com/you/rupantar.git
cd rupantar
npm install
```

### 2 — Configure environment

```bash
cp .env.example .env
```

Fill in `.env`:

| Variable | Description |
|----------|-------------|
| `META_ACCESS_TOKEN` | System user long-lived token from Meta Business Manager |
| `META_PHONE_NUMBER_ID` | From the WhatsApp API Setup page |
| `META_VERIFY_TOKEN` | Your arbitrary string used for webhook GET verification |
| `PUBLIC_BASE_URL` | Your public URL (ngrok URL in dev, real domain in prod) |
| `GOTENBERG_URL` | `http://localhost:3000` if running Gotenberg separately; `http://gotenberg:3000` inside docker-compose |

### 3 — Start Gotenberg

```bash
docker compose up gotenberg
```

Or run the full stack together:

```bash
docker compose up --build
```

### 4 — Start the bot (local dev)

```bash
npm run dev
```

### 5 — Expose locally with ngrok

```bash
ngrok http 3001
```

Copy the `https://...ngrok.io` URL into `PUBLIC_BASE_URL` in your `.env` and into the Meta App Dashboard webhook field:

```
Webhook URL: https://abc123.ngrok.io/webhook/whatsapp
Verify Token: (the value you set in META_VERIFY_TOKEN)
```

> **Note:** the ngrok URL changes every time ngrok restarts. Use a fixed ngrok domain or a real domain for anything more than quick testing.

### 6 — Test it

Message the test number registered in your Meta App, then send any `.docx`, `.xlsx`, `.pptx`, or `.pdf` file.

---

## Project structure

```
rupantar/
├── server.js                  # Express app — webhook + /file/:token routes
├── lib/
│   └── conversionMatrix.js    # Source-of-truth conversion options
├── services/
│   ├── messaging-meta.js      # Provider-agnostic interface (Meta impl)
│   ├── convert.js             # Gotenberg wrapper (buffer in → buffer out)
│   ├── session.js             # In-memory pending-upload store
│   └── ephemeralStore.js      # In-memory one-time file-serving store
├── docker-compose.yml
├── Dockerfile
├── .env.example
└── README.md
```



---

## No-storage design — how it works and why

### The constraint

Files are never written to disk, stored in a database, or sent to any third-party storage service. They exist only in server RAM, for the minimum time needed to relay the conversion result back to the user.

### The one unavoidable caveat

Meta's WhatsApp Cloud API expects media to be uploaded before sending, or fetched from a public URL. To attach a file to an outbound message, Meta fetches it from a public URL. This means the converted file has to be reachable at a URL for the few seconds Meta takes to retrieve it.

**How Rupantar handles this without any storage bucket:**

- After conversion, the converted `Buffer` is placed into a RAM-backed `Map` keyed by a random 48-character hex token (`crypto.randomBytes(24)`).
- A route `GET /file/:token` is exposed on the same server. The token is unguessable (192 bits of entropy), so no authentication beyond the token itself is needed.
- The buffer is **deleted immediately** after the first successful GET — one-time delivery.
- A background sweep runs every 30 seconds and deletes any token that has passed its 2-minute TTL, covering the case where Meta never fetches the file (failed delivery, network error).
- If the server restarts, everything in the map is gone — there is no durable copy anywhere.

This is the closest thing to true zero-storage that is technically possible while still using Twilio's media-fetch model.

### What you can truthfully state in a privacy policy

- Files are never written to disk.
- Files are never stored in a database or third-party storage service (no S3, no GCS, no Azure Blob).
- Files exist in server memory only, for at most ~2 minutes, purely to relay the conversion result back to the user.
- Files are deleted immediately after delivery, or automatically after a short timeout if delivery fails.
- No file content or filenames are included in server logs.

---

## Memory safety limits

- Maximum incoming file size: **15 MB** (matches WhatsApp's own media limit).
- Maximum concurrent in-flight upload sessions: **50** (configurable in `server.js`). Requests beyond this limit receive a "busy" message and are not processed.
- Sessions expire after **10 minutes** of inactivity; converted files expire after **2 minutes**.

---

## Adding new conversion formats

Edit `lib/conversionMatrix.js`:

```js
const CONVERSION_MATRIX = {
  xlsx: [
    { id: 'convert_pdf',  title: 'PDF' },
    { id: 'convert_docx', title: 'Word (.docx)' },
    { id: 'convert_csv',  title: 'CSV' }
    // add more here...
  ]
};
```

WhatsApp Reply Buttons are capped at **3 per message**. If a type's array grows past 3 options, `sendButtons()` in `services/messaging.js` will throw at runtime — that's your signal to switch that type to a List Message (which supports up to 10 options).

---

## License

MIT
