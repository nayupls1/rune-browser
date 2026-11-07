// Releases (see docs/releasing.md):
//
//   bun run release           tags origin/master with the version in apps/browser/package.json
//                             and pushes the tag, which starts the release workflow
//   bun run release --daily   starts the release workflow on master for a daily build
//                             (0.2.1-daily.20261031.42, for the daily channel); the
//                             workflow picks the version and tags it
import { $ } from "bun";

const SEMVER = /^\d+\.\d+\.\d+$/;
/** The browser's package.json, from the repo's root: the version lives there. */
const PACKAGE = "apps/browser/package.json";
const ACTIONS = "https://github.com/nayupls1/rune-browser/actions/workflows/release.yml";

const fail = (message: string): never => {
  console.error(`✗ ${message}`);
  process.exit(1);
};

const USAGE = `Usage:
  bun run release           tag origin/master with the version in ${PACKAGE} and push the tag
  bun run release --daily   start a daily build of master`;

// Both commands publish a release, so anything unexpected (a typo, --help) stops here instead.
const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log(USAGE);
  process.exit(0);
}
if (args.length > 1) fail(`Expected at most one argument, got: ${args.join(" ")}\n${USAGE}`);
const arg = args[0];
if (arg === "--daily") {
  await $`gh workflow run release.yml --ref master`;
  console.log(`✓ Started a daily release of master. The workflow builds, tests and publishes it: ${ACTIONS}`);
} else if (arg !== undefined) {
  fail(`Unknown argument "${arg}". Set the version in ${PACKAGE} (in a PR), then run \`bun run release\`.`);
} else {
  await $`git fetch origin master --quiet`;
  const { version } = JSON.parse(await $`git show ${`origin/master:${PACKAGE}`}`.text()) as { version: string };
  if (!SEMVER.test(version)) fail(`master's ${PACKAGE} has "${version}", not a version like 0.2.0.`);
  const tag = `v${version}`;
  // On GitHub, not locally: a failed release's tag may be deleted there but still be here.
  if ((await $`git ls-remote --tags origin ${`refs/tags/${tag}`}`.text()).trim())
    fail(`${tag} is released already. Bump the version in ${PACKAGE} (in a PR) first.`);
  await $`git tag --force -a ${tag} -m ${`Rune Browser ${version}`} origin/master`;
  await $`git push --quiet origin ${tag}`;
  console.log(`✓ Pushed ${tag} (origin/master). The release workflow builds, tests and publishes it: ${ACTIONS}`);
}
