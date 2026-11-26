// Finds the case studies and insights articles an agent reply names.
// Matching happens here in the browser, so the agent can never link to a page
// that isn't in work.js or insights.js.
import { WORK } from "./work.js";
import { INSIGHTS } from "./insights.js";

const escapeRe = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Case studies: case-sensitive whole-word match on each project's terms.
const CASES = WORK.map((item) => ({
  item: {
    key: `case:${item.slug}`,
    kind: "case",
    name: item.name,
    line: item.line,
    url: item.url,
    thumb: item.thumb,
  },
  find: (text) =>
    text.search(new RegExp(`(?<![A-Za-z0-9])(?:${item.match.map(escapeRe).join("|")})(?![A-Za-z0-9])`)),
}));

// Insights: the title must appear in the reply. Compared loosely (case,
// punctuation and curly quotes ignored) because spoken replies rarely keep them.
const loose = (str) =>
  str
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[^a-z0-9' ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const ARTICLES = INSIGHTS.map((a) => {
  const title = loose(a.title);
  return {
    item: {
      key: `insight:${a.url}`,
      kind: "insight",
      name: a.title,
      line: "",
      url: a.url,
      thumb: a.thumb,
    },
    find: (_text, looseText) => {
      const at = ` ${looseText} `.indexOf(` ${title} `);
      return at === -1 ? -1 : at;
    },
  };
});

// Site pages worth showing. The capabilities page appears whenever he says the
// word "capabilities", which his prompt has him do when describing how we work.
const PAGES = [
  {
    item: {
      key: "page:capabilities",
      kind: "page",
      name: "Capabilities",
      line: "Strategy, design and engineering, from product definition to launch",
      url: "https://www.raredays.com/capabilities",
      thumb: "https://cdn.prod.website-files.com/675b10e0b07e3ae5a68125b0/67e30e36679d089e505969bc_og-capab.webp",
    },
    find: (text) => text.search(/\bcapabilities\b/i),
  },
  // The culture page appears when he talks about our culture or values: in the
  // "Who exactly are Rare Days?" answer, and when he points someone at jobs.
  {
    item: {
      key: "page:culture",
      kind: "page",
      pill: "Who we are",
      name: "Culture",
      line: "The team, how we work together, and what we believe",
      url: "https://www.raredays.com/culture",
      thumb: "https://cdn.prod.website-files.com/675b10e0b07e3ae5a68125b0/67e30e3667447e2f7edb045a_og-culture.webp",
    },
    // He doesn't always say "culture", so talk of our values counts too.
    find: (text) => text.search(/\bculture\b|\bvalues\b/i),
  },
];

const MAX_PER_REPLY = 3;

// Links a reply names, in the order they are mentioned. Each carries `at`, how
// far into the reply it is mentioned, so it can be shown when he gets there.
export function findLinks(text) {
  const looseText = loose(text);
  return [...CASES, ...ARTICLES, ...PAGES]
    .map(({ item, find }) => ({ item, at: find(text, looseText) }))
    .filter((hit) => hit.at !== -1)
    .sort((a, b) => a.at - b.at)
    .slice(0, MAX_PER_REPLY)
    .map((hit) => ({ ...hit.item, at: hit.at }));
}

export const LABELS = { case: "Case study", insight: "Insights", page: "How we work" };

// The image area of a card, falling back to the name when there is no image.
export function media(item, className) {
  const box = document.createElement("div");
  box.className = className;
  const fallback = () => {
    box.classList.add("empty");
    box.textContent = item.name;
  };
  if (!item.thumb) {
    fallback();
    return box;
  }
  const img = document.createElement("img");
  img.src = item.thumb;
  img.alt = "";
  img.loading = "lazy";
  img.addEventListener("error", () => {
    img.remove();
    fallback();
  });
  box.appendChild(img);
  return box;
}

function link(item, className) {
  const a = document.createElement("a");
  a.className = className;
  a.href = item.url;
  a.target = "_blank";
  a.rel = "noopener";
  return a;
}

function text(tag, className, value) {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = value;
  return node;
}

// Small cards inside the chat. Only shown on narrow screens, where the
// showcase panel has no room.
export function inlineCards(items) {
  const row = document.createElement("div");
  row.className = "cards";
  for (const item of items) {
    const card = link(item, "card");
    const body = document.createElement("div");
    body.className = "card-body";
    body.appendChild(text("span", "card-name", item.name));
    if (item.line) body.appendChild(text("span", "card-line", item.line));
    body.appendChild(text("span", "card-cta", `${(item.pill ?? LABELS[item.kind])} ↗`));
    card.append(media(item, "card-media"), body);
    row.appendChild(card);
  }
  return row;
}

// A large card for the showcase panel.
export function featureCard(item) {
  const card = link(item, `feature ${item.kind}`);
  const body = document.createElement("div");
  body.className = "feature-body";
  body.appendChild(text("span", "feature-kind", (item.pill ?? LABELS[item.kind])));
  body.appendChild(text("span", "feature-name", item.name));
  if (item.line) body.appendChild(text("span", "feature-line", item.line));
  card.append(media(item, "feature-media"), body);
  return card;
}

// A compact row for the history list.
export function historyRow(item) {
  const row = link(item, "past");
  row.append(
    media(item, "past-media"),
    text("span", "past-name", item.name),
    text("span", "past-kind", (item.pill ?? LABELS[item.kind])),
  );
  return row;
}
