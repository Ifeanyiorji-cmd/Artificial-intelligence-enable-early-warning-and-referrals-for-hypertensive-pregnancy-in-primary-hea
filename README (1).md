# AMEWRIN backend and frontend

A minimal Express + Postgres API that gives the AMEWRIN frontend real accounts,
saved assessment history, and a shared facility directory. It implements
exactly the endpoints `index.html` already calls, so no frontend changes are
needed beyond the `API_BASE` URL.

## Why Postgres, not SQLite
The original version used SQLite, stored as a file inside the app's own
container. On Render's free tier (and most free-tier hosts), that disk is
**ephemeral** — every restart (inactivity spin-down, redeploy, crash) wipes it,
which deletes every account and makes previously-correct PINs fail with
"incorrect password," because the account itself no longer exists. Postgres
lives in its own separate, persistent database, so it survives restarts.

## What's inside
- `server.js` — the whole API (register/login, assessments, facilities)
- JWT-based auth (phone + PIN, matching the app's sign-in modal)
- Tables are created automatically on first boot (`CREATE TABLE IF NOT EXISTS`)

## 1. Get a free Postgres database
Pick one (all have a free tier that persists indefinitely, not just for a trial period):

- **Neon** (neon.tech) — free tier, serverless Postgres. Create a project, copy the connection string.
- **Supabase** (supabase.com) — free tier, includes Postgres. Project Settings → Database → Connection string (use the "Session pooler" URI).
- **Render Postgres** — works too, but Render's free Postgres instances expire after 90 days; fine for testing, not for a real pilot.

Either way you'll end up with a connection string that looks like:
```
postgresql://user:password@host:5432/dbname?sslmode=require
```

## 2. Run it locally first (optional but recommended)
```bash
cd amewrin-backend
npm install
DATABASE_URL="postgresql://..." JWT_SECRET=some-long-random-string npm start
```
It starts on `http://localhost:3000`. Test it:
```bash
curl http://localhost:3000/
```

## 3. Deploy the API
### Option A — Render (recommended)
1. Push this `amewrin-backend` folder to a GitHub repo.
2. On render.com → **New → Web Service** → connect the repo.
3. Build command: `npm install`. Start command: `npm start`.
4. Add environment variables:
   - `DATABASE_URL` → the Postgres connection string from step 1
   - `JWT_SECRET` → any long random string
   - `CORS_ORIGIN` → your frontend's URL (e.g. `https://yourname.github.io`), or `*` while testing
5. Deploy. Render gives you a URL like `https://amewrin-backend.onrender.com`.

**Free tier note:** the free web service still spins down after inactivity and
takes ~30–60s to wake — that's just cold-start latency now, not data loss.
Your accounts and history are safe in Postgres either way.

### Option B — Fly.io
Same idea — `fly launch`, then:
```bash
fly secrets set DATABASE_URL="postgresql://..." JWT_SECRET=some-long-random-string CORS_ORIGIN=https://your-frontend-url
fly deploy
```

### If you go back to Railway
Set the same three env vars (`DATABASE_URL`, `JWT_SECRET`, `CORS_ORIGIN`),
build with `npm install`, start with `npm start`. Double-check the service's
public domain is enabled (Settings → Networking → Generate Domain).

## 4. Point the frontend at it
In `index.html`:
```js
const API_BASE = "https://your-backend-url";
```
No trailing slash. That's the only frontend change needed.

## Frontend (index.html)

The frontend is one self-contained file, `index.html` (about 120 KB). There is no build step, no framework and no npm install. Open it in a browser or host it as a static file (GitHub Pages, Render static site, any web server).

### What it does
1. **Triage form.** The health worker enters age, antenatal history, vital signs, proteinuria, symptoms and risk factors. Mean arterial pressure, pulse pressure and shock index are calculated automatically from the readings.
2. **Risk assessment.** The app returns one of four classes (Normal, Gestational hypertension, Pre-eclampsia, Eclampsia) with a confidence value, class probabilities, a referral probability, a gauge showing mean arterial pressure, and plain-language recommendations. A severe-range blood pressure (160/110 mmHg or above) is always flagged as an emergency, whatever the model says.
3. **Referral.** "Find nearest referral facility" ranks the built-in facility list by distance from the phone's location (Haversine formula). The worker can add a facility that is not listed, then press "Open SMS to send referral", which opens the phone's own messaging app with the number and message already filled in. The worker reviews and sends it.
4. **Accounts and history.** Sign in with phone number and PIN to save assessments and load them later. This is the only part that needs the backend.

### How the prediction works
The trained models are embedded in the file as a `MODEL` object (standardisation values and logistic regression coefficients). The browser computes the prediction itself, so the assessment works with no internet connection. The diagnosis model is trained on the full 52,717-record dataset and the referral model on the 717 Abia-linked records.

### Interface
- **Languages:** English and Igbo, switched from the menu. Clinical terms and the SMS text stay in English so they are not misread. The Igbo wording has not been reviewed by a native-speaking clinician.
- **Theme:** light and dark mode, with the choice remembered on the device.
- **Menu:** account, language and theme are grouped under one menu button in the header.
- **Layout:** responsive, designed for a phone first. Font is Instrument Sans (loaded from Google Fonts, with system fonts as the fallback when offline).
- **Feedback:** toast messages for confirmations and errors, a bottom sheet on phones for sign-in and the facility form, and reduced-motion support.

### Settings you may need to change
| Setting | Where | Notes |
|---|---|---|
| `API_BASE` | one line in the script block | URL of your deployed backend, no trailing slash. Leave it as is to use the existing Render service. |
| `FACILITIES` | array in the script block | Built-in facility list with coordinates and phone numbers. Add or correct numbers here. Facilities added by users are stored through the backend. |
| `amewrin_theme`, `amewrin_lang` | browser `localStorage` | Remembered theme and language. Nothing else is stored in the browser. |

### Limits
- SMS opens the phone's messaging app. Sending automatically would need a paid SMS gateway.
- Accounts, history and the shared facility directory need the backend to be running. The prediction does not.
- Predictions are tied to the training data and have not been validated against clinician diagnoses, so the tool supports triage decisions and does not replace clinical judgement.

## Notes
- PINs are hashed with bcrypt before storage — never stored in plain text.
- `ssl: { rejectUnauthorized: false }` in `server.js` is there because most
  free managed Postgres providers use certs that Node won't otherwise trust
  automatically; this is standard practice for these providers, not a security
  downgrade of your data in transit.
