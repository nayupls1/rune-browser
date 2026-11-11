# Security policy

Rune Browser runs an agent and web pages next to your logins, so security
reports are very welcome.

## Reporting a vulnerability

Please **don't open a public issue**. Report it privately through GitHub:
[Report a vulnerability](https://github.com/nayupls1/rune-browser/security/advisories/new)
(the repository's Security tab → "Report a vulnerability").

Include what you found, how to reproduce it, and what an attacker could do with
it. You'll get an answer within a week; fixes for confirmed issues ship in a
release as soon as they're ready, and the advisory is published with it (with
credit, if you like).

## Supported versions

Only the latest release gets security fixes. Rune Browser updates itself, so
staying current is one restart away.

## Scope

Especially interesting:

- A web page escaping its sandbox, or reaching your files, other workspaces'
  logins or Rune Browser's own API.
- A web page getting the agent to use a provider's own tools (see "Rules for
  the product" in [CLAUDE.md](CLAUDE.md): the agent only ever has Rune
  Browser's tools).
- Cookies, tokens or sealed credentials reaching the agent, prompts, logs or
  API responses.
- Anything that lets an agent bypass a permission prompt.

The agents themselves (Claude Code, Codex, OpenCode) are separate projects;
report their own bugs to them.
