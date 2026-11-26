# Rare Days site guide

A local chat and voice front end for the ElevenLabs agent
"Rare Days — Site Guide (local test)". Nothing here touches Webflow or the
live site, and it is separate from the existing "February" agent.

## Run it

Needs Node 20.19+ or 22.12+.

```
npm install
npm run dev
```

Open the URL Vite prints (http://localhost:5173). Voice needs microphone
access, which browsers only allow on localhost or HTTPS, so open it through
the dev server and not as a file.

## What's in here

- `index.html` — markup
- `src/main.js` — session logic: start/stop, text and voice modes, transcript
- `src/style.css` — all styling, driven by the CSS variables at the top
- `src/config.js` — the agent ID
- `src/diamond.js` — the particle diamond
- `src/speech.js` — forms each reply out of WebGL particles rising from below
- `src/links.js` — finds named case studies and articles, builds their cards
- `src/insights.js` — insights articles the agent can link to: title, link, image
- `src/work.js` — the case studies that can appear as cards: name, match terms,
  one-line description, link and thumbnail

## How it works

- The page starts a WebRTC voice session on load. Every page load therefore
  uses ElevenLabs credits. The browser asks for the mic on first visit.
- You can type while in voice. Mute turns the mic off without ending the session.
- If the browser has no mic access, the app falls back to a text-only session
  over WebSocket.
- The agent does not carry memory between sessions.
- The particle diamond on the right (`src/diamond.js`) turns on its own, leans
  toward the pointer, scatters particles near it, and swells slightly while the
  agent speaks.
- There is no API key in this project. The agent ID in `src/config.js` is all
  the browser needs. The agent only accepts sessions from the published page and
  from localhost, and has a daily conversation limit, both set in ElevenLabs.

## Links panel

When a reply names a client or an insights article, the right-hand panel shows
it as a large card with its image and a link, stacked vertically. Cards from earlier replies drop
into an "Earlier in this chat" list underneath, newest first, so the
conversation leaves a trail of links. The diamond fades back while the panel is
showing. On narrow screens the panel is hidden and small cards appear in the
chat instead.

Matching happens in the browser (`src/links.js`), so the agent can't link to a
page that isn't in `src/work.js` (19 case studies, matched on client names) or
`src/insights.js` (44 articles, matched on title). At most three per reply.

Thumbnails load from the raredays.com CDN. Airbnb, Notion, Skool and Ziff Davis
have no project image on the site, so their cards show the name instead.

## Starters and follow-up buttons

The page shows the agent's opening line straight away (`GREETING` in
`src/config.js`, keep it the same as the first message in ElevenLabs) and
starts a voice session by itself. Two small buttons sit under the greeting:
Who exactly are Rare Days?, and See projects we're most proud of. He reads
both offers aloud at the end of his opening line. The text box
placeholder reads "Got a question about your business?".

Every answer ends with the agent saying a short lead-in and two questions.
The page shows only the answer as text and turns the two questions into
buttons, each fading in as he reads it. Tapping one sends "Yes: <what he
offered>". If a reply has no closing questions, the app shows its own
(`fallbackFollowups` in `src/main.js`), which are not spoken.

There is no Start again button. After a session ends, asking anything (typing
or tapping a button) starts a new one.

## Changing the agent

The prompt, voice, knowledge base and guardrails live in ElevenLabs, not in
this code. Edit them in the ElevenLabs dashboard or ask Claude to. Changes
apply to the next session with no rebuild.

The knowledge base is a crawl of raredays.com (capabilities, work, insights,
culture, summits) set to re-sync weekly. New pages added to the site are not
picked up automatically; they need adding to the crawl.

## Cost

Every session draws ElevenLabs credits from the Rare Days workspace. Voice
costs far more than text. End sessions when you're done testing.
