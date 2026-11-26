import { Conversation } from "@elevenlabs/client";
import { AGENT_ID, GREETING } from "./config.js";
import { findLinks, inlineCards, featureCard, historyRow } from "./links.js";
import { createDiamond } from "./diamond.js";
import { createSpeaker } from "./speech.js";

const el = (id) => document.getElementById(id);
const log = el("log");
const statusEl = el("status");
const dot = el("dot");
const input = el("input");
const composer = el("composer");
const muteBtn = el("mute");
const voiceBtn = el("voice");
const endBtn = el("end");

let conversation = null;
let kind = null; // "text" | "voice"
let muted = false; // the visitor's mic
let voiceMuted = false; // Ray's voice; kept across sessions
let agentSpeaking = false;
let pending = null; // typing indicator node
let lastTyped = ""; // last message sent as text, to skip its echo
let starting = false;
let generation = 0; // bumps on every start, so callbacks from an old session are ignored
let queuedPrompt = ""; // a question asked before the session was ready
let greeted = false; // this session's opening line has arrived
let greetingRow = null; // the opening line, once he has said it
let quietTimer = 0;

// A chip is a button: `label` is what it shows, `send` is what tapping it asks.
// He offers these two out loud at the end of his opening line, in his own
// words ("Wanna know who the hell we are? Or fancy takin' a gander at our
// favourite projects?"). The buttons keep their own wording.
const STARTERS = ["Who exactly are Rare Days?", "See projects we're most proud of"].map((q) => ({ label: q, send: q }));

function outputVolume() {
  if (!conversation || kind !== "voice") return 0;
  try {
    return conversation.getOutputVolume?.() ?? 0;
  } catch {
    return 0;
  }
}

// Each thing he says forms on screen out of particles (see speech.js).
const speaker = createSpeaker();

// Run something once he has finished speaking the current message, which is
// when the buttons come up. In a text chat there is no voice, so it runs when
// the paragraph has finished forming instead.
let onVoiceStop = null;
let heardSpeaking = false;
let voiceStopTimer = 0;

let speakingSince = 0; // when he started speaking the current message

function whenVoiceStops(formed, fn) {
  cancelVoiceStop();
  if (kind !== "voice") {
    formed.then(() => fn(0));
    return;
  }
  onVoiceStop = fn;
  heardSpeaking = agentSpeaking;
  speakingSince = agentSpeaking ? performance.now() : 0;
  // Safety net in case the speaking/listening signal never arrives.
  voiceStopTimer = setTimeout(() => runVoiceStop(0), 40000);
}

function runVoiceStop(spokeFor = 0) {
  const fn = onVoiceStop;
  cancelVoiceStop();
  fn?.(spokeFor);
}

function cancelVoiceStop() {
  clearTimeout(voiceStopTimer);
  clearTimeout(quietTimer);
  onVoiceStop = null;
}

// ---------- rendering ----------

function setStatus(text, state = "idle") {
  statusEl.textContent = text;
  dot.dataset.state = state;
}

// The newest message sits in the vertical centre of the chat; everything
// before it fades back. Scrolling up by hand brings the older ones back to
// full strength until the next message arrives.
let scrollTarget = 0;
let autoScrollUntil = 0;

function scrollDown() {
  const all = log.querySelectorAll(".msg");
  const latest = all[all.length - 1];
  if (!latest) return;
  log.classList.remove("browsing");
  let seen = false;
  for (const child of log.children) {
    if (child === latest) seen = true;
    child.classList.toggle("old", !seen);
  }
  const view = log.clientHeight;
  scrollTarget =
    latest.offsetHeight > view - 80
      ? latest.offsetTop - 40
      : latest.offsetTop + latest.offsetHeight / 2 - view / 2;
  autoScrollUntil = performance.now() + 900;
  log.scrollTo({ top: scrollTarget, behavior: "smooth" });
}

log.addEventListener(
  "scroll",
  () => {
    if (performance.now() < autoScrollUntil) return;
    log.classList.toggle("browsing", Math.abs(log.scrollTop - scrollTarget) > 30);
  },
  { passive: true },
);
window.addEventListener("resize", () => scrollDown());

function addMessage(role, text) {
  const row = document.createElement("div");
  row.className = `msg ${role}`;
  row.textContent = text;
  log.appendChild(row);
  scrollDown();
  return row;
}

function addNote(text) {
  const row = document.createElement("div");
  row.className = "note";
  row.textContent = text;
  log.appendChild(row);
  scrollDown();
}

function showTyping() {
  if (pending) return;
  pending = document.createElement("div");
  pending.className = "msg agent typing";
  pending.textContent = "…";
  log.appendChild(pending);
  scrollDown();
}

function hideTyping() {
  pending?.remove();
  pending = null;
}

function syncControls() {
  const live = Boolean(conversation);
  endBtn.hidden = !live;
  const inVoice = live && kind === "voice";
  muteBtn.hidden = !inVoice;
  muteBtn.setAttribute("aria-pressed", String(muted));
  muteBtn.title = muted ? "Unmute your microphone" : "Mute your microphone";
  muteBtn.setAttribute("aria-label", muteBtn.title);
  voiceBtn.hidden = !inVoice;
  voiceBtn.setAttribute("aria-pressed", String(voiceMuted));
  voiceBtn.title = voiceMuted ? "Unmute Ray's voice" : "Mute Ray's voice";
  voiceBtn.setAttribute("aria-label", voiceBtn.title);
}

// ---------- showcase (right panel) ----------

const showcase = el("showcase");
const featuredEl = el("featured");
const historyEl = el("history");
const historyList = el("historyList");
let featured = []; // items from the latest reply that named something
let history = []; // everything shown before, newest first

// Links come up one at a time, each when he reaches it in what he's saying
// (see the cue below). The first link of a reply moves the previous reply's
// cards down into the history list.
let linksOpen = false; // this reply has shown at least one link
let inlineRow = null; // small cards in the chat, for narrow screens

function beginLinks() {
  linksOpen = false;
  inlineRow = null;
}

function revealLink(item) {
  if (!linksOpen) {
    linksOpen = true;
    history = [...featured, ...history];
    featured = [];
    featuredEl.replaceChildren();
  }
  if (featured.some((i) => i.key === item.key)) return;
  history = history.filter((i) => i.key !== item.key);
  featured.push(item);
  showcase.hidden = false;
  document.body.classList.add("has-showcase");
  featuredEl.dataset.count = String(featured.length);
  featuredEl.appendChild(featureCard(item));
  historyEl.hidden = !history.length;
  historyList.replaceChildren(...history.map(historyRow));
  // Inline cards for narrow screens; CSS hides them when the panel is visible.
  if (!inlineRow) {
    inlineRow = inlineCards([]);
    log.appendChild(inlineRow);
  }
  inlineRow.appendChild(inlineCards([item]).firstChild);
}

// ---------- chips: starters and his closing questions ----------

let chips = null; // the row of buttons under the latest reply
const asked = new Set(); // questions already asked, so chips don't repeat them

function addChip(item) {
  if (!item?.label || asked.has(item.send.toLowerCase())) return;
  if (!chips) {
    chips = document.createElement("div");
    chips.className = "chips";
    log.appendChild(chips);
  }
  const b = document.createElement("button");
  b.type = "button";
  b.className = "chip";
  b.textContent = item.label;
  b.addEventListener("click", () => ask(item.send, "tap"));
  chips.appendChild(b);
}

function showChips(items) {
  hideChips();
  items.slice(0, 2).forEach(addChip);
}

function hideChips() {
  chips?.remove();
  chips = null;
}

// Every reply ends "lead-in? question? question?" (see the agent's prompt). He
// says all of it, but only the answer is shown as text: the two questions
// become the buttons and the lead-in is heard, not shown.
function splitReply(text) {
  const parts = text.match(/[^.?!]+[.?!]+["')\]]*\s*|[^.?!]+$/g) ?? [text];
  let i = parts.length;
  while (i > 0 && /\?["')\]]*\s*$/.test(parts[i - 1])) i--;
  const tail = parts.slice(i).map((s) => s.trim());
  if (i === 0 || tail.length < 2) return { body: text, lead: "", questions: [] };
  return {
    body: parts.slice(0, i).join("").trim(),
    lead: tail.slice(0, -2).join(" "),
    questions: tail.slice(-2),
  };
}

// A closing question as a button: shown without a leading "Or", and tapping it
// sends "Yes: <the thing he offered>".
function questionChip(question) {
  const plain = question.replace(/^or,?\s+/i, "");
  const label = plain.charAt(0).toUpperCase() + plain.slice(1);
  const offer = plain
    .replace(/\?+$/, "")
    .replace(/^(wanna|want to|want|fancy|need|curious|care to|shall i|shall we|should i)\s+(to\s+)?((hear|know|see)\s+)?(about\s+)?/i, "")
    .trim();
  return { label, send: `Yes: ${offer || plain}` };
}

// Stand-ins for a reply that came without closing questions. In his voice,
// but not spoken.
function fallbackFollowups(links) {
  return [
    ...links
      .filter((l) => l.kind === "case")
      .map((l) => ({ label: `Want more on ${l.name}?`, send: `Tell me more about ${l.name}` })),
    { label: "Want to know what makes us different?", send: "What makes Rare Days different?" },
    { label: "Shall I show you some work?", send: "Show me projects you're proud of" },
    { label: "Want to hear how we work?", send: "How do you work with clients?" },
  ];
}

// Each button fades in as he reads its question. There are no per-word
// timings on this connection, so the moment is estimated from how many
// characters come before the question and how fast he speaks. The speaking
// rate is re-measured from every message he finishes.
let speechRate = 13; // characters per second
let cue = null; // the reply being spoken: { items, before, total, links, t0, timers, shown, linked }

function cueReply(items, before, total, links = []) {
  clearCue();
  beginLinks();
  cue = { items, before, total, links, t0: 0, timers: [], shown: 0, linked: 0 };
  if (kind === "voice" && agentSpeaking) startCue();
}

// He has started speaking: line the buttons up against the clock.
function startCue() {
  if (!cue || cue.t0) return;
  cue.t0 = performance.now();
  cue.items.forEach((item, n) => {
    cue.timers.push(
      setTimeout(() => {
        if (!cue) return;
        addChip(item);
        cue.shown = n + 1;
        scrollDown();
      }, (cue.before[n] / speechRate) * 1000),
    );
  });
  // Cards for the projects and articles he names, each as he gets to it.
  cue.links.forEach((link, n) => {
    cue.timers.push(
      setTimeout(() => {
        if (!cue) return;
        revealLink(link);
        cue.linked = n + 1;
      }, (link.at / speechRate) * 1000),
    );
  });
}

// He has stopped: show any button that hasn't come up yet and learn his pace.
function endCue(links, spokeFor) {
  if (!cue) return;
  const { items, shown, total, t0 } = cue;
  flushLinks();
  if (t0 && spokeFor > 1.5) {
    const measured = Math.min(24, Math.max(8, total / spokeFor));
    speechRate = speechRate * 0.4 + measured * 0.6;
  }
  clearCue();
  const rest = items.slice(shown);
  rest.forEach((item, n) => setTimeout(() => addChip(item), n * 350));
  if (!items.length && links) setTimeout(() => showChips(fallbackFollowups(links)), 300);
  setTimeout(scrollDown, rest.length * 350 + 50);
}

// Show any cards he hasn't reached yet (he stopped, or was cut off).
function flushLinks() {
  if (!cue) return;
  cue.links.slice(cue.linked).forEach(revealLink);
  cue.linked = cue.links.length;
}

function clearCue() {
  cue?.timers.forEach(clearTimeout);
  cue = null;
}

// The visitor said or typed something: clear the buttons until the next reply.
function onUserTurn(text) {
  asked.add(text.trim().toLowerCase());
  flushLinks();
  clearCue();
  hideChips();
  cancelVoiceStop();
  speaker.finish(); // they cut in: put the text up now
}

// ---------- asking ----------

// Ray has a one-off opening line for the visitor's first button tap and another
// for the first question they type. He can't tell a typed message from a spoken
// one, so the page tells him, with a note sent just ahead of the question. The
// lines themselves live in his prompt ("One-off opening lines").
const OPENERS = {
  tap: "Well I gave you that one for free, but I'll let you off. We're just greasing the wheels.",
  typed: "Ah, great question. I can tell you're a diamond geezer, like me.",
};
const openerUsed = { tap: false, typed: false };
let queuedHow = "";

function openerNote(how) {
  if (!OPENERS[how] || openerUsed[how]) return "";
  openerUsed[how] = true;
  return `OPENER: begin your next reply with exactly this line, as its own first paragraph, then answer: "${OPENERS[how]}"`;
}

// Send a question as the visitor, starting a session first if there isn't one.
// `how` is "tap" for a button or "typed" for the message box.
function ask(text, how = "") {
  onUserTurn(text);
  addMessage("user", text);
  showTyping();
  if (conversation && greeted) return deliver(text, false, how);
  queuedPrompt = text;
  queuedHow = how;
  if (!conversation && !starting) start(kind ?? "voice");
}

// In a voice session the server can hold a tapped or typed question back if it
// thinks the visitor is mid-sentence (room noise or speaker echo on the mic),
// and then only answers when its 60-second silence timer fires. Two guards:
// the mic is paused around the send so nothing keeps that phantom turn open,
// and if no answer has started after a few seconds the question is sent again.
let micHold = 0;
let resendTimer = 0;

function deliver(text, isRetry = false, how = "") {
  lastTyped = text;
  clearTimeout(resendTimer);
  const note = isRetry ? "" : openerNote(how);
  if (note) conversation.sendContextualUpdate(note);
  if (kind === "voice" && !muted) {
    conversation.setMicMuted(true);
    clearTimeout(micHold);
    micHold = setTimeout(releaseMic, 4000);
  }
  conversation.sendUserMessage(text);
  if (!isRetry) {
    const gen = generation;
    resendTimer = setTimeout(() => {
      if (gen !== generation || !conversation || !pending) return;
      console.warn("[guide] no answer after 6s, sending the question again");
      deliver(text, true);
    }, 6000);
  }
}

// Give the mic back once he has started answering (or the hold runs out).
function releaseMic() {
  clearTimeout(micHold);
  micHold = 0;
  if (conversation && kind === "voice" && !muted) conversation.setMicMuted(false);
}

function answered() {
  clearTimeout(resendTimer);
  if (micHold) releaseMic();
}

function flushQueued() {
  if (!queuedPrompt || !conversation || !greeted) return;
  const text = queuedPrompt;
  queuedPrompt = "";
  deliver(text, false, queuedHow);
}

// ---------- session ----------

async function start(nextKind) {
  if (starting) return;
  starting = true;
  try {
    await stop({ silent: true });

    kind = nextKind;
    muted = false;
    greeted = false;
    const gen = ++generation;
    const stale = () => gen !== generation;
    setStatus("Connecting…", "connecting");

    if (nextKind === "voice") {
      // Ask for the mic up front so a denial gives a clear message.
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop());
    }

    conversation = await Conversation.startSession({
      agentId: AGENT_ID,
      textOnly: nextKind === "text",
      connectionType: nextKind === "text" ? "websocket" : "webrtc",

      onConnect: () => {
        if (stale()) return;
        setStatus("", "live");
        agentSpeaking = false;
        if (voiceMuted) conversation?.setVolume({ volume: 0 });
      },

      onDisconnect: (details) => {
        if (stale()) return;
        conversation = null;
        hideTyping();
        speaker.finish();
        const why =
          details?.reason === "error"
            ? `Disconnected: ${details.message}.`
            : details?.reason === "agent"
              ? "The agent ended the session."
              : "Session ended.";
        addNote(`${why} Ask something to start again.`);
        setStatus("Not connected", details?.reason === "error" ? "error" : "idle");
        syncControls();
      },

      onMessage: ({ message: raw, role }) => {
        if (stale() || !raw) return;
        // Drop the voice model's delivery tags, e.g. "[slow]", from the transcript.
        const message = raw.replace(/\[[a-z][a-z ,'-]{0,30}\]\s*/gi, "").trim();
        if (!message) return;
        if (role === "user") {
          // Silence sometimes comes through as a transcript of just dots.
          if (!/[\p{L}\p{N}]/u.test(message)) return;
          // Typed and tapped questions are already on screen; only show speech.
          if (message === lastTyped) {
            lastTyped = "";
            return;
          }
          onUserTurn(message);
          addMessage("user", message);
          return;
        }
        if (!greeted) {
          greeted = true;
          // Nothing is on screen until he speaks. After a restart the opening
          // line is already there, so it isn't shown twice.
          if (!greetingRow) {
            // The opening line ends with his two spoken offers. Only the line
            // itself is shown; each starter button fades in as he reads its offer.
            const { body, lead, questions } = splitReply(message);
            greetingRow = addMessage("agent", body);
            const first = body.length + 1 + (lead ? lead.length + 1 : 0);
            const before = STARTERS.map((_, n) =>
              questions.length === 2 ? first + (n ? questions[0].length + 1 : 0) : message.length,
            );
            cueReply(STARTERS, before, message.length);
            whenVoiceStops(speaker.say(greetingRow, body), (spokeFor) => endCue(null, spokeFor));
          }
          // In voice, wait for the greeting to finish playing (see onModeChange).
          if (kind === "text") flushQueued();
          return;
        }
        hideTyping();
        answered();
        // Only the answer is shown; the closing questions become the buttons.
        const { body, lead, questions } = splitReply(message);
        const row = addMessage("agent", body);
        const links = findLinks(message);
        const items = questions.map(questionChip);
        const first = body.length + 1 + (lead ? lead.length + 1 : 0);
        const before = questions.map((_, n) => first + (n ? questions[0].length + 1 : 0));
        cueReply(items, before, message.length, links);
        whenVoiceStops(speaker.say(row, body), (spokeFor) => {
          if (!stale()) endCue(links, spokeFor);
        });
      },

      onModeChange: ({ mode }) => {
        if (stale() || kind !== "voice" || !conversation) return;
        agentSpeaking = mode === "speaking";
        dot.dataset.state = agentSpeaking ? "speaking" : "live";
        clearTimeout(quietTimer);
        if (agentSpeaking) {
          heardSpeaking = true;
          speakingSince ||= performance.now();
          startCue();
        }
        if (mode === "listening") {
          flushQueued();
          // He has stopped. Give short pauses a moment before the buttons.
          if (onVoiceStop && heardSpeaking) {
            const stoppedAt = performance.now();
            quietTimer = setTimeout(() => {
              if (!stale()) runVoiceStop(speakingSince ? (stoppedAt - speakingSince) / 1000 : 0);
            }, 700);
          }
        }
      },

      onError: (message, context) => {
        if (stale()) return;
        console.error("[agent error]", message, context);
        hideTyping();
        addNote(`Error: ${message}`);
        setStatus("Error", "error");
      },
    });
  } catch (err) {
    console.error(err);
    conversation = null;
    const denied = err?.name === "NotAllowedError" || err?.name === "NotFoundError";
    if (denied && nextKind === "voice") {
      addNote("No microphone access, so this is a text chat. Allow the mic and reload to talk.");
      starting = false;
      return start("text");
    }
    hideTyping();
    speaker.finish();
    // No voice to wait for: put the opening line and buttons up plainly.
    if (!greetingRow) {
      greetingRow = addMessage("agent", GREETING);
      showChips(STARTERS);
    }
    addNote(`Could not connect: ${err?.message ?? err}`);
    setStatus("Not connected", "error");
  } finally {
    starting = false;
    // onConnect can fire before `conversation` is assigned, so apply it here too.
    if (conversation && kind === "voice" && voiceMuted) conversation.setVolume({ volume: 0 });
    syncControls();
  }
}

async function stop({ silent = false } = {}) {
  const current = conversation;
  if (!current) return;
  conversation = null;
  hideTyping();
  try {
    await current.endSession();
  } catch (err) {
    if (!silent) console.error(err);
  }
  syncControls();
}

// ---------- events ----------

composer.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = input.value.trim();
  if (!text) return;
  input.value = "";
  ask(text, "typed");
});

// In voice mode, typing tells the agent to hold off speaking.
input.addEventListener("input", () => {
  if (kind === "voice" && conversation) conversation.sendUserActivity();
});

muteBtn.addEventListener("click", () => {
  if (!conversation || kind !== "voice") return;
  muted = !muted;
  clearTimeout(micHold);
  micHold = 0;
  conversation.setMicMuted(muted);
  syncControls();
});

voiceBtn.addEventListener("click", () => {
  voiceMuted = !voiceMuted;
  if (conversation && kind === "voice") conversation.setVolume({ volume: voiceMuted ? 0 : 1 });
  syncControls();
});

endBtn.addEventListener("click", () => stop());

window.addEventListener("beforeunload", () => {
  conversation?.endSession();
});

// ---------- boot: the session starts itself; nothing shows until he speaks ----------

syncControls();
start("voice");

// The diamond swells a little while the agent is speaking.
createDiamond(el("diamond"), { energy: outputVolume });
