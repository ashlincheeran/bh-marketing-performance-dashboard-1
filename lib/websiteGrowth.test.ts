import { test } from "node:test";
import assert from "node:assert/strict";
import { lookupSql, readVisits, readWebsiteCrm, websiteCrmSql, websiteSql } from "@/lib/websiteGrowth";

const OCT = { from: "2026-10-01", to: "2026-10-31" };

test("a month's visits are filed by channel, careers apart, with direct's short visits counted", () => {
  const v = readVisits([
    ["Direct", 0, 48891, 9252],
    ["Direct", 1, 485, 134],
    ["Organic Search", 0, 17471, 3347],
    ["Paid Social", 1, 6945, 1821],
    ["Paid Social", 0, 9769, 2495],
    ["Paid Video", 0, 6, 1],
  ]);
  assert.ok(v);
  assert.deepEqual(v.channels.direct, { site: 48891, careers: 485 });
  assert.deepEqual(v.channels.paidSocial, { site: 9769, careers: 6945 });
  assert.deepEqual(v.channels.organic, { site: 17471, careers: 0 });
  assert.deepEqual(v.channels.other, { site: 6, careers: 0 });
  // Only direct visits off the careers pages count as direct's short ones.
  assert.equal(v.directShort, 9252);
  // PostHog not answering is unknown, never a month of nothing.
  assert.equal(readVisits(null), null);
});

test("the visits questions count every visit on bhomes.com, careers told apart by the page a visit began on", () => {
  const sql = websiteSql.visits(OCT);
  assert.match(sql, /FROM sessions/);
  assert.match(sql, /\$start_timestamp >= toDateTime\('2026-10-01 00:00:00'\) AND \$start_timestamp <= toDateTime\('2026-10-31 23:59:59'\)/);
  assert.match(sql, /\$entry_hostname/);
  assert.match(sql, /\$entry_pathname/);
  assert.match(sql, /'join-our-team' AS careers/);
  assert.match(sql, /countIf\(\$session_duration < 5\)/);
  // Our own site referring a visit makes it Direct, as on the SEO tab.
  assert.match(sql, /'Referral' AND .*bhomes\.com.*'Direct'/);
  // No bot filter here: section 04 shows the automated share instead.
  assert.doesNotMatch(sql, /virt_is_bot/);
  assert.match(websiteSql.countries(OCT), /virt_is_bot/);
  // Forms, actions and senders leave the careers pages out; page views by section keep every page.
  for (const k of ["forms", "actions", "senders"] as const) assert.match(websiteSql[k](OCT), /!= 'join-our-team'/);
  assert.doesNotMatch(websiteSql.sections(OCT), /join-our-team/);
  assert.match(websiteSql.senders(OCT), /startsWith\(event, 'lead_'\)/);
});

test("the CRM counts website enquiries and job applications apart, each person once a month", () => {
  const { leads, outcomes } = websiteCrmSql("2026-08-01", "2026-10-31");
  // The careers form writes the CV first; that, not the source, marks an application.
  assert.match(leads, /COALESCE\(l\.message, ''\) LIKE 'CV:%' THEN 'jobs'/);
  assert.match(leads, /LOWER\(l\.enquiry_source\) = 'website'/);
  assert.match(leads, /COUNT\(DISTINCT cid\)/);
  assert.match(leads, /GROUP BY m, kind, ch WITH ROLLUP/);
  // The shared lead scope: no GoYzer, no staff or test contacts.
  assert.match(leads, /GoYzer/);
  assert.match(leads, /@bhomes\.com/);
  // Outcomes credit a person's listings and deals after their first website enquiry, applications left out.
  assert.match(outcomes, /ROW_NUMBER\(\) OVER \(PARTITION BY l\.customer_id ORDER BY l\.created_at, l\.id\)/);
  assert.match(outcomes, /NOT \(COALESCE\(l\.message, ''\) LIKE 'CV:%'\)/);
  assert.match(outcomes, /li\.created_at >= tc\.first_at/);
  assert.match(outcomes, /d\.status IN \('Reserved','Closed','Completed'\)/);
  assert.match(outcomes, /GREATEST\(COALESCE\(d\.final_gross_commission_amount, 0\), COALESCE\(d\.reserved_gross_commission_amount, 0\)\)/);
});

test("the CRM's rows become months: channels, each person once, applicants, and what they led to", () => {
  const months = readWebsiteCrm(
    [
      ["2026-10", "enquiries", "untagged", 611],
      ["2026-10", "enquiries", "email", 178],
      ["2026-10", "enquiries", "ai", 34],
      ["2026-10", "enquiries", null, 820],
      ["2026-10", "jobs", "paidSocial", 259],
      ["2026-10", "jobs", null, 632],
      ["2026-10", null, null, 1452],
      [null, null, null, 9999],
    ],
    [
      ["listed", "2026-10", "untagged", 121, 0],
      ["listed", "2026-10", "email", 1, 0],
      ["completed", "2026-10", "untagged", 10, 36511.9],
      ["awaiting", "2026-10", "untagged", 14, 591325],
      ["ended", "2026-10", "untagged", 2, 23000],
      ["listed", "2026-10", "nonsense", 5, 0],
    ],
  );
  const oct = months.get("2026-10");
  assert.ok(oct);
  assert.equal(oct.enquiries.untagged, 611);
  assert.equal(oct.enquiries.email, 178);
  assert.equal(oct.enquiries.paidSearch, 0);
  // The month's own rows: each enquirer once, each applicant once; applicants' channels are not enquiries.
  assert.equal(oct.enquirers, 820);
  assert.equal(oct.jobs, 632);
  assert.equal(oct.enquiries.paidSocial, 0);
  assert.equal(oct.listed.untagged, 121);
  assert.equal(oct.listed.email, 1);
  // Every deal reserved counts once; completed and awaiting carry the commission, a deal that ended does not.
  assert.equal(oct.reserved.untagged, 26);
  assert.equal(oct.completed.untagged, 10);
  assert.equal(oct.awaiting, 14);
  assert.deepEqual(oct.commission, { completed: 36511.9, awaiting: 591325 });
  assert.equal(months.size, 1);
});

test("a page's look-up asks about that page alone, over the days chosen", () => {
  const q = lookupSql("/en/buy", 30);
  for (const sql of Object.values(q)) assert.match(sql, /'\/en\/buy'/);
  assert.match(q.overview, /now\(\) - INTERVAL 30 DAY/);
  assert.match(q.entrances, /FROM sessions/);
  assert.match(q.next, /leadInFrame/);
  // The home page is the empty path.
  assert.match(lookupSql("", 7).trend, /= ''/);
});
