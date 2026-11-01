// The unit tests (`bun run test`). Test files that fail are run once more, on
// their own: if they pass then, the failure was flaky (a slow CI machine, a
// port taken in between) and is reported as such instead of failing the run.
// Anything else fails as usual: a test that fails twice, a file that crashed
// outside its tests, or many failing files at once (that's a real breakage).
//
//   bun run test                  every file in tests/
//   bun run test tests/x.test.ts  only those (arguments go to `bun test`)
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reportFlaky } from "./lib/flaky";

/** More failing files than this isn't flakiness. */
const MAX_RERUN = 5;

const args = process.argv.slice(2);
const dir = mkdtempSync(join(tmpdir(), "rune-test-report-"));

async function run(targets: string[], report: string) {
  const proc = Bun.spawn(
    [process.execPath, "test", "--timeout", "30000", "--reporter=junit", `--reporter-outfile=${report}`, ...targets],
    { stdio: ["inherit", "inherit", "inherit"] },
  );
  return proc.exited;
}

const attr = (tag: string, name: string) => tag.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1];
const unescape = (s: string) =>
  s
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

/** The files with failing tests in a junit report, with those tests; null if there's no report. */
function failures(report: string): Map<string, string[]> | null {
  if (!existsSync(report)) return null;
  const xml = readFileSync(report, "utf8");
  const failed = new Map<string, string[]>();
  for (const suite of xml.split("<testsuite ").slice(1)) {
    const file = attr(suite, "file");
    if (!file) continue;
    const names: string[] = [];
    for (const testcase of suite.split("<testcase ").slice(1))
      if (/<(failure|error)[\s>]/.test(testcase)) names.push(unescape(attr(` ${testcase}`, "name") ?? "(unnamed)"));
    // Failures outside any test (a hook, an import) count too.
    if (names.length || Number(attr(suite, "failures") ?? 0) > 0 || /<error[\s>]/.test(suite.split("<testcase ")[0]!))
      failed.set(unescape(file).replaceAll("\\", "/"), names.length ? names : ["(outside a test)"]);
  }
  return failed;
}

let code: number;
try {
  code = await run(args.length ? args : ["tests"], join(dir, "first.xml"));
  if (code !== 0) {
    const failed = failures(join(dir, "first.xml"));
    if (failed?.size && failed.size <= MAX_RERUN) {
      const files = [...failed.keys()];
      console.log(`\nRunning ${files.length} failed test file(s) again on their own: ${files.join(", ")}\n`);
      code = await run(
        files.map((f) => `./${f}`),
        join(dir, "again.xml"),
      );
      if (code === 0)
        reportFlaky(
          "unit tests",
          [...failed].flatMap(([file, names]) => names.map((n) => `${file}: ${n}`)),
        );
    } else if (failed?.size) {
      console.log(`\n${failed.size} test files failed: not running them again (more than ${MAX_RERUN}).`);
    }
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
process.exit(code);
