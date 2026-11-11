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
   kept or rejected. That holds while a run is working on the article too
   (see "Keep and Reject while a run holds the article"), for an old row
   a person changed on the old Bot Activity since its story was imported, and
   for the 23 old rival rows rejected by hand in the rival feed's cleanup
   (`metadata.rejected_by`, reason "manual cleanup: not the competitor
   brokerage"), even when the AI would keep the story.
7. **One run per article at a time.** Steps claim articles through
   `claim_news_articles`, so two runs (or two deployments) never handle the
   same article, and a run that dies gives its claims back after the lease.
   A step saves an article only while it still holds it.
8. **A story counts once.** An imported story that turns out to be the same
   article as another stored one is that article's duplicate, and the old
   bot's row for it stops counting once that article has a verdict (see
   "Duplicates of imported stories").
9. **Test mode changes nothing on the PR tab.** With counting off in Settings
   the bot still finds, reads and sorts everything, but writes nothing to
   `mentions` until counting is switched back on.
10. **A company's own website is not its coverage** (decided by Ash, Nov
    2026), for the rivals and for us alike: Allsopp & Allsopp's blog, Dubai
    Sotheby's pages, a page on bhomes.com. `lib/news/ownSite.ts` reads each
    company's sites from its `tracked_keywords` row (`sites`, migration 0024:
    the first lists were each checked on 6 Nov 2026; betterhomes' are on its
    row of kind `us`) and, for a story with no address, matches the
    publisher's name against the company's spellings. Another
    company named on the page still counts for that company: the rule is
    about who published it. Applied at every point a story passes:
    - **read**: an own-site page that names only its publisher or its people
      is decided there, with no AI: a new one is `skipped` with the reason,
      an imported one is rejected like any other import (its old row stops
      counting, or is held in test mode). A new own-site page that can't be
      read is skipped too; an imported one is retried, as its old row may be
      another company's.
    - **check**: the same, for one read before the rule; otherwise the AI is
      asked as usual and the publisher is taken out of its answer, recorded
      in `dropped`.
    - **writing to `mentions`**: the publisher is taken out of any decision,
      so a decision held from before the rule never counts it either, and its
      old row stops counting with the reason "it is on <company>'s own
      website".
    - **import**: an old bot's row still counting on its own company's site
      comes in held with that decision, so the next publish takes it out.
    - **Bot Activity** shows every decision the way it would be written.

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
| unreadable | not readable and the headline names nobody | back to queued after `next_try_at`, 3 tries; a person's Keep, Count or Not about a company clears `next_try_at`, so it is not tried again |
| skipped | the headline itself rules it out (Better Homes & Gardens) | final |
| duplicate | the same article as `dup_of` | final |
| failed | the AI failed on it three times | a person |

A person's Reject on Bot Activity takes any article still open (queued to
failed above, reading and checking included) straight to decided, about no
company, whatever a run was doing with it.

## Who the bot looks for (lib/news/registry.ts)

- **Companies:** betterhomes, plus every active rival in `tracked_keywords`
  (kind `competitor`), keyed by its label: Allsopp & Allsopp, Haus & Haus,
  Driven Properties, Engel & Völkers, Metropolitan, Sotheby's, White & Co,
  fäm Properties, Knight Frank.
- **A rival's spellings** are the `aliases` of its `tracked_keywords` row
  (migration 0024), and only that list: the label is not added on top. A
  rival with no list is known by its label alone. Bare words that also mean
  something else are left out on purpose: "Metropolitan" alone matches
  "metropolitan area", "White Co" matches "white collar". Engel & Völkers is
  also written with "oe" for the "ö" (Engel & Voelkers).
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
which is what lets a preview's links call each other. A hand-off that is
refused ends the run, and says why on the run's last `news_runs` row (see
"The end of a chain"). Run now and Settings start a run the same way; when
the route refuses that first call, the first link runs inside the button's
own request, but its hand-off goes to the same address and is refused the
same way, so a preview without the bypass secret stops after its first link,
with the reason on Bot Activity.

**search** (cron 04:00 UTC, 08:00 Dubai)

A deployment with no Claude key starts no morning run, since it could never
check what it finds: a second Vercel project deploys this repo without the
key, on the same database, and stands down rather than repeat the search and
log a failure every morning. Run now still runs there.

1. Unreadable articles whose retry time has come go back to queued.
2. Searches: `betterhomes` always, whatever the PR keyword list holds; every
   active keyword in `tracked_keywords` (kind `pr`); every rival's query; and
   `"<name>" dubai` for every current person. Each gets the Google News time
   filter from Settings (`when:2d` by default).
3. Results whose headline or outlet names Better Homes & Gardens or
   BetterHome Group are stored as skipped. Everything new is stored as queued.
   The repeat lookups go a few thousand characters of links at a time, since
   a lookup's values travel in the request's address. Only the rows this
   search stored count as new, so two searches at once never both count one
   article.
4. Chain: read.

**read**
1. Claim queued articles, newest first.
2. Unwrap the Google link (lib/googleNews.ts, free). If the address already
   belongs to another stored article, this one is a duplicate. An imported
   duplicate's old row is left for the end of the check step (see
   "Duplicates of imported stories").
3. Read the page with a plain request and extract the article text
   (lib/news/extract.ts). If that fails and Settings allows it, Apify reads it,
   within the monthly cap, and only while 150 seconds or more of the step's
   200 remain: one Apify read can take minutes.
4. Spot the tracked names in the headline and text (lib/news/spot.ts).
   - names found: status read, candidates saved
   - not read, but the headline or outlet names another company with our
     name in it (Better Homes & Gardens, BetterHome Group): skipped, as the
     search step skips one; an old bot's story is rejected the same way
   - read in full, no names: no_names
   - not readable, no names: unreadable, `next_try_at` tomorrow

   The outcome is saved only while this run still holds the article, and a
   person's Keep or Reject note stays in place of the read's own.
5. Chain: read again while articles are queued, then check.

**check**
1. Claim read articles. Settings' `countOnPrTab` is read once for all of the
   step's articles.
2. Ask Claude (model from Settings, Haiku 5.5 by default) to sort each one,
   then check its answer (lib/news/classify.ts).
3. Counting on: look at the article once more, then write what counts to
   `mentions` (lib/news/write.ts) and the decision to the article, status
   decided. An article a person rejected on Bot Activity is decided with
   nothing written. Counting off (test mode): save the decision on the
   article, status held, and write nothing. Either save lands only while this
   run still holds the article.
4. If the AI itself fails, put the articles this run still holds back in read
   and stop.
5. Chain: check again while articles wait. The last check reads Settings'
   `countOnPrTab` again: when counting is on and articles are still held
   (counting was switched on during a test-mode check, or their publish
   failed), publish; then the summary.

**publish** (when counting is switched back on, or after a check as above)
1. With counting still off it does nothing, and says so in its log.
   Otherwise it first imports what the old bot stored since the last import.
   A story the old bot still counts is queued for the next run's read and
   check (not stored as decided), so nothing it added during the test window
   stays counted unchecked; until then it counts as the old bot left it. One
   on its own company's website comes in held, and is published here.
2. Read held articles twenty at a time, oldest first, and write each saved
   decision with `writeDecision`, the registry and rate card loaded once.
   Save each as decided. A held article a person rejected is decided with
   nothing written; one held without a decision goes back to read; one whose
   write fails stays held, and the step moves on past it. Publish takes no
   claim, so each article is looked at once more before its decision is
   written, and saved only while it is still held. Only the publish that moves
   an article from held to decided counts it, so two publishes at once count
   each article once.
3. Once nothing is left held, take the old row of every imported duplicate
   whose article has a verdict out of the count. Rows already out are left as
   they are, so every publish can sweep them all. The last check of a chain
   does the same when counting is on.
4. Chain: publish again while held articles wait, then the summary.

**The end of a chain**
1. The run's summary goes to `ingest_runs` (what Bot Activity and Settings
   show as the bot's last run): found is the new articles stored, considered
   the articles read that name someone, inserted the `mentions` rows new to
   the table that the checks and the publish step added (an old row brought
   up to date is not new coverage), skipped what was turned down.
2. How the chain ended, when that was more than running out of work (a next
   link that surely could not be started, or the 40-link limit), also goes
   on the run's last `news_runs` row, whatever the mode: the reason added to
   the row's error, and ok false, which Bot Activity shows as a problem. A
   preview's test run writes no summary, so this is its only record of it.
   A hand-off that got no answer records nothing, since the next link may
   well be running.
3. The PR insights are refreshed (lib/insights.ts `refreshInsightsCache`),
   so the PR tab's advice reads the coverage just counted. Best effort: at
   most 60 seconds, never past the function's limit, a failure is only
   logged. Not when the run stopped because the AI failed, not without a
   Claude key, and not in test mode: a test run counts nothing, and the
   cached set is shared with production.

## Keep and Reject while a run holds the article

Bot Activity offers Keep and Reject on an article a run is reading, checking
or about to publish, and the person's verdict wins.

- **Reject** closes the article first: decided, about no company, with the
  note "rejected by a person", and with any run's claim let go of. It does
  so only while the article is in the status it just read; when a run moved
  it on in between, it looks again and goes by where the article is now.
  Only then does it mark the article's rows.
- **A step saves an article only while it still holds it:** read and check
  while the run's claim is in place (`claimed_by`), publish while the article
  is still held. So a step that finishes after a Reject saves nothing over
  it, and gives nothing back over it either.
- **Check and publish look at the article again just before they write** to
  `mentions`, and write nothing once a person has closed it. Should the
  Reject land between that look and the save, the save is refused, and the
  step takes the rows it just wrote out of the count as the person's
  (lib/news/write.ts `markPersonRejected`). The Reject marks every row it
  finds, so between the two every row ends up rejected with their verdict.
- **Keep** decides our row, not the article: the row counts, reviewed, and
  no write of the bot changes it. The bot still sorts the article for the
  rivals, and a held article is still published. A read that finishes after
  a Keep keeps the person's note rather than writing its own, so the
  re-checks still leave the article alone.
- **Count for a company** (Check by hand) is Keep for the company named:
  betterhomes, or a tracked rival, whose `competitor_news` row is written
  the way the bot writes one, reviewed and with the person's verdict, so the
  competitor feed, Share of Voice and Press mentions count it and no
  re-check changes it. A company is never counted on its own website, by
  Keep either. Keep or Count on an unreadable article clears its
  `next_try_at`, so the morning's re-queue passes it by: a person has
  decided it, and its site turns the bot away anyway.
- **Not about a company** (Check by hand, where the article counts for
  another company already) is Reject for that company alone: its row is
  written the way the bot writes one, or marked when it has one, rejected
  with the person's verdict, and nothing else of the article changes, so
  what counts for the other company stays. It clears `next_try_at` too.

## Test mode (Settings: Count on the PR tab)

Production and the preview share one database, and production runs the old
bot until this branch is merged. Test mode is how the new bot is tried on the
preview without changing the live PR tab.

- `countOnPrTab: false` turns counting off. Only an explicit false does: a
  missing value counts, so a fresh install counts what it finds.
- With counting off the check step still asks the AI and saves its decision,
  but marks the article held instead of writing it to `mentions`, and
  imported duplicates' old rows are left counting. Bot Activity shows
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
   treats it as seen and never reads or judges it again by accident. A story
   the old bot stored twice (two links, two outlet spellings) becomes one
   article, the row that counts taken first, and the other row is stored as
   its duplicate. Safe to run again: what it stored the first time is skipped.
   Each article also records the status its old row had at the import
   (`legacy_status`, migration 0023, which filled it in for the stories
   imported before it). Publish runs the same import first, for the stories
   the old bot stored since.

   Until the merge, production runs the old Bot Activity, whose Keep and
   Reject set a row's status and nothing else. Its bot never changes a stored
   row's status, and everything the new bot and the new Bot Activity write
   leaves the article's id on the row. So when an old row's status differs
   from `legacy_status` and the row carries no `metadata.articleId`, a person
   changed it on the old screen, and the bot leaves it as it is, like any row
   a person decided (lib/news/write.ts `changedOnOldScreen`). Without this,
   publishing a held re-check would put a row a person rejected there during
   the test window back in the count.
2. **recheck**, each kind once: `POST /api/news?step=recheck&kind=<kind>`.
   The chosen stories go back through read and check, so the new rules decide
   them. A re-queued article gets the note "re-checking the old bot's story",
   and `writeDecision` then updates the old row rather than adding a second.
   An article goes back when its own old row, or its duplicate's, is one the
   kind covers. Held articles are left alone: they are checked already, and
   only wait for counting.
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
   new, and no bot of that time rejected one again. So are the rival rows
   rejected by hand in the old feed's cleanup, which carry
   `metadata.rejected_by`: no bot ever writes that key. Those rows get
   `metadata.personVerdict` "rejected", so nothing counts them again, and the
   re-check filters leave out any row with `rejected_by` as well. Rows the
   new bot or the new Bot Activity wrote carry `metadata.articleId` and are
   left out. Safe to run again; the recheck's log counts them as
   `markedRejected`.
3. **publish**: switch counting on once Bot Activity looks right.

## Duplicates of imported stories

An imported article is another stored article's duplicate when the seed finds
the old bot stored the story twice, or when the read step finds its address
belongs to another stored article. The other article counts the story from
then on, so the old bot's row of the duplicate would count it twice. Once that
article has a verdict of its own (decided with a decision, read in full and
naming nobody, or ruled out by its headline: lib/news/store.ts
`speaksForStory`), the duplicate's old row is rejected with `metadata.reason`
"news check: the same story as article <id>" and a failed `factCheck` that
keeps the status it had (lib/news/write.ts `withdrawLegacyRows`). Before that
verdict it is left as it is: withdrawing it could drop the story's only counted
row on the strength of an article nobody has checked. A row a person decided is
never touched, nor one a person changed on the old Bot Activity since the import
(its status differs from the duplicate's `legacy_status`). The last check of
each chain and the publish step sweep them, with counting on only.

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
  "rejected", or `metadata.rejected_by` from the rival feed's cleanup) is
  never changed by the bot, in the code and again in the database's update
  filter, and nor is an imported story's old row a person changed on the old
  Bot Activity since the import (see "Moving from the old bot").
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
`searchWindow` ("2d"), `countOnPrTab` (on; off is test mode). Edited in the
News bot card on PR & Media settings, below.

## PR & Media settings (/pr/settings)

Behind the settings PIN, like the main Settings page. What this document calls
Bot Activity, which sat at the foot of the PR tab until November 2026, is
here, with the news bot's settings that were on the main Settings page:

- **News bot**: the settings above, the test-mode banner while counting is
  off, and This morning's run in numbers, with Run now. Its line on the
  articles that could not be read splits them as Check by hand does: those
  it lists; those with nothing left to decide that are still counted on the
  PR tab from the old bot; and those only general market searches found
  ("dubai real estate", "dubai mortgage"), which are rarely about anyone
  tracked. Those a person has decided are in none of them.
- **Check by hand**, when there is anything to check: every unreadable
  article with a company still to decide, newest first, with why it could
  not be read and a link to open it in the reader's own browser
  (lib/data.ts `handCheckList`). An article is for the companies its
  searches were for (lib/news/search.ts `searchedFor`) and the companies the
  old bot's rows for it were for, its own and its copies', since the old bot
  found it by searching for that company; never the company whose own
  website it is on. A company is no longer asked about once a row for it
  counts (a person's Count, or the old bot's row as it left it) or a person
  has said it is not about it (Not about, the old screen's Reject, the rival
  feed's cleanup). Each company still to decide gets Count for it. While nothing
  of the article counts, Not about them is the article's Reject; once
  something does, Not about goes one company at a time, so that count
  stays. An article leaves the list once each of its companies is decided,
  so one about two companies can be counted for both. Most of these sites
  (Arabian Business, Gulf Business, Construction Week) turn away cloud
  servers, so a later morning's try rarely reads them either.
- **Review**: every stored article with what happened to it and why, with
  Keep and Reject, and the stories the fact check dropped. The stories the
  program ruled out by itself, without the AI (no_names, skipped, or a
  `none:` decision about no company: a look-alike name such as Better Homes &
  Gardens, a page naming nobody tracked, a company's own website), sit under
  one closed line unless a person has decided one or part of it still counts.
  Keep works there too.
- **Companies and people**: one card per company, betterhomes first. For
  betterhomes its searches (the 'pr' keywords), its websites (the 'us' row)
  and its people; for each rival its name, its search, its other spellings,
  its websites and its people, and Remove rival. Each card lists what is
  searched every morning for it, `"<name>" dubai` for each current person
  included (lib/news/search.ts searchesByCompany). Then Add a rival.
- **Possible moves**, when there are any.

This morning's run counts only the steps of the deployment showing it: each
`news_runs` row carries the `env` that wrote it (Vercel's environment, or
"development"), since production and the previews share the table.
Production also reads the rows with no env, written by code from before
migration 0024. The Apify monthly cap counts every deployment's reads, since
the money is shared.
