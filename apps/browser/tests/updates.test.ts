import { describe, expect, test } from "bun:test";
import {
  compareVersions,
  defaultChannel,
  newestRelease,
  releasesNewestFirst,
  tagsFromFeed,
} from "../src/shared/updates";

describe("compareVersions", () => {
  test("SemVer order, daily builds by date and run", () => {
    const sorted = [
      "0.1.0",
      "0.1.1-daily.20261031.3",
      "0.1.1-daily.20261101.5",
      "0.1.1-daily.20261101.6",
      "0.1.1-daily.20261102.7",
      "0.1.1",
      "0.1.2-daily.20261103.9",
      "0.1.2-daily.20261103.10",
      "0.2.0",
      "0.10.0",
    ];
    const shuffled = [...sorted].reverse();
    expect(shuffled.sort(compareVersions)).toEqual(sorted);
    expect(compareVersions("v0.2.0", "0.2.0")).toBe(0);
  });
});

describe("newestRelease", () => {
  // As the releases were on 2026-11-03: a daily build after the stable one.
  const tags = ["v0.1.2-daily.20261103.9", "v0.1.1", "v0.1.1-daily.20261102.7", "v0.1.1-daily.20261101.6", "v0.1.0"];

  test("the daily channel gets the newest daily build", () => {
    expect(newestRelease(tags, "daily")).toBe("v0.1.2-daily.20261103.9");
  });

  test("the daily channel gets a stable release that's newer than every daily build", () => {
    expect(newestRelease(["v0.2.0", ...tags], "daily")).toBe("v0.2.0");
    // Whatever order the feed lists them in.
    expect(newestRelease([...tags, "v0.2.0"], "daily")).toBe("v0.2.0");
  });

  test("the stable channel never gets a daily build", () => {
    expect(newestRelease(tags, "stable")).toBe("v0.1.1");
    expect(newestRelease(["v0.1.2-daily.20261103.9"], "stable")).toBeNull();
  });

  test("candidates newest first, each once (the latest release is also in the feed)", () => {
    expect(releasesNewestFirst(["v0.1.1", ...tags], "daily")).toEqual([
      "v0.1.2-daily.20261103.9",
      "v0.1.1",
      "v0.1.1-daily.20261102.7",
      "v0.1.1-daily.20261101.6",
      "v0.1.0",
    ]);
    expect(releasesNewestFirst(tags, "stable")).toEqual(["v0.1.1", "v0.1.0"]);
  });

  test("tags that aren't versions are ignored", () => {
    expect(newestRelease(["nightly", "v1", "latest"], "daily")).toBeNull();
  });
});

test("tagsFromFeed reads the releases' tags from GitHub's feed", () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry><id>tag:github.com,2008:Repository/1/v0.1.2-daily.20261103.9</id>
    <link rel="alternate" type="text/html" href="https://github.com/nayupls1/rune-browser/releases/tag/v0.1.2-daily.20261103.9"/>
  </entry>
  <entry><link rel="alternate" type="text/html" href="https://github.com/nayupls1/rune-browser/releases/tag/v0.1.1"/>
    <content type="html">&lt;a href="https://github.com/electron/electron/releases/tag/v45.2.1"&gt;Electron&lt;/a&gt;
      <link href="https://github.com/someone/else/releases/tag/v9.9.9"/></content>
  </entry>
</feed>`;
  // Only the entries' own links to this repository's releases, not links in the notes.
  expect(tagsFromFeed(xml, "nayupls1/rune-browser")).toEqual(["v0.1.2-daily.20261103.9", "v0.1.1"]);
});

test("a daily build starts on the daily channel", () => {
  expect(defaultChannel("0.1.1-daily.20261102.7")).toBe("daily");
  expect(defaultChannel("0.2.0")).toBe("stable");
});
