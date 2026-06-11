# BrowserTest — Playwright Skill Recorder & Player

A lightweight browser automation tool built on [Playwright](https://playwright.dev/).  
Record user interactions as **skills** (JSON files), then replay them on demand.

---

## Quick start

```bash
# Record a new skill
node recorder.js

# Play it back
node player.js <skill-name>

# List all recorded skills
node player.js --list
```

---

## recorder.js

Opens a real browser window and captures every click, fill, select, upload, checkbox, and navigation into a JSON skill file under `skills/`.

```bash
node recorder.js [skill-name] [start-url]
```

- If arguments are omitted you will be prompted for them.
- A **REC** overlay in the top-right corner of the browser confirms recording is active.
- Press **Enter** in the terminal to stop recording.
- Upload steps ask for a local file path so replay can re-send the same file.

### How selectors are chosen

The recorder tries each strategy in order, stopping at the first match:

| Priority | Strategy | Example |
|---|---|---|
| 1 | `data-testid` / `data-test` / `data-cy` / `data-qa` / `data-id` | `[data-testid="submit"]` |
| 2 | Stable `id` attribute | `#email` |
| 3 | `name` attribute on form elements | `input[name="username"]` |
| 4 | Visible text (buttons / links) | `button:text("Sign In")` |
| 5 | `aria-label` attribute | `button[aria-label="Close"]` |
| 6 | `placeholder` on inputs | `input[placeholder="Search…"]` |
| 7 | Associated `<label>` text | finds `<label for="x">` or wrapping `<label>` |
| 8 | `aria-labelledby` reference | `input[aria-labelledby="lbl1"]` |
| 9 | CSS path fallback | `table > tbody > tr:nth-of-type(2) > td > select` |

### Handling duplicate / unlabelled elements

When a portal has no IDs or names, and multiple identical elements appear on the same page, the recorder automatically stores an `nth` index alongside the selector:

```json
{ "type": "click", "selector": "button:text(\"Edit\")", "nth": 2 }
```

`nth` is 0-based and only written when the element is **not** the first match, keeping existing skill files clean.

---

## player.js

Replays a recorded skill step by step, printing a pass/fail result for each.

```bash
node player.js <skill>                    # play back
node player.js --list                     # list all skills
node player.js --generate <skill>         # print Playwright script to stdout
```

### Options

| Flag | Description |
|---|---|
| `--headless` | Run without opening a visible browser window |
| `--continue` | Keep going even when a step fails |
| `--keep-open` | Leave the browser open after playback finishes |
| `--prompt-selects` | Pause at every dropdown and let you pick a different value |
| `--delay=<ms>` | Pause between steps (default: 600 ms) |
| `--timeout=<ms>` | Per-step timeout (default: 15 000 ms) |

### Examples

```bash
node player.js Login-Flow
node player.js --headless --continue Login-Flow
node player.js --prompt-selects Login-Flow
node player.js --generate Login-Flow > login.spec.js
```

---

## `--prompt-selects` — override dropdown values at runtime

Use this flag when a skill was recorded with one dropdown value but you need to run it with a different one — without re-recording.

At each `select` step the player reads the live `<option>` list from the page and displays a menu:

```
  ┌─ Select options available:
  │  [ 0]  (please select)
  │  [ 1]  Test Workflow        http://…/159/11  ◀ recorded
  │  [ 2]  Production Workflow  http://…/200/11
  │  [ 3]  Draft Workflow       http://…/201/11
  └─ Recorded value: "Test Workflow"
  Enter option number or label/value (Enter = keep recorded):
```

**How to answer:**

| Input | What it does |
|---|---|
| *(Enter)* | Keep the recorded value |
| `2` | Select by option number shown in the menu |
| `Production` | Select by partial label (case-insensitive) |
| `http://…/200/11` | Select by exact `<option value>` string |

The skill JSON is never modified — the override applies only to that playback run.

---

## Skill file format (`skills/*.json`)

```json
{
  "name": "Login-Flow",
  "startUrl": "http://localhost/app/login",
  "recordedAt": "2026-06-08T23:55:48.237Z",
  "steps": [
    { "type": "navigate", "url": "http://localhost/app/login" },
    { "type": "fill",     "selector": "#email",    "value": "user@example.com" },
    { "type": "fill",     "selector": "#password",  "value": "secret" },
    { "type": "press",    "selector": "#password",  "key": "Enter" },
    { "type": "click",    "selector": "button:text(\"Sign In\")" },
    { "type": "select",   "selector": "#status",    "value": "active", "label": "Active", "nth": 1 },
    { "type": "check",    "selector": "#agree",     "checked": true },
    { "type": "upload",   "selector": "#cv",        "file": "uploads/cv.pdf" },
    { "type": "wait",     "ms": 2000 }
  ]
}
```

### Step types

| Type | Required fields | Notes |
|---|---|---|
| `navigate` | `url` | Waits for `domcontentloaded` |
| `click` | `selector` | `nth` — which occurrence (0-based, omit for first) |
| `fill` | `selector`, `value` | Triggers on blur / Enter |
| `select` | `selector`, `value` | Falls back to `label` if value not found |
| `press` | `selector`, `key` | Any Playwright key name, e.g. `"Enter"` |
| `check` | `selector`, `checked` | Boolean — true = check, false = uncheck |
| `upload` | `selector`, `file` | Path relative to project root under `uploads/` |
| `wait` | `ms` | Hard pause in milliseconds |

### Manually editing a skill

To fix a bad selector or target a duplicate element, edit the JSON directly:

```json
// Second "Edit" button on the page
{ "type": "click", "selector": "button:text(\"Edit\")", "nth": 1 }

// Input scoped inside a known parent
{ "type": "fill", "selector": "#user-form input[type=text]", "value": "John" }
```

---

## Project structure

```
BrowserTest/
├── recorder.js       # Browser recorder — produces skill JSON files
├── player.js         # Skill player — replays and generates Playwright code
├── skills/           # Recorded skill JSON files
│   ├── Login-Flow.json
│   └── Test.json
└── uploads/          # Files used by upload steps (copied at record time)
```
