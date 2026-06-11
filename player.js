'use strict';

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const SKILLS_DIR = path.join(__dirname, 'skills');

// ─── Load a skill by name or file path ──────────────────────────────────────
function loadSkill(nameOrPath) {
  let file = nameOrPath;
  if (!path.isAbsolute(file) && !file.endsWith('.json')) {
    file = path.join(SKILLS_DIR, file + '.json');
  } else if (!path.isAbsolute(file)) {
    file = path.join(SKILLS_DIR, file);
  }
  if (!fs.existsSync(file)) throw new Error(`Skill not found: ${file}`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// ─── List all recorded skills ────────────────────────────────────────────────
function listSkills() {
  if (!fs.existsSync(SKILLS_DIR)) { console.log('  No skills recorded yet.'); return; }
  const files = fs.readdirSync(SKILLS_DIR).filter(f => f.endsWith('.json'));
  if (files.length === 0) { console.log('  No skills recorded yet. Run: node recorder.js'); return; }

  console.log('\n  Available skills:\n');
  for (const f of files) {
    try {
      const s = JSON.parse(fs.readFileSync(path.join(SKILLS_DIR, f), 'utf8'));
      const date = s.recordedAt ? new Date(s.recordedAt).toLocaleDateString() : '?';
      console.log(`    ${s.name.padEnd(32)} ${String(s.steps.length).padStart(3)} steps   ${date}   [${f}]`);
    } catch {
      console.log(`    ${f}  (unreadable)`);
    }
  }
  console.log();
}

// ─── Resolve a locator, honoring the optional `nth` index ───────────────────
function resolveLocator(page, step) {
  const base = page.locator(step.selector);
  return step.nth != null && step.nth > 0 ? base.nth(step.nth) : base.first();
}

// ─── Execute a single step ───────────────────────────────────────────────────
async function executeStep(page, step, opts = {}) {
  const timeout = opts.timeout || 15000;

  switch (step.type) {
    case 'navigate':
      await page.goto(step.url, { waitUntil: 'domcontentloaded', timeout });
      break;

    case 'click': {
      const loc = resolveLocator(page, step);
      await loc.waitFor({ state: 'visible', timeout });
      await loc.click({ timeout });
      break;
    }

    case 'fill': {
      const loc = resolveLocator(page, step);
      await loc.waitFor({ state: 'visible', timeout });
      await loc.fill(step.value, { timeout });
      break;
    }

    case 'select': {
      const loc = resolveLocator(page, step);
      await loc.waitFor({ state: 'visible', timeout });
      // Try value first, fall back to label
      try {
        await loc.selectOption({ value: step.value }, { timeout });
      } catch {
        if (step.label) await loc.selectOption({ label: step.label }, { timeout });
        else throw new Error(`Cannot select option value="${step.value}" on ${step.selector}`);
      }
      break;
    }

    case 'upload': {
      if (!step.file) {
        console.log(`    (no file path stored for upload on ${step.selector}, skipping)`);
        return;
      }
      const filePath = path.resolve(__dirname, step.file);
      if (!fs.existsSync(filePath)) {
        throw new Error(`Upload file not found: ${filePath}`);
      }
      const loc = resolveLocator(page, step);
      await loc.waitFor({ timeout });
      await loc.setInputFiles(filePath, { timeout });
      break;
    }

    case 'check': {
      const loc = resolveLocator(page, step);
      await loc.waitFor({ state: 'visible', timeout });
      if (step.checked) {
        await loc.check({ timeout });
      } else {
        await loc.uncheck({ timeout });
      }
      break;
    }

    case 'press': {
      const loc = resolveLocator(page, step);
      await loc.waitFor({ state: 'visible', timeout });
      await loc.press(step.key, { timeout });
      break;
    }

    case 'wait':
      await page.waitForTimeout(step.ms || 1000);
      break;

    default:
      console.log(`    Unknown step type "${step.type}", skipping.`);
  }
}

// ─── Format a step for display ───────────────────────────────────────────────
function formatStep(step) {
  const p = s => s.padEnd(8);
  const nthTag = step.nth != null && step.nth > 0 ? `  [#${step.nth}]` : '';
  switch (step.type) {
    case 'navigate': return `${p('navigate')} → ${step.url}`;
    case 'click':    return `${p('click')}   ${step.selector}${nthTag}`;
    case 'fill':     return `${p('fill')}    ${step.selector}${nthTag}  =  "${step.value}"`;
    case 'select':   return `${p('select')}  ${step.selector}${nthTag}  =  "${step.value}"  [${step.label || ''}]`;
    case 'upload':   return `${p('upload')}  ${step.selector}${nthTag}  ←  ${step.file || step.filename}`;
    case 'check':    return `${step.checked ? p('check') : p('uncheck')}  ${step.selector}${nthTag}`;
    case 'press':    return `${p('press')}   ${step.key}  on  ${step.selector}${nthTag}`;
    case 'wait':     return `${p('wait')}    ${step.ms}ms`;
    default:         return JSON.stringify(step);
  }
}

// ─── Generate Playwright script from a skill ─────────────────────────────────
function generateCode(skill) {
  const lines = [
    `'use strict';`,
    `const { chromium } = require('playwright');`,
    ``,
    `(async () => {`,
    `  const browser = await chromium.launch({ headless: false });`,
    `  const page = await browser.newPage();`,
    ``
  ];

  for (const step of skill.steps) {
    const pick = step.nth != null && step.nth > 0 ? `.nth(${step.nth})` : `.first()`;
    const loc = `page.locator('${esc(step.selector)}')${pick}`;
    switch (step.type) {
      case 'navigate':
        lines.push(`  await page.goto('${step.url}');`);
        break;
      case 'click':
        lines.push(`  await ${loc}.click();${step.text ? `  // ${step.text}` : ''}`);
        break;
      case 'fill':
        lines.push(`  await ${loc}.fill('${esc(step.value)}');`);
        break;
      case 'select':
        lines.push(`  await ${loc}.selectOption({ value: '${esc(step.value)}' });  // ${step.label}`);
        break;
      case 'upload':
        lines.push(`  await ${loc}.setInputFiles('${esc(step.file || step.filename)}');`);
        break;
      case 'check':
        lines.push(step.checked
          ? `  await ${loc}.check();`
          : `  await ${loc}.uncheck();`
        );
        break;
      case 'press':
        lines.push(`  await ${loc}.press('${step.key}');`);
        break;
      case 'wait':
        lines.push(`  await page.waitForTimeout(${step.ms || 1000});`);
        break;
    }
  }

  lines.push(``, `  await browser.close();`, `})();`);
  return lines.join('\n');
}

function esc(s) { return (s || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'"); }

// ─── Prompt user to override a select step value ─────────────────────────────
async function promptSelectOverride(page, step, ask, timeout) {
  const loc = resolveLocator(page, step);

  // Wait for the element, then read its current options from the DOM
  await loc.waitFor({ state: 'visible', timeout });
  const options = await loc.evaluate(sel => {
    return Array.from(sel.options).map((o, i) => ({
      index: i,
      value: o.value,
      label: o.text.trim()
    }));
  });

  if (options.length === 0) return step;  // nothing to choose from

  console.log('\n  ┌─ Select options available:');
  options.forEach(o => {
    const marker = o.value === step.value ? ' ◀ recorded' : '';
    console.log(`  │  [${String(o.index).padStart(2)}]  ${o.label.padEnd(40)}  ${o.value}${marker}`);
  });
  console.log(`  └─ Recorded value: "${step.label || step.value}"`);

  const answer = (await ask('  Enter option number or label/value (Enter = keep recorded): ')).trim();

  if (!answer) return step;  // keep original

  // Match by index number first
  const byIndex = options.find(o => String(o.index) === answer);
  if (byIndex) return { ...step, value: byIndex.value, label: byIndex.label };

  // Then by label (case-insensitive partial)
  const byLabel = options.find(o => o.label.toLowerCase().includes(answer.toLowerCase()));
  if (byLabel) return { ...step, value: byLabel.value, label: byLabel.label };

  // Then by exact value
  const byValue = options.find(o => o.value === answer);
  if (byValue) return { ...step, value: byValue.value, label: byValue.label };

  console.log('  (no match found — keeping recorded value)');
  return step;
}

// ─── Playback ────────────────────────────────────────────────────────────────
async function play(skillName, opts = {}) {
  const skill = loadSkill(skillName);
  const delay = opts.delay !== undefined ? opts.delay : 600;
  const timeout = opts.timeout || 15000;

  // Set up readline only when needed for prompts
  let rl, ask;
  if (opts.promptSelects) {
    rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    ask = q => new Promise(resolve => rl.question(q, resolve));
  }

  console.log(`\n  Playing: "${skill.name}"  (${skill.steps.length} steps)\n`);
  if (opts.promptSelects) {
    console.log('  [--prompt-selects] You will be asked to confirm or change each dropdown.\n');
  }

  const browser = await chromium.launch({ headless: opts.headless || false });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();

  let passed = 0;
  let failed = 0;

  try {
    for (let i = 0; i < skill.steps.length; i++) {
      let step = skill.steps[i];

      // Prompt user to override the value before executing select steps
      if (opts.promptSelects && step.type === 'select') {
        console.log(`\n  [${String(i + 1).padStart(3)}/${skill.steps.length}]  ${formatStep(step)}`);
        try {
          step = await promptSelectOverride(page, step, ask, timeout);
        } catch (err) {
          console.log(`  (could not read options: ${err.message} — keeping recorded value)`);
        }
        process.stdout.write(`  → executing: ${formatStep(step)}  …  `);
      } else {
        process.stdout.write(`  [${String(i + 1).padStart(3)}/${skill.steps.length}]  ${formatStep(step)}  …  `);
      }

      try {
        await executeStep(page, step, { timeout });
        console.log('✓');
        passed++;
      } catch (err) {
        console.log(`✗  ${err.message}`);
        failed++;
        if (!opts.continueOnError) {
          console.log('\n  Stopping on first error. Use --continue to skip errors.\n');
          break;
        }
      }

      if (delay > 0) await page.waitForTimeout(delay);
    }
  } finally {
    const summary = `\n  Done: ${passed} passed, ${failed} failed.\n`;
    console.log(summary);
    if (!opts.keepOpen) await browser.close();
    if (rl) rl.close();
  }
}

// ─── CLI ─────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const flags = {};
const positional = [];

for (const arg of args) {
  if (arg === '--headless')            flags.headless = true;
  else if (arg === '--continue')       flags.continueOnError = true;
  else if (arg === '--keep-open')      flags.keepOpen = true;
  else if (arg === '--generate')       flags.generate = true;
  else if (arg === '--list')           flags.list = true;
  else if (arg === '--prompt-selects') flags.promptSelects = true;
  else if (arg.startsWith('--delay='))   flags.delay = Number(arg.split('=')[1]);
  else if (arg.startsWith('--timeout=')) flags.timeout = Number(arg.split('=')[1]);
  else positional.push(arg);
}

if (flags.list) {
  listSkills();
} else if (flags.generate && positional.length > 0) {
  const skill = loadSkill(positional[0]);
  console.log(generateCode(skill));
} else if (positional.length > 0) {
  play(positional[0], flags).catch(err => { console.error('  Error:', err.message); process.exit(1); });
} else {
  console.log(`
  Playwright Skill Player

  Usage:
    node player.js <skill>                   Play back a recorded skill
    node player.js --generate <skill>        Print generated Playwright code
    node player.js --list                    List all recorded skills

  Options:
    --headless          Run without opening a browser window
    --continue          Continue playback even if a step fails
    --keep-open         Leave browser open after playback
    --prompt-selects    Pause at each dropdown and let you pick a different value
    --delay=<ms>        Delay between steps (default: 600ms)
    --timeout=<ms>      Per-step timeout (default: 15000ms)

  Examples:
    node player.js login
    node player.js --headless --continue checkout-flow
    node player.js --prompt-selects Login-Flow
    node player.js --generate login > login.spec.js
`);
}
