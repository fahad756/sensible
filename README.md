# Sensible

Sensible is a real-time, paired interview practice dashboard. A desktop producer captures a permitted practice session, detects spoken or on-screen questions, sends them to the server-side answer engine, and streams concise answer drafts to a paired mobile viewer.

Use it only for mock interviews, coaching, accessibility support, or interviews where live assistance is explicitly permitted.

## Features

- Desktop onboarding context for role, projects, and company/session notes.
- Screen capture with system-audio track detection and clear browser edge-case handling.
- Sensible screen scan for visible on-screen questions.
- Sensible audio scan for screen-share audio questions.
- No microphone capture path: the frontend does not call `getUserMedia` or Web Speech APIs.
- Socket.IO room pairing with QR code and room ID.
- Mobile-optimized answer card with haptic notification on new responses.
- Server-side answer engine integration using `@google/genai`; no API key is shipped to the browser.

## Local Setup

```bash
npm install
copy .env.example .env
npm run dev
```

Edit `.env` and set `GEMINI_API_KEY`. The key from a chat, ticket, screenshot, or public repo should be considered compromised and rotated before production use.

Open the app at:

```text
http://localhost:5173
```

For phone pairing on the same Wi-Fi, open the desktop app using your computer's LAN IP, for example `http://192.168.1.20:5173`, then scan the QR code.

## Production

```bash
npm install
npm run build
npm start
```

Set these environment variables in your host:

```text
GEMINI_API_KEY=...
GEMINI_MODEL=gemini-flash-lite-latest
GEMINI_FALLBACK_MODEL=gemini-2.5-flash
PORT=8787
PUBLIC_APP_URL=https://your-domain.example
```

Production screen capture requires HTTPS. `localhost` is allowed by browsers for local development.

## Browser Notes

- `getDisplayMedia` support is strongest in Chrome and Edge.
- Screen-share audio availability depends on OS, browser, and what the user shares. Chrome tab sharing with "Share audio" is usually the most reliable path; entire-screen audio support varies.
- The app intentionally does not use microphone APIs. It only uses the video and optional audio tracks returned by `navigator.mediaDevices.getDisplayMedia(...)`.
- Mobile haptics require browser support for `navigator.vibrate`.
