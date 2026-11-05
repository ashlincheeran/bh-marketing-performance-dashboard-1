import { test } from "node:test";
import assert from "node:assert/strict";
import { OK_CHARS, extractArticle, tidyText } from "@/lib/news/extract";

const STORY = [
  "Prime property prices in Dubai rose by five per cent in the third quarter, according to new figures.",
  "Louis Harding, chief executive of Knight Frank Middle East, said overseas buyers were driving demand.",
  "Agents at betterhomes reported more enquiries from families moving to the emirate from London this year.",
  "Analysts expect growth to slow next year as thousands of new homes are handed over across the city.",
  "Rents in established communities such as Arabian Ranches and Jumeirah Park also climbed in the period.",
];
const WHOLE = STORY.join("\n");
const paragraphs = (lines: string[]) => lines.map((line) => `<p>${line}</p>`).join("\n");
const ldJson = (data: unknown) => `<script type="application/ld+json">${JSON.stringify(data)}</script>`;

test("the story used below is a whole article's worth of text", () => {
  assert.ok(WHOLE.length >= OK_CHARS);
});

test("JSON-LD: the longest articleBody of an article object, in @graph or in an array", () => {
  const graph = {
    "@context": "https://schema.org",
    "@graph": [
      // A web page is not an article, so its far longer text is passed over.
      { "@type": "WebPage", articleBody: "A page that is not an article. ".repeat(40) },
      { "@type": "NewsArticle", headline: "Prices rise", articleBody: WHOLE },
    ],
  };
  const list = [
    { "@type": "Organization", name: "Gulf Paper" },
    { "@type": ["Article", "ReportageNewsArticle"], articleBody: "A short teaser of the story." },
  ];
  const html = `<html><head>${ldJson(list)}${ldJson(graph)}</head>
    <body><article><p>The article element says something else entirely.</p></article></body></html>`;
  const page = extractArticle(html);
  assert.equal(page.source, "jsonld");
  assert.equal(page.text, WHOLE);
});

test("JSON-LD: an article under mainEntity counts, and full type names and every listed type are understood", () => {
  const data = [{ "@type": "WebPage", mainEntity: { "@type": "http://schema.org/NewsArticle", articleBody: WHOLE } }];
  assert.equal(extractArticle(ldJson(data)).text, WHOLE);
  for (const type of ["NewsArticle", "Article", "ReportageNewsArticle", "BlogPosting", "AnalysisNewsArticle", "schema:OpinionNewsArticle"]) {
    const page = extractArticle(ldJson({ "@type": type, articleBody: "The body." }));
    assert.equal(page.text, "The body.", type);
    assert.equal(page.source, "jsonld", type);
  }
  assert.equal(extractArticle(ldJson({ "@type": "Recipe", articleBody: "Not an article." })).source, "none");
});

test("JSON-LD: a body written as HTML, or as escaped HTML, comes out as plain paragraphs", () => {
  const body = "<p>Dubai&#8217;s market &amp; its   agents.</p><button>Share</button><p>Second&nbsp;paragraph.</p>";
  assert.equal(extractArticle(ldJson({ "@type": "NewsArticle", articleBody: body })).text, "Dubai’s market & its agents.\nSecond paragraph.");
  const escaped = "&lt;p&gt;One.&lt;/p&gt;&lt;p&gt;Two &amp;amp; three.&lt;/p&gt;";
  assert.equal(extractArticle(ldJson({ "@type": "NewsArticle", articleBody: escaped })).text, "One.\nTwo & three.");
  // Line breaks escaped once too often still break lines.
  assert.equal(extractArticle(ldJson({ "@type": "NewsArticle", articleBody: "Line one.\\nLine two." })).text, "Line one.\nLine two.");
});

test("JSON-LD holding only a teaser gives way to the whole story further down the page", () => {
  const page = extractArticle(`<head>${ldJson({ "@type": "NewsArticle", articleBody: "Prices rose. Subscribe for more." })}</head>
    <body><article>${paragraphs(STORY)}</article></body>`);
  assert.equal(page.source, "article");
  assert.equal(page.text, WHOLE);
});

test("JSON-LD that isn't strictly valid is still read", () => {
  const html = `<script type="application/ld+json">
//<![CDATA[
{"@type": "NewsArticle", "articleBody": "First line of the story.
Second line, with a stray \\' escape.", "author": {"@type": "Person", "name": "A Writer",},}
{"@type": "Organization", "name": "Gulf Paper"};
//]]>
</script>`;
  const page = extractArticle(html);
  assert.equal(page.source, "jsonld");
  assert.equal(page.text, "First line of the story.\nSecond line, with a stray ' escape.");
  // Past repair: nothing is found there, and nothing throws.
  assert.equal(extractArticle(`<script type="application/ld+json">{"@type": "NewsArticle", "articleBody": </script>`).source, "none");
});

test("itemprop=articleBody: the marked body, a line per block, without the furniture inside it", () => {
  const html = `<body>
    <div class="story" itemprop="articleBody">
      <p>${STORY[0]}</p>
      <h2>A subheading</h2>
      <div>${STORY[1]}<br>${STORY[2]}</div>
      <aside><p>Read more: Knight Frank says prices will keep rising</p></aside>
      <script>var t = "not the story";</script>
      <p>We use cookies to give you the best experience on our site.</p>
    </div>
    <div class="advert">Advertisement</div>
    <div itemprop="articleBody"><p>${STORY[3]}</p><p>${STORY[4]}</p></div>
    <p>A paragraph outside the marked body, long enough to count anywhere else.</p>
  </body>`;
  const page = extractArticle(html);
  assert.equal(page.source, "articlebody");
  assert.equal(page.text, [STORY[0], "A subheading", STORY[1], STORY[2], STORY[3], STORY[4]].join("\n"));
});

test("<article>: the longest article's own paragraphs, without its furniture or the articles nested in it", () => {
  const html = `<body>
    <aside><article><p>A related story in the sidebar, which is not this article at all.</p></article></aside>
    <article class="story">
      <header><h1>Prices rise</h1><p>By Staff Writer</p></header>
      <p>${STORY[0]}</p><p>${STORY[1]}</p>
      <nav><p>Home / Business / Property</p></nav>
      <p>${STORY[2]}</p><p>${STORY[3]}</p><p>${STORY[4]}</p>
      <article class="comment"><p>A reader's comment, which should be left out of the story.</p></article>
      <footer><p>Tags: property, Dubai, prices</p></footer>
      <p>Subscribe to continue reading our premium coverage.</p>
    </article>
  </body>`;
  const page = extractArticle(html);
  assert.equal(page.source, "article");
  assert.equal(page.text, WHOLE);
});

test("<main>, or role=main, when the only article element is a teaser card", () => {
  const teaser = `<div class="cards"><article><p>A teaser card for a different story on the same page.</p></article></div>`;
  const main = extractArticle(`<body>${teaser}<main><nav><p>Home / Property</p></nav>${paragraphs(STORY)}</main></body>`);
  assert.equal(main.source, "main");
  assert.equal(main.text, WHOLE);
  const role = extractArticle(`<body>${teaser}<div role="main">${paragraphs(STORY)}</div></body>`);
  assert.equal(role.source, "main");
  assert.equal(role.text, WHOLE);
});

test("the page's paragraphs: 40 characters or more, outside the furniture, and no notices", () => {
  const html = `<body>
    <header><p>Gulf Paper, the region's most trusted business newspaper since 1978</p></header>
    <nav><p>Business | Property | Markets | Opinion | Lifestyle | Video | Podcasts</p></nav>
    <div role="navigation"><p>A row of links that a site has styled as one long paragraph</p></div>
    <div class="content">
      <p>Short caption.</p>
      ${paragraphs(STORY)}
      <p>This website uses cookies to improve your experience and for analytics.</p>
      <p>Already a subscriber? Sign in to continue reading this article.</p>
      <p>Read more: Knight Frank says prime prices will keep rising in 2027</p>
      <p>${STORY[1]}</p>
    </div>
    <form><p>Sign up for our newsletter to get the latest stories in your inbox</p><input name="email"></form>
    <aside><p>Most read: five things to know about the new rental index this week</p></aside>
    <footer><p>Copyright 2026 Gulf Paper. All rights reserved. Registered in Dubai.</p></footer>
  </body>`;
  const page = extractArticle(html);
  assert.equal(page.source, "paragraphs");
  assert.equal(page.text, WHOLE);
});

test("a <form> around the whole page, as ASP.NET writes it, is not a sign-up box", () => {
  const page = extractArticle(`<body><form id="aspnetForm" method="post"><h1>Prices rise</h1><div>${paragraphs(STORY)}</div></form></body>`);
  assert.equal(page.source, "paragraphs");
  assert.equal(page.text, WHOLE);
});

test("when no way finds a whole article, the longest find wins, and a tie goes to the earlier way", () => {
  const longer = extractArticle(`<body><article><p>Teaser only.</p></article><div><p>A longer paragraph, of about sixty characters, outside it.</p></div></body>`);
  assert.equal(longer.source, "paragraphs");
  assert.equal(longer.text, "A longer paragraph, of about sixty characters, outside it.");
  const tie = extractArticle(`<body><article><p>The same paragraph found two ways, both over forty characters.</p></article></body>`);
  assert.equal(tie.source, "article");
});

test("the page's summary is the last resort: the meta description, else og:description", () => {
  const both = `<head><meta name="description" content="Prices rose &amp; rents   followed."><meta property="og:description" content="The og summary."></head><body><div>No paragraphs here.</div></body>`;
  assert.deepEqual(extractArticle(both), { text: "Prices rose & rents followed.", title: null, source: "meta" });
  const og = extractArticle(`<head><meta property="og:description" content="The og summary."></head><body></body>`);
  assert.equal(og.text, "The og summary.");
  assert.equal(og.source, "meta");
  assert.deepEqual(extractArticle("<html><body><div></div></body></html>"), { text: "", title: null, source: "none" });
});

test("the title is og:title, else <title>, and never an icon's <title>", () => {
  assert.equal(extractArticle(`<head><title>Page | Gulf Paper</title><meta property="og:title" content="Prices &amp; rents rise"></head>`).title, "Prices & rents rise");
  assert.equal(extractArticle(`<head><meta name="og:title" content="Named, not a property"></head>`).title, "Named, not a property");
  assert.equal(extractArticle(`<head><meta property="og:title" content="  "><title>  Prices
    rise </title></head>`).title, "Prices rise");
  assert.equal(extractArticle(`<body><svg><title>Share on Facebook</title></svg><p>Text</p></body>`).title, null);
  assert.equal(extractArticle(`<HTML><HEAD><TITLE>Upper case</TITLE></HEAD></HTML>`).title, "Upper case");
});

test("text is plain: entities decoded, whitespace collapsed, invisible characters dropped", () => {
  const page = extractArticle(`<article><p>Engel &amp; V&ouml;lkers&nbsp;and  Sotheby&#8217;s
    opened\toffices in Abu Dha&shy;bi and Dubai&#x200B;.</p><p>Second <b>bold</b><br>line.</p></article>`);
  assert.equal(page.text, "Engel & Völkers and Sotheby’s opened offices in Abu Dhabi and Dubai.\nSecond bold line.");
});

test("malformed HTML never throws", () => {
  const inputs: unknown[] = [
    "",
    "<",
    "<<<>>>",
    "<p>unclosed <b>bold <i>italic",
    "</div></div></p><p>Stray closing tags before a paragraph.</p>",
    `<div class="a" id='b' data-x=unquoted <p>broken attribute</p>`,
    "<!-- a comment that never ends <p>hidden</p>",
    "<script>never closed",
    "<script type=\"application/ld+json\">[[[[{{{{",
    "\u0000￿ binary \ud800 junk \u0007",
    "<p>" + "x".repeat(100_000),
    undefined,
    null,
    42,
  ];
  for (const input of inputs) {
    const page = extractArticle(input as string);
    assert.equal(typeof page.text, "string");
    assert.ok(["jsonld", "articlebody", "article", "main", "paragraphs", "meta", "none"].includes(page.source));
  }
});

test("a page cut off part way still gives up its paragraphs", () => {
  const page = extractArticle(`<html><body><main><article>${paragraphs(STORY.slice(0, 3))}<p>Half a sen`);
  assert.equal(page.text, [STORY[0], STORY[1], STORY[2]].join("\n"));
});

test("a page with tens of thousands of unclosed tags is read quickly", () => {
  const started = Date.now();
  const page = extractArticle("<div>".repeat(50_000) + `<p>${STORY[0]}</p>` + "<span>".repeat(20_000));
  assert.equal(page.text, STORY[0]);
  assert.ok(Date.now() - started < 5_000, `took ${Date.now() - started} ms`);
  // Nested landmarks and forms are each looked through once, not once for every one above them.
  for (const tag of ["article", "main", "form", "aside"]) {
    const begun = Date.now();
    extractArticle(`<${tag}>`.repeat(20_000) + `<h1>Prices rise</h1><p>${STORY[0]}</p>`);
    assert.ok(Date.now() - begun < 5_000, `${tag}: took ${Date.now() - begun} ms`);
  }
});

test("tidyText puts text from elsewhere in the same shape", () => {
  assert.equal(tidyText("  First   line \r\n\r\n Second\tline \n We use cookies to improve your experience. \n First line "), "First line\nSecond line");
  assert.equal(tidyText(""), "");
});
