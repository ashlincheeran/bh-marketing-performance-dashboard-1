-- ════════════════════════════════════════════════════════════════
-- Spokespeople the news bot should recognise, ours and each rival's.
--
-- Press often quotes a person without naming the company in the same
-- sentence ("said Richard Waind, CEO" after the company was named once,
-- or a headline that names only the person). The planned news flow uses
-- this list twice: as extra searches, and as names that make a sentence
-- worth checking, mapped to the company the person speaks for.
--
-- People move between companies: Louis Harding left betterhomes for
-- Knight Frank in 2026, and Jacob Fletcher, quoted for betterhomes in 2023,
-- now heads residential leasing at Engel & Völkers. So `active = false`
-- marks someone who no longer speaks for that company: a mention of them
-- counts for the company only when the article names it too. `company`
-- matches a tracked_keywords label, or 'betterhomes'.
--
-- Public names and titles only, so readable like tracked_keywords. Nothing
-- reads this table until the new flow is built.
-- ════════════════════════════════════════════════════════════════
create table if not exists tracked_people (
  id          bigserial primary key,
  name        text not null,
  company     text not null,
  role        text,
  aliases     text[] not null default '{}',
  note        text,
  source_url  text,
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  unique (name, company)
);

alter table tracked_people enable row level security;
do $$ begin
  create policy "public read tracked_people" on tracked_people for select using (true);
exception when duplicate_object then null; end $$;

insert into tracked_people (name, company, role, aliases, note, source_url, active) values
  -- betterhomes
  ('Richard Waind', 'betterhomes', 'CEO', '{}', 'Returned as CEO in 2026; earlier Group Managing Director', 'https://www.bhomes.com/en/meet-the-team/management', true),
  ('Rupert Simmonds', 'betterhomes', 'Director of Leasing', '{"Rupert Simmons"}', 'Spelt Simmons in The National, Apr 2025', 'https://www.bhomes.com/en/meet-the-team/management', true),
  ('Alex Leigh', 'betterhomes', 'Director of Operations', '{}', 'Quoted by Zawya, Feb 2026', 'https://www.bhomes.com/en/meet-the-team/management', true),
  ('Nada Osman', 'betterhomes', 'Director, betterhomes Abu Dhabi', '{}', 'Quoted Oct 2026', 'https://www.bhomes.com/en/meet-the-team/management', true),
  ('Connor Manning', 'betterhomes', 'Head of Secondary Sales', '{}', 'Title from the management page; another page says Branch Sales Manager', 'https://www.bhomes.com/en/meet-the-team/management', true),
  ('Wassim Abdallah', 'betterhomes', 'Head of Off-plan', '{}', NULL, 'https://www.bhomes.com/en/meet-the-team/management/wassim-abdallah', true),
  ('Evelyn Pali', 'betterhomes', 'Sales Manager', '{}', 'Quoted Jul 2026', 'https://www.bhomes.com/en/meet-the-team/management/evelyn-pali', true),
  ('Gemma Frankland', 'betterhomes', 'Sales Director, Business Bay and Client Partnerships', '{}', NULL, 'https://www.bhomes.com/en/meet-the-team/management/gemma-frankland', true),
  ('Kelly Anne Steiger', 'betterhomes', 'Sales Director', '{}', NULL, 'https://www.bhomes.com/en/meet-the-team/management', true),
  ('Kapil Gupta', 'betterhomes', 'Finance Director', '{}', 'One page says Director of Leasing', 'https://www.bhomes.com/en/meet-the-team/management/kapil-gupta', true),
  ('Toni Elia Abou Jaoude', 'betterhomes', 'Head of Administration and IT Infrastructure', '{}', 'No CTO is listed; this is the closest role', 'https://www.bhomes.com/en/meet-the-team/management/toni-elia-abou-jaoude', true),
  ('Linda Mahoney', 'betterhomes', 'Founder', '{}', NULL, NULL, true),
  ('Louis Harding', 'betterhomes', 'Former CEO', '{}', 'Left in 2026 to be Partner and Head of Residential, Knight Frank UAE', 'https://www.consultancy-me.com/news/14474/knight-frank-appoints-louis-harding-as-head-of-residential-business-in-uae', false),
  ('Jacob Fletcher', 'betterhomes', 'Former broker', '{"Jake Fletcher"}', 'Now Head of Residential Leasing at Engel & Völkers', 'https://www.engelvoelkers.com/ae/en/advisors/jacob-fletcher', false),
  -- Allsopp & Allsopp
  ('Lewis Allsopp', 'Allsopp & Allsopp', 'Chairman and co-founder', '{"Lewis Allsop"}', NULL, 'https://gulfbusiness.com/?p=120260', true),
  ('Carl Allsopp', 'Allsopp & Allsopp', 'CEO and co-founder', '{}', NULL, 'https://www.cbinsights.com/company/allsopp-allsopp', true),
  ('Marc Walters', 'Allsopp & Allsopp', 'Managing Director', '{}', NULL, 'https://proptechconnect.com/marc-walters-managing-director-allsopp-allsopp/', true),
  ('Darren Murphy', 'Allsopp & Allsopp', 'Sales and Leasing Director', '{}', 'Title from a 2019 profile', 'https://www.bayut.com/mybayut/allsopp-allsopp-top-real-estate-agency-dubai-may-2019/', true),
  -- haus & haus
  ('Simon Baker', 'Haus & Haus', 'Co-founder and Managing Director', '{}', NULL, 'https://www.hausandhaus.com/about-us/our-team/simon-baker', true),
  ('James Perry', 'Haus & Haus', 'Founder and Managing Director', '{}', NULL, 'https://www.hausandhaus.com/about-us/our-team/james-perry', true),
  ('Luke Remington', 'Haus & Haus', 'Managing Director', '{}', NULL, 'https://www.hausandhaus.com/about-us/our-team/luke-remington', true),
  ('Charlie Bannan', 'Haus & Haus', 'Managing Director', '{}', 'Promoted from Sales Director in 2024', 'https://hausandhaus.com/about-us/our-team/charlie-bannan', true),
  -- Driven
  ('Abdullah Alajaji', 'Driven Properties', 'Founder and CEO', '{"Abdullah Al Ajaji","Abdullah Al-Ajaji"}', 'The firm also trades as Driven | Forbes Global Properties', 'https://www.zawya.com/en/press-release/companies-news/driven-properties-opens-abu-dhabi-branch-unveils-2025-report-and-early-2026-investor-behaviour-tqp12m1a', true),
  ('Hadi Hamra', 'Driven Properties', 'Deputy CEO and Chief Commercial Officer', '{}', NULL, 'https://www.zawya.com/en/press-release/companies-news/driven-properties-grows-assets-under-management-to-aed-2bln-kbt318ip', true),
  ('Emre Okay', 'Driven Properties', 'Group CFO', '{}', NULL, 'https://www.zawya.com/en/press-release/people-in-the-news/driven-properties-appoints-emre-okay-as-new-group-chief-financial-officer-amid-business-expansion-667340', true),
  ('Ibrahim Abdulkarim', 'Driven Properties', 'Head of Secondary Sales', '{}', NULL, 'https://www.drivenproperties.com/team/profile/ibrahim-abdulkarim', true),
  -- Engel & Völkers
  ('Daniel Hadi', 'Engel & Völkers', 'CEO, Middle East', '{}', NULL, 'https://mena.entrepreneur.com/?p=39134', true),
  ('Robert Villalobos', 'Engel & Völkers', 'Head of Brokerage', '{}', NULL, 'https://www.zawya.com/en/press-release/companies-news/engel-and-volkers-2025-annual-report-highlights-dubais-strongest-year-on-record-as-market-enters-a-more-sustainable-growth-phase-u6mcaa6r', true),
  ('Jacob Fletcher', 'Engel & Völkers', 'Head of Residential Leasing', '{"Jake Fletcher"}', 'Formerly at betterhomes', 'https://www.engelvoelkers.com/ae/en/advisors/jacob-fletcher', true),
  ('Mohab Samak', 'Engel & Völkers', 'Managing Director, Dubai', '{}', 'Title from 2022', 'https://mot-backup.gulfbusiness.com/videolinks/property-finder-talks-in-conversation-with-mohab-samak-managing-director-engel-and-volkers-dubai', true),
  -- Metropolitan
  ('Nikita Kuznetsov', 'Metropolitan', 'Founder and CEO', '{}', NULL, 'https://mena.entrepreneur.com/?p=39300', true),
  ('Evgeny Ratskevich', 'Metropolitan', 'Co-founder and partner', '{}', NULL, 'https://metropolitan.realestate/about-us/', true),
  ('Alina Adamco', 'Metropolitan', 'Secondary Market Sales and Leasing Director', '{}', 'Zawya calls her Head of Secondary Market Sales', 'https://www.zawya.com/en/press-release/companies-news/metropolitan-premium-properties-closes-aed-18mln-rental-deal-in-district-one-w7fy44m8', true),
  -- Sotheby's
  ('George Azar', 'Sotheby''s', 'Chairman and CEO, Dubai Sotheby''s International Realty', '{}', NULL, 'https://sothebysrealty.ae/management/george-azar/', true),
  ('Chris Whitehead', 'Sotheby''s', 'Managing Partner, Dubai Sotheby''s International Realty', '{}', NULL, 'https://sothebysrealty.ae/management/chris-whitehead/', true),
  ('Tareq Darwish', 'Sotheby''s', 'Managing Director, projects', '{}', NULL, 'https://sothebysrealty.ae/agent/tareq-darwish', true),
  ('Honey Deylami', 'Sotheby''s', 'Executive Partner, Luxhabitat Sotheby''s International Realty', '{}', 'Luxhabitat is a separate Sotheby''s franchise', 'https://www.zawya.com/en/press-release/people-in-the-news/honey-deylami-appointed-as-executive-partner-at-luxhabitat-sothebys-international-realty-q0difc1s', true),
  -- White & Co
  ('Calum White', 'White & Co', 'Founder and CEO', '{}', NULL, 'https://gulfnews.com/podcasts/gn-talks/from-8-to-400-brokers-in-3-years-calum-white-on-building-dubais-fastest-growing-real-estate-firm-1.500176105', true),
  ('Neil Maclean', 'White & Co', 'Managing Director', '{}', NULL, 'https://mena.entrepreneur.com/leadership/100-real-estate-agents-neil-maclean-white-and-co-real-estate', true),
  ('Tiernan Colgan', 'White & Co', 'Leasing Director', '{}', NULL, 'https://www.propertyfinder.ae/en/agent/tiernan-colgan-357221', true),
  ('Poppy Wigstead', 'White & Co', 'Director of Leasing and Training', '{}', NULL, 'https://propertyfinder.ae/en/agent/poppy-wigstead-271254', true),
  ('Rob Searle', 'White & Co', 'Sales and Leasing Director', '{"Robert Searle"}', NULL, 'https://www.propertyfinder.ae/en/agent/robert-searle-203936', true),
  -- fäm Properties
  ('Firas Al Msaddi', 'fäm Properties', 'Founder and CEO', '{"Firas Al-Msaddi","Firas Almsaddi"}', 'Also listed as Executive Chairman', 'https://mena.entrepreneur.com/?p=39443', true),
  ('Fateh Al Msaddi', 'fäm Properties', 'COO', '{"Fateh Al-Msaddi"}', NULL, 'https://proptechconnect.com/fateh-al-msaddi-coo-fam-properties-dubai/', true),
  ('Rami Wahood', 'fäm Properties', 'Executive Partner', '{}', NULL, 'https://mena.entrepreneur.com/leadership/100-real-estate-agents-rami-wahood-executive-partner-fam-properties', true)
on conflict (name, company) do nothing;
