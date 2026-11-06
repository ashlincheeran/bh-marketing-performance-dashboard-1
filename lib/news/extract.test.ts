import { test } from "node:test";
import assert from "node:assert/strict";
import { OK_CHARS, extractArticle, saysNotFound, tidyText, wallLineIn } from "@/lib/news/extract";

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
  // The author the article data names is read as the story's byline.
  assert.equal(page.text, "By A Writer\nFirst line of the story.\nSecond line, with a stray ' escape.");
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

test("<article>: the longest article's own lines, its header and footer as credits, without its other furniture or the articles nested in it", () => {
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
  // The article's own header and footer are read as its credits, the header before the story and the
  // footer after it. The paragraphs alone decide that the article was read in full.
  assert.equal(page.text, ["Prices rise", "By Staff Writer", WHOLE, "Tags: property, Dubai, prices"].join("\n"));
  assert.equal(page.storyChars, WHOLE.length);
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

test("the page's paragraphs: 40 characters or more decide, the lines beside them come too, outside the furniture, and no notices", () => {
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
  // The short caption sits beside the story, so it is read with it, but only the story's own
  // paragraphs of 40 characters or more count towards a read in full.
  assert.equal(page.text, `Short caption.\n${WHOLE}`);
  assert.equal(page.storyChars, WHOLE.length);
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
  assert.deepEqual(extractArticle(both), { text: "Prices rose & rents followed.", title: null, source: "meta", storyChars: 0 });
  const og = extractArticle(`<head><meta property="og:description" content="The og summary."></head><body></body>`);
  assert.equal(og.text, "The og summary.");
  assert.equal(og.source, "meta");
  assert.deepEqual(extractArticle("<html><body><div></div></body></html>"), { text: "", title: null, source: "none", storyChars: 0 });
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
  // A <br> starts a new line, in a paragraph as in the marked body.
  assert.equal(page.text, "Engel & Völkers and Sotheby’s opened offices in Abu Dhabi and Dubai.\nSecond bold\nline.");
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
  // The cut-off paragraph is left as text beside the others, and is read with them, but it is too
  // little for the page to count as read in full.
  assert.equal(page.text, [STORY[0], STORY[1], STORY[2], "Half a sen"].join("\n"));
  assert.ok(page.storyChars < OK_CHARS);
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

// The review's cases (docs/news-pipeline.md rule 4): only a whole story read in full may name nobody.

const P1 =
  "Sales of homes worth more than Dh10 million in Dubai reached a record in the three months to September, as wealthy buyers from Europe and Asia continued to move money into the emirate's prime districts.";
const P2 =
  "More than 1,200 such homes changed hands in the quarter, up 18 per cent on a year earlier, with Palm Jumeirah, Emirates Hills and Jumeirah Bay Island accounting for nearly half of the deals by value.";
const P3 = "Analysts expect growth to slow next year as thousands of new homes are handed over across the city.";
const NAMED = "Louis Harding, chief executive of Knight Frank Middle East, said betterhomes and other agencies were seeing record enquiries.";

test("a story the page says goes on behind a paywall is walled, however long its opening", () => {
  const wall = `<div class="paywall"><h2>This article is for subscribers</h2><p>Already a subscriber? Sign in to continue reading.</p>
    <p>Get unlimited access to every story, the daily briefing and the Gulf Herald app from Dh25 a month.</p><a href="/subscribe">Subscribe</a></div>`;
  const marked = ldJson({ "@type": "NewsArticle", isAccessibleForFree: false, hasPart: { "@type": "WebPageElement", isAccessibleForFree: false, cssSelector: ".paywall" } });
  const teaser = extractArticle(`<head>${marked}</head><body><article><h1>Luxury sales hit a record</h1><p>${P1}</p><p>${P2}</p>${wall}</article></body>`);
  assert.equal(teaser.walled, true);
  assert.ok(teaser.storyChars >= OK_CHARS, "the opening alone is long enough, which is why the mark matters");
  assert.ok(teaser.text.includes(P1) && teaser.text.includes(P2));
  // The mark as some publishers write it, a string on the article itself.
  const stringly = extractArticle(`${ldJson({ "@type": "NewsArticle", isAccessibleForFree: "False" })}<article><p>${P1}</p><p>${P2}</p></article>`);
  assert.equal(stringly.walled, true);
  // No mark, but the paywall's own line among the story's.
  const unmarked = extractArticle(`<article><p>${P1}</p><p>${P2}</p><p>Already a subscriber? Sign in to continue reading.</p></article>`);
  assert.equal(unmarked.walled, true);
  // A soft paywall sends the part it marks, and the story was all there.
  const soft = extractArticle(`${ldJson({ "@type": "NewsArticle", isAccessibleForFree: false, hasPart: { "@type": "WebPageElement", isAccessibleForFree: false, cssSelector: ".premium" } })}
    <article><p>${P1}</p><div class="premium"><p>${P2}</p><p>${P3}</p><p>${NAMED}</p></div></article>`);
  assert.equal("walled" in soft, false);
  // A free article says nothing of the kind.
  const free = extractArticle(`${ldJson({ "@type": "NewsArticle", isAccessibleForFree: true })}<article>${paragraphs(STORY)}</article>`);
  assert.equal("walled" in free, false);
});

test("names in lists, tables, headings, quotes and captions are read, but only paragraphs count towards a read in full", () => {
  const intro = [
    "Dubai's secondary market recorded more than 40,000 resale transactions in the first nine months of the year, according to Dubai Land Department figures, a record for the period.",
    "Five brokerages handled more than a third of those deals between them, as buyers increasingly turned to established agencies with large teams and long track records in the emirate.",
  ];
  const ranking = extractArticle(`<article><h1>Dubai's busiest brokerages of 2026</h1>${paragraphs(intro)}
    <h2>The top five by transactions</h2>
    <ol><li><strong>betterhomes</strong>: 2,140 transactions</li><li><strong>Allsopp &amp; Allsopp</strong>: 1,980 transactions</li></ol>
    <table><tr><th>Brokerage</th><th>Share of resales</th></tr><tr><td>Knight Frank</td><td>4.1 per cent</td></tr></table>
    <h3>Betterhomes: 'We expect another record year'</h3>
    <blockquote><p>"Demand from end users has never been stronger."</p><cite>Louis Harding, Knight Frank</cite></blockquote>
    <figure><img src="x.jpg"><figcaption>Agents from fam Properties at the Cityscape show.</figcaption></figure>
  </article>`);
  assert.equal(ranking.source, "article");
  for (const line of ["betterhomes: 2,140 transactions", "Allsopp & Allsopp: 1,980 transactions", "Knight Frank", "Betterhomes: 'We expect another record year'", "Louis Harding, Knight Frank", "Agents from fam Properties at the Cityscape show."]) {
    assert.ok(ranking.text.split("\n").includes(line), line);
  }
  // The intro and the quote's paragraph are the story's paragraphs; the rest only proves who is named.
  assert.equal(ranking.storyChars, [...intro, '"Demand from end users has never been stronger."'].join("\n").length);

  // With no article or main, the short lines beside the story's paragraphs are read with them.
  const plain = extractArticle(`<body><div class="story">${paragraphs(STORY.slice(0, 4))}<p>Betterhomes declined to comment.</p><p>&mdash; Louis Harding, Knight Frank</p></div></body>`);
  assert.equal(plain.source, "paragraphs");
  assert.ok(plain.text.includes("Betterhomes declined to comment."));
  assert.ok(plain.text.includes("Louis Harding, Knight Frank"));
  assert.equal(plain.storyChars, STORY.slice(0, 4).join("\n").length);

  // A teaser padded out with a dozen related links is still a teaser.
  const links = Array.from({ length: 12 }, (_, i) => `<li><a href="/story-${i}">Dubai property story number ${i} that sits beside this one</a></li>`).join("");
  const padded = extractArticle(`<article><p>Only the first paragraph of this story is free to read on the site.</p><ul>${links}</ul></article>`);
  assert.ok(padded.storyChars < OK_CHARS);
});

test("a line outside a paragraph that is only a link is another story's, and is left out; a paragraph is always kept", () => {
  const page = extractArticle(`<article>${paragraphs(STORY)}
    <h3>Related</h3><ul class="related"><li><a href="/kf">Knight Frank says prime prices will keep rising</a></li></ul>
    <div class="card"><a href="/other"><h4>Allsopp &amp; Allsopp opens a new office</a></h4></div>
    <div class="tags"><a href="/t/dubai">Dubai</a> <a href="/t/property">Property</a></div>
    <p><a href="/report">Haus &amp; Haus published its full report on the market this week</a></p>
  </article>`);
  assert.equal(page.source, "article");
  assert.ok(!page.text.includes("Knight Frank says prime prices"), page.text);
  assert.ok(!page.text.includes("Allsopp & Allsopp opens"), page.text);
  assert.ok(!page.text.includes("Dubai Property"), page.text);
  assert.ok(page.text.includes("Haus & Haus published its full report"), "a paragraph that is all link is still read, as it always was");
});

test("a declared body that is only the story's opening gives way to the same story told in full", () => {
  // JSON-LD that says itself it stops short, with an ellipsis.
  const excerpt = extractArticle(`<head>${ldJson({ "@type": "NewsArticle", articleBody: `${P1} ${P2} \u2026` })}</head>
    <body><article>${paragraphs([P1, P2, P3, NAMED])}</article></body>`);
  assert.equal(excerpt.source, "article");
  assert.ok(excerpt.text.includes(NAMED));
  // JSON-LD that is clearly shorter than the story it opens.
  const opening = extractArticle(`${ldJson({ "@type": "NewsArticle", articleBody: `${P1}\n${P2}` })}
    <article>${paragraphs([P1, P2, P3, NAMED, STORY[4]])}</article>`);
  assert.equal(opening.source, "article");
  assert.ok(opening.text.includes(NAMED));
  // A marked body that holds only the first part of the story.
  const marked = extractArticle(`<article><div itemprop="articleBody">${paragraphs([P1, P2])}</div>${paragraphs([P3, NAMED, STORY[4]])}</article>`);
  assert.equal(marked.source, "article");
  assert.ok(marked.text.includes(NAMED));
  // A whole body in the article data stays the find when the page's version is barely longer.
  const whole = extractArticle(`${ldJson({ "@type": "NewsArticle", articleBody: WHOLE })}<article>${paragraphs(STORY)}<p>A short caption under the photograph.</p></article>`);
  assert.equal(whole.source, "jsonld");
  assert.equal(whole.text, WHOLE);
});

test("a crafted page of tag openers that never close is read in a moment, not in the square of its length", () => {
  const started = Date.now();
  const page = extractArticle(`<article>${paragraphs(STORY)}</article>` + "<b".repeat(1_500_000) + ">");
  assert.ok(Date.now() - started < 3_000, `took ${Date.now() - started} ms`);
  assert.equal(page.text, WHOLE);
});

test("a byline, a standfirst and a note on the author are read as the story's credits, and never count towards a read in full", () => {
  const body = [
    "Anyone who has rented a flat in Dubai knows the ritual: every twelve months, a new contract, a new cheque book and a new round of negotiation with a landlord.",
    "Longer leases would give families the certainty they need to put down roots, and give owners the steady income that lenders and investors value far more.",
    "The rental index has done a great deal to make increases predictable. The next step is to let both sides agree three or five year terms from the start.",
  ];
  const oped = extractArticle(`<head>${ldJson({ "@type": "OpinionNewsArticle", author: { "@type": "Person", name: "Louis Harding", jobTitle: "Chief executive", worksFor: { "@type": "Organization", name: "Knight Frank Middle East" } } })}</head>
    <body><article><header><h1>Why Dubai needs longer leases</h1><p class="standfirst">Three-year terms would suit tenants and owners alike.</p><p class="byline">By Louis Harding</p></header>
    ${paragraphs(body)}
    <footer class="author-bio"><p>Louis Harding is the chief executive of Knight Frank Middle East.</p></footer></article></body>`);
  assert.equal(oped.source, "article");
  const lines = oped.text.split("\n");
  for (const line of ["By Louis Harding, Chief executive, Knight Frank Middle East", "Three-year terms would suit tenants and owners alike.", "By Louis Harding", "Louis Harding is the chief executive of Knight Frank Middle East."]) {
    assert.ok(lines.includes(line), line);
  }
  assert.equal(oped.storyChars, body.join("\n").length);

  // WordPress writes the byline as nested spans in the entry header, and links the author's page.
  const wordpress = extractArticle(`<article><header class="entry-header"><h1>Rents rise</h1><div class="entry-meta"><span class="byline">by <span class="author vcard"><a class="url fn n" href="/author/louis-harding/">Louis Harding</a></span></span></div></header>
    <div class="entry-content">${paragraphs(STORY)}</div></article>`);
  assert.ok(wordpress.text.split("\n").includes("by Louis Harding"), wordpress.text);
  // The page's own note of who wrote it.
  assert.ok(extractArticle(`<head><meta name="author" content="Louis Harding"></head><article>${paragraphs(STORY)}</article>`).text.startsWith("By Louis Harding\n"));

  // A teaser with a long note on its author is still a teaser.
  const bio = "Louis Harding has led Knight Frank in the Middle East since 2026, and before that ran betterhomes for a decade. ".repeat(4);
  const short = extractArticle(`<article><p>Only the first paragraph of this story is free to read on the site.</p><footer><p>${bio}</p></footer></article>`);
  assert.ok(short.storyChars < OK_CHARS);
  assert.ok(short.text.length >= OK_CHARS);

  // Another story's card, and a sidebar, are not this story's credits.
  const cards = extractArticle(`<article class="story">${paragraphs(STORY)}</article>
    <article class="card"><header><h3>Haus &amp; Haus opens in Abu Dhabi</h3></header><span class="author">Jane Doe</span><p>A short card.</p></article>
    <aside><div class="author-box">Engel &amp; Voelkers columnist of the week</div></aside>`);
  assert.equal(cards.text, WHOLE);
});

test("a script, style or noscript closed in another case or with a space ends where a browser ends it", () => {
  const closers = [
    "<script>window.ads = 1;</script >",
    '<SCRIPT type="text/javascript" src="https://ads.example/tag.js"></script>',
    '<noscript><img src="https://px.example/p.gif"></NOSCRIPT>',
    "<style>p { color: red; }</STYLE>",
    "<script>var x = 1;</script\n>",
    "<Script>var y = 2;</sCrIpT>",
  ];
  for (const closer of closers) {
    const page = extractArticle(`<html><body><article><p>${P1}</p><p>${P2}</p>${closer}<p>${NAMED}</p></article></body></html>`);
    assert.ok(page.text.endsWith(NAMED), `${closer}: ${page.text.slice(-80)}`);
  }
  // Article data in an upper-case script is still read.
  assert.equal(extractArticle(`<SCRIPT TYPE="application/ld+json">${JSON.stringify({ "@type": "NewsArticle", articleBody: WHOLE })}</SCRIPT>`).source, "jsonld");
});

test("a page that calls itself not found is marked so, and a story that merely starts the same way is not", () => {
  const notFound = [
    `<head><title>Page not found | Gulf Paper</title></head><body><main>${paragraphs(STORY)}</main></body>`,
    `<head><title>404 - Gulf Paper</title></head><body></body>`,
    `<head><title>Gulf Paper | News from the UAE</title></head><body><main><h1>Page not found</h1><p>Sorry, the page you were looking for may have been moved.</p>${paragraphs(STORY)}</main></body>`,
    `<body><header class="page-header"><h1 class="page-title">Oops! That page can&rsquo;t be found.</h1></header></body>`,
  ];
  for (const html of notFound) assert.equal(extractArticle(html).notFound, true, html.slice(0, 80));
  const story = extractArticle(`<head><title>Not found: the missing millions of Dubai's property market | Gulf Paper</title></head><body><article>${paragraphs(STORY)}</article></body>`);
  assert.equal("notFound" in story, false);
  assert.equal(saysNotFound("Error 404"), true);
  assert.equal(saysNotFound("Sorry, we couldn't find that page"), true);
  assert.equal(saysNotFound("404 error: why Dubai's property portals keep crashing"), false);
  assert.equal(saysNotFound(null), false);
});

test("short of the whole story, what the other ways found is kept, since it can still prove a mention", () => {
  // The article data holds only the opening, and the page writes its paragraphs as <div>s.
  const lead = "Dubai's residential property market continues to attract buyers despite the conflict in West Asia, with some investors viewing the correction in prices as a chance to buy.";
  const page = extractArticle(`${ldJson({ "@type": "NewsArticle", articleBody: lead })}
    <article><div>${P1}</div><div>Gulam Zia, international partner at Knight Frank India, said selective interest from global investors remained.</div></article>`);
  assert.equal(page.source, "jsonld");
  assert.equal(page.storyChars, lead.length);
  assert.ok(page.text.includes("Knight Frank India"), page.text);
});

test("wallLineIn finds a paywall's own line in text from elsewhere", () => {
  assert.equal(wallLineIn("Prices rose.\nSubscribe to continue reading.\n"), true);
  assert.equal(wallLineIn("To continue reading, subscribe to the Gulf Herald."), true);
  assert.equal(wallLineIn(WHOLE), false);
  assert.equal(wallLineIn(""), false);
});

test("an <article> outside the page's <main> is a card for another story, however long, and the <main> is read instead", () => {
  const page = extractArticle(`<html><body><main><h1>Prime prices rise</h1><p>${P3}</p><p>${NAMED}</p><p>${P1}</p></main>
    <div class="related"><article><p>${P1}</p><p>${P2}</p></article></div></body></html>`);
  assert.equal(page.source, "main");
  assert.ok(page.text.includes(NAMED));
  // Without a <main>, an <article> is still the first landmark looked at.
  const bare = extractArticle(`<body><div class="related"><article>${paragraphs(STORY)}</article></div></body>`);
  assert.equal(bare.source, "article");
});
