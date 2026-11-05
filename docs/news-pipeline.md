# News bot: how it works

Every morning the news bot finds press coverage of betterhomes and its rivals,
reads it, and sorts each article as ours, a rival's, both, or rejected. The
PR & Media tab counts what it keeps.

```
08:00 Dubai  search ─▶ read ─▶ check ─▶ mentions (PR & Media)
             Google     free      Claude
             News       page      Haiku
                        read
                                  check ─▶ held ─▶ publish ─▶ mentions
                                  (counting off)   (counting back on)
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
6. **A person's Keep or Reject always stands** over the bot's. The bot never
   changes a row a person decided, writes nothing for an article a person
   rejected on Bot Activity, and no re-check sends back an article a person
   kept or rejected.
7. **One run per article at a time.** Steps claim articles through
   `claim_news_articles`, so two runs (or two deployments) never handle the
   same article, and a run that dies gives its claims back after the lease.
8. **A story counts once.** An imported story that turns out to be the same
   article as another stored one is that article's duplicate, and the old
   bot's row for it stops counting (see "Duplicates of imported stories").
9. **Test mode changes nothing on the PR tab.** With counting off in Settings
   the bot still finds, reads and sorts everything, but writes nothing to
   `mentions` until counting is switched back on.

## Statuses (news_articles.status)

| Status | Meaning | Next |
|---|---|---|
| queued | found, waiting to be read | read step |
| reading | claimed by a read run | read, no_names, unreadable, duplicate |
| read | a tracked name was found | check step |
| checking | claimed by a check run | decided or held, or back to read on an AI failure |
| decided | the AI sorted it; `decision` holds the result, and it is written to mentions | final |
| held | the AI sorted it while counting was off (test mode); `decision` holds the result, nothing is in mentions yet | publish step |
| no_names | read in full, no tracked company or person named | final (free reject) |
| unreadable | not readable and the headline names nobody | back to queued after `next_try_at`, 3 tries |
| skipped | the headline itself rules it out (Better Homes & Gardens) | final |
| duplicate | the same article as `dup_of` | final |
| failed | the AI failed on it three times | a person |

## Who the bot looks for (lib/news/registry.ts)

- **Companies:** betterhomes, plus every active rival in `tracked_keywords`
  (kind `competitor`), keyed by its label: Allsopp & Allsopp, Haus & Haus,
  Driven Properties, Engel & Völkers, Metropolitan, Sotheby's, White & Co,
  fäm Properties, Knight Frank.
- **A rival's spellings** are its list in `COMPANY_ALIASES`, and only that
  list: the label is not added on top. A rival with no list is known by its
  label alone. Bare words that also mean something else are left out on
  purpose: "Metropolitan" alone matches "metropolitan area", "White Co"
  matches "white collar". Engel & Völkers is also written with "oe" for the
  "ö" (Engel & Voelkers).
- **A company name written another way** ("knight frank", "Engel and Volkers",
  "Allsopp and Allsopp") means the company it plainly does: the label exactly,
  then the label ignoring case, accents, apostrophes and "&" or "and", then
  one of the company's spellings (`companyNamed`). Rows are always written
  under the label.
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

**Hand-off.** Each link calls the next with the cron secret. In production it
calls the public domain (`https://` and `VERCEL_PROJECT_PRODUCTION_URL`),
since a deployment's own address sits behind Vercel's login; anywhere else,
or when that variable is not set, the address the request came in on. When
`VERCEL_AUTOMATION_BYPASS_SECRET` is set, the protection bypass goes along,
which is what lets a preview's links call each other.

**search** (cron 04:00 UTC, 08:00 Dubai)
1. Unreadable articles whose retry time has come go back to queued.
2. Searches: `betterhomes` always, whatever the PR keyword list holds; every
   active keyword in `tracked_keywords` (kind `pr`); every rival's query; and
   `"<name>" dubai` for every current person. Each gets the Google News time
   filter from Settings (`when:2d` by default).
3. Results whose headline or outlet names Better Homes & Gardens or
   BetterHome Group are stored as skipped. Everything new is stored as queued.
   The repeat lookups go a few thousand characters of links at a time, since
   a lookup's values travel in the request's address.
4. Chain: read.

**read**
1. Claim queued articles, newest first.
2. Unwrap the Google link (lib/googleNews.ts, free). If the address already
   belongs to another stored article, this one is a duplicate. An imported
   duplicate's old row stops counting at once, or at the publish step in
   test mode (see "Duplicates of imported stories").
3. Read the page with a plain request and extract the article text
   (lib/news/extract.ts). If that fails and Settings allows it, Apify reads it,
   within the monthly cap, and only while 150 seconds or more of the step's
   200 remain: one Apify read can take minutes.
4. Spot the tracked names in the headline and text (lib/news/spot.ts).
   - names found: status read, candidates saved
   - read in full, no names: no_names
   - not readable, no names: unreadable, `next_try_at` tomorrow
5. Chain: read again while articles are queued, then check.

**check**
1. Claim read articles. Settings' `countOnPrTab` is read once for the step.
2. Ask Claude (model from Settings, Haiku 5.5 by default) to sort each one,
   then check its answer (lib/news/classify.ts).
3. Counting on: write what counts to `mentions` (lib/news/write.ts) and the
   decision to the article, status decided. An article a person rejected on
   Bot Activity is decided with nothing written. Counting off (test mode):
   save the decision on the article, status held, and write nothing.
4. If the AI itself fails, put the articles back in read and stop.
5. Chain: check again while articles wait; then, when counting is on and
   articles are still held (counting was switched on during a test-mode
   check, or their publish failed), publish; then the summary.

**publish** (when counting is switched back on, or after a check as above)
1. With counting still off it does nothing, and says so in its log.
2. Read held articles twenty at a time, oldest first, and write each saved
   decision with `writeDecision`, the registry and rate card loaded once.
   Save each as decided. A held article a person rejected is decided with
   nothing written; one held without a decision goes back to read; one whose
   write fails stays held, and the step moves on past it.
3. Once nothing is left held, take the old row of every imported duplicate
   out of the count. Rows already out are left as they are, so every publish
   can sweep them all.
4. Chain: publish again while held articles wait, then the summary.

**The end of a chain**
1. The run's summary goes to `ingest_runs` (what Bot Activity and Settings
   show as the bot's last run): found is the new articles stored, considered
   the articles read that name someone, inserted the `mentions` rows new to
   the table that the checks and the publish step added (an old row brought
   up to date is not new coverage), skipped what was turned down.
2. The PR insights are refreshed (lib/insights.ts `refreshInsightsCache`),
   so the PR tab's advice reads the coverage just counted. Best effort: at
   most 60 seconds, never past the function's limit, a failure is only
   logged. Not when the run stopped because the AI failed, not without a
   Claude key, and not in test mode: a test run counts nothing, and the
   cached set is shared with production.

## Test mode (Settings: Count on the PR tab)

Production and the preview share one database, and production runs the old
bot until this branch is merged. Test mode is how the new bot is tried on the
preview without changing the live PR tab.

- `countOnPrTab: false` turns counting off. Only an explicit false does: a
  missing value counts, so a fresh install counts what it finds.
- With counting off the check step still asks the AI and saves its decision,
  but marks the article held instead of writing it to `mentions`, and the
  read step leaves imported duplicates' old rows counting. Bot Activity shows
  held articles, so the PR team can see what the bot would count before it
  counts.
- Switching counting back on runs the publish step (Settings starts it),
  which writes every held decision, oldest first, and marks it decided.

## Moving from the old bot (lib/news/migrate.ts)

Run these from the preview with counting off, one chain at a time, each when
the last has finished (Bot Activity shows the queue):

1. **seed**, once: `POST /api/news?step=seed`. Every story the old bot kept or
   turned down (mentions with source googlenews or competitor_news) is stored
   as an article already decided, with `legacy_mention_id`, so the new bot
   treats it as seen and never reads or judges it again by accident. Safe to
   run again: what it stored the first time is skipped.
2. **recheck**, each kind once: `POST /api/news?step=recheck&kind=<kind>`.
   The chosen stories go back through read and check, so the new rules decide
   them. A re-queued article gets the note "re-checking the old bot's story",
   and `writeDecision` then updates the old row rather than adding a second.
   - `unchecked_ours`: our old rows still counting (status new) that the old
     fact check never looked at.
   - `pending_reread`: our old rows the old fact check took out of the count
     because it could not read the page (status rejected, `factCheck.result`
     "unread"), with no person's verdict.
   - `rivals`: every old rival row, of any year and any status, with no
     person's verdict.

   Left alone: articles a person kept or rejected on Bot Activity (their note
   starts "kept by a person" or "rejected by a person"), articles a run is
   working on, duplicates, and articles with nothing to read.

   Before re-queueing, the rows a person rejected on the old Bot Activity are
   marked as theirs. That screen's Reject set the status and nothing else, but
   status rejected together with `metadata.recoveredBy` "backfill" can only
   come from a person: the retired backfill put the rows it recovered back to
   new, and no bot of that time rejected one again. Those rows get
   `metadata.personVerdict` "rejected", so nothing counts them again. Rows the
   new bot or the new Bot Activity wrote carry `metadata.articleId` and are
   left out. Safe to run again; the recheck's log counts them as
   `markedRejected`.
3. **publish**: switch counting on once Bot Activity looks right.

## Duplicates of imported stories

When the read step finds that an imported article's address belongs to
another stored article, the imported one is saved as that article's duplicate,
and the other article counts the story from now on. The old bot's row the
import came from would otherwise go on counting too, so the story would count
twice. That row is rejected with `metadata.reason` "news check: the same story
as article <id>" and a failed `factCheck` that keeps the status it had, as a
check's rejection does (lib/news/write.ts `withdrawLegacyRow`). A row a person
decided is never touched. With counting on the read step does this at once;
in test mode the publish step does it, for every imported duplicate.

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
- Nothing is written while counting is off: held decisions reach `mentions`
  through the publish step.

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
- The answer's company, role and tone are sent as plain strings, with the
  allowed values in their descriptions. The API would not enforce a list of
  values anyway, and the SDK's own check of one would fail the whole answer
  over one word. The program settles each claim: a company written another
  way is its label, one that is no tracked company is refused (and recorded),
  an unknown role counts as named in passing and an unknown tone as neutral.
- Failures: no key, no credit or spend limit reached, auth errors, and a
  model the key can't use (a 404, such as a model retired since it was chosen
  in Settings) stop the check step for the day. Rate limits and server errors
  are retried by the SDK; an article that still fails goes back to read, and
  after three failures to failed.

## The PR insights (lib/insights.ts)

The advice cards on the PR tab are written by Claude, with the same key and
the model chosen in Settings, since Gemini ran out of credit in October 2026.
Every chain that ends refreshes the cached set (see "The end of a chain"),
and "Receive Insights" writes a set for the range the PR team picks.

## Settings (app_settings.payload.news)

`model` (Haiku 5.5, Sonnet 5.5 or Opus 5.5), `apifyBackup` (off), `apifyMonthlyCap` (30),
`searchWindow` ("2d"), `countOnPrTab` (on; off is test mode).

## Bot Activity (PR page)

This morning's run in numbers; every stored article with what happened to it
and why, with Keep and Reject; held articles while counting is off; possible
moves; and the spokespeople list, editable.
