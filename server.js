'use strict';

const express = require('express');
const { WebSocketServer } = require('ws');
const { chromium } = require('playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 3000;
const SKILLS_DIR = path.join(__dirname, 'skills');
const UPLOADS_DIR = path.join(__dirname, 'uploads');

[SKILLS_DIR, UPLOADS_DIR].forEach(d => fs.mkdirSync(d, { recursive: true }));

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.static(path.join(__dirname, 'public')));

// ─── Per-connection state ────────────────────────────────────────────────────
function mkState() {
  return {
    browser: null,
    ctx: null,
    page: null,
    steps: [],
    skillName: null,
    lastUrl: '',
    isRecording: false,
    isPlaying: false,
    pendingResolve: null,   // set while waiting for user to type a file path
  };
}

// ─── WebSocket connections ───────────────────────────────────────────────────
wss.on('connection', ws => {
  const state = mkState();

  function send(role, text, extra = {}) {
    if (ws.readyState !== ws.OPEN) return;
    ws.send(JSON.stringify({ role, text, ...extra }));
  }

  send('bot', [
    'Welcome to Playwright Skill Recorder',
    '',
    '  record <name> <url>   — start recording a new skill',
    '  stop                  — stop recording and save',
    '  play <name>           — replay a saved skill',
    '  list                  — show all skills',
    '  generate <name>       — print Playwright code for a skill',
    '  help                  — show this message',
  ].join('\n'), { status: 'ready' });

  ws.on('close', () => {
    if (state.browser) state.browser.close().catch(() => {});
  });

  ws.on('message', async raw => {
    let text;
    try { text = JSON.parse(raw.toString()).text?.trim(); } catch { return; }
    if (!text) return;

    // Pending input (upload file path collection after stop)
    if (state.pendingResolve) {
      const resolve = state.pendingResolve;
      state.pendingResolve = null;
      resolve(text);
      return;
    }

    const [cmd, ...rest] = text.split(/\s+/);
    try {
      switch (cmd.toLowerCase()) {
        case 'record':   await doRecord(state, send, rest); break;
        case 'stop':     await doStop(state, send); break;
        case 'play':     await doPlay(state, send, rest); break;
        case 'list':     doList(send); break;
        case 'generate': doGenerate(send, rest); break;
        case 'help':     doHelp(send); break;
        default:
          send('error', state.isRecording
            ? 'Still recording — type stop to finish, or interact with the browser.'
            : `Unknown command: "${cmd}". Type help for available commands.`
          );
      }
    } catch (err) {
      send('error', `Error: ${err.message}`);
      state.isRecording = false;
      state.isPlaying = false;
    }
  });

  // ── record ─────────────────────────────────────────────────────────────────
  async function doRecord(state, send, args) {
    if (state.isRecording) { send('error', 'Already recording. Type stop to finish.'); return; }
    if (state.isPlaying)   { send('error', 'Playback in progress, please wait.'); return; }

    let [name, url] = args;
    if (!name || !url) { send('error', 'Usage: record <name> <url>'); return; }
    if (!url.match(/^https?:\/\//)) url = 'https://' + url;

    state.skillName = name;
    state.steps = [];
    state.lastUrl = '';
    state.isRecording = true;

    send('bot', `Opening browser for skill: "${name}"\nURL: ${url}\n\nInteract with the page, then type stop here when done.`, { status: 'recording' });

    state.browser = await chromium.launch({ headless: false });
    state.ctx = await state.browser.newContext({ viewport: { width: 1280, height: 800 } });
    state.page = await state.ctx.newPage();

    await state.ctx.exposeFunction('__recordStep', step => {
      if (!state.isRecording) return;
      state.steps.push(step);
      send('step', `[${String(state.steps.length).padStart(3)}]  ${fmtStep(step)}`);
    });

    await state.ctx.addInitScript(recorderBrowserScript);

    state.page.on('framenavigated', frame => {
      if (frame !== state.page.mainFrame()) return;
      const navUrl = frame.url();
      if (navUrl === 'about:blank' || navUrl === state.lastUrl) return;
      state.lastUrl = navUrl;
      const step = { type: 'navigate', url: navUrl };
      state.steps.push(step);
      send('step', `[${String(state.steps.length).padStart(3)}]  ${fmtStep(step)}`);
    });

    state.browser.on('disconnected', () => {
      if (state.isRecording) {
        state.isRecording = false;
        send('error', 'Browser was closed. Recording ended.', { status: 'ready' });
      }
    });

    await state.page.goto(url);
  }

  // ── stop ───────────────────────────────────────────────────────────────────
  async function doStop(state, send) {
    if (!state.isRecording) { send('error', 'Not currently recording.'); return; }
    state.isRecording = false;

    try { await state.browser.close(); } catch { /* already closed */ }
    state.browser = null;

    send('bot', `Recording stopped — ${state.steps.length} steps captured.`, { status: 'saving' });

    // Collect file paths for any upload steps
    const uploads = state.steps.filter(s => s.type === 'upload');
    for (const step of uploads) {
      send('bot',
        `File upload detected\nElement: ${step.selector}\nFilename: ${step.filename}\n\nType the full local file path to save for playback\n(or type skip to leave it out):`,
        { status: 'input' }
      );
      const answer = await new Promise(r => { state.pendingResolve = r; });
      if (!answer || answer.toLowerCase() === 'skip') {
        send('info', 'Upload step skipped.');
      } else {
        const src = path.resolve(answer.trim());
        if (fs.existsSync(src)) {
          const dest = path.join(UPLOADS_DIR, path.basename(src));
          fs.copyFileSync(src, dest);
          step.file = 'uploads/' + path.basename(src);
          send('info', `Copied → ${step.file}`);
        } else {
          send('error', `File not found: ${src}\nThis upload step will be skipped during playback.`);
        }
      }
    }

    const clean = dedupe(state.steps);
    const slug = state.skillName.replace(/\s+/g, '-').replace(/[^a-zA-Z0-9-_]/g, '');
    const skill = {
      name: state.skillName,
      startUrl: clean.find(s => s.type === 'navigate')?.url || '',
      recordedAt: new Date().toISOString(),
      steps: clean,
    };

    fs.writeFileSync(path.join(SKILLS_DIR, `${slug}.json`), JSON.stringify(skill, null, 2));

    send('success',
      `Skill "${state.skillName}" saved\nSteps: ${clean.length}\n\nReplay: play ${slug}\nCode:   generate ${slug}`,
      { status: 'ready' }
    );
    state.steps = [];
    state.skillName = null;
  }

  // ── play ───────────────────────────────────────────────────────────────────
  async function doPlay(state, send, args) {
    if (state.isPlaying)   { send('error', 'Already playing, please wait.'); return; }
    if (state.isRecording) { send('error', 'Recording in progress. Type stop first.'); return; }

    const [name] = args;
    if (!name) { send('error', 'Usage: play <skill-name>'); return; }

    let skill;
    try { skill = loadSkill(name); } catch (err) { send('error', err.message); return; }

    state.isPlaying = true;
    send('bot', `Playing: "${skill.name}"  (${skill.steps.length} steps)`, { status: 'playing' });

    const browser = await chromium.launch({ headless: false });
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    let passed = 0, failed = 0;

    try {
      for (let i = 0; i < skill.steps.length; i++) {
        const step = skill.steps[i];
        send('step', `[${String(i + 1).padStart(3)}/${skill.steps.length}]  ${fmtStep(step)}`);
        try {
          await runStep(page, step);
          send('info', '  ✓');
          passed++;
        } catch (err) {
          send('error', `  ✗  ${err.message}`);
          failed++;
        }
        // Safe delay between steps — catch prevents crash if page closed mid-navigation
        await page.waitForTimeout(600).catch(() => {});
      }
    } finally {
      state.isPlaying = false;
      await browser.close().catch(() => {});
      send(failed === 0 ? 'success' : 'bot',
        `Playback complete: ${passed} passed, ${failed} failed.`,
        { status: 'ready' }
      );
    }
  }

  // ── list ───────────────────────────────────────────────────────────────────
  function doList(send) {
    const files = fs.existsSync(SKILLS_DIR)
      ? fs.readdirSync(SKILLS_DIR).filter(f => f.endsWith('.json'))
      : [];
    if (!files.length) { send('bot', 'No skills recorded yet.\nUse: record <name> <url>'); return; }

    const rows = files.map(f => {
      try {
        const s = JSON.parse(fs.readFileSync(path.join(SKILLS_DIR, f), 'utf8'));
        const d = s.recordedAt ? new Date(s.recordedAt).toLocaleDateString() : '—';
        return `  ${(s.name || f).padEnd(28)} ${String(s.steps.length).padStart(3)} steps   ${d}`;
      } catch { return `  ${f}  (unreadable)`; }
    });
    send('bot', 'Recorded skills:\n\n' + rows.join('\n'));
  }

  // ── generate ───────────────────────────────────────────────────────────────
  function doGenerate(send, args) {
    const [name] = args;
    if (!name) { send('error', 'Usage: generate <skill-name>'); return; }
    let skill;
    try { skill = loadSkill(name); } catch (err) { send('error', err.message); return; }
    send('code', genCode(skill));
  }

  // ── help ───────────────────────────────────────────────────────────────────
  function doHelp(send) {
    send('bot', [
      'Commands:',
      '',
      '  record <name> <url>   Start recording a new skill',
      '  stop                  Finish recording and save',
      '  play <name>           Replay a recorded skill',
      '  list                  Show all saved skills',
      '  generate <name>       Output Playwright code',
      '  help                  Show this help',
      '',
      'During playback, errors are shown and execution continues.',
      'Upload file paths are collected interactively after you type stop.',
    ].join('\n'));
  }
});

// ─── Shared helpers ──────────────────────────────────────────────────────────

function loadSkill(nameOrPath) {
  let f = nameOrPath;
  if (!path.isAbsolute(f) && !f.endsWith('.json')) f = path.join(SKILLS_DIR, f + '.json');
  if (!fs.existsSync(f)) throw new Error(`Skill not found: "${nameOrPath}"`);
  return JSON.parse(fs.readFileSync(f, 'utf8'));
}

function dedupe(steps) {
  const out = [];
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    const prev = out[out.length - 1];
    if (s.type === 'navigate' && prev?.type === 'navigate' && prev.url === s.url) continue;
    if (s.type === 'fill' && i + 1 < steps.length &&
        steps[i + 1].type === 'fill' && steps[i + 1].selector === s.selector) continue;
    out.push(s);
  }
  return out;
}

function fmtStep(step) {
  const p = s => s.padEnd(8);
  switch (step.type) {
    case 'navigate': return `${p('navigate')} → ${step.url}`;
    case 'click':    return `${p('click')}   ${step.selector}${step.text ? `  ("${step.text}")` : ''}`;
    case 'fill':     return `${p('fill')}    ${step.selector}  =  "${step.value}"`;
    case 'select':   return `${p('select')}  ${step.selector}  =  "${step.value}"  [${step.label || ''}]`;
    case 'upload':   return `${p('upload')}  ${step.selector}  ←  ${step.file || step.filename}`;
    case 'check':    return `${step.checked ? p('check') : p('uncheck')}  ${step.selector}`;
    case 'press':    return `${p('press')}   ${step.key}  on  ${step.selector}`;
    case 'wait':     return `${p('wait')}    ${step.ms}ms`;
    default:         return JSON.stringify(step);
  }
}

async function runStep(page, step, timeout = 15000) {
  switch (step.type) {
    case 'navigate':
      await page.goto(step.url, { waitUntil: 'domcontentloaded', timeout });
      break;

    case 'click': {
      const loc = page.locator(step.selector).first();
      await loc.waitFor({ state: 'visible', timeout });
      await loc.click({ timeout });
      // absorb any navigation the click triggers without failing if there is none
      await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
      break;
    }

    case 'fill': {
      const loc = page.locator(step.selector).first();
      await loc.waitFor({ state: 'visible', timeout });
      await loc.fill(step.value, { timeout });
      break;
    }

    case 'select': {
      const loc = page.locator(step.selector).first();
      await loc.waitFor({ state: 'visible', timeout });
      try {
        await loc.selectOption({ value: step.value }, { timeout });
      } catch {
        if (step.label) {
          await loc.selectOption({ label: step.label }, { timeout });
        } else {
          throw new Error(`Cannot select value="${step.value}" on ${step.selector}`);
        }
      }
      break;
    }

    case 'upload': {
      if (!step.file) return;   // no path stored — silently skip
      const fp = path.resolve(__dirname, step.file);
      if (!fs.existsSync(fp)) throw new Error(`Upload file missing: ${fp}`);
      await page.locator(step.selector).first().setInputFiles(fp, { timeout });
      break;
    }

    case 'check': {
      const loc = page.locator(step.selector).first();
      await loc.waitFor({ state: 'visible', timeout });
      step.checked ? await loc.check({ timeout }) : await loc.uncheck({ timeout });
      break;
    }

    case 'press': {
      const loc = page.locator(step.selector).first();
      await loc.waitFor({ state: 'visible', timeout });
      await loc.press(step.key, { timeout });
      await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
      break;
    }

    case 'wait':
      await page.waitForTimeout(step.ms || 1000);
      break;
  }
}

function genCode(skill) {
  const esc = s => (s || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  const lines = [
    `'use strict';`,
    `const { chromium } = require('playwright');`,
    ``,
    `(async () => {`,
    `  const browser = await chromium.launch({ headless: false });`,
    `  const page = await browser.newPage();`,
    ``
  ];
  for (const s of skill.steps) {
    switch (s.type) {
      case 'navigate': lines.push(`  await page.goto('${s.url}');`); break;
      case 'click':    lines.push(`  await page.locator('${esc(s.selector)}').first().click();${s.text ? `  // ${s.text}` : ''}`); break;
      case 'fill':     lines.push(`  await page.locator('${esc(s.selector)}').first().fill('${esc(s.value)}');`); break;
      case 'select':   lines.push(`  await page.locator('${esc(s.selector)}').first().selectOption({ value: '${esc(s.value)}' });  // ${s.label}`); break;
      case 'upload':   lines.push(`  await page.locator('${esc(s.selector)}').first().setInputFiles('${esc(s.file || s.filename)}');`); break;
      case 'check':    lines.push(s.checked ? `  await page.locator('${esc(s.selector)}').first().check();` : `  await page.locator('${esc(s.selector)}').first().uncheck();`); break;
      case 'press':    lines.push(`  await page.locator('${esc(s.selector)}').first().press('${s.key}');`); break;
      case 'wait':     lines.push(`  await page.waitForTimeout(${s.ms || 1000});`); break;
    }
  }
  lines.push(``, `  await browser.close();`, `})();`);
  return lines.join('\n');
}

// ─── Browser-side recorder (serialized and injected into every page) ─────────
function recorderBrowserScript() {
  if (window.__recorderInitialized) return;
  window.__recorderInitialized = true;

  function addOverlay() {
    if (document.getElementById('__rec-overlay')) return;
    const s = document.createElement('style');
    s.textContent = [
      '#__rec-overlay{position:fixed;top:10px;right:10px;z-index:2147483647;',
      'background:rgba(200,35,35,.93);color:#fff;padding:7px 14px;border-radius:6px;',
      'font:600 12px/1.5 monospace;pointer-events:none;',
      'box-shadow:0 2px 10px rgba(0,0,0,.4);display:flex;align-items:center;gap:8px;}',
      '#__rec-dot{width:8px;height:8px;border-radius:50%;background:#fff;',
      'animation:__rec-p 1s ease-in-out infinite;}',
      '@keyframes __rec-p{0%,100%{opacity:1}50%{opacity:.2}}'
    ].join('');
    const d = document.createElement('div');
    d.id = '__rec-overlay';
    d.innerHTML = '<div id="__rec-dot"></div><span>REC</span><span id="__rec-n">0</span>';
    document.head.appendChild(s);
    document.body.appendChild(d);
  }

  if (document.body) addOverlay();
  else document.addEventListener('DOMContentLoaded', addOverlay);

  let count = 0;
  function tick() {
    count++;
    const el = document.getElementById('__rec-n');
    if (el) el.textContent = count;
  }

  function getSelector(el) {
    if (!el || el.nodeType !== 1) return null;
    for (const a of ['data-testid', 'data-test', 'data-cy', 'data-qa', 'data-id']) {
      const v = el.getAttribute(a);
      if (v) return `[${a}="${v.replace(/"/g, '\\"')}"]`;
    }
    const id = el.id;
    if (id && id.length < 60 && !/^\d/.test(id) && !/[a-f0-9]{8}-[a-f0-9]{4}/.test(id)) return '#' + id;
    const tag = el.tagName.toLowerCase();
    const name = el.getAttribute('name');
    if (['input', 'select', 'textarea', 'button'].includes(tag) && name)
      return `${tag}[name="${name.replace(/"/g, '\\"')}"]`;
    if ((tag === 'button' || tag === 'a' || el.getAttribute('role') === 'button') && el.textContent.trim())
      return `${tag}:text("${el.textContent.trim().slice(0, 50).replace(/"/g, '\\"')}")`;
    const al = el.getAttribute('aria-label');
    if (al) return `${tag}[aria-label="${al.replace(/"/g, '\\"')}"]`;
    const ph = el.getAttribute('placeholder');
    if (ph && tag === 'input') return `input[placeholder="${ph.replace(/"/g, '\\"')}"]`;
    const parts = [];
    let cur = el;
    for (let depth = 0; cur && cur !== document.documentElement && depth < 5; depth++) {
      let seg = cur.tagName.toLowerCase();
      if (cur.id && !/^\d/.test(cur.id) && cur.id.length < 60) { parts.unshift('#' + cur.id); break; }
      if (cur.parentElement) {
        const sibs = Array.from(cur.parentElement.children).filter(c => c.tagName === cur.tagName);
        if (sibs.length > 1) seg += `:nth-of-type(${sibs.indexOf(cur) + 1})`;
      }
      parts.unshift(seg);
      cur = cur.parentElement;
    }
    return parts.join(' > ');
  }

  const TEXT_TYPES = new Set(['text', 'email', 'password', 'search', 'url', 'tel',
    'number', 'date', 'time', 'datetime-local', 'month', 'week', 'color', '']);
  const SKIP = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

  // clicks
  document.addEventListener('click', function (e) {
    const tgt = e.target;
    if (!tgt || tgt.closest('#__rec-overlay')) return;
    if (SKIP.has(tgt.tagName)) return;
    const el = tgt.closest('a,button,[role="button"],[role="tab"],[role="menuitem"],[role="option"],[onclick]') || tgt;
    if (SKIP.has(el.tagName)) return;
    const selector = getSelector(el);
    if (!selector) return;
    tick();
    window.__recordStep({ type: 'click', selector, tag: el.tagName.toLowerCase(), text: (el.textContent || '').trim().slice(0, 60) });
  }, true);

  // fill (captured on blur so we get the final typed value)
  const snap = new Map();
  document.addEventListener('focus', function (e) {
    const el = e.target;
    if ((el.tagName === 'INPUT' && TEXT_TYPES.has(el.type || '')) || el.tagName === 'TEXTAREA')
      snap.set(getSelector(el), el.value);
  }, true);

  document.addEventListener('blur', function (e) {
    const el = e.target;
    const isText = el.tagName === 'INPUT' && TEXT_TYPES.has(el.type || '');
    if (!isText && el.tagName !== 'TEXTAREA') return;
    const sel = getSelector(el);
    const prev = snap.get(sel) || '';
    snap.delete(sel);
    if (el.value && el.value !== prev) { tick(); window.__recordStep({ type: 'fill', selector: sel, value: el.value }); }
  }, true);

  // enter key (captures value before potential navigation)
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter') return;
    const el = e.target;
    const isText = el.tagName === 'INPUT' && TEXT_TYPES.has(el.type || '');
    if (!isText && el.tagName !== 'TEXTAREA') return;
    if (!el.value) return;
    const sel = getSelector(el);
    const prev = snap.get(sel) || '';
    if (el.value !== prev) { tick(); window.__recordStep({ type: 'fill', selector: sel, value: el.value }); snap.set(sel, el.value); }
    tick();
    window.__recordStep({ type: 'press', selector: sel, key: 'Enter' });
  }, true);

  // select / file upload / checkbox
  document.addEventListener('change', function (e) {
    const el = e.target;
    if (el.closest('#__rec-overlay')) return;

    if (el.tagName === 'SELECT') {
      const opt = el.selectedOptions[0];
      tick();
      window.__recordStep({ type: 'select', selector: getSelector(el), value: el.value, label: opt ? opt.text.trim() : '', index: el.selectedIndex });
      return;
    }
    if (el.tagName === 'INPUT' && el.type === 'file' && el.files.length > 0) {
      tick();
      window.__recordStep({ type: 'upload', selector: getSelector(el), filename: el.files[0].name });
      return;
    }
    if (el.tagName === 'INPUT' && (el.type === 'checkbox' || el.type === 'radio')) {
      tick();
      window.__recordStep({ type: 'check', selector: getSelector(el), checked: el.checked, value: el.value });
    }
  }, true);
}

// ─── Start ───────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`Skill Recorder  →  http://localhost:${PORT}`);
});
