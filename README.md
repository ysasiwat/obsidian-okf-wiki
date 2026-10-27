<a id="readme-top"></a>



<!-- PROJECT SHIELDS -->
[![Contributors][contributors-shield]][contributors-url]
[![Forks][forks-shield]][forks-url]
[![Stargazers][stars-shield]][stars-url]
[![Issues][issues-shield]][issues-url]
[![Apache-2.0 License][license-shield]][license-url]



<!-- PROJECT HEADER -->
<br />
<div align="center">
  <h3 align="center">OKF Wiki</h3>

  <p align="center">
    Serve your Obsidian notes to AI agents over MCP as Open Knowledge Format bundles, with provenance, trust and freshness.
    <br />
    <a href="#usage"><strong>Read the usage guide »</strong></a>
    <br />
    <br />
    <a href="https://github.com/ysasiwat/obsidian-okf-wiki/issues/new?labels=bug&template=bug-report.md">Report Bug</a>
    &middot;
    <a href="https://github.com/ysasiwat/obsidian-okf-wiki/issues/new?labels=enhancement&template=feature-request.md">Request Feature</a>
  </p>
</div>



<!-- TABLE OF CONTENTS -->
<details>
  <summary>Table of Contents</summary>
  <ol>
    <li>
      <a href="#about-the-project">About The Project</a>
      <ul>
        <li><a href="#features">Features</a></li>
        <li><a href="#network-use-and-data">Network use and data</a></li>
      </ul>
    </li>
    <li>
      <a href="#getting-started">Getting Started</a>
      <ul>
        <li><a href="#prerequisites">Prerequisites</a></li>
        <li><a href="#installation">Installation</a></li>
        <li><a href="#first-time-setup">First-time setup</a></li>
      </ul>
    </li>
    <li>
      <a href="#usage">Usage</a>
      <ul>
        <li><a href="#connect-an-agent">Connect an agent</a></li>
        <li><a href="#access-tokens-and-scopes">Access tokens and scopes</a></li>
        <li><a href="#reviewing-what-agents-write">Reviewing what agents write</a></li>
        <li><a href="#trust-and-provenance">Trust and provenance</a></li>
        <li><a href="#staying-in-control">Staying in control</a></li>
        <li><a href="#organizing-bundles">Organizing bundles</a></li>
        <li><a href="#bundle-policy">Bundle policy</a></li>
      </ul>
    </li>
    <li><a href="#roadmap">Roadmap</a></li>
    <li><a href="#support">Support</a></li>
    <li>
      <a href="#building-and-extending">Building and Extending</a>
      <ul>
        <li><a href="#built-with">Built With</a></li>
        <li><a href="#build-from-source">Build from source</a></li>
        <li><a href="#the-okf-cli">The okf CLI</a></li>
        <li><a href="#extension-api-for-other-plugins">Extension API for other plugins</a></li>
        <li><a href="#contributing">Contributing</a></li>
      </ul>
    </li>
    <li><a href="#license">License</a></li>
    <li><a href="#acknowledgments">Acknowledgments</a></li>
  </ol>
</details>

Everything from **About The Project** to **Support** is for people who use the plugin in Obsidian and
needs no programming. Building, testing, the `okf` CLI and the API for other plugins are in
[Building and Extending](#building-and-extending).



<!-- ABOUT THE PROJECT -->
## About The Project

OKF Wiki serves folders of your vault to AI agents over [MCP](https://modelcontextprotocol.io) as
[Open Knowledge Format (OKF) v0.2](https://github.com/google/open-knowledge-format) bundles:
plain Markdown with YAML frontmatter that records where knowledge came from, who checked it and
when it goes stale. Agents read, search and write through OKF-aware tools; you stay in charge of
what counts as reviewed.

Here's why:

- Agents that remember things in your notes should say where each fact came from
- You should decide which knowledge counts as reviewed, not the agent
- Your notes stay plain Markdown that you can read and edit without the plugin

Desktop only. Status: 0.7.0, early.

<p align="right">(<a href="#readme-top">back to top</a>)</p>



### Features

- **MCP tools for OKF:** browse, search, read, graph, history and lint, plus writes for agents you allow
- **Drafts first:** everything an agent writes starts as a draft that you approve or reject in Obsidian
- **Provenance:** who wrote each note and why, kept in `log.md` and an audit log
- **Checkable trust:** notes whose `status` or `verified` changed outside the plugin are reported as not attested
- **Safe writes:** rate limits, no writes while you type in a note, snapshots and one-click revert
- **Language policy:** curated notes in English, original sources kept as raw files in any language
- **Extension API:** other plugins can read the wiki and follow every change
- **`okf` CLI:** lint any OKF bundle in CI

<p align="right">(<a href="#readme-top">back to top</a>)</p>



### Network use and data

- The plugin runs a **local MCP server on `127.0.0.1`** (port 27150 by default, changeable in the
  settings). It listens on the loopback interface only, so other machines cannot reach it. It
  starts only once you create an access token.
- Every request needs a token you create in the settings. Tokens are stored as SHA-256 hashes, are
  shown once, and can be limited to scopes, bundles and folders.
- The plugin **contacts no remote service** and has **no telemetry**. Whatever an agent reads goes
  to the agent you connected, which may send it to its own model provider; that is between you
  and that agent.
- It reads and writes only inside your vault: the bundle folders you enable, and its own state
  (snapshots, audit log, trust snapshot) in its plugin folder. Files reached through symlinks that
  lead outside the vault are not served.
- It imports Node's `fs` module for one thing only: resolving a file's real path (`realpath`), so
  that a symlink inside a bundle cannot expose files outside the vault or in its configuration
  folder. It reads and writes notes only through Obsidian's vault API.

<p align="right">(<a href="#readme-top">back to top</a>)</p>



<!-- GETTING STARTED -->
## Getting Started

### Prerequisites

* Obsidian desktop 1.13.1 or later (the plugin does not run on mobile)
* An MCP client that speaks streamable HTTP, such as Claude Code

### Installation

1. In Obsidian, open **Settings → Community plugins**, search for **OKF Wiki**, install and enable it.
2. To install by hand instead, download `main.js`, `manifest.json` and `styles.css` from the
   [latest release](https://github.com/ysasiwat/obsidian-okf-wiki/releases) into
   `<vault>/.obsidian/plugins/okf-wiki/`, then enable the plugin.

To build the plugin from source instead, see [Build from source](#build-from-source).

### First-time setup

From a fresh install to your first approved note. The steps use Claude Code;
other MCP clients work the same way with the `.mcp.json` snippet.

1. **Choose a folder.** Pick a folder in your vault for the knowledge agents may use, or create an
   empty one, for example `Knowledge`. Notes outside it stay private.
2. **Serve it.** Open **Settings → OKF Wiki**. Under **Bundles**, type the folder path in
   **Add a folder** and press **Add**.
3. **Set your ID.** Under **Agent writes**, fill in **Your ID**, for example your name. You need it
   to approve notes, and it records your own edits.
4. **Create a token.** Under **New token**, enter a name such as `claude-code`. Turn on
   **Scope: Write** if the agent may write drafts; leave it off for read only. Press
   **Create token**.
5. **Copy a command.** A dialog shows the token once, with two **Claude Code** commands (one for
   this project folder, one for all your projects) and a `.mcp.json` snippet. Copy the one you need
   before you close it; if you lose it, revoke the token and create another. The status bar now shows `OKF MCP :27150 · 1 bundle`.
6. **Connect Claude Code.** Paste the command in a terminal, then start `claude`:
   - **This project folder** (`--scope local`) adds the server only for the folder you run it in,
     so run it in the folder where you start Claude Code.
   - **All your projects** (`--scope user`) adds it for every folder.

   Avoid `--scope project`: it writes the token into the project's `.mcp.json`, which is often
   committed to git.
7. **Try it.** Ask, for example, "Which OKF bundles can you use, and what is in them?" With
   Write, ask it to write a short note on a topic you know, citing its sources.
8. **Review the draft.** Run the command **Open review queue** and read the new note. Press
   **Approve** next to it, or **Reject** with a reason the agent can read.

Next, read [Organizing bundles](#organizing-bundles) before your bundle grows, and
[Access tokens and scopes](#access-tokens-and-scopes) before you give tokens to more agents.

<p align="right">(<a href="#readme-top">back to top</a>)</p>



<!-- USAGE EXAMPLES -->
## Usage

### Connect an agent

1. In the plugin settings under **Bundles**, add a folder to serve. Any folder works; it becomes an
   OKF bundle (an `index.md`, a `log.md` and optionally a `.okf.yaml` policy). Folders that
   already look like OKF bundles are offered for you to enable.
2. Under **New token**, create a token (see [Access tokens and scopes](#access-tokens-and-scopes)).
   New tokens can read; turn on **Scope: Write** to let agents write drafts.
3. Copy a command shown for Claude Code (or the `.mcp.json` snippet for other clients). For this
   project folder only, run it in that folder:

   ```sh
   claude mcp add --transport http --scope local okf-wiki http://127.0.0.1:27150/mcp/ --header "Authorization: Bearer okf_…"
   ```

   For all your projects, the command uses `--scope user` instead.

4. Ask your agent something about the notes in the bundle.

The agent gets these tools. Reading: `okf_bundles`, `okf_browse`, `okf_read`, `okf_read_file`
(non-markdown text such as attester code), `okf_search`, `okf_graph`, `okf_history`, `okf_lint`.
Writing (Write scope): `okf_create`, `okf_update`, `okf_move`, `okf_deprecate`,
`okf_describe_directory`, `okf_ingest_raw`, `okf_request_review`. Prompts: `okf_author_concept`
and `okf_distill_raw`.

### Access tokens and scopes

Give each agent its own token, created under **New token** in the settings:

- **New token name** identifies the agent in logs, for example `claude-code`.
- **Limit to bundles** and **Limit to paths** restrict the token to some bundle folders, or to some
  folders inside them (such as `concepts` and `decisions`). Empty means everything.
- Every token can read. Extra scopes:
  - **Write**: create, update, move and deprecate notes and ingest raw sources. New notes are drafts.
  - **Publish**, **Replace raw sources** and **Edit computations** are for trusted automation only.
    Publish makes drafts stable without a person's review.
- **Automated process** stamps the token's writes as `process:<name>` instead of the agent's name
  and version.

The token is shown once, together with the Claude Code commands and the `.mcp.json` snippet. Only a
hash is kept, so if you lose a token, revoke it under **Access tokens** and create another.

### Reviewing what agents write

- **Agents write drafts.** Everything an agent creates starts as `draft`. Only you, in Obsidian, can
  approve a note (**Approve this note**, or the **Review queue**); no token can mark knowledge as
  reviewed by a person. Approving needs **Your ID** (under **Agent writes**).
- **The review queue** lists drafts and other notes that need you, such as stale notes or notes an
  agent asked you to review. Open it with the command **Open review queue**. From the next release
  after 0.6.3, a ribbon icon (a checklist, `list-checks`) opens it too, and the status bar shows
  `OKF review: N` while notes wait for you (click it to open the queue). You can tick several notes,
  or **Select all without errors**, and **Approve selected** in one go.
- **Auto approve (optional, off by default).** Under **Auto approve**, list the tokens (and
  optionally bundles) you trust. A note such a token writes that cites its sources in footnotes and
  has no lint warnings or review request is approved at once as `process:auto-approve`: it becomes
  stable and machine-confirmed, not reviewed by a person. Notes you approved yourself always come
  back to you after an agent edits them.
- **Reject.** **Reject** in the review queue, or **Reject the agent's latest change to this note…**,
  undoes the agent's latest change to that note (a new draft goes to the trash) and writes your
  reason to `log.md`, where agents read it.

### Trust and provenance

- **Provenance is recorded for you.** The server stamps who wrote each note, keeps `index.md` and
  `log.md` up to date, and, once you set **Your ID**, records your own edits when you leave a note
  (turn this off with **Record your edits**).
- **Trust you can check.** If someone edits `status` or `verified` outside the plugin (another
  device, a script), the note is reported as not attested instead of trusted.
- **Original sources stay original.** Curated notes are English. Material in other languages is
  stored as a write-once raw source under `references/raw/` and cited with footnotes.

### Staying in control

- **Pause or resume agent writes** stops every agent write at once.
- **Revert an agent change…** undoes any recent agent write from its snapshot.
- Writes are rate limited per token (settings under **Agent writes**), refused while you are typing
  in that note, and checked so they cannot drop sources, citations or large parts of a note by
  accident.

Other commands: **Open review queue**, **Accept edits to this raw source**, **Convert links in
this bundle to OKF form**, **Reload OKF bundles**, **Copy MCP endpoint URL**, **Restart MCP
server**.

### Organizing bundles

- **One bundle per body of knowledge whose notes link to each other.** Links, `sources` and
  footnote citations cannot point outside their bundle, and the graph and backlinks stop at its
  edge, so splitting related notes across bundles breaks them apart.
- **Add another bundle only for a real boundary:** a different set of agents that may read or
  write it (tokens can be limited to bundles), a different auto approve choice, a different
  `.okf.yaml` policy, or a folder you share or sync on its own. Bundles cannot be nested.
- **Inside a bundle, use folders for the kind of note and tags for the topic**, for example
  `concepts/`, `playbooks/` and `decisions/`, with originals in `references/raw/`. A note has one
  folder but many tags, and `okf_search` filters by both. Keep folders shallow.
- **Notes outside every bundle are not served**, so personal notes and drafts can stay in the
  same vault.

### Bundle policy

A bundle may carry a `.okf.yaml` file:

```yaml
okf_version: "0.2"
content_language: en
raw_dirs: [references/raw]
non_english_threshold: 0.05
auto_index: true
auto_log: true
agent_initial_status: draft
```

<p align="right">(<a href="#readme-top">back to top</a>)</p>



<!-- ROADMAP -->
## Roadmap

- [x] Read-only MCP server with OKF lint and the `okf` CLI
- [x] Agent writes with drafts, snapshots, revert and rate limits
- [x] Review queue, batch approve, auto approve and reject
- [x] Extension API for other plugins

See the [open issues](https://github.com/ysasiwat/obsidian-okf-wiki/issues) for a full
list of proposed features (and known issues).

<p align="right">(<a href="#readme-top">back to top</a>)</p>



<!-- SUPPORT -->
## Support

Like this project? A coffee keeps it going — every cup funds issues, fixes, and
new features.

<div align="center">
  <a href="https://buymeacoffee.com/ysasiwat" target="_blank">
    <img src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png" alt="Buy Me A Coffee" width="217" height="60">
  </a>
</div>

<p align="right">(<a href="#readme-top">back to top</a>)</p>



<!-- BUILDING AND EXTENDING -->
## Building and Extending

This part is for people who build the plugin, check bundles in CI, write plugins on top of OKF Wiki,
or contribute. You do not need any of it to use the plugin.

### Built With

* [![TypeScript][TypeScript-shield]][TypeScript-url]
* [![Obsidian][Obsidian-shield]][Obsidian-url]
* [![MCP][MCP-shield]][MCP-url]
* [![Zod][Zod-shield]][Zod-url]
* [![esbuild][esbuild-shield]][esbuild-url]
* [![Vitest][Vitest-shield]][Vitest-url]

### Build from source

Needs Node.js 22 or later:

```sh
git clone https://github.com/ysasiwat/obsidian-okf-wiki.git
cd obsidian-okf-wiki
npm ci
npm run build
node scripts/install-plugin.mjs <path-to-vault>
```

### The `okf` CLI

Checks any OKF bundle directory, in or out of Obsidian, for example in CI:

```sh
npm install
npm run build:cli
node dist/okf.cjs lint path/to/bundle            # conformance and policy; exit 1 on errors
node dist/okf.cjs lint path/to/bundle --strict   # also fail on warnings
node dist/okf.cjs index path/to/bundle           # exit 1 if index.md files are out of date
node dist/okf.cjs index path/to/bundle --write   # regenerate them
```

### Extension API for other plugins

Other plugins can read the wiki and follow its changes, but not write to it:

```ts
const api = (this.app as any).plugins.plugins["okf-wiki"]?.api;
if (api?.apiVersion === 1) {
  const off = api.onCommit((e) => {
    // e: { commitId, at, bundle, actor, tool, conceptId, reason?, reverts?,
    //      changes: [{ path, change: "created" | "modified" | "deleted" }] }
  });
  this.register(off);
  const hits = api.search({ bundle: "Knowledge", query: "remote sensing" }).hits;
  const note = api.read({ bundle: "Knowledge", concept_id: hits[0].concept_id });
}
```

- `bundles()`, `search(args)` and `read(args)` take the same arguments as the `okf_bundles`,
  `okf_search` and `okf_read` tools and return copies.
- `onCommit` is called after every commit is on disk: agent writes, your own approvals and edits, and
  reverts (a revert lists the files it restored). Listeners run after the write and cannot slow or
  break it.
- When OKF Wiki is disabled or reloaded, listeners are dropped and the old `api` object throws; get
  it again once OKF Wiki is enabled. The types are in [src/api.ts](src/api.ts).

### Contributing

Contributions are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) for the project's rules, then:

1. Fork the Project
2. Create your Feature Branch (`git checkout -b feature/AmazingFeature`)
3. Run `npm run typecheck`, `npm run lint` and `npm test`
4. Commit your Changes (`git commit -m 'Add some AmazingFeature'`)
5. Push to the Branch (`git push origin feature/AmazingFeature`)
6. Open a Pull Request

Development commands:

```sh
npm test              # vitest
npm run typecheck
npm run lint          # eslint-plugin-obsidianmd
npm run build         # main.js
npm run bench         # UI-thread cost on large synthetic bundles
```

### Top contributors:

<a href="https://github.com/ysasiwat/obsidian-okf-wiki/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=ysasiwat/obsidian-okf-wiki" alt="contrib.rocks image" />
</a>

<p align="right">(<a href="#readme-top">back to top</a>)</p>



<!-- LICENSE -->
## License

Distributed under the Apache-2.0 License. See [LICENSE](LICENSE) for more information.
Includes material from Open Knowledge Format (Apache-2.0); the design of the server follows
obsidian-local-rest-api (MIT) without using its code. See [NOTICE](NOTICE).

<p align="right">(<a href="#readme-top">back to top</a>)</p>



<!-- ACKNOWLEDGMENTS -->
## Acknowledgments

* [Open Knowledge Format](https://github.com/google/open-knowledge-format) for the bundle format and sample bundles
* [obsidian-local-rest-api](https://github.com/coddingtonbear/obsidian-local-rest-api) for the design of a local server inside Obsidian
* [Model Context Protocol](https://modelcontextprotocol.io) and its TypeScript SDK
* [Obsidian developer docs](https://docs.obsidian.md)

<p align="right">(<a href="#readme-top">back to top</a>)</p>



<!-- MARKDOWN LINKS & IMAGES -->
[contributors-shield]: https://img.shields.io/github/contributors/ysasiwat/obsidian-okf-wiki.svg?style=for-the-badge
[contributors-url]: https://github.com/ysasiwat/obsidian-okf-wiki/graphs/contributors
[forks-shield]: https://img.shields.io/github/forks/ysasiwat/obsidian-okf-wiki.svg?style=for-the-badge
[forks-url]: https://github.com/ysasiwat/obsidian-okf-wiki/network/members
[stars-shield]: https://img.shields.io/github/stars/ysasiwat/obsidian-okf-wiki.svg?style=for-the-badge
[stars-url]: https://github.com/ysasiwat/obsidian-okf-wiki/stargazers
[issues-shield]: https://img.shields.io/github/issues/ysasiwat/obsidian-okf-wiki.svg?style=for-the-badge
[issues-url]: https://github.com/ysasiwat/obsidian-okf-wiki/issues
[license-shield]: https://img.shields.io/github/license/ysasiwat/obsidian-okf-wiki.svg?style=for-the-badge
[license-url]: https://github.com/ysasiwat/obsidian-okf-wiki/blob/main/LICENSE
[TypeScript-shield]: https://img.shields.io/badge/TypeScript-3178C6?style=for-the-badge&logo=typescript&logoColor=white
[TypeScript-url]: https://www.typescriptlang.org/
[Obsidian-shield]: https://img.shields.io/badge/Obsidian-7C3AED?style=for-the-badge&logo=obsidian&logoColor=white
[Obsidian-url]: https://obsidian.md/
[MCP-shield]: https://img.shields.io/badge/MCP-000000?style=for-the-badge&logo=modelcontextprotocol&logoColor=white
[MCP-url]: https://modelcontextprotocol.io/
[Zod-shield]: https://img.shields.io/badge/Zod-3E67B1?style=for-the-badge&logo=zod&logoColor=white
[Zod-url]: https://zod.dev/
[esbuild-shield]: https://img.shields.io/badge/esbuild-FFCF00?style=for-the-badge&logo=esbuild&logoColor=black
[esbuild-url]: https://esbuild.github.io/
[Vitest-shield]: https://img.shields.io/badge/Vitest-6E9F18?style=for-the-badge&logo=vitest&logoColor=white
[Vitest-url]: https://vitest.dev/
