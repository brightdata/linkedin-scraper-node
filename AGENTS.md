# For coding agents working in this repository

Read this before changing anything. Every line below was verified against the
live API or the installed SDK on 2026-09-17.

## What this repository may demonstrate

LinkedIn profile data is personal data. The API says so itself: of the 46 fields
in the profiles dataset, it marks 8 with `pii: true`, namely `id`, `name`,
`about`, `url`, `input_url`, `linkedin_id`, `first_name` and `last_name`.

- Examples use public figures whose professional presence is already public,
  and company pages. Do not add an example that scrapes a private individual.
- Do not add an example built on `discoverProfiles`. It searches by first and
  last name, which is people search, and this repository does not demonstrate
  it against a real person.
- Permitted use is the customer's responsibility, and the README links to Bright
  Data's compliance material rather than restating it here.

## Auth

- The SDK reads `apiKey`, then `BRIGHTDATA_API_TOKEN` or `BRIGHTDATA_API_KEY`
  from the environment, then the credentials `bdata login` stored.
- The JavaScript SDK does not read a `.env` file. It has no dotenv dependency
  and reads `process.env` only. Node 20 loads one for it: `node --env-file=.env`.
- Always construct the client as `new bdclient({ autoCreateZones: false })`.
  Left on, the SDK creates Web Unlocker and SERP zones on the first request.
  This repository never uses a zone, and zone creation fails on accounts
  without a payment method.
- The class JSDoc shows `api_token` and `auto_create_zones`. Those are the
  Python names. The schema this SDK validates against is camelCase, and a
  snake_case key is dropped in silence.

## How the API behaves

- Every call is an asynchronous job: trigger, poll, fetch. Expect one to three
  minutes. There is no synchronous path worth using here.
- LinkedIn lives on `client.scrape.linkedin`. The profiles dataset is
  `gd_l1viktl72bvl7bjuj0`, the same id the control panel shows.
- Pass `{ async: true, includeErrors: true }` on collect calls. Unset, the SDK
  omits `include_errors` and the API default is off, so a dead profile comes
  back as zero rows and reads like a profile with no data. The orchestrated
  helpers (`profiles`, `companies`, `jobs`, `posts`) cannot carry it:
  `orchestrate()` forwards only `format` and the poll options.
- Poll options are milliseconds, not seconds. `pollTimeout` defaults to 600000.
- Every profile goes in one job. The API bills per record, not per job, and a
  job takes one to three minutes whether it carries one URL or ten. Batching is
  the single biggest speed win here, and it is why `scrape()` takes a list.
- A batch returns rows in no guaranteed order, and an error row names the input
  it failed on. `attribute()` matches rows back to the slug that asked for them.
  Never assume row order matches input order.
- One credit per record. 5,000 credits are free each month.
- `discoverProfiles` takes `{ first_name, last_name }`, not a URL. It is name
  search, and the zod filter rejects a URL outright.
- `discoverJobs` requires `location`, plus optional `keyword`, `company`,
  `time_range`, `job_type`, `experience_level` and `remote`.
- `limitPerInput` is the only cap on how many records a discover call returns,
  and therefore on what it bills. It is silently stripped unless you also pass
  `async: true`, because the options schema is a union keyed on `async` and the
  sync half drops unknown keys. The typed `DiscoverOptions` tells you to omit
  `async`, so the correct-looking call is the uncapped one. Always pass both.
  Tracked in [sdk-js#36](https://github.com/brightdata/sdk-js/issues/36).
- Never pin a job URL in the README. A posting closes and the weekly live check
  goes red through no fault of the code. Discover jobs by keyword and location.
- The schema changes without notice. Never hardcode a field list. Read it with
  `client.datasets.linkedinProfiles.getMetadata()`. It returns `{ id, fields }`,
  and `fields` is an object keyed by field name, 46 of them on 2026-09-17. The
  SDK's own types declare `fields: DatasetField[]`, an array, which is wrong:
  iterating it as one yields nothing. Tracked in
  [sdk-js#35](https://github.com/brightdata/sdk-js/issues/35).
- The full documentation index, one `.md` page per entry:
  https://docs.brightdata.com/llms.txt

## The API stalls in waves

On 2026-09-16, building the Instagram twin, the API went through stretches of
roughly an hour where most jobs sat until the poll deadline and returned
`status: "timeout"` with no rows. Between those stretches the same calls
finished in 62 s to 200 s. Load did not explain it.

- A red live check whose only symptom is timeouts is probably a bad wave.
  Rerun it before looking for a code change.
- `live.yml` retries once on a timeout and caps the README matrix at
  `max-parallel: 3`. The cap is not a fix. It limits the damage from one wave.
- Do not raise `POLL_TIMEOUT_MS` to chase this. A stalled snapshot did not
  finish at 900 s either.

## Working here

- `npm test` runs offline and needs no token. `npm run lint` must pass.
- CI installs from the README's own commands on an empty machine. A weekly
  workflow executes every fenced block in the README against the real API, and
  a daily one runs a smaller live check.
- The field table in the README sits between `<!-- fields:start -->` and
  `<!-- fields:end -->` and is regenerated daily. Do not edit it by hand.
- The "last verified" badge line at the top of the README is rewritten by the
  daily run. Do not edit it by hand.
- Keep it small: 14 files and about 350 lines of JavaScript in `src/`. Do not
  add retries, deduplication, scheduling, databases or concurrency.
