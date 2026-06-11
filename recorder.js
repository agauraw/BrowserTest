'use strict';

const { chromium } = require('playwright');
const readline = require('readline');
const fs = require('fs');
const path = require('path');

const SKILLS_DIR = path.join(__dirname, 'skills');
const UPLOADS_DIR = path.join(__dirname, 'uploads');

[SKILLS_DIR, UPLOADS_DIR].forEach(d => fs.mkdirSync(d, { recursive: true }));

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = q => new Promise(resolve => rl.question(q, resolve));

// ─── Browser-side recorder script ──────────────────────────────────────────
// This function is serialized and injected into every page. No Node.js scope.
function recorderInitScript() {
  if (window.__recorderInitialized) return;
  window.__recorderInitialized = true;

  // Overlay ──────────────────────────────────────────────────────────────────
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
    const div = document.createElement('div');
    div.id = '__rec-overlay';
    div.innerHTML = '<div id="__rec-dot"></div><span>REC</span><span id="__rec-n">0</span>';
    document.head.appendChild(s);
    document.body.appendChild(div);
  }

  if (document.body) addOverlay();
  else document.addEventListener('DOMContentLoaded', addOverlay);

  let count = 0;
  function tick() {
    count++;
    const el = document.getElementById('__rec-n');
    if (el) el.textContent = count;
  }

  // Selector generation ──────────────────────────────────────────────────────
  function getSelector(el) {
    if (!el || el.nodeType !== 1) return null;

    for (const attr of ['data-testid', 'data-test', 'data-cy', 'data-qa', 'data-id']) {
      const v = el.getAttribute(attr);
      if (v) return `[${attr}="${v.replace(/"/g, '\\"')}"]`;
    }

    const id = el.id;
    if (id && id.length < 60 && !/^\d/.test(id) && !/[a-f0-9]{8}-[a-f0-9]{4}/.test(id)) {
      return '#' + id;
    }

    const tag = el.tagName.toLowerCase();
    const name = el.getAttribute('name');

    if (['input', 'select', 'textarea', 'button'].includes(tag) && name) {
      return `${tag}[name="${name.replace(/"/g, '\\"')}"]`;
    }

    if ((tag === 'button' || tag === 'a' || el.getAttribute('role') === 'button') &&
        el.textContent.trim()) {
      return `${tag}:text("${el.textContent.trim().slice(0, 50).replace(/"/g, '\\"')}")`;
    }

    const ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel) return `${tag}[aria-label="${ariaLabel.replace(/"/g, '\\"')}"]`;

    const placeholder = el.getAttribute('placeholder');
    if (placeholder && tag === 'input') {
      return `input[placeholder="${placeholder.replace(/"/g, '\\"')}"]`;
    }

    // Label association — find <label for="id"> or wrapping <label>
    if (['input', 'select', 'textarea'].includes(tag)) {
      const labelEl = el.id
        ? document.querySelector(`label[for="${el.id}"]`)
        : el.closest('label');
      if (labelEl) {
        const labelText = labelEl.textContent.trim().slice(0, 60).replace(/"/g, '\\"');
        if (labelText) return `${tag}[aria-labelledby],label:text("${labelText}") ~ ${tag}, label:text("${labelText}") + ${tag}`;
      }
    }

    // aria-labelledby — resolve the referenced element's text
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const labelTarget = document.getElementById(labelledBy);
      if (labelTarget) {
        const t = labelTarget.textContent.trim().slice(0, 60).replace(/"/g, '\\"');
        if (t) return `${tag}[aria-labelledby="${labelledBy}"]`;
      }
    }

    // CSS path fallback — climb up to nearest anchored ancestor, include nth index
    const parts = [];
    let cur = el;
    for (let d = 0; cur && cur !== document.documentElement && d < 6; d++) {
      let seg = cur.tagName.toLowerCase();
      if (cur.id && !/^\d/.test(cur.id) && cur.id.length < 60 &&
          !/[a-f0-9]{8}-[a-f0-9]{4}/.test(cur.id)) {
        parts.unshift('#' + cur.id);
        break;
      }
      if (cur.parentElement) {
        const sibs = Array.from(cur.parentElement.children).filter(c => c.tagName === cur.tagName);
        if (sibs.length > 1) seg += `:nth-of-type(${sibs.indexOf(cur) + 1})`;
      }
      parts.unshift(seg);
      cur = cur.parentElement;
    }
    return parts.join(' > ');
  }

  // Returns the 0-based index of el among all elements matching the same selector
  function getNthIndex(el, selector) {
    try {
      const all = Array.from(document.querySelectorAll(selector));
      const idx = all.indexOf(el);
      return idx > 0 ? idx : 0;  // 0 means "first", skip storing it
    } catch { return 0; }
  }

  const TEXT_TYPES = new Set(['text', 'email', 'password', 'search', 'url', 'tel',
    'number', 'date', 'time', 'datetime-local', 'month', 'week', 'color', '']);
  const SKIP_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

  // Click ────────────────────────────────────────────────────────────────────
  document.addEventListener('click', function(e) {
    const tgt = e.target;
    if (!tgt || tgt.closest('#__rec-overlay')) return;
    if (SKIP_TAGS.has(tgt.tagName)) return;

    const el = tgt.closest(
      'a,button,[role="button"],[role="tab"],[role="menuitem"],[role="option"],[role="switch"],[onclick]'
    ) || tgt;
    if (SKIP_TAGS.has(el.tagName)) return;

    const selector = getSelector(el);
    if (!selector) return;
    tick();
    const nth = getNthIndex(el, selector);
    window.__recordStep({
      type: 'click',
      selector,
      ...(nth > 0 && { nth }),
      tag: el.tagName.toLowerCase(),
      text: (el.textContent || '').trim().slice(0, 60)
    });
  }, true);

  // Fill (on blur = final value after typing) ────────────────────────────────
  const focusSnapshot = new Map();

  document.addEventListener('focus', function(e) {
    const el = e.target;
    if ((el.tagName === 'INPUT' && TEXT_TYPES.has(el.type || '')) || el.tagName === 'TEXTAREA') {
      focusSnapshot.set(getSelector(el), el.value);
    }
  }, true);

  document.addEventListener('blur', function(e) {
    const el = e.target;
    const isText = el.tagName === 'INPUT' && TEXT_TYPES.has(el.type || '');
    if (!isText && el.tagName !== 'TEXTAREA') return;

    const selector = getSelector(el);
    const prev = focusSnapshot.get(selector) || '';
    focusSnapshot.delete(selector);

    if (el.value && el.value !== prev) {
      tick();
      const nth = getNthIndex(el, selector);
      window.__recordStep({ type: 'fill', selector, ...(nth > 0 && { nth }), value: el.value });
    }
  }, true);

  // Enter key on inputs (before potential navigation) ────────────────────────
  document.addEventListener('keydown', function(e) {
    if (e.key !== 'Enter') return;
    const el = e.target;
    const isText = el.tagName === 'INPUT' && TEXT_TYPES.has(el.type || '');
    if (!isText && el.tagName !== 'TEXTAREA') return;
    if (!el.value) return;

    const selector = getSelector(el);
    const prev = focusSnapshot.get(selector) || '';
    if (el.value !== prev) {
      tick();
      window.__recordStep({ type: 'fill', selector, value: el.value });
      focusSnapshot.set(selector, el.value);
    }
    tick();
    window.__recordStep({ type: 'press', selector, key: 'Enter' });
  }, true);

  // Select / dropdown ────────────────────────────────────────────────────────
  // File upload ──────────────────────────────────────────────────────────────
  // Checkbox / radio ─────────────────────────────────────────────────────────
  document.addEventListener('change', function(e) {
    const el = e.target;
    if (el.closest('#__rec-overlay')) return;

    if (el.tagName === 'SELECT') {
      const selector = getSelector(el);
      const opt = el.selectedOptions[0];
      const nth = getNthIndex(el, selector);
      tick();
      window.__recordStep({
        type: 'select',
        selector,
        ...(nth > 0 && { nth }),
        value: el.value,
        label: opt ? opt.text.trim() : '',
        index: el.selectedIndex
      });
      return;
    }

    if (el.tagName === 'INPUT' && el.type === 'file' && el.files.length > 0) {
      const selector = getSelector(el);
      const filenames = Array.from(el.files).map(f => f.name);
      tick();
      window.__recordStep({
        type: 'upload',
        selector,
        filename: filenames[0],
        filenames: filenames.length > 1 ? filenames : undefined
      });
      return;
    }

    if (el.tagName === 'INPUT' && (el.type === 'checkbox' || el.type === 'radio')) {
      const selector = getSelector(el);
      const nth = getNthIndex(el, selector);
      tick();
      window.__recordStep({ type: 'check', selector, ...(nth > 0 && { nth }), checked: el.checked, value: el.value });
    }
  }, true);
}

// ─── Node.js helpers ────────────────────────────────────────────────────────
function formatStep(step) {
  const p = s => s.padEnd(8);
  switch (step.type) {
    case 'navigate': return `${p('navigate')} → ${step.url}`;
    case 'click':    return `${p('click')}   ${step.selector}${step.text ? `  ("${step.text}")` : ''}`;
    case 'fill':     return `${p('fill')}    ${step.selector}  =  "${step.value}"`;
    case 'select':   return `${p('select')}  ${step.selector}  =  "${step.value}"  [${step.label}]`;
    case 'upload':   return `${p('upload')}  ${step.selector}  ←  ${step.filename}`;
    case 'check':    return `${step.checked ? p('check') : p('uncheck')}  ${step.selector}`;
    case 'press':    return `${p('press')}   ${step.key}  on  ${step.selector}`;
    default:         return JSON.stringify(step);
  }
}

function deduplicateSteps(steps) {
  const out = [];
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    const prev = out[out.length - 1];
    // Skip consecutive navigate to the same URL
    if (s.type === 'navigate' && prev && prev.type === 'navigate' && prev.url === s.url) continue;
    // Keep only the last fill for the same selector before the next non-fill step
    if (s.type === 'fill' && i + 1 < steps.length &&
        steps[i + 1].type === 'fill' && steps[i + 1].selector === s.selector) continue;
    out.push(s);
  }
  return out;
}

// ─── Main ───────────────────────────────────────────────────────────────────
async function main() {
  let [,, skillName, startUrl] = process.argv;

  if (!skillName) skillName = (await ask('Skill name: ')).trim();
  if (!skillName) { console.error('Skill name is required.'); process.exit(1); }

  if (!startUrl) startUrl = (await ask('Starting URL: ')).trim();
  if (!startUrl.match(/^https?:\/\//)) startUrl = 'https://' + startUrl;

  const steps = [];
  let lastUrl = '';

  console.log(`\n  Opening browser for skill: "${skillName}"`);
  console.log('  Interact with the page, then press Enter here to stop.\n');

  const browser = await chromium.launch({ headless: false });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();

  // Expose step-recording callback to the page
  await ctx.exposeFunction('__recordStep', step => {
    steps.push(step);
    process.stdout.write(`  [${String(steps.length).padStart(3)}]  ${formatStep(step)}\n`);
  });

  await ctx.addInitScript(recorderInitScript);

  // Track URL changes (including SPA routing and redirects)
  page.on('framenavigated', frame => {
    if (frame !== page.mainFrame()) return;
    const url = frame.url();
    if (url === 'about:blank' || url === lastUrl) return;
    lastUrl = url;
    const step = { type: 'navigate', url };
    steps.push(step);
    process.stdout.write(`  [${String(steps.length).padStart(3)}]  ${formatStep(step)}\n`);
  });

  await page.goto(startUrl);

  // Block until user presses Enter
  await new Promise(resolve => rl.once('line', resolve));
  console.log('\n  Recording stopped.\n');
  await browser.close();

  // Collect file paths for upload steps ──────────────────────────────────────
  const uploadSteps = steps.filter(s => s.type === 'upload');
  if (uploadSteps.length > 0) {
    console.log(`  ${uploadSteps.length} file upload(s) detected.`);
    console.log('  Provide local file paths so they can be replayed.\n');
    for (const step of uploadSteps) {
      const input = (await ask(
        `  Upload on ${step.selector}\n  Detected filename: ${step.filename}\n  Local path (Enter to skip): `
      )).trim();

      if (input) {
        const src = path.resolve(input);
        if (fs.existsSync(src)) {
          const dest = path.join(UPLOADS_DIR, path.basename(src));
          fs.copyFileSync(src, dest);
          step.file = 'uploads/' + path.basename(src);
          console.log(`  Saved → ${step.file}\n`);
        } else {
          console.log(`  File not found, skipping.\n`);
        }
      }
    }
  }

  const cleanSteps = deduplicateSteps(steps);
  const slug = skillName.replace(/\s+/g, '-').replace(/[^a-zA-Z0-9-_]/g, '');

  const skill = {
    name: skillName,
    startUrl,
    recordedAt: new Date().toISOString(),
    steps: cleanSteps
  };

  const outFile = path.join(SKILLS_DIR, `${slug}.json`);
  fs.writeFileSync(outFile, JSON.stringify(skill, null, 2));

  console.log(`\n  Skill saved:   ${outFile}`);
  console.log(`  Steps:         ${cleanSteps.length}`);
  console.log(`\n  Replay:        node player.js ${slug}`);
  console.log(`  Generate code: node player.js --generate ${slug}\n`);

  rl.close();
}

main().catch(err => { console.error(err.message); process.exit(1); });
