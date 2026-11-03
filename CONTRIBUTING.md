# Contributing

Thanks for your interest in Rune Browser!

## Issues, not pull requests (for now)

Rune Browser is young and changes fast, so for now it takes **issues only**:
pull requests from outside are closed without review. That will change once
things settle.

- **Bugs:** [open a bug report](https://github.com/nayupls1/rune-browser/issues/new?template=bug_report.yml)
  with your OS, the Rune Browser version (Settings → About) and the steps to
  reproduce it. Screenshots help a lot.
- **Ideas:** [suggest a feature](https://github.com/nayupls1/rune-browser/issues/new?template=feature_request.yml).
  Describe the problem you have, not only the solution you'd like.
- **Security issues:** never in a public issue; see [SECURITY.md](SECURITY.md).

## Running it from source

You're welcome to build and hack on it locally:

```sh
bun install
bun run dev      # the app with hot reload
bun fmt          # format the code
bun run check    # formatting, typecheck, unit tests, build and e2e (headless)
```

See the [README](README.md) for requirements and [apps/browser/docs/](apps/browser/docs/) for how it fits
together. [CLAUDE.md](CLAUDE.md) has the conventions the code follows (it's
written for coding agents, but it's the best summary for people too).
