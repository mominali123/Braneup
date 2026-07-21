# Brane

Brand-identity generator. Static frontend + one Vercel serverless function
that calls the Groq API, so the API key never reaches the browser.

## Project structure

```
index.html          landing page
app.html            the generator app (calls /api/generate)
privacy-policy.html
terms-and-conditions.html
api/generate.js     serverless function — holds the Groq key + prompt
package.json
```

`server.js`/Express is gone — Vercel serves the `.html` files as static
assets and turns anything in `/api` into its own serverless endpoint
automatically. Nothing else to configure.

## 1. Push to GitHub

```bash
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/<you>/<repo>.git
git push -u origin main
```

## 2. Import into Vercel

1. Go to https://vercel.com/new
2. Import the GitHub repo
3. Framework preset: "Other" (no build step needed) — leave build/output settings blank
4. **Before deploying**, add the environment variable below

## 3. Add your Groq API key

In the Vercel project → **Settings → Environment Variables**:

| Name | Value | Environments |
|---|---|---|
| `GROQ_API_KEY` | *your Groq key* | Production, Preview, Development |

Get a key at https://console.groq.com/keys. Save, then deploy (or
redeploy if you already deployed once).

## 4. Rotate the old key

The previous version of `app.html` had a real Groq key hardcoded in the
page source, visible to anyone who viewed the file. Treat that key as
burned — revoke it in the Groq console and use a freshly generated one
for `GROQ_API_KEY` above, even if it's the only change you make.

## How it works

- The browser submits the brief to `POST /api/generate` on your own domain.
- `api/generate.js` reads `GROQ_API_KEY` from the server environment,
  calls Groq, and returns the parsed brand JSON.
- The key and system prompt never leave the server.

## Local development

```bash
npm i -g vercel
vercel dev
```

This runs the static files and the `/api` function together locally,
using a `.env` file (add `GROQ_API_KEY=...` there) or Vercel-linked env vars.
