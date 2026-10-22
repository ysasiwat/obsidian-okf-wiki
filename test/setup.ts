// Plugin code calls window.setTimeout (popout-window safe in Obsidian); Node has no window.
(globalThis as { window?: unknown }).window ??= globalThis;
