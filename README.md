# Task Cleaner

Check off a task and it gets out of the way: Task Cleaner hides it (or deletes it) a moment later, and keeps them so you can bring them back with a click.

## How it works

Check a task, in any list style (`- [ ]`, `* [ ]`, `+ [ ]`, `1. [ ]`). Half a second later (the delay is a setting) the task, with anything nested under it, is taken out of the note:

- **Hide** (the default): it's kept by Task Cleaner, ready to be shown again.
- **Delete**: it's removed for good.

Changed your mind? Uncheck it during the delay and it stays. In the editor, Ctrl/Cmd+Z puts it back.

It works wherever you check a task in Obsidian: live preview, source mode, reading view, a task list in another note (Dataview, Tasks), an embedded note or a hover preview. Changes that arrive by sync from another device are left to the device they were made on, so a task is never hidden twice.

## Showing hidden tasks

The sidebar button and the command **Show completed tasks** put a note's hidden tasks back where they were, each under the line it was under (or on its old line if that one's gone). The button's dashed circle turns solid, and both now read **Hide completed tasks**, which tucks them away again.

While they're shown:

- Uncheck one and it becomes a normal task again.
- Delete one and it's gone for good.
- Check another task and it's hidden as usual.

**Delete completed tasks** (Hide mode only) deletes all of the note's completed tasks that Task Cleaner keeps, hidden or shown.

## Where hidden tasks are kept

In Task Cleaner's settings file (`.obsidian/plugins/task-cleaner/data.json`), listed by note, so nothing is added to your notes. Each one remembers the line it was under and the line number it was on, so it goes back to the right place even when a line is repeated. They follow a note when it's renamed, and are dropped when the note is deleted.

If the settings file syncs between devices (Obsidian Sync with community plugin settings on, for example), so do hidden tasks. When one device's settings come in, Task Cleaner merges them note by note, keeping each note's list from whichever device changed it last, so hiding tasks on both doesn't lose either side's.

Hidden tasks are deleted for good after a while (**Purge hidden items** in settings, 30 days by default). Tasks shown in a note at the time stay.

## Leaving a note alone

Add this to a note's frontmatter and Task Cleaner won't touch its checked tasks:

```yaml
---
task-cleaner-ignore: true
---
```

Or run **Ignore this note** from the command palette. In an ignored note the same command reads **Track this note**, and removes it again.

Notes with a [Task Resetter](https://github.com/titandrive/Obsidian-Task-Resetter) button (`[reset-tasks]`) are left alone too, so their checklists keep working (**Leave Task Resetter notes alone** in settings, on by default).

## Settings

- **Checked item behavior:** Hide (the default) or Delete.
- **Delay:** how long a checked task stays before it's hidden or deleted. Right away, half a second (the default), 1, 2, 3, 5, 10 or 30 seconds.
- **Purge hidden items:** how long hidden tasks are kept. 1 day, 1 week, 2 weeks, 30 days (the default), 90 days, 1 year, or never.
- **Leave Task Resetter notes alone:** on by default. Only shown, and only used, when Task Resetter is installed.

## QuickNote

The [QuickNote](https://github.com/titandrive/obsidian-quicknote) Android widget follows Task Cleaner's settings: a task ticked on the widget is hidden (or deleted) after the same delay, and ignored notes are left alone. The widget leaves hidden tasks in `widget-inbox.json` next to the settings, which Task Cleaner takes in when Obsidian comes to the front.

## Install

Not on the community plugin store; install it with [BRAT](https://github.com/TfTHacker/obsidian42-brat):

1. Install and enable BRAT.
2. BRAT → **Add beta plugin** → `titandrive/Obsidian-Task-Cleaner`.
3. Enable **Task Cleaner** under Settings → Community plugins.

Or copy `main.js`, `manifest.json` and `styles.css` into `.obsidian/plugins/task-cleaner/` in your vault.

Earlier versions (some called Checker) kept hidden tasks in a block at the bottom of each note. Task Cleaner moves any such block into its settings and out of the note when it starts. The old `checker-ignore` property still works.
