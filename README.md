# Task Cleaner

Check off a task and it gets out of the way: Task Cleaner hides it (or deletes it) a moment later, and keeps hidden tasks in the note so you can bring them back with a click.

## How it works

Check a task, in any list style (`- [ ]`, `* [ ]`, `+ [ ]`, `1. [ ]`). Half a second later (the delay is a setting) the task, with anything nested under it, is taken out of the note:

- **Hide** (the default): it moves into a comment block at the bottom of the note, which Obsidian doesn't show in live preview or reading view.
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

In the note itself, at the bottom, so they sync and move with it:

```markdown
%% Task Cleaner: hidden items
after: "- [ ] Milk" @3
- [x] Eggs
	- [x] brown
after: top @0
- [x] Call the dentist
%%
```

Each `after:` line says which line the task goes back under, and the line number it was on (to tell repeated lines apart); the task's own lines follow. While tasks are shown, they're listed as `shown: "..."` instead.

The block only shows in source mode. In live preview it's hidden, the cursor skips over it, and typing or deleting can't change it, so it can't get broken by accident. Edit it in source mode if you need to.

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
- **Leave Task Resetter notes alone:** on by default.

## QuickNote

The [QuickNote](https://github.com/titandrive/obsidian-quicknote) Android widget follows Task Cleaner's settings: a task ticked on the widget is hidden (or deleted) into the same block, after the same delay. It doesn't know about `task-cleaner-ignore` yet.

## Install

Not on the community plugin store; install it with [BRAT](https://github.com/TfTHacker/obsidian42-brat):

1. Install and enable BRAT.
2. BRAT → **Add beta plugin** → `titandrive/Obsidian-Task-Cleaner`.
3. Enable **Task Cleaner** under Settings → Community plugins.

Or copy `main.js`, `manifest.json` and `styles.css` into `.obsidian/plugins/task-cleaner/` in your vault.

Task Cleaner used to be called Checker. Notes from then keep working: the old `%% Checker: hidden items` blocks and `checker-ignore` properties are still read, and are switched to the new names the first time Task Cleaner runs.
