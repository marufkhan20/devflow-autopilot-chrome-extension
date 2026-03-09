// ============================================================
//  DevFlow Autopilot — Content Script
//  Ordered action blueprint: records clicks + fills in sequence
// ============================================================

let isRecording = false;

// ── State sync ───────────────────────────────────────────────
chrome.storage.local.get(['isRecording'], (result) => {
    isRecording = result.isRecording || false;
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'startRecording') { isRecording = true; }
    else if (request.action === 'stopRecording') { isRecording = false; }
    sendResponse({ status: isRecording ? 'started' : 'stopped' });
    return true;
});

chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace === 'local' && changes.isRecording !== undefined) {
        isRecording = changes.isRecording.newValue;
    }
});

// ── Helpers ──────────────────────────────────────────────────
function getBaseUrl() {
    return window.location.href.split('?')[0].split('#')[0];
}

/**
 * Build a reliable selector for an element.
 * Priority: #id → [name] → [data-testid] → [aria-label] → structural path
 * NO class fallback (Tailwind classes are useless as identifiers).
 */
function getSelector(el) {
    if (el.id) return `#${CSS.escape(el.id)}`;
    if (el.name) return `[name="${CSS.escape(el.name)}"]`;
    if (el.dataset && el.dataset.testid) return `[data-testid="${CSS.escape(el.dataset.testid)}"]`;
    if (el.getAttribute('aria-label')) return `[aria-label="${CSS.escape(el.getAttribute('aria-label'))}"]`;
    // Structural path fallback (up to 4 ancestors)
    return buildStructuralPath(el, 4);
}

function buildStructuralPath(el, maxDepth) {
    const parts = [];
    let node = el;
    let depth = 0;
    while (node && node !== document.body && depth < maxDepth) {
        let part = node.tagName.toLowerCase();
        const parent = node.parentElement;
        if (parent) {
            const siblings = Array.from(parent.children).filter(c => c.tagName === node.tagName);
            if (siblings.length > 1) {
                const idx = siblings.indexOf(node) + 1;
                part += `:nth-of-type(${idx})`;
            }
        }
        parts.unshift(part);
        node = node.parentElement;
        depth++;
    }
    return parts.join(' > ');
}

/**
 * Build a human-readable label for a button (for display in the popup).
 */
function getButtonLabel(btn) {
    const text = (btn.textContent || '').trim().replace(/\s+/g, ' ').substring(0, 40);
    return text || btn.getAttribute('aria-label') || 'Button';
}

/**
 * Check if an element is inside or closely related to a form or form-like container.
 */
function isInsideForm(el) {
    let node = el;
    let depth = 0;
    while (node && depth < 12) {
        if (node.tagName === 'FORM') return true;
        // Common form wrapper patterns
        if (node.classList && (
            node.classList.contains('form') ||
            node.getAttribute('role') === 'dialog' ||
            node.getAttribute('role') === 'form'
        )) return true;
        node = node.parentElement;
        depth++;
    }
    return false;
}

// ── Storage helpers ──────────────────────────────────────────
function loadBlueprint(callback) {
    chrome.storage.local.get([getBaseUrl()], (result) => {
        callback(result[getBaseUrl()] || []);
    });
}

function saveBlueprint(blueprint) {
    chrome.storage.local.set({ [getBaseUrl()]: blueprint });
}

/**
 * Add or update a step in the blueprint.
 * For 'fill': update existing selector entry if found.
 * For 'click': deduplicate by selector — keep only the last click to the same button.
 */
function recordStep(step) {
    loadBlueprint((blueprint) => {
        if (step.type === 'fill' || step.type === 'file') {
            const idx = blueprint.findIndex(s => s.selector === step.selector);
            if (idx !== -1) {
                blueprint[idx] = { ...blueprint[idx], ...step };
            } else {
                blueprint.push(step);
            }
        } else if (step.type === 'click') {
            // Remove previous click to the same button, keep latest position
            const filtered = blueprint.filter(s => !(s.type === 'click' && s.selector === step.selector));
            filtered.push(step);
            blueprint = filtered;
        }
        saveBlueprint(blueprint);
    });
}

// ── RECORDER ─────────────────────────────────────────────────

// Fill events: input (text, number, etc.) and change (select, checkbox, radio)
document.addEventListener('input', handleFillEvent);
document.addEventListener('change', handleFillEvent);

function handleFillEvent(e) {
    if (!isRecording) return;
    const target = e.target;
    const tag = target.tagName;

    if (tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT') return;
    if (target.type === 'password') return; // never record passwords

    const selector = getSelector(target);

    // File inputs — record as 'file' step (replay = highlight only)
    if (target.type === 'file') {
        recordStep({
            type: 'file',
            selector,
            label: target.getAttribute('aria-label') || target.name || 'File Upload',
            timestamp: Date.now(),
        });
        return;
    }

    // Checkboxes and radios
    if (target.type === 'checkbox' || target.type === 'radio') {
        recordStep({
            type: 'fill',
            fieldType: target.type,
            selector,
            value: target.value,
            checked: target.checked,
            timestamp: Date.now(),
        });
        return;
    }

    // All other inputs, textareas, selects
    recordStep({
        type: 'fill',
        fieldType: target.type || tag.toLowerCase(),
        selector,
        value: target.value,
        timestamp: Date.now(),
    });
}

// Click events: record button clicks inside forms
document.addEventListener('click', (e) => {
    if (!isRecording) return;
    const target = e.target.closest('button');
    if (!target) return;
    if (target.type === 'submit') return; // don't record form submissions
    if (!isInsideForm(target)) return;    // only buttons inside forms

    recordStep({
        type: 'click',
        selector: getSelector(target),
        label: getButtonLabel(target),
        timestamp: Date.now(),
    });
}, true); // capture phase so we get it before React

// ── REPLAYER ─────────────────────────────────────────────────

const CLICK_SETTLE_MS = 350;  // wait after a click for React to re-render
const FILL_SETTLE_MS = 50;   // wait between fills
const RETRY_INTERVAL = 500;  // ms between retries
const MAX_RETRIES = 8;    // total retry attempts per step

function dispatchReactEvents(el) {
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
}

async function replayStep(step, retries = MAX_RETRIES) {
    let el;
    try { el = document.querySelector(step.selector); } catch (_) { return; }

    if (!el) {
        if (retries > 0) {
            await sleep(RETRY_INTERVAL);
            return replayStep(step, retries - 1);
        }
        console.warn(`DevFlow Autopilot: Element not found — ${step.selector}`);
        return;
    }

    if (step.type === 'click') {
        el.click();
        await sleep(CLICK_SETTLE_MS);

    } else if (step.type === 'fill') {
        if (step.fieldType === 'checkbox' || step.fieldType === 'radio') {
            el.checked = step.checked;
        } else {
            el.value = step.value;
        }
        dispatchReactEvents(el);
        await sleep(FILL_SETTLE_MS);

    } else if (step.type === 'file') {
        highlightFileInput(el);
    }
}

async function autoFill() {
    const blueprint = await new Promise(resolve => loadBlueprint(resolve));
    if (!blueprint || blueprint.length === 0) return;

    // Sort steps by recorded timestamp to replay in order
    const ordered = [...blueprint].sort((a, b) => a.timestamp - b.timestamp);

    console.log(`DevFlow Autopilot: Replaying ${ordered.length} steps in order…`);
    for (const step of ordered) {
        await replayStep(step);
    }
    console.log('DevFlow Autopilot: Replay complete.');
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ── File upload highlight ─────────────────────────────────────
function highlightFileInput(el) {
    // Climb up to find the visual wrapper (label or parent div)
    let wrapper = el;
    for (let i = 0; i < 4; i++) {
        if (wrapper.parentElement) wrapper = wrapper.parentElement;
        if (wrapper.tagName === 'LABEL' || wrapper.tagName === 'DIV') break;
    }

    const originalOutline = wrapper.style.outline;
    const originalBoxShadow = wrapper.style.boxShadow;

    wrapper.style.outline = '3px solid #f59e0b';
    wrapper.style.boxShadow = '0 0 0 6px rgba(245, 158, 11, 0.25)';
    wrapper.scrollIntoView({ behavior: 'smooth', block: 'center' });

    // Pulse animation
    let on = true;
    const pulse = setInterval(() => {
        on = !on;
        wrapper.style.boxShadow = on
            ? '0 0 0 6px rgba(245, 158, 11, 0.25)'
            : '0 0 0 2px rgba(245, 158, 11, 0.1)';
    }, 600);

    setTimeout(() => {
        clearInterval(pulse);
        wrapper.style.outline = originalOutline;
        wrapper.style.boxShadow = originalBoxShadow;
    }, 6000);
}

// ── Run on page load ─────────────────────────────────────────
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', autoFill);
} else {
    autoFill();
}
window.addEventListener('load', autoFill);
