// Checks that failed and then passed when run again: not a reason to fail CI,
// but never silent either. On GitHub Actions they become warnings on the run
// (and in the PR's checks) and a section in the job summary, so flaky tests get
// fixed instead of retried forever.
import { appendFileSync } from "node:fs";

export function reportFlaky(kind: string, names: string[]) {
  if (!names.length) return;
  const list = names.map((n) => `  - ${n}`).join("\n");
  console.log(`\n⚠ Flaky ${kind}: failed, then passed when run again:\n${list}`);
  if (!process.env.GITHUB_ACTIONS) return;
  // Workflow commands are one line each: newlines are escaped.
  const escape = (s: string) => s.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
  for (const name of names) console.log(`::warning title=${escape(`Flaky ${kind}`)}::${escape(name)}`);
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary)
    appendFileSync(
      summary,
      `### ⚠ Flaky ${kind} (${process.platform})\n\nFailed, then passed when run again:\n\n${names.map((n) => `- ${n}`).join("\n")}\n\n`,
    );
}
