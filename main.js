import MarkdownIt from "npm:markdown-it@14.1.0";
import hljs from "npm:highlight.js@11.11.1";
import markdownItAbbr from "npm:markdown-it-abbr@2.0.0";
import markdownItDeflist from "npm:markdown-it-deflist@3.0.0";
import markdownItFootnote from "npm:markdown-it-footnote@4.0.0";
import markdownItIns from "npm:markdown-it-ins@4.0.0";
import markdownItKatexModule from "npm:@vscode/markdown-it-katex@1.1.2";
const markdownItKatex = markdownItKatexModule.default ?? markdownItKatexModule;
import markdownItMark from "npm:markdown-it-mark@4.0.0";
import markdownItSub from "npm:markdown-it-sub@2.0.0";
import markdownItSup from "npm:markdown-it-sup@2.0.0";
import markdownItTaskLists from "npm:markdown-it-task-lists@2.1.1";

const ID_ALPHABET =
  "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
const RESERVED_IDS = new Set([
  "about",
  "api",
  "favicon",
  "health",
  "mermaid",
  "readme",
  "robots",
  "style",
  "view",
]);
const DEFAULT_MAX_MARKDOWN_BYTES = 128 * 1024;
const SOCIAL_DESCRIPTION_LENGTH = 200;
const SOCIAL_TITLE_LENGTH = 80;
const encoder = new TextEncoder();

function highlightCode(code, language) {
  const lang = language?.trim().toLowerCase();

  if (lang && hljs.getLanguage(lang)) {
    try {
      const result = hljs.highlight(code, {
        language: lang,
        ignoreIllegals: true,
      });
      return `<pre class="hljs"><code class="language-${
        escapeHtml(lang)
      }">${result.value}</code></pre>`;
    } catch {
      // fall back to escaped plain text
    }
  }

  return `<pre class="hljs"><code>${escapeHtml(code)}</code></pre>`;
}

const md = new MarkdownIt({
  html: false,
  linkify: true,
  typographer: true,
  highlight: highlightCode,
})
  .use(markdownItAbbr)
  .use(markdownItDeflist)
  .use(markdownItFootnote)
  .use(markdownItIns)
  .use(markdownItKatex)
  .use(markdownItMark)
  .use(markdownItSub)
  .use(markdownItSup)
  .use(markdownItTaskLists, { enabled: true });

const defaultFence = md.renderer.rules.fence;

md.renderer.rules.fence = (tokens, index, options, env, self) => {
  const token = tokens[index];
  const language = token.info.trim().split(/\s+/)[0].toLowerCase();

  if (language === "mermaid" || language === "mmd") {
    return `<figure class="mermaid-diagram" data-mermaid><pre class="mermaid-source">${
      escapeHtml(token.content)
    }</pre></figure>`;
  }

  return defaultFence(tokens, index, options, env, self);
};

function envInteger(name, fallback) {
  const value = Number(Deno.env.get(name));
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

export function configFromEnv() {
  return {
    baseUrl: Deno.env.get("BASE_URL")?.trim() || "",
    idLength: envInteger("ID_LENGTH", 7),
    maxMarkdownBytes: envInteger(
      "MAX_MARKDOWN_BYTES",
      DEFAULT_MAX_MARKDOWN_BYTES,
    ),
    port: envInteger("PORT", 3000),
    rateLimitPosts: envInteger("RATE_LIMIT_POSTS", 20),
    rateLimitWindowSeconds: envInteger("RATE_LIMIT_WINDOW_SECONDS", 3600),
  };
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function randomIndex(max) {
  const limit = Math.floor(256 / max) * max;
  const bytes = new Uint8Array(1);

  do {
    crypto.getRandomValues(bytes);
  } while (bytes[0] >= limit);

  return bytes[0] % max;
}

function makeId(length) {
  let id = "";

  for (let index = 0; index < length; index += 1) {
    id += ID_ALPHABET[randomIndex(ID_ALPHABET.length)];
  }

  return id;
}

function makeHttpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function truncateText(value, maxLength) {
  const characters = [...value];

  if (characters.length <= maxLength) {
    return value;
  }

  const candidate = characters.slice(0, maxLength - 1).join("").trimEnd();
  const lastSpace = candidate.lastIndexOf(" ");
  const cutoff = lastSpace >= Math.floor(maxLength * 0.6)
    ? candidate.slice(0, lastSpace)
    : candidate;

  return `${cutoff}…`;
}

function inlineText(token) {
  return (token.children || [])
    .map((child) => {
      if (["text", "code_inline", "image"].includes(child.type)) {
        return child.content;
      }

      if (["softbreak", "hardbreak"].includes(child.type)) {
        return " ";
      }

      return "";
    })
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}

export function socialPreviewFromMarkdown(markdown) {
  const blocks = md.parse(markdown, {})
    .map((token) => {
      if (token.type === "inline") {
        return inlineText(token);
      }

      if (["fence", "code_block"].includes(token.type)) {
        return token.content.replace(/\s+/g, " ").trim();
      }

      return "";
    })
    .filter(Boolean);

  const plainText = blocks.join(" ");
  const fallbackDescription = "A Markdown paste shared with tinypaste.";

  return {
    title: blocks.length
      ? truncateText(blocks[0], SOCIAL_TITLE_LENGTH)
      : "tinypaste",
    description: truncateText(
      plainText || fallbackDescription,
      SOCIAL_DESCRIPTION_LENGTH,
    ),
  };
}

function publicUrl(request, config, path) {
  const requestUrl = new URL(request.url);
  const baseUrl = config.baseUrl || requestUrl.origin;
  return new URL(path, baseUrl).toString();
}

export function renderMarkdown(markdown) {
  return md.render(markdown);
}

function byteLength(value) {
  return encoder.encode(value).byteLength;
}

function assertMarkdownSize(value, maxMarkdownBytes) {
  if (byteLength(value) <= maxMarkdownBytes) {
    return;
  }

  throw makeHttpError(
    413,
    `Markdown is too large. Limit is ${maxMarkdownBytes} bytes.`,
  );
}

async function extractMarkdown(request, maxMarkdownBytes) {
  const contentType = request.headers.get("content-type") || "";

  if (
    contentType.includes("application/json") || contentType.includes("+json")
  ) {
    const body = await request.text();
    let json;

    try {
      json = JSON.parse(body);
    } catch {
      throw makeHttpError(400, 'Expected JSON like {"markdown":"# text"}.');
    }

    const value = json.markdown ?? json.content ?? json.text;

    if (typeof value !== "string") {
      throw makeHttpError(400, 'Expected JSON like {"markdown":"# text"}.');
    }

    assertMarkdownSize(value, maxMarkdownBytes);

    return value;
  }

  if (
    contentType.includes("application/x-www-form-urlencoded") ||
    contentType.includes("multipart/form-data")
  ) {
    const form = await request.formData();
    const value = form.get("markdown");

    if (typeof value !== "string") {
      throw makeHttpError(400, "Expected Markdown in the markdown form field.");
    }

    assertMarkdownSize(value, maxMarkdownBytes);

    return value;
  }

  const value = await request.text();

  assertMarkdownSize(value, maxMarkdownBytes);

  return value;
}

function response(
  body,
  status = 200,
  contentType = "text/plain; charset=utf-8",
  headers = {},
) {
  return new Response(body, {
    status,
    headers: {
      "content-type": contentType,
      ...headers,
    },
  });
}

function corsHeaders(headers = {}) {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "content-type, accept",
    "access-control-max-age": "86400",
    ...headers,
  };
}

function page(title, body, scripts = "", head = "") {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
${head}
<meta name="color-scheme" content="light dark">
<meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#101010" media="(prefers-color-scheme: dark)">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@100..900&amp;family=JetBrains+Mono:wght@100..800&amp;display=swap">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.22/dist/katex.min.css">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/highlight.js@11.11.1/styles/github.min.css" media="(prefers-color-scheme: light)">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/highlight.js@11.11.1/styles/github-dark.min.css" media="(prefers-color-scheme: dark)">
<link rel="stylesheet" href="/style.css">
${scripts}
</head>
<body>
${body}
<script type="module">
(() => {
  const checkboxes = Array.from(document.querySelectorAll(".task-list-item-checkbox"));
  if (!checkboxes.length) return;

  const storageKey = "tinypaste:tasks:" + location.pathname;
  let saved = [];
  try {
    saved = JSON.parse(localStorage.getItem(storageKey) || "[]");
  } catch {
    saved = [];
  }

  checkboxes.forEach((checkbox, index) => {
    checkbox.disabled = false;
    if (index < saved.length) checkbox.checked = saved[index];

    checkbox.addEventListener("change", () => {
      const states = checkboxes.map((c) => c.checked);
      try {
        localStorage.setItem(storageKey, JSON.stringify(states));
      } catch {}
    });
  });
})();
</script>
</body>
</html>`;
}

function navHtml(options = {}) {
  const about = options.showAbout
    ? '<a class="about-link" href="/about">about</a>'
    : "";

  return `<nav aria-label="Main">
    <a class="brand" href="/">tinypaste</a>
    ${about}
  </nav>`;
}

function editorPage(error = "") {
  const errorHtml = error
    ? `<p class="error" role="alert">${escapeHtml(error)}</p>`
    : "";

  return page(
    "tinypaste",
    `<main class="shell">
  ${navHtml({ showAbout: true })}
  ${errorHtml}
  <form method="post" action="/">
    <label class="visually-hidden" for="markdown">Markdown</label>
    <textarea id="markdown" name="markdown" autofocus spellcheck="true" placeholder="# Paste Markdown"></textarea>
    <button type="submit">publish</button>
  </form>
</main>`,
  );
}

async function aboutPage() {
  const readme = await Deno.readTextFile(
    new URL("./README.md", import.meta.url),
  );

  return page(
    "tinypaste readme",
    `<main class="shell">
  ${navHtml()}
  <article class="markdown">${renderMarkdown(readme)}</article>
</main>`,
  );
}

function viewPage(paste, canonicalUrl) {
  const preview = socialPreviewFromMarkdown(paste.markdown);
  const title = escapeHtml(preview.title);
  const description = escapeHtml(preview.description);
  const url = escapeHtml(canonicalUrl);

  return page(
    preview.title,
    `<main class="shell">
  <article class="markdown">${renderMarkdown(paste.markdown)}</article>
</main>`,
    `<script src="https://cdn.jsdelivr.net/npm/svg-pan-zoom@3.6.1/dist/svg-pan-zoom.min.js"></script>
<script type="module">
import mermaid from "https://esm.sh/mermaid@11.14.0";
window.mermaid = mermaid;
await import("/view.js");
</script>`,
    `<meta name="description" content="${description}">
<link rel="canonical" href="${url}">
<meta property="og:type" content="article">
<meta property="og:site_name" content="tinypaste">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${description}">
<meta property="og:url" content="${url}">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="${title}">
<meta name="twitter:description" content="${description}">`,
  );
}

function normalizePaste(value) {
  if (!value || typeof value !== "object") {
    return null;
  }

  if (typeof value.markdown !== "string") {
    return null;
  }

  return {
    createdAt: typeof value.createdAt === "string" ? value.createdAt : "",
    markdown: value.markdown,
  };
}

async function getPaste(kv, id) {
  const entry = await kv.get(["paste", id]);
  return normalizePaste(entry.value);
}

async function savePaste(kv, id, paste) {
  const result = await kv.atomic()
    .check({ key: ["paste", id], versionstamp: null })
    .set(["paste", id], paste)
    .commit();

  return result.ok;
}

async function hitRate(kv, ip, limit, windowSeconds) {
  const now = Math.floor(Date.now() / 1000);
  const windowStart = Math.floor(now / windowSeconds) * windowSeconds;
  const resetSeconds = windowStart + windowSeconds - now;
  const key = ["rate", ip, windowStart];

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const entry = await kv.get(key);
    const count = (typeof entry.value === "number" ? entry.value : 0) + 1;
    const result = await kv.atomic()
      .check(entry)
      .set(key, count, { expireIn: (resetSeconds + 5) * 1000 })
      .commit();

    if (result.ok) {
      return {
        allowed: count <= limit,
        remaining: Math.max(0, limit - count),
        resetSeconds,
      };
    }
  }

  throw makeHttpError(503, "Could not update rate limit.");
}

function clientIp(request, info) {
  if (info && info.remoteAddr) {
    return info.remoteAddr.hostname;
  }

  const forwarded = request.headers.get("x-forwarded-for");

  if (forwarded) {
    return forwarded.split(",")[0].trim();
  }

  return request.headers.get("x-real-ip") || "unknown";
}

async function createPaste(request, kv, config, info) {
  const rate = await hitRate(
    kv,
    clientIp(request, info),
    config.rateLimitPosts,
    config.rateLimitWindowSeconds,
  );

  if (!rate.allowed) {
    const error = makeHttpError(
      429,
      `Rate limit exceeded. Retry in ${rate.resetSeconds} seconds.`,
    );
    error.resetSeconds = rate.resetSeconds;
    throw error;
  }

  const markdown = await extractMarkdown(request, config.maxMarkdownBytes);

  if (!markdown.trim()) {
    throw makeHttpError(400, "Markdown cannot be empty.");
  }

  const paste = {
    createdAt: new Date().toISOString(),
    markdown,
  };

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const id = makeId(config.idLength);

    if (RESERVED_IDS.has(id.toLowerCase())) {
      continue;
    }

    if (await savePaste(kv, id, paste)) {
      return { id, paste, rate };
    }
  }

  throw makeHttpError(503, "Could not allocate a paste id.");
}

function acceptsJson(request) {
  const accept = request.headers.get("accept") || "";

  return accept.split(",").some((part) => {
    const type = part.split(";")[0].trim().toLowerCase();
    return type === "application/json" || type.endsWith("+json");
  });
}

function handleError(error, request) {
  const status = error.status || 500;
  const message = status === 500 ? "Internal server error." : error.message;
  const headers = {};
  const url = new URL(request.url);
  const isApiRequest = url.pathname === "/api/pastes";

  if (status === 429 && error.resetSeconds) {
    headers["retry-after"] = String(error.resetSeconds);
  }

  if (isApiRequest) {
    Object.assign(headers, corsHeaders());
    if (acceptsJson(request)) {
      return response(
        JSON.stringify({ error: message }),
        status,
        "application/json; charset=utf-8",
        headers,
      );
    }
  }

  if (request.method === "POST" && url.pathname === "/" && status < 500) {
    return response(
      editorPage(message),
      status,
      "text/html; charset=utf-8",
      headers,
    );
  }

  return response(`${message}\n`, status, "text/plain; charset=utf-8", headers);
}

export function createHandler(options = {}) {
  const kv = options.kv;
  const config = options.config || configFromEnv();

  if (!kv) {
    throw new Error("KV store is required.");
  }

  return async (request, info) => {
    const url = new URL(request.url);
    const { pathname } = url;

    try {
      if (request.method === "GET" && pathname === "/health") {
        return response("ok\n");
      }

      if (request.method === "GET" && pathname === "/style.css") {
        return response(STYLE, 200, "text/css; charset=utf-8");
      }

      if (request.method === "GET" && pathname === "/view.js") {
        return response(
          VIEW_SCRIPT,
          200,
          "application/javascript; charset=utf-8",
        );
      }

      if (request.method === "GET" && pathname === "/favicon.ico") {
        return new Response(null, { status: 204 });
      }

      if (request.method === "GET" && pathname === "/") {
        return response(editorPage(), 200, "text/html; charset=utf-8");
      }

      if (request.method === "GET" && pathname === "/about") {
        return response(await aboutPage(), 200, "text/html; charset=utf-8");
      }

      if (request.method === "POST" && pathname === "/") {
        const { id } = await createPaste(request, kv, config, info);
        return new Response(null, {
          status: 303,
          headers: { location: `/${id}` },
        });
      }

      if (request.method === "POST" && pathname === "/api/pastes") {
        const { id, rate } = await createPaste(request, kv, config, info);
        const url = publicUrl(request, config, `/${id}`);
        const headers = corsHeaders({
          "x-ratelimit-limit": String(config.rateLimitPosts),
          "x-ratelimit-remaining": String(rate.remaining),
          "x-ratelimit-reset": String(rate.resetSeconds),
        });

        if (acceptsJson(request)) {
          return response(
            JSON.stringify({ id, url }),
            201,
            "application/json; charset=utf-8",
            headers,
          );
        }

        return response(`${url}\n`, 201, "text/plain; charset=utf-8", headers);
      }

      if (request.method === "OPTIONS" && pathname === "/api/pastes") {
        return new Response(null, {
          status: 204,
          headers: corsHeaders(),
        });
      }

      const rawMatch = pathname.match(/^\/([0-9a-zA-Z]+)\.md$/);

      if (request.method === "GET" && rawMatch) {
        const paste = await getPaste(kv, rawMatch[1]);

        if (!paste) {
          throw makeHttpError(404, "Paste not found.");
        }

        return response(paste.markdown, 200, "text/markdown; charset=utf-8");
      }

      const htmlMatch = pathname.match(/^\/([0-9a-zA-Z]+)\.html$/);

      if (request.method === "GET" && htmlMatch) {
        const paste = await getPaste(kv, htmlMatch[1]);

        if (!paste) {
          throw makeHttpError(404, "Paste not found.");
        }

        return response(
          renderMarkdown(paste.markdown),
          200,
          "text/html; charset=utf-8",
        );
      }

      const viewMatch = pathname.match(/^\/([0-9a-zA-Z]+)$/);

      if (request.method === "GET" && viewMatch) {
        const id = viewMatch[1];
        const paste = await getPaste(kv, id);

        if (!paste) {
          throw makeHttpError(404, "Paste not found.");
        }

        const canonicalUrl = publicUrl(request, config, pathname);
        return response(
          viewPage(paste, canonicalUrl),
          200,
          "text/html; charset=utf-8",
        );
      }

      return response("Not found.\n", 404);
    } catch (error) {
      if (!error.status || error.status >= 500) {
        console.error(error);
      }

      return handleError(error, request);
    }
  };
}

export const STYLE = `
/* RaggioProietto palette (Raycast-derived: coral #ff6363 on grayscale
   surfaces, hairline borders, 6/8/12px radii, Inter + JetBrains Mono).
   Ported from the summarize webapp theme and the RaggioProietto Obsidian
   theme. Unofficial. Not affiliated with Raycast or OpenAI. */
:root {
  color-scheme: light;
  --bg: #ffffff;
  --text: #1a1a1a;
  --secondary: #f7f7f7;
  --elevated: #efefef;
  --row: rgba(0, 0, 0, 0.045);
  --border: rgba(0, 0, 0, 0.08);
  --border-strong: #e4e4e4;
  --muted: #6b6b6b;
  --faint: #707070;
  --accent: #ff6363;
  --accent-hover: #e23e3e;
  --on-accent: #101010;
  --link: #b12424;
  --link-hover: #8f1c1c;
  --selection: rgba(255, 99, 99, 0.18);
  --highlight: rgba(255, 99, 99, 0.22);
  --focus: rgba(255, 99, 99, 0.55);
  --danger: #b12424;
  --chart-1: #b12424;
  --chart-2: #c75d07;
  --chart-3: #c7920e;
  --chart-4: #006b4f;
  --chart-5: #0f7a75;
  --chart-6: #0b6eaa;
  --chart-7: #6e56cf;
  --chart-8: #c41d7f;
  --radius-s: 6px;
  --radius-m: 8px;
  --shell-width: 42rem;
  --font-ui: Inter, "Segoe UI", -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
  --font-mono: "JetBrains Mono", "SF Mono", ui-monospace, Consolas, monospace;
  accent-color: var(--accent);
  scrollbar-color: var(--border-strong) transparent;
  scrollbar-width: thin;
}

@media (prefers-color-scheme: dark) {
  :root {
    color-scheme: dark;
    --bg: #101010;
    --text: #f4f4f6;
    --secondary: #141414;
    --elevated: #1a1a1a;
    --row: rgba(255, 255, 255, 0.06);
    --border: rgba(255, 255, 255, 0.08);
    --border-strong: #242728;
    --muted: #9c9c9d;
    --faint: #8f8f90;
    --accent: #ff6363;
    --accent-hover: #ff8585;
    --on-accent: #101010;
    --link: #ff6363;
    --link-hover: #ff8585;
    --selection: rgba(255, 99, 99, 0.28);
    --highlight: rgba(255, 99, 99, 0.22);
    --focus: rgba(255, 99, 99, 0.55);
    --danger: #ff6363;
    --chart-1: #ff6363;
    --chart-2: #ff9217;
    --chart-3: #ffc531;
    --chart-4: #59d499;
    --chart-5: #52eee5;
    --chart-6: #56c2ff;
    --chart-7: #c7a6ff;
    --chart-8: #cf2f98;
  }
}

* { box-sizing: border-box; }

html { font-size: 16px; }

body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font-family: var(--font-ui);
  font-feature-settings: "ss03" 1, "calt" 1, "kern" 1, "liga" 1;
  -webkit-font-smoothing: antialiased;
  line-height: 1.5;
}

a {
  color: var(--link);
  text-decoration-thickness: 1px;
  text-underline-offset: 0.16em;
}

a:hover { color: var(--link-hover); }

::selection {
  background: var(--selection);
  color: var(--text);
}

a:focus-visible,
textarea:focus-visible,
button:focus-visible,
[tabindex]:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: 2px;
}

.visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  border: 0;
  padding: 0;
  overflow: hidden;
  clip: rect(0 0 0 0);
  clip-path: inset(50%);
  white-space: nowrap;
}

.shell {
  width: min(100% - 32px, var(--shell-width));
  margin: 0 auto;
  padding: 28px 0 56px;
}

nav {
  display: flex;
  gap: 10px;
  align-items: baseline;
  margin-bottom: 24px;
}

nav a {
  border-radius: var(--radius-s);
  padding: 3px 8px;
  text-decoration: none;
}

nav a:hover { background: var(--row); }

.brand {
  margin-left: -8px;
  color: var(--text);
  font-weight: 600;
  letter-spacing: -0.01em;
}

.about-link {
  color: var(--muted);
  font-family: var(--font-mono);
  font-size: 0.6875rem;
  font-weight: 500;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

.about-link:hover { color: var(--text); }

form {
  display: grid;
  gap: 12px;
}

textarea {
  width: 100%;
  min-height: min(64vh, 640px);
  resize: vertical;
  border: 1px solid var(--border);
  border-radius: var(--radius-m);
  background: var(--secondary);
  color: var(--text);
  caret-color: var(--text);
  padding: 14px 16px;
  font-family: var(--font-mono);
  font-size: 0.875rem;
  line-height: 1.6;
  transition: border-color 0.12s ease;
}

textarea:focus-visible { border-color: var(--accent); }

textarea::placeholder {
  color: var(--faint);
  opacity: 1;
}

button {
  justify-self: start;
  border: 1px solid var(--accent);
  border-radius: var(--radius-s);
  background: var(--accent);
  color: var(--on-accent);
  padding: 9px 14px;
  font-family: var(--font-mono);
  font-size: 0.6875rem;
  font-weight: 500;
  letter-spacing: 0.04em;
  line-height: 1.5;
  text-transform: uppercase;
  cursor: pointer;
  transition: background-color 0.12s ease, border-color 0.12s ease, color 0.12s ease;
}

button:hover {
  background: var(--accent-hover);
  border-color: var(--accent-hover);
}

button:active { background: var(--accent-hover); }

.error {
  margin: 0 0 16px;
  border: 1px solid var(--border);
  border-left: 2px solid var(--danger);
  border-radius: var(--radius-m);
  background: var(--elevated);
  color: var(--danger);
  padding: 10px 12px;
  font-size: 0.9375rem;
}

.markdown { overflow-wrap: break-word; }
.markdown > *:first-child { margin-top: 0; }

.markdown p { margin: 0 0 1.25rem; }

.markdown h1,
.markdown h2,
.markdown h3,
.markdown h4,
.markdown h5,
.markdown h6 {
  margin: 1.75rem 0 0.6rem;
  line-height: 1.3;
  font-weight: 600;
  letter-spacing: -0.01em;
}

.markdown h1 { font-size: 1.5rem; }
.markdown h2 { font-size: 1.25rem; }
.markdown h3 { font-size: 1.1rem; font-weight: 550; }
.markdown h4 { font-size: 1rem; font-weight: 550; }
.markdown h5 { font-size: 0.9rem; font-weight: 500; }
.markdown h6 { font-size: 0.85rem; font-weight: 500; color: var(--muted); }

.markdown pre,
.markdown code {
  font-family: var(--font-mono);
  font-size: 0.875em;
}

.markdown code {
  border-radius: 4px;
  background: var(--secondary);
  padding: 0.12em 0.35em;
}

.markdown pre {
  overflow: auto;
  border: 1px solid var(--border);
  border-radius: var(--radius-m);
  background: var(--secondary);
  padding: 12px 14px;
  line-height: 1.55;
}

.markdown pre code {
  border-radius: 0;
  background: transparent;
  padding: 0;
}

.markdown blockquote {
  margin: 0 0 1.25rem;
  padding-left: 16px;
  border-left: 2px solid var(--border-strong);
  color: var(--muted);
}

.markdown hr {
  margin: 1.75rem 0;
  border: 0;
  border-top: 1px solid var(--border);
}

.markdown mark {
  border-radius: 3px;
  background: var(--highlight);
  color: var(--text);
  padding: 0 0.15em;
}

.markdown ins {
  text-decoration-thickness: 1px;
  text-underline-offset: 0.16em;
}

.markdown abbr[title] {
  text-decoration: underline dotted var(--faint);
  text-underline-offset: 0.16em;
  cursor: help;
}

.markdown img {
  max-width: 100%;
  border-radius: var(--radius-s);
}

.markdown ul,
.markdown ol { margin: 0 0 1.25rem; padding-left: 1.35em; }

.markdown li + li { margin-top: 0.18em; }
.markdown .contains-task-list { padding-left: 1.1em; }
.markdown .task-list-item { list-style: none; }

.markdown .task-list-item-checkbox {
  margin: 0 0.45em 0 -1.1em;
  accent-color: var(--accent);
  cursor: pointer;
}

.markdown dl { margin: 0 0 1.25rem; }
.markdown dt { font-weight: 600; }
.markdown dd {
  margin: 0 0 0.4rem 1.35em;
  color: var(--muted);
}

.markdown .footnotes {
  margin-top: 2rem;
  border-top: 1px solid var(--border);
  padding-top: 0.9rem;
  color: var(--muted);
  font-size: 0.875rem;
}

.markdown .footnotes-sep { display: none; }

.markdown .katex-display {
  overflow-x: auto;
  overflow-y: hidden;
  padding: 2px 0;
}

.markdown table {
  width: 100%;
  margin: 0 0 1.25rem;
  border: 1px solid var(--border);
  border-radius: var(--radius-m);
  border-collapse: separate;
  border-spacing: 0;
  overflow: hidden;
}

.markdown th,
.markdown td {
  border-bottom: 1px solid var(--border);
  padding: 7px 10px;
  text-align: left;
}

.markdown th + th,
.markdown td + td { border-left: 1px solid var(--border); }

.markdown th {
  background: var(--secondary);
  font-weight: 600;
}

.markdown tr:last-child td { border-bottom: 0; }

.mermaid-diagram {
  position: relative;
  margin: 0 0 1.45rem;
  border: 1px solid var(--border);
  border-radius: var(--radius-m);
  background: var(--secondary);
  overflow: hidden;
}

.mermaid-source {
  margin: 0;
  border: 0;
  border-radius: 0;
  background: transparent;
  padding: 12px 14px;
  color: var(--muted);
}

.mermaid-frame {
  position: relative;
  height: clamp(260px, 56vh, 620px);
  overflow: hidden;
  background: var(--secondary);
  cursor: grab;
  touch-action: none;
  user-select: none;
}

.mermaid-frame:active { cursor: grabbing; }
.mermaid-frame.is-grabbing { cursor: grabbing; }

.mermaid-frame:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: -2px;
}

button.mermaid-open,
button.mermaid-close {
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-s);
  background: color-mix(in srgb, var(--bg) 72%, transparent);
  color: var(--muted);
  padding: 4px 8px;
  font-family: var(--font-mono);
  font-size: 0.6875rem;
  font-weight: 500;
  letter-spacing: 0.04em;
  line-height: 1.2;
  text-transform: uppercase;
  cursor: pointer;
  -webkit-backdrop-filter: blur(8px);
  backdrop-filter: blur(8px);
}

button.mermaid-open {
  position: absolute;
  top: 8px;
  right: 8px;
  z-index: 2;
}

button.mermaid-open:hover,
button.mermaid-close:hover {
  background: color-mix(in srgb, var(--bg) 88%, transparent);
  border-color: var(--accent);
  color: var(--text);
}

.mermaid-content {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
  touch-action: none;
  user-select: none;
  -webkit-user-select: none;
}

.mermaid-content svg {
  display: block;
  width: 100% !important;
  height: 100% !important;
  max-width: none !important;
  touch-action: none;
  user-select: none;
  -webkit-user-select: none;
}

.mermaid-error {
  padding: 12px 14px;
  color: var(--danger);
  font-family: var(--font-mono);
  font-size: 0.8125rem;
}

.mermaid-fullscreen {
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: grid;
  grid-template-rows: auto 1fr;
  background: var(--bg);
}

.mermaid-fullscreen[hidden] { display: none; }

.mermaid-fullscreen-bar {
  display: flex;
  justify-content: flex-end;
  border-bottom: 1px solid var(--border);
  padding: 8px;
}

.mermaid-fullscreen-frame {
  position: relative;
  overflow: hidden;
  background: var(--bg);
  cursor: grab;
  touch-action: none;
  user-select: none;
}

.mermaid-fullscreen-frame:active { cursor: grabbing; }
.mermaid-fullscreen-frame.is-grabbing { cursor: grabbing; }

/* Mermaid's base theme hardcodes a few diagram parts that ignore
   themeVariables: pie slice and legend colours (pie1..12), the class
   diagram cScale boxes and the arrowheads. Presentation attributes lose
   to stylesheet rules and inline styles need !important, so pin them. */
.mermaid-content svg path.pieCircle:nth-of-type(8n + 1) { fill: var(--chart-1); }
.mermaid-content svg path.pieCircle:nth-of-type(8n + 2) { fill: var(--chart-2); }
.mermaid-content svg path.pieCircle:nth-of-type(8n + 3) { fill: var(--chart-3); }
.mermaid-content svg path.pieCircle:nth-of-type(8n + 4) { fill: var(--chart-4); }
.mermaid-content svg path.pieCircle:nth-of-type(8n + 5) { fill: var(--chart-5); }
.mermaid-content svg path.pieCircle:nth-of-type(8n + 6) { fill: var(--chart-6); }
.mermaid-content svg path.pieCircle:nth-of-type(8n + 7) { fill: var(--chart-7); }
.mermaid-content svg path.pieCircle:nth-of-type(8n + 8) { fill: var(--chart-8); }

.mermaid-content svg .legend:nth-of-type(8n + 1) rect {
  fill: var(--chart-1) !important;
  stroke: var(--chart-1) !important;
}

.mermaid-content svg .legend:nth-of-type(8n + 2) rect {
  fill: var(--chart-2) !important;
  stroke: var(--chart-2) !important;
}

.mermaid-content svg .legend:nth-of-type(8n + 3) rect {
  fill: var(--chart-3) !important;
  stroke: var(--chart-3) !important;
}

.mermaid-content svg .legend:nth-of-type(8n + 4) rect {
  fill: var(--chart-4) !important;
  stroke: var(--chart-4) !important;
}

.mermaid-content svg .legend:nth-of-type(8n + 5) rect {
  fill: var(--chart-5) !important;
  stroke: var(--chart-5) !important;
}

.mermaid-content svg .legend:nth-of-type(8n + 6) rect {
  fill: var(--chart-6) !important;
  stroke: var(--chart-6) !important;
}

.mermaid-content svg .legend:nth-of-type(8n + 7) rect {
  fill: var(--chart-7) !important;
  stroke: var(--chart-7) !important;
}

.mermaid-content svg .legend:nth-of-type(8n + 8) rect {
  fill: var(--chart-8) !important;
  stroke: var(--chart-8) !important;
}

.mermaid-content svg marker path {
  fill: var(--muted);
  stroke: var(--muted);
}

.mermaid-content svg g.node .outer-path path {
  fill: var(--bg);
  stroke: var(--border-strong);
}

.mermaid-content svg g.divider path { stroke: var(--border-strong); }

@media (max-width: 520px) {
  html { font-size: 15px; }

  .shell {
    width: min(100% - 24px, var(--shell-width));
    padding-top: 18px;
  }

  textarea {
    min-height: 68vh;
    padding: 12px;
  }
}
`;

export const VIEW_SCRIPT = `
(() => {
  const diagrams = Array.from(document.querySelectorAll("[data-mermaid]"));
  const sources = diagrams.map((diagram) =>
    diagram.querySelector(".mermaid-source")?.textContent || ""
  );
  let overlay = null;
  let overlayController = null;
  let overlayPanZoom = null;
  let renderPass = 0;
  let passController = null;

  if (!diagrams.length) return;

  if (!window.mermaid) {
    for (const diagram of diagrams) diagram.classList.add("mermaid-error");
    return;
  }

  // RaggioProietto palette: coral on grayscale surfaces with hairlines.
  const PALETTE = {
    light: {
      darkMode: false,
      surface: "#ffffff",
      card: "#f7f7f7",
      elevated: "#efefef",
      text: "#1a1a1a",
      muted: "#6b6b6b",
      border: "#e4e4e4",
      accent: "#ff6363",
      onAccent: "#101010",
      onChart: "#ffffff",
      done: "#efefef",
      scales: ["#b12424", "#c75d07", "#c7920e", "#006b4f", "#0f7a75", "#0b6eaa", "#6e56cf", "#c41d7f"],
    },
    dark: {
      darkMode: true,
      surface: "#101010",
      card: "#141414",
      elevated: "#1a1a1a",
      text: "#f4f4f6",
      muted: "#9c9c9d",
      border: "#242728",
      accent: "#ff6363",
      onAccent: "#101010",
      onChart: "#101010",
      done: "#9c9c9d",
      scales: ["#ff6363", "#ff9217", "#ffc531", "#59d499", "#52eee5", "#56c2ff", "#c7a6ff", "#cf2f98"],
    },
  };

  const scheme = window.matchMedia("(prefers-color-scheme: dark)");

  function themeVariables(palette) {
    const vars = {
      darkMode: palette.darkMode,
      background: palette.card,
      fontFamily: "Inter, 'Segoe UI', -apple-system, system-ui, sans-serif",
      fontSize: "16px",
      textColor: palette.text,
      mainBkg: palette.surface,
      primaryColor: palette.surface,
      primaryTextColor: palette.text,
      primaryBorderColor: palette.border,
      secondaryColor: palette.card,
      secondaryTextColor: palette.text,
      secondaryBorderColor: palette.border,
      tertiaryColor: palette.elevated,
      tertiaryTextColor: palette.text,
      tertiaryBorderColor: palette.border,
      nodeBorder: palette.border,
      nodeTextColor: palette.text,
      lineColor: palette.muted,
      titleColor: palette.text,
      clusterBkg: palette.card,
      clusterBorder: palette.border,
      edgeLabelBackground: palette.surface,
      labelBackgroundColor: palette.card,
      /* Sequence diagrams */
      actorBkg: palette.surface,
      actorBorder: palette.border,
      actorTextColor: palette.text,
      actorLineColor: palette.muted,
      signalColor: palette.muted,
      signalTextColor: palette.text,
      labelBoxBkgColor: palette.surface,
      labelBoxBorderColor: palette.border,
      labelTextColor: palette.text,
      loopTextColor: palette.text,
      noteBkgColor: palette.elevated,
      noteBorderColor: palette.border,
      noteTextColor: palette.text,
      activationBkgColor: palette.elevated,
      activationBorderColor: palette.border,
      sequenceNumberColor: palette.onAccent,
      /* State and class diagrams */
      altBackground: palette.card,
      compositeBackground: palette.card,
      compositeBorder: palette.border,
      transitionColor: palette.muted,
      transitionLabelColor: palette.text,
      stateBkg: palette.surface,
      stateBorder: palette.border,
      /* Gantt */
      sectionBkgColor: palette.card,
      altSectionBkgColor: palette.surface,
      sectionBkgColor2: palette.card,
      taskBkgColor: palette.accent,
      taskBorderColor: palette.accent,
      taskTextColor: palette.onAccent,
      taskTextDarkColor: palette.onAccent,
      taskTextOutsideColor: palette.text,
      activeTaskBkgColor: palette.accent,
      activeTaskBorderColor: palette.accent,
      doneTaskBkgColor: palette.done,
      doneTaskBorderColor: palette.done,
      gridColor: palette.border,
      todayLineColor: palette.accent,
      /* Git graph */
      commitLabelColor: palette.text,
      commitLabelBackground: palette.elevated,
      tagLabelColor: palette.text,
      tagLabelBackground: palette.elevated,
      tagLabelBorder: palette.border,
      /* Pie */
      pieTitleTextColor: palette.text,
      pieLegendTextColor: palette.muted,
      pieSectionTextColor: palette.onChart,
      pieStrokeColor: palette.surface,
      pieOuterStrokeColor: palette.border,
      pieOuterStrokeWidth: "1px",
      pieOpacity: "1",
    };

    palette.scales.forEach((color, index) => {
      vars["pie" + (index + 1)] = color;
      vars["cScale" + index] = color;
      vars["git" + index] = color;
      vars["gitInv" + index] = palette.card;
    });

    return vars;
  }

  function initializeMermaid() {
    window.mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: "base",
      themeVariables: themeVariables(
        scheme.matches ? PALETTE.dark : PALETTE.light,
      ),
    });
  }

  function contentSize(content) {
    const svg = content.querySelector("svg");
    if (!svg) return { width: 800, height: 480 };

    const viewBox = svg.viewBox && svg.viewBox.baseVal;
    const width = viewBox && viewBox.width ? viewBox.width : Number.parseFloat(svg.getAttribute("width")) || 800;
    const height = viewBox && viewBox.height ? viewBox.height : Number.parseFloat(svg.getAttribute("height")) || 480;
    return { width, height };
  }

  function normalizeSvg(content) {
    const svg = content.querySelector("svg");
    if (!svg) return;

    svg.removeAttribute("style");
    svg.setAttribute("width", "100%");
    svg.setAttribute("height", "100%");
    svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
  }

  function setFrameHeight(frame, content) {
    const padding = 12;
    const { width, height } = contentSize(content);
    const fitScale = Math.min(1, (frame.clientWidth - padding * 2) / width);

    frame.style.height = Math.round(Math.min(window.innerHeight * 0.72, Math.max(240, height * fitScale + padding * 2))) + "px";
  }

  function fitPanZoom(frame, content, panZoom, dynamicHeight) {
    if (dynamicHeight) setFrameHeight(frame, content);

    try {
      panZoom.resize();
      panZoom.fit();
      panZoom.center();
    } catch {}
  }

  function resetPanZoom(panZoom) {
    try {
      panZoom.resetZoom();
      panZoom.center();
      panZoom.fit();
    } catch {}
  }

  function destroyPanZoom(panZoom) {
    if (!panZoom) return;

    try {
      panZoom.destroy();
    } catch {}
  }

  function distance(first, second) {
    return Math.hypot(first.x - second.x, first.y - second.y);
  }

  function midpoint(first, second) {
    return {
      x: (first.x + second.x) / 2,
      y: (first.y + second.y) / 2,
    };
  }

  function svgPointFromClient(svg, point) {
    const svgPoint = svg.createSVGPoint();
    svgPoint.x = point.x;
    svgPoint.y = point.y;
    return svgPoint.matrixTransform(svg.getScreenCTM().inverse());
  }

  function gestureFromPoints(points) {
    if (points.length < 2) return null;

    const first = points[0];
    const second = points[1];

    return {
      center: midpoint(first, second),
      distance: Math.max(1, distance(first, second)),
    };
  }

  function preventEvent(event) {
    if (event.cancelable) event.preventDefault();
  }

  function makeTouchEventsHandler(frame) {
    const cleanup = [];

    return {
      haltEventListeners: ["touchstart", "touchmove", "touchend", "touchleave", "touchcancel"],
      init: function (options) {
        const svg = options.svgElement;
        const panZoom = options.instance;
        const activePointers = new Map();
        let previousSinglePoint = null;
        let previousGesture = null;
        let tapStart = null;
        let lastTap = null;

        function add(target, type, handler, listenerOptions) {
          target.addEventListener(type, handler, listenerOptions);
          cleanup.push(function () {
            target.removeEventListener(type, handler, listenerOptions);
          });
        }

        function clearGesture() {
          activePointers.clear();
          previousSinglePoint = null;
          previousGesture = null;
          tapStart = null;
          frame.classList.remove("is-grabbing");
        }

        function startTap(point) {
          tapStart = {
            x: point.x,
            y: point.y,
            moved: false,
            multi: false,
          };
        }

        function markTapMovement(point) {
          if (tapStart && distance(tapStart, point) > 8) {
            tapStart.moved = true;
          }
        }

        function handleTap(point) {
          const now = Date.now();

          if (lastTap && now - lastTap.time <= 300 && distance(lastTap, point) <= 28) {
            resetPanZoom(panZoom);
            lastTap = null;
            return;
          }

          lastTap = {
            x: point.x,
            y: point.y,
            time: now,
          };
        }

        function panBy(delta) {
          if (delta.x || delta.y) {
            panZoom.panBy(delta);
          }
        }

        function applyMultiPointGesture(points) {
          const nextGesture = gestureFromPoints(points);
          if (!nextGesture) return;

          if (previousGesture) {
            const scale = Math.min(4, Math.max(0.25, nextGesture.distance / previousGesture.distance));
            panZoom.zoomAtPointBy(scale, svgPointFromClient(svg, nextGesture.center));
            panBy({
              x: nextGesture.center.x - previousGesture.center.x,
              y: nextGesture.center.y - previousGesture.center.y,
            });
          }

          previousGesture = nextGesture;
        }

        function usePoints(points) {
          if (points.length === 1) {
            const point = points[0];
            markTapMovement(point);

            if (previousSinglePoint) {
              panBy({
                x: point.x - previousSinglePoint.x,
                y: point.y - previousSinglePoint.y,
              });
            }

            previousSinglePoint = point;
            previousGesture = null;
            return;
          }

          if (points.length > 1) {
            if (tapStart) tapStart.multi = true;
            previousSinglePoint = null;
            applyMultiPointGesture(points);
          }
        }

        if (window.PointerEvent) {
          function pointerPoint(event) {
            return {
              id: event.pointerId,
              x: event.clientX,
              y: event.clientY,
            };
          }

          function currentPointerPoints() {
            return Array.from(activePointers.values());
          }

          function onPointerDown(event) {
            if (event.pointerType === "mouse") return;

            preventEvent(event);

            const point = pointerPoint(event);
            activePointers.set(event.pointerId, point);
            frame.classList.add("is-grabbing");

            if (activePointers.size === 1) {
              previousSinglePoint = point;
              previousGesture = null;
              startTap(point);
            } else {
              if (tapStart) tapStart.multi = true;
              previousSinglePoint = null;
              previousGesture = gestureFromPoints(currentPointerPoints());
            }

            if (frame.setPointerCapture) {
              try {
                frame.setPointerCapture(event.pointerId);
              } catch {}
            }
          }

          function onPointerMove(event) {
            if (!activePointers.has(event.pointerId)) return;

            preventEvent(event);

            const point = pointerPoint(event);
            activePointers.set(event.pointerId, point);
            usePoints(currentPointerPoints());
          }

          function onPointerEnd(event) {
            if (!activePointers.has(event.pointerId)) return;

            preventEvent(event);

            const point = pointerPoint(event);
            markTapMovement(point);

            if (tapStart && activePointers.size === 1 && !tapStart.moved && !tapStart.multi) {
              handleTap(point);
            }

            activePointers.delete(event.pointerId);

            if (frame.releasePointerCapture) {
              try {
                frame.releasePointerCapture(event.pointerId);
              } catch {}
            }

            const points = currentPointerPoints();

            if (!points.length) {
              clearGesture();
              return;
            }

            if (points.length === 1) {
              previousSinglePoint = points[0];
              previousGesture = null;
            } else {
              previousSinglePoint = null;
              previousGesture = gestureFromPoints(points);
            }
          }

          add(frame, "pointerdown", onPointerDown);
          add(frame, "pointermove", onPointerMove);
          add(frame, "pointerup", onPointerEnd);
          add(frame, "pointercancel", onPointerEnd);
          add(frame, "lostpointercapture", onPointerEnd);
          return;
        }

        function touchPoint(touch) {
          return {
            id: touch.identifier,
            x: touch.clientX,
            y: touch.clientY,
          };
        }

        function touchPoints(touches) {
          return Array.from(touches).map(touchPoint);
        }

        function syncTouchState(points) {
          if (!points.length) {
            clearGesture();
            return;
          }

          if (points.length === 1) {
            previousSinglePoint = points[0];
            previousGesture = null;
          } else {
            previousSinglePoint = null;
            previousGesture = gestureFromPoints(points);
          }
        }

        function onTouchStart(event) {
          preventEvent(event);

          const points = touchPoints(event.touches);
          frame.classList.add("is-grabbing");

          if (points.length === 1) {
            previousSinglePoint = points[0];
            previousGesture = null;
            startTap(points[0]);
            return;
          }

          if (tapStart) tapStart.multi = true;
          syncTouchState(points);
        }

        function onTouchMove(event) {
          preventEvent(event);
          usePoints(touchPoints(event.touches));
        }

        function onTouchEnd(event) {
          preventEvent(event);

          if (event.changedTouches.length) {
            const point = touchPoint(event.changedTouches[0]);
            markTapMovement(point);

            if (tapStart && !event.touches.length && !tapStart.moved && !tapStart.multi) {
              handleTap(point);
            }
          }

          syncTouchState(touchPoints(event.touches));
        }

        const activeTouchListener = { passive: false };
        add(frame, "touchstart", onTouchStart, activeTouchListener);
        add(frame, "touchmove", onTouchMove, activeTouchListener);
        add(frame, "touchend", onTouchEnd, activeTouchListener);
        add(frame, "touchcancel", onTouchEnd, activeTouchListener);
      },
      destroy: function () {
        while (cleanup.length) cleanup.pop()();
        frame.classList.remove("is-grabbing");
      },
    };
  }

  function attachPanZoom(frame, content, options = {}) {
    const dynamicHeight = Boolean(options.dynamicHeight);
    const listenerOptions = options.signal
      ? { signal: options.signal }
      : undefined;
    const svg = content.querySelector("svg");

    frame.tabIndex = 0;
    frame.setAttribute("role", "img");
    frame.setAttribute("aria-label", "Mermaid diagram. Drag to pan. Wheel or pinch to zoom. Double-click or double-tap to reset.");

    if (dynamicHeight) setFrameHeight(frame, content);
    normalizeSvg(content);

    if (!svg || typeof window.svgPanZoom !== "function") {
      return null;
    }

    const panZoom = window.svgPanZoom(svg, {
      zoomEnabled: true,
      controlIconsEnabled: false,
      fit: true,
      center: true,
      contain: false,
      minZoom: 0.2,
      maxZoom: 12,
      zoomScaleSensitivity: 0.35,
      dblClickZoomEnabled: false,
      mouseWheelZoomEnabled: true,
      customEventsHandler: makeTouchEventsHandler(frame),
    });

    const refit = () => fitPanZoom(frame, content, panZoom, dynamicHeight);
    const releaseGrab = () => frame.classList.remove("is-grabbing");

    requestAnimationFrame(refit);
    window.addEventListener("resize", refit, listenerOptions);
    frame.addEventListener("mousedown", () => frame.classList.add("is-grabbing"), listenerOptions);
    frame.addEventListener("mouseup", releaseGrab, listenerOptions);
    frame.addEventListener("mouseleave", releaseGrab, listenerOptions);
    svg.addEventListener("dblclick", (event) => {
      event.preventDefault();
      resetPanZoom(panZoom);
    }, listenerOptions);

    frame.addEventListener("keydown", (event) => {
      if (event.key === "+" || event.key === "=") {
        event.preventDefault();
        panZoom.zoomBy(1.2);
      }

      if (event.key === "-") {
        event.preventDefault();
        panZoom.zoomBy(1 / 1.2);
      }

      if (event.key === "0" || event.key === "Escape") {
        event.preventDefault();
        resetPanZoom(panZoom);
      }
    }, listenerOptions);

    if (options.signal) {
      options.signal.addEventListener("abort", () => {
        destroyPanZoom(panZoom);
      }, { once: true });
    }

    return panZoom;
  }

  function closeFullscreen() {
    if (!overlay) return;

    const panZoom = overlayPanZoom;
    overlayPanZoom = null;

    if (overlayController) {
      overlayController.abort();
      overlayController = null;
    } else {
      destroyPanZoom(panZoom);
    }

    overlay.hidden = true;
    overlay.querySelector(".mermaid-fullscreen-frame").replaceChildren();
  }

  function ensureOverlay() {
    if (overlay) return overlay;

    overlay = document.createElement("div");
    overlay.className = "mermaid-fullscreen";
    overlay.hidden = true;
    overlay.innerHTML = '<div class="mermaid-fullscreen-bar"><button class="mermaid-close" type="button">close</button></div><div class="mermaid-fullscreen-frame"></div>';
    document.body.append(overlay);

    overlay.querySelector(".mermaid-close").addEventListener("click", closeFullscreen);

    document.addEventListener("keydown", (event) => {
      if (!overlay.hidden && event.key === "Escape") {
        closeFullscreen();
      }
    });

    return overlay;
  }

  function openFullscreen(svgHtml) {
    const currentOverlay = ensureOverlay();
    const frame = currentOverlay.querySelector(".mermaid-fullscreen-frame");
    const content = document.createElement("div");

    if (overlayController) {
      overlayController.abort();
      overlayController = null;
      overlayPanZoom = null;
    }

    overlayController = new AbortController();
    content.className = "mermaid-content";
    content.innerHTML = svgHtml;
    frame.replaceChildren(content);
    currentOverlay.hidden = false;
    overlayPanZoom = attachPanZoom(frame, content, {
      dynamicHeight: false,
      signal: overlayController.signal,
    });
    frame.focus();
  }

  async function renderDiagram(diagram, source, index, signal) {
    const frame = document.createElement("div");
    const content = document.createElement("div");
    const open = document.createElement("button");

    frame.className = "mermaid-frame";
    content.className = "mermaid-content";
    open.className = "mermaid-open";
    open.type = "button";
    open.textContent = "open";
    open.setAttribute("aria-label", "Open Mermaid diagram fullscreen");
    frame.append(content);
    diagram.replaceChildren(open, frame);

    try {
      const result = await window.mermaid.render("mermaid-" + Date.now() + "-" + index, source);
      const svgHtml = result.svg;
      content.innerHTML = result.svg;
      attachPanZoom(frame, content, { dynamicHeight: true, signal });
      open.addEventListener("click", () => openFullscreen(svgHtml), { signal });
    } catch {
      const pre = document.createElement("pre");
      pre.className = "mermaid-error";
      pre.textContent = source;
      diagram.replaceChildren(pre);
    }
  }

  async function renderDiagrams() {
    const pass = ++renderPass;

    if (passController) passController.abort();
    passController = new AbortController();

    initializeMermaid();

    for (let index = 0; index < diagrams.length; index += 1) {
      if (pass !== renderPass) return;
      await renderDiagram(
        diagrams[index],
        sources[index],
        index,
        passController.signal,
      );
    }
  }

  renderDiagrams();

  if (typeof scheme.addEventListener === "function") {
    scheme.addEventListener("change", () => {
      closeFullscreen();
      renderDiagrams();
    });
  }
})();
`;

if (import.meta.main) {
  const kv = await Deno.openKv();
  const config = configFromEnv();
  const handler = createHandler({ kv, config });

  if (Deno.env.get("DENO_DEPLOYMENT_ID")) {
    Deno.serve(handler);
  } else {
    Deno.serve({ port: config.port }, handler);
    console.log(`tinypaste listening on ${config.port}`);
  }
}
