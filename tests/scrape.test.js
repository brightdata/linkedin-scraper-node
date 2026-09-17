/** These run without a token. The client is a stub. */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { after, before, describe, test } from "node:test";

import { attribute, cleanSlug, profileUrl, scrape, sdk, write } from "../src/scrape.js";
import { main } from "../src/cli.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const run = promisify(execFile);

let temp;
before(async () => {
  temp = await mkdtemp(join(tmpdir(), "lischeck-"));
});
after(async () => {
  await rm(temp, { recursive: true, force: true });
});

/** A client whose one LinkedIn call returns canned rows. */
function stub(records, { capture } = {}) {
  const collectProfiles = async (input, options) => {
    if (capture) capture.push({ input, options });
    if (records instanceof Error) throw records;
    return { toResult: async () => ({ success: true, status: "ready", data: records }) };
  };
  return { scrape: { linkedin: { collectProfiles } } };
}

/** A client whose request comes back as a failed envelope, with no rows. */
function envelope(fields) {
  return {
    scrape: {
      linkedin: { collectProfiles: async () => ({ toResult: async () => fields }) },
    },
  };
}

/** Swap the SDK constructor for the body of one test, then put it back. */
async function withFakeSdk(Fake, body) {
  const real = sdk.bdclient;
  sdk.bdclient = Fake;
  try {
    return await body();
  } finally {
    sdk.bdclient = real;
  }
}

describe("profile input", () => {
  test("a slug, a URL, or a URL with a query string all name the same profile", () => {
    assert.equal(cleanSlug("satyanadella"), "satyanadella");
    assert.equal(cleanSlug("https://www.linkedin.com/in/satyanadella/"), "satyanadella");
    assert.equal(cleanSlug("https://www.linkedin.com/in/satyanadella"), "satyanadella");
    assert.equal(
      cleanSlug("https://www.linkedin.com/in/satyanadella/?originalSubdomain=us"),
      "satyanadella",
    );
    assert.equal(profileUrl("satyanadella"), "https://www.linkedin.com/in/satyanadella/");
  });

  test("anything that is not a profile is refused before any request", () => {
    for (const bad of ["not a profile", "", "https://www.linkedin.com/company/microsoft/x y"]) {
      assert.throws(() => cleanSlug(bad), /is not a LinkedIn profile/, String(bad));
    }
  });
});

describe("what the API answers", () => {
  test("a profile comes back against the slug that asked for it", async () => {
    const rows = [
      { input_url: "https://www.linkedin.com/in/reidhoffman/", name: "R H", followers: 2 },
      { input_url: "https://www.linkedin.com/in/satyanadella/", name: "S N", followers: 1 },
    ];
    const [first, second] = await scrape(["satyanadella", "reidhoffman"], { client: stub(rows) });

    assert.equal(first.slug, "satyanadella");
    assert.equal(first.profile.name, "S N", "rows come back in no guaranteed order");
    assert.equal(second.slug, "reidhoffman");
    assert.equal(second.profile.name, "R H");
  });

  test("an error row fails only the profile it belongs to", async () => {
    const rows = [
      { input_url: "https://www.linkedin.com/in/satyanadella/", name: "S N" },
      { input_url: "https://www.linkedin.com/in/zz-not-a-real-profile-zz/", error: "Page not found" },
    ];
    const [good, bad] = await scrape(["satyanadella", "zz-not-a-real-profile-zz"], {
      client: stub(rows),
    });

    assert.ok(good.ok);
    assert.ok(!bad.ok);
    assert.equal(bad.line(), "failed  zz-not-a-real-profile-zz: Page not found");
  });

  test("a profile the API never returned is a failure, not a silent gap", async () => {
    const [only] = await scrape(["satyanadella"], { client: stub([]) });

    assert.ok(!only.ok);
    assert.match(only.error, /no row/);
  });

  test("a timed out request fails every profile in the batch", async () => {
    const client = envelope({ success: false, data: null, error: null, status: "timeout" });
    const outcomes = await scrape(["satyanadella", "reidhoffman"], { client });

    assert.equal(outcomes.length, 2);
    for (const outcome of outcomes) assert.equal(outcome.error, "timeout");
  });

  test("one bad input does not stop the others being fetched", async () => {
    const rows = [{ input_url: "https://www.linkedin.com/in/satyanadella/", name: "S N" }];
    const [good, bad] = await scrape(["satyanadella", "not a profile"], { client: stub(rows) });

    assert.ok(good.ok);
    assert.ok(!bad.ok);
    assert.match(bad.error, /is not a LinkedIn profile/);
  });

  test("a thrown request does not end the run", async () => {
    const outcomes = await scrape(["satyanadella"], { client: stub(new RangeError("boom")) });

    assert.equal(outcomes[0].error, "RangeError: boom");
  });

  test("error rows are asked for, and every profile goes in one job", async () => {
    const capture = [];
    await scrape(["satyanadella", "reidhoffman"], { client: stub([], { capture }) });

    assert.equal(capture.length, 1, "a batch must be one job, not one job per profile");
    assert.deepEqual(capture[0].options, { async: true, includeErrors: true });
    assert.deepEqual(capture[0].input, [
      "https://www.linkedin.com/in/satyanadella/",
      "https://www.linkedin.com/in/reidhoffman/",
    ]);
  });

  test("a row naming no slug we asked for is still attributed, not dropped", () => {
    const [outcome] = attribute(["satyanadella"], { data: [{ name: "S N", followers: 9 }] });

    assert.ok(outcome.ok);
    assert.equal(outcome.profile.followers, 9);
  });
});

describe("writing the file", () => {
  test("a run writes what it found", async () => {
    const profile = { input_url: "https://www.linkedin.com/in/satyanadella/", name: "S N" };
    const outcomes = await scrape(["satyanadella"], { client: stub([profile]) });

    assert.match(outcomes[0].line(), /^got     satyanadella: 2 fields \(S N\)$/);

    const path = await write(outcomes, join(temp, "out.json"));
    const document = JSON.parse(await readFile(path, "utf8"));
    assert.deepEqual(document.profiles, [{ slug: "satyanadella", profile }]);
    assert.ok(document.generated_at);
  });
});

describe("the client we own", () => {
  test("a client we opened is always closed", async () => {
    const calls = [];
    class Fake {
      constructor() {
        calls.push("new");
        Object.assign(this, stub([{ input_url: "/in/satyanadella/", name: "S N" }]));
      }
      async close() {
        calls.push("close");
      }
    }
    await withFakeSdk(Fake, async () => {
      const [outcome] = await scrape(["satyanadella"]);
      assert.ok(outcome.ok);
    });
    assert.deepEqual(calls, ["new", "close"]);
  });

  test("we do not ask the SDK to create zones", async () => {
    let seen;
    class Fake {
      constructor(options) {
        seen = options;
        Object.assign(this, stub([]));
      }
      async close() {}
    }
    await withFakeSdk(Fake, () => scrape(["satyanadella"]));
    assert.equal(seen.autoCreateZones, false);
  });
});

describe("the command", () => {
  async function fakeCli(records, argv) {
    class Fake {
      constructor() {
        Object.assign(this, stub(records));
      }
      async close() {}
    }
    return withFakeSdk(Fake, () => main(argv));
  }

  test("the exit code says whether every profile worked", async () => {
    const ok = await fakeCli(
      [{ input_url: "/in/satyanadella/", name: "S N" }],
      ["satyanadella", "--out", join(temp, "ok.json")],
    );
    assert.equal(ok, 0);

    const bad = await fakeCli(
      [{ input_url: "/in/satyanadella/", error: "boom" }],
      ["satyanadella", "--out", join(temp, "bad.json")],
    );
    assert.equal(bad, 1);
  });

  test("no arguments is refused with the usage, not a stack trace", async () => {
    const written = [];
    const real = process.stderr.write;
    process.stderr.write = (chunk) => (written.push(String(chunk)), true);
    try {
      assert.equal(await main([]), 2);
    } finally {
      process.stderr.write = real;
    }
    assert.match(written.join(""), /usage: linkedin-scraper/);
  });

  test("an unknown flag is refused before any request", async () => {
    const written = [];
    const real = process.stderr.write;
    process.stderr.write = (chunk) => (written.push(String(chunk)), true);
    try {
      assert.equal(await main(["satyanadella", "--limit", "5"]), 2);
    } finally {
      process.stderr.write = real;
    }
    assert.match(written.join(""), /usage: linkedin-scraper/);
  });

  test("a missing token is a message, not a stack trace", async () => {
    const written = [];
    const real = process.stderr.write;
    process.stderr.write = (chunk) => (written.push(String(chunk)), true);
    const { AuthenticationError } = await import("@brightdata/sdk");
    class Fake {
      constructor() {
        throw new AuthenticationError("No API token found. Run `npx @brightdata/cli login`");
      }
    }
    let code;
    try {
      code = await withFakeSdk(Fake, () => main(["satyanadella"]));
    } finally {
      process.stderr.write = real;
    }
    const err = written.join("");
    assert.equal(code, 2);
    assert.match(err, /export BRIGHTDATA_API_TOKEN/);
    assert.match(err, /bdata login/);
    assert.doesNotMatch(err, /apiKey option/, "the SDK's JavaScript-only advice leaked into the CLI");
  });

  test("piped output keeps the header before the error", async () => {
    // A log or an agent reads a pipe. The header must not land after the error.
    const env = { ...process.env, HOME: temp, PATH: process.env.PATH };
    delete env.BRIGHTDATA_API_TOKEN;
    delete env.BRIGHTDATA_API_KEY;
    let stdout = "";
    let code = 0;
    try {
      const done = await run(process.execPath, [join(ROOT, "src/cli.js"), "satyanadella"], {
        cwd: temp,
        env,
        timeout: 60_000,
      });
      stdout = done.stdout + done.stderr;
    } catch (error) {
      code = error.code;
      stdout = `${error.stdout}${error.stderr}`;
    }
    assert.equal(code, 2, stdout);
    assert.ok(
      stdout.indexOf("Fetching 1 LinkedIn profile") < stdout.indexOf("API token required"),
      `header landed after the error:\n${stdout}`,
    );
  });
});

describe("the SDK contract the README relies on", () => {
  test("every LinkedIn method the README names exists", async () => {
    const { LinkedinAPI } = await import(
      join(ROOT, "node_modules/@brightdata/sdk/dist/esm/api/scrape/linkedin.mjs")
    );
    for (const name of [
      "collectProfiles",
      "discoverProfiles",
      "collectCompanies",
      "collectJobs",
      "discoverJobs",
      "collectPosts",
      "discoverUserPosts",
      "discoverCompanyPosts",
      "profiles",
      "companies",
      "jobs",
      "posts",
    ]) {
      assert.equal(typeof LinkedinAPI.prototype[name], "function", name);
    }
  });

  test("the profiles dataset is the one the control panel shows", async () => {
    const { LinkedinProfilesDataset } = await import(
      join(ROOT, "node_modules/@brightdata/sdk/dist/esm/api/datasets/platforms/linkedin.mjs")
    );
    // gd_l1viktl72bvl7bjuj0, as shown at
    // brightdata.com/cp/scrapers/gd_l1viktl72bvl7bjuj0/pdp/configuration
    assert.equal(new LinkedinProfilesDataset({ transport: null }).datasetId, "gd_l1viktl72bvl7bjuj0");
  });

  test("discoverProfiles searches by name, so it is not a URL lookup", async () => {
    const { LinkedinProfileFilterSchema: schema } = await import(
      join(ROOT, "node_modules/@brightdata/sdk/dist/esm/schemas/filters/linkedin.mjs")
    );
    assert.equal(schema.safeParse({ first_name: "Satya", last_name: "Nadella" }).success, true);
    assert.equal(
      schema.safeParse({ url: "https://www.linkedin.com/in/satyanadella/" }).success,
      false,
      "a URL is not a discoverProfiles filter",
    );
  });

  test("discoverJobs needs a location, which is why a job URL is never pinned", async () => {
    const { LinkedinJobFilterSchema: schema } = await import(
      join(ROOT, "node_modules/@brightdata/sdk/dist/esm/schemas/filters/linkedin.mjs")
    );
    assert.equal(schema.safeParse({ keyword: "data engineer" }).success, false);
    assert.equal(schema.safeParse({ location: "London", keyword: "data engineer" }).success, true);
  });

  test("polling is measured in milliseconds, so a timeout is not off by a thousand", async () => {
    const { pollUntilReady } = await import(
      join(ROOT, "node_modules/@brightdata/sdk/dist/esm/utils/polling.mjs")
    );
    const started = Date.now();
    await assert.rejects(
      () => pollUntilReady("sd_x", async () => ({ status: "running" }), {
        pollInterval: 10,
        pollTimeout: 60,
      }),
      /timeout|timed out/i,
    );
    assert.ok(Date.now() - started < 5_000, "a 60 ms timeout waited for seconds");
  });
});

describe("the README", () => {
  test("the excerpt is the start of the example file", async () => {
    const sample = await readFile(join(ROOT, "examples/sample_output.json"), "utf8");
    const readme = await readFile(join(ROOT, "README.md"), "utf8");

    assert.ok(
      readme.includes(sample.split("\n").slice(0, 19).join("\n")),
      "README excerpt drifted from the file",
    );
    assert.ok(readme.includes("](examples/sample_output.json)"));
  });

  test("every in-page link has its heading", async () => {
    const readme = await readFile(join(ROOT, "README.md"), "utf8");
    const anchors = new Set(
      [...readme.matchAll(/^#{1,6} (.+)$/gm)].map(([, heading]) =>
        heading.toLowerCase().replace(/[^a-z0-9 -]/g, "").replace(/ /g, "-"),
      ),
    );
    for (const [, anchor] of readme.matchAll(/\]\(#([^)]+)\)/g)) {
      assert.ok(anchors.has(anchor), `#${anchor} points at no heading`);
    }
  });

  test("the README names no pinned job URL, which would expire", async () => {
    const readme = await readFile(join(ROOT, "README.md"), "utf8");
    assert.doesNotMatch(
      readme,
      /linkedin\.com\/jobs\/view\/\d+/,
      "a pinned job URL turns red in CI the week the posting closes",
    );
  });
});
