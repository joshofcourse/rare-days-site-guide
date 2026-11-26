// End-to-end voice check. Drives a real headless Chrome over the DevTools
// protocol: loads the app in a WebRTC voice session with a fake microphone,
// clicks the second starter when it appears, and prints what the page shows
// over time. Uses real ElevenLabs credits (one short voice session).
//
//   node scripts/voice-test.mjs http://localhost:5174/ 40000 /tmp/rd-chrome-profile /path/to/mic.wav
//
// Arguments: page URL, how long to watch (ms), a throwaway Chrome profile
// folder, and a WAV file to play as the microphone (48 kHz mono 16-bit).
import { spawn } from "child_process";
const url = process.argv[2], waitMs = Number(process.argv[3] || 40000);
const chrome = spawn("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", ["--headless=new", "--remote-debugging-port=9333", "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--use-file-for-fake-audio-capture=" + process.argv[5], "--autoplay-policy=no-user-gesture-required", "--enable-unsafe-swiftshader", "--window-size=1400,900", "--user-data-dir=" + process.argv[4], "about:blank"], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let targets;
for (let i = 0; i < 40; i++) { await sleep(250); try { targets = await (await fetch("http://127.0.0.1:9333/json")).json(); if (targets.length) break; } catch {} }
const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0; const pending = new Map(); const logs = [];
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); }
  if (m.method === "Runtime.consoleAPICalled" && ["error", "warning"].includes(m.params.type)) logs.push(m.params.type + ": " + m.params.args.map((a) => a.value ?? a.description ?? "").join(" ").slice(0, 300));
  if (m.method === "Runtime.exceptionThrown") logs.push("EXCEPTION: " + (m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text).slice(0, 500)); };
const send = (method, params = {}) => new Promise((r) => { pending.set(++id, r); ws.send(JSON.stringify({ id, method, params })); });
const evaluate = async (expression) => (await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })).result?.value;
await send("Runtime.enable"); await send("Page.enable");
await send("Page.navigate", { url });
const t0 = Date.now(); let clicked = 0; const timeline = [];
const snap = () => evaluate(`JSON.stringify({dot: document.getElementById("dot").dataset.state, status: document.getElementById("status").textContent, rows: [...document.getElementById("log").children].map(e => e.className.split(" ").slice(0,3).join(".") + ": " + e.textContent.slice(0, 90))})`);
let lastSnap = "";
while (Date.now() - t0 < waitMs) {
  await sleep(500);
  const s = await snap().catch(() => "");
  if (s && s !== lastSnap) { lastSnap = s; timeline.push(((Date.now() - t0) / 1000).toFixed(1) + "s " + s); }
  if (!clicked && (await evaluate(`!!document.querySelector(".chip:nth-child(2)")`))) { clicked = Date.now(); await evaluate(`document.querySelector(".chip:nth-child(2)").click()`); timeline.push(((Date.now() - t0) / 1000).toFixed(1) + "s CLICKED"); }
}
console.log(timeline.join("\n")); console.log("LOGS:\n" + logs.join("\n"));
chrome.kill(); process.exit(0);
