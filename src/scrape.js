/**
 * Get LinkedIn profiles by URL or by the slug in that URL.
 *
 *     slug -> collectProfiles -> ScrapeJob -> full profile records
 *
 * Every profile asked for goes into one job. The API bills per record, not per
 * job, and a job takes one to three minutes whether it carries one URL or ten,
 * so a batch of ten costs the same time as a single profile. This is the one
 * real difference in shape from the Instagram twin, which runs a job per
 * account because each account needs its own discovery filter.
 */

import { writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { bdclient } from "@brightdata/sdk";

/** The SDK polls in milliseconds and gives up at 600000 by default. */
export const POLL_TIMEOUT_MS = 600_000;
export const POLL_INTERVAL_MS = 5_000;

/** A public profile slug: the part after /in/. */
const SLUG = /^[A-Za-z0-9\-_%.]{2,100}$/;

/**
 * The SDK constructor, behind one indirection.
 *
 * ES module exports are read-only bindings, so a test cannot replace an
 * imported class the way Python's monkeypatch replaces a module attribute.
 */
export const sdk = { bdclient };

/** Accept satyanadella, a full profile URL, or one with a query string. */
export function cleanSlug(input) {
  let cleaned = String(input ?? "").trim();
  cleaned = cleaned.split("?")[0].split("#")[0].replace(/\/+$/, "");
  if (cleaned.includes("linkedin.com/")) {
    cleaned = cleaned.slice(cleaned.lastIndexOf("/") + 1);
  }
  if (!SLUG.test(cleaned)) {
    throw new Error(`${JSON.stringify(String(input))} is not a LinkedIn profile`);
  }
  return cleaned;
}

export function profileUrl(input) {
  return `https://www.linkedin.com/in/${cleanSlug(input)}/`;
}

/** Flatten a ScrapeResult, or an array of them, into plain objects. */
export function rows(result) {
  if (Array.isArray(result)) return result.flatMap(rows);
  let data = result && typeof result === "object" && "data" in result ? result.data : result;
  if (data && typeof data === "object" && !Array.isArray(data)) data = [data];
  if (!Array.isArray(data)) return [];
  return data.filter((row) => row && typeof row === "object" && !Array.isArray(row));
}

/**
 * A failed or timed out request carries no rows to explain itself.
 *
 * Without this check the run prints "0 profiles", which reads like an account
 * that does not exist rather than a request that never came back.
 */
export function envelopeError(result) {
  if (!result || result.success !== false) return null;
  return String(result.error ?? result.status ?? "request failed");
}

/** What happened to one profile. */
export class Outcome {
  constructor({ slug, profile = null, error = null }) {
    this.slug = slug;
    this.profile = profile;
    this.error = error;
  }

  get ok() {
    return this.error === null;
  }

  /** One line a reader can understand without having read the source. */
  line() {
    if (!this.ok) return `failed  ${this.slug}: ${this.error}`;
    const name = this.profile?.name ? ` (${this.profile.name})` : "";
    return `got     ${this.slug}: ${Object.keys(this.profile ?? {}).length} fields${name}`;
  }
}

/**
 * Match each returned row back to the slug that asked for it.
 *
 * A batch returns rows in no guaranteed order, and an error row for a dead
 * profile carries the input it failed on rather than a profile URL. Matching on
 * the slug inside whichever URL field is present is the only link back.
 */
export function attribute(slugs, result) {
  const bySlug = new Map(slugs.map((slug) => [slug, null]));
  const unmatched = [];

  for (const row of rows(result)) {
    const candidates = [row.input_url, row.url, row.input?.url, row.linkedin_id];
    const hit = slugs.find((slug) =>
      candidates.some((value) => typeof value === "string" && value.includes(slug)),
    );
    if (hit) bySlug.set(hit, row);
    else unmatched.push(row);
  }

  // Rows that name no slug we asked for, in slug order, so nothing is dropped.
  for (const slug of slugs) {
    if (bySlug.get(slug) === null && unmatched.length) bySlug.set(slug, unmatched.shift());
  }

  return slugs.map((slug) => {
    const row = bySlug.get(slug);
    if (!row) return new Outcome({ slug, error: "the API returned no row for this profile" });
    if (row.error) return new Outcome({ slug, error: String(row.error) });
    return new Outcome({ slug, profile: row });
  });
}

/**
 * Run `fn` with the client passed in, or with one we open and own.
 *
 * A client we opened holds an undici pool, so the process would not exit until
 * it is closed. A client the caller passed is theirs to close.
 */
export async function withClient(client, fn) {
  if (client) return fn(client);
  // autoCreateZones defaults to true: the SDK creates Web Unlocker and SERP
  // zones on the first request, which this scraper never uses. Creating a zone
  // needs a payment method, so leaving it on breaks the first run for free
  // accounts.
  const owned = new sdk.bdclient({ autoCreateZones: false });
  try {
    return await fn(owned);
  } finally {
    await owned.close();
  }
}

/** Fetch every profile in one job. Never throws: a failure becomes Outcomes. */
export async function scrape(inputs, { client = null } = {}) {
  const slugs = [];
  const rejected = [];
  for (const input of inputs) {
    try {
      slugs.push(cleanSlug(input));
    } catch (error) {
      rejected.push(new Outcome({ slug: String(input), error: error.message }));
    }
  }
  if (!slugs.length) return rejected;

  const found = await withClient(client, async (opened) => {
    try {
      // includeErrors is off unless asked for, and the orchestrated profiles()
      // helper cannot pass it, so collect plus toResult is the only path that
      // reports a dead profile instead of silently returning nothing.
      const job = await opened.scrape.linkedin.collectProfiles(
        slugs.map((slug) => profileUrl(slug)),
        { async: true, includeErrors: true },
      );
      const result = await job.toResult({
        pollInterval: POLL_INTERVAL_MS,
        pollTimeout: POLL_TIMEOUT_MS,
      });
      const failed = envelopeError(result);
      if (failed) return slugs.map((slug) => new Outcome({ slug, error: failed }));
      return attribute(slugs, result);
    } catch (error) {
      const message = `${error?.constructor?.name ?? "Error"}: ${error?.message ?? error}`;
      return slugs.map((slug) => new Outcome({ slug, error: message }));
    }
  });

  // Give the caller back one Outcome per input, in the order they asked.
  const order = new Map(found.map((outcome) => [outcome.slug, outcome]));
  const rejects = new Map(rejected.map((outcome) => [outcome.slug, outcome]));
  return inputs.map((input) => {
    const raw = String(input);
    if (rejects.has(raw)) return rejects.get(raw);
    let slug;
    try {
      slug = cleanSlug(input);
    } catch {
      return new Outcome({ slug: raw, error: "not a LinkedIn profile" });
    }
    return order.get(slug) ?? new Outcome({ slug, error: "no result" });
  });
}

/** Write one JSON file: when it ran, and the profile found per slug. */
export async function write(outcomes, path) {
  const document = {
    generated_at: new Date().toISOString(),
    profiles: outcomes.map((o) => ({ slug: o.slug, profile: o.profile })),
  };
  const target = resolve(path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(document, null, 2)}\n`, "utf8");
  return target;
}
