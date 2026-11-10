<!-- user-manual-boilerplate v1.0.0 -->

# OKF Wiki user manual

OKF Wiki serves folders of your Obsidian vault to AI agents over the Model Context Protocol (MCP), so
agents can read, search and draft notes while you decide what counts as reviewed.

This manual covers OKF Wiki 0.7.0 and its `okf` command line tool. It is for people who keep
knowledge in Obsidian and want agents such as Claude Code to use it, and for people who check
Open Knowledge Format (OKF) bundles in CI. You need Obsidian desktop and, to connect an agent, an MCP
client. The `okf` tool also needs Node.js.

## Start here

| If you want to | Read |
| -------------- | ---- |
| Install OKF Wiki or the `okf` tool | [Installation](installation.md) |
| Get an agent reading your notes in ten minutes | [Quickstart](quickstart.md) |
| Follow a real job from input to output | [Examples](#examples) |
| Do one specific task | [How-to guides](#how-to-guides) |
| Understand how it works | [Concepts](#concepts) |
| Look up a command, tool, setting or lint code | [Reference](#reference) |
| Fix an error | [Troubleshooting](troubleshooting.md) |

## Examples

End-to-end walkthroughs with sample data and the exact output you should see.

- [Check a bundle before you commit it](examples/01-check-a-bundle-before-you-commit.md)

## How-to guides

One task per page, in numbered steps.

- [Connect an agent](how-to/connect-an-agent.md)
- [Limit what a token can do](how-to/limit-what-a-token-can-do.md)
- [Review and approve agent drafts](how-to/review-and-approve-agent-drafts.md)
- [Turn on auto approve](how-to/turn-on-auto-approve.md)
- [Undo an agent change](how-to/undo-an-agent-change.md)
- [Check bundles in CI](how-to/check-bundles-in-ci.md)

## Concepts

Background and explanation. No steps.

- [OKF bundles](concepts/okf-bundles.md)
- [Trust and provenance](concepts/trust-and-provenance.md)
- [Language policy and raw sources](concepts/language-policy-and-raw-sources.md)

## Reference

- [Command line](reference/cli.md)
- [Lint codes](reference/lint-codes.md)
- [MCP tools](reference/mcp-tools.md)
- [Extension API](reference/extension-api.md)
- [Configuration](reference/configuration.md)

## Help

- [Troubleshooting](troubleshooting.md)
- [Glossary](glossary.md)
- Report a problem: <https://github.com/ysasiwat/obsidian-okf-wiki/issues>
