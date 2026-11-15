# Serve agents while Obsidian is closed

Use this when agents should reach your bundles even when Obsidian is not open. `okf serve` runs the
same MCP server, on the same port with the same tokens, from the moment you log in. When you open
Obsidian, the plugin takes the server over; when you close Obsidian, `okf serve` takes it back.
Agents keep the same URL and token.

## Before you start

- The plugin is set up in the vault: at least one bundle enabled and one token created.
- Node.js 22 or later is installed (`node --version`).
- Windows. On macOS and Linux, see [Other systems](#other-systems).

## Steps

1. In Obsidian, open **Settings → OKF Wiki → Background server**. The status shows
   **Not installed**. If it says Node.js is missing, install it from nodejs.org and reopen the
   settings.
2. Click **Install** and confirm. The plugin writes `okf.cjs` to `%USERPROFILE%\.okf-wiki\`, adds
   a Task Scheduler task that starts it at logon with no window, and starts it now. The status
   changes to **Installed, running**.
3. Use **Stop** and **Start** in the same place to stop the server until the next logon or start
   it again, and **Uninstall** to remove it. After a plugin update, the plugin updates `okf.cjs`
   and restarts the task by itself.
4. Optional: to let agents write while Obsidian is closed, turn on **Allow agent writes while
   Obsidian is closed** in the same section. It is off by default, so the background server only
   reads. Outside Obsidian nothing sees you typing in another editor; new notes still wait for your
   approval in the review queue.

## Check that it worked

Close Obsidian and ask your agent to list its OKF bundles. Open Obsidian again: the **Background
server** section shows `Last report: released`, which means the plugin has the server.

The server logs to `.obsidian/plugins/okf-wiki/state/daemon.log` in the vault.

## Stop or start it

To turn the background server off without a terminal, turn off **Serve while Obsidian is closed**
in **Settings → OKF Wiki → Background server**. The next time you close Obsidian, `okf serve` keeps
running but serves nothing; turn it on again and it serves from the next close.

To stop the server until the next logon, or to start it again now, run this in a terminal:

```
node "%USERPROFILE%\.okf-wiki\okf.cjs" serve --stop --vault "C:\Users\you\Notes"
node "%USERPROFILE%\.okf-wiki\okf.cjs" serve --start --vault "C:\Users\you\Notes"
```

Ending the task in Task Scheduler does not stop the server; use `--stop`.

## Remove it

Copy the **Uninstall** command from the same section and run it, or run:

```
node "%USERPROFILE%\.okf-wiki\okf.cjs" serve --uninstall --vault "C:\Users\you\Notes"
```

## Other systems

`--install` supports Windows only. Elsewhere, start this command at login with your system's service
manager. These examples are untested.

- macOS: a LaunchAgent in `~/Library/LaunchAgents/` whose `ProgramArguments` are `node`,
  the path to `okf.cjs`, `serve`, `--vault` and the vault path, with `RunAtLoad` and `KeepAlive` true.
- Linux: a `systemd --user` unit with
  `ExecStart=/usr/bin/node /path/to/okf.cjs serve --vault /path/to/vault` and
  `WantedBy=default.target`, enabled with `systemctl --user enable --now`.

## Troubleshooting

- **The plugin shows "did not hand over the vault in time" and pauses agent writes.** The background
  server did not release the vault within 10 seconds. Restart Obsidian; if it repeats, read
  `daemon.log`.
- **`another okf serve already runs for ...`.** The logon task already runs for this vault.
- **A version warning in Background server.** Download `okf.cjs` from the new release and run the
  install command again.
