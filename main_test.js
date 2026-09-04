import { createHandler, socialPreviewFromMarkdown } from "./main.js";

function assertEquals(actual, expected) {
  if (actual !== expected) {
    throw new Error(
      `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

function assertStringIncludes(actual, expected) {
  if (!actual.includes(expected)) {
    throw new Error(`Expected string to include ${JSON.stringify(expected)}`);
  }
}

Deno.test("social preview uses plain Markdown text", () => {
  const preview = socialPreviewFromMarkdown(
    "# A **useful** title\n\nRead [the guide](https://example.com) before running `deploy`.",
  );

  assertEquals(preview.title, "A useful title");
  assertEquals(
    preview.description,
    "A useful title Read the guide before running deploy.",
  );
});

Deno.test("social preview truncates long descriptions on a word boundary", () => {
  const preview = socialPreviewFromMarkdown(
    `# Title\n\n${"preview ".repeat(40)}`,
  );

  assertEquals([...preview.description].length <= 200, true);
  assertEquals(preview.description.endsWith("preview…"), true);
});

Deno.test("bin page includes escaped Open Graph and Twitter metadata", async () => {
  const kv = {
    get() {
      return Promise.resolve({
        value: {
          createdAt: "2026-09-04T00:00:00.000Z",
          markdown: '# Cats & Dogs\n\nA "shareable" <preview>.',
        },
      });
    },
  };
  const handler = createHandler({
    kv,
    config: {
      baseUrl: "https://tnypst.example",
      idLength: 7,
      maxMarkdownBytes: 1024,
      port: 3000,
      rateLimitPosts: 20,
      rateLimitWindowSeconds: 3600,
    },
  });

  const response = await handler(
    new Request("https://internal.example/abc1234"),
  );
  const html = await response.text();

  assertEquals(response.status, 200);
  assertStringIncludes(
    html,
    '<meta property="og:title" content="Cats &amp; Dogs">',
  );
  assertStringIncludes(
    html,
    'content="Cats &amp; Dogs A “shareable” &lt;preview&gt;."',
  );
  assertStringIncludes(
    html,
    '<meta property="og:url" content="https://tnypst.example/abc1234">',
  );
  assertStringIncludes(html, '<meta name="twitter:card" content="summary">');
  assertStringIncludes(
    html,
    '<link rel="canonical" href="https://tnypst.example/abc1234">',
  );
});
