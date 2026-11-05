# News bot: how it works

Every morning the news bot finds press coverage of betterhomes and its rivals,
reads it, and sorts each article as ours, a rival's, both, or rejected. The
PR & Media tab counts what it keeps.

```
08:00 Dubai  search ─▶ read ─▶ check ─▶ mentions (PR & Media)
             Google     free      Claude
             News       page      Haiku
                        read
```

## The rules that matter

1. **Every article is stored once, the first time it is found** (`news_articles`).
   A repeat is dropped before anything reads it or sends it to the AI. Repeats
   are caught three ways: the same Google link, the same headline at the same
   outlet, and, once the link is unwrapped, the same address.
2. **A program does the cheap work, the AI only sorts.** The program reads the
   page and finds the sentences that name a tracked company or person. An
   article that names nobody is rejected for free. Only articles with a
   tracked name go to the AI.
3. **The AI rejects only the clearly irrelevant** and sorts the rest by
   company. It must point at the sentence that proves each company, and the
   program checks that sentence really names that company or one of its
   people. A claim the program refuses is dropped and recorded.
4. **No article text, no conclusion from absence.** If a page can't be read,
   the headline and any text that came back can still prove a mention, but
   finding nothing proves nothing: the article waits as unreadable and is
   tried again on later mornings, up to three times.
5. **Nothing counts unchecked.** If the AI can't answer (no key, no credit,
   errors), articles wait in `read` and nothing new counts that morning.
6. **A person's Keep or Reject always stands** over the bot's.
7. **One run per article at a time.** Steps claim articles through
   `claim_news_articles`, so two runs (or two deployments) never handle the
   same article, and a run that dies gives its claims back after the lease.

## Statuses (news_articles.status)

| Status | Meaning | Next |
|---|---|---|
| queued | found, waiting to be read | read step |
| reading | claimed by a read run | read, no_names, unreadable, duplicate |
| read | a tracked name was found | check step |
| checking | claimed by a check run | decided, or back to read on an AI failure |
| decided | the AI sorted it; `decision` holds the result | final |
| no_names | read in full, no tracked company or person named | final (free reject) |
| unreadable | not readable and the headline names nobody | back to queued after `next_try_at`, 3 tries |
| skipped | the headline itself rules it out (Better Homes & Gardens) | final |
| duplicate | the same article as `dup_of` | final |
| failed | the AI failed on it three times | a person |

## Who the bot looks for (lib/news/registry.ts)

- **Companies:** betterhomes, plus every active rival in `tracked_keywords`
  (kind `competitor`), keyed by its label: Allsopp & Allsopp, Haus & Haus,
  Driven Properties, Engel & Völkers, Metropolitan, Sotheby's, White & Co,
  fäm Properties, Knight Frank. Other spellings are in `COMPANY_ALIASES`.
  Bare words that also mean something else are left out on purpose:
  "Metropolitan" alone matches "metropolitan area", "White Co" matches
  "white collar".
- **betterhomes** is matched by the strict rules in lib/match.ts:
  "betterhomes" or "bhomes" as one word in any case, or "Better Homes" with
  both capitals outside a title-case headline. "Better Homes & Gardens" and
  "BetterHome Group" are struck out first.
- **People** come from `tracked_people`. A current person (`active`) counts
  for their company even when the sentence doesn't name it. A former person
  counts for their old company only when the article names that company.
  People move: Louis Harding (betterhomes CEO, then Knight Frank in 2026) and
  Jacob Fletcher (betterhomes, then Engel & Völkers) are on file under both,
  former at the old company.

## Steps

All steps run in `app/api/news/route.ts`. Each step works for up to 200
seconds, saves its place, and starts the next link of the chain, so the
300-second function limit never drops work. A run day has at most 40 links.

**search** (cron 04:00 UTC, 08:00 Dubai)
1. Unreadable articles whose retry time has come go back to queued.
2. Searches: every active keyword in `tracked_keywords` (kind `pr`), every
   rival's query, and `"<name>" dubai` for every current person. Each gets
   the Google News time filter from Settings (`when:2d` by default).
3. Results whose headline or outlet names Better Homes & Gardens or
   BetterHome Group are stored as skipped. Everything new is stored as queued.
4. Chain: read.

**read**
1. Claim queued articles, newest first.
2. Unwrap the Google link (lib/googleNews.ts, free). If the address already
   belongs to another stored article, this one is a duplicate.
3. Read the page with a plain request and extract the article text
   (lib/news/extract.ts). If that fails and Settings allows it, Apify reads it,
   within the monthly cap.
4. Spot the tracked names in the headline and text (lib/news/spot.ts).
   - names found: status read, candidates saved
   - read in full, no names: no_names
   - not readable, no names: unreadable, `next_try_at` tomorrow
5. Chain: read again while articles are queued, then check.

**check**
1. Claim read articles.
2. Ask Claude (model from Settings, Haiku 5.5 by default) to sort each one,
   then check its answer (lib/news/classify.ts).
3. Write what counts to `mentions` (lib/news/write.ts) and the decision to
   the article.
4. If the AI itself fails, put the articles back in read and stop.
5. Chain: check again while articles wait, then write the morning's summary
   to `ingest_runs` (what Bot Activity and Settings already show).

## What gets counted (mentions)

| AI result | mentions row |
|---|---|
| ours | `source` googlenews, `brand` betterhomes, `status` new |
| a rival | `source` competitor_news, `brand` null, `metadata.competitor` = the rival's label exactly |
| both | one row per company |
| rejected | none (the decision stays on the article for Bot Activity) |

- Row ids: `nb_<articleId>` for ours, `nr_<articleId>_<slug>` for a rival.
- An article imported from the old bot (`legacy_mention_id`) updates that
  existing row instead of adding a second one, for the brand that row was for.
- `metadata.factCheck` = `{ result: "pass", role, quote, sentence, checkedAt, model }`,
  so the PR table shows the proving sentence under the headline.
- A row a person kept (`status` reviewed) or rejected (`metadata.personVerdict`
  "rejected") is never changed by the bot.

## The AI (lib/news/classify.ts)

- Claude through the official SDK (`@anthropic-ai/sdk`), key in
  `ANTHROPIC_API_KEY`. Model from Settings; default `claude-haiku-5-5`.
  `output_config: { effort: "low", format: zodOutputFormat(...) }`. No
  temperature (the API refuses it).
- It is given: the companies and the ways their names are written, the
  current people and who they speak for, the former people, and the article's
  headline, outlet, date and numbered candidate sentences.
- Its instructions: reject only what is clearly irrelevant to every tracked
  company (a different company with a similar name such as Better Homes &
  Gardens or BetterHome Group, the Sotheby's auction house, an ordinary phrase
  such as "better homes", "metropolitan area" or "white collar", or a different
  person who shares a name). Keep and sort everything else: for each company
  the article is about, the number of the proving sentence, how it is mentioned
  (spokesperson quoted, its data, its own news, named in passing) and the tone
  toward that company. Report a listed person described at a different company
  as a possible move. When unsure, keep it.
- Failures: no key, no credit or spend limit reached, auth errors stop the
  check step for the day. Rate limits and server errors are retried by the SDK;
  an article that still fails goes back to read, and after three failures to
  failed.

## Settings (app_settings.payload.news)

`model` (Haiku 5.5, Sonnet 5.5 or Opus 5.5), `apifyBackup` (off), `apifyMonthlyCap` (30),
`searchWindow` ("2d").

## Bot Activity (PR page)

This morning's run in numbers; every stored article with what happened to it
and why, with Keep and Reject; possible moves; and the spokespeople list,
editable.
