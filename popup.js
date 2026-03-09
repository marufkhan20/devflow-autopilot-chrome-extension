document.addEventListener('DOMContentLoaded', async () => {
    const recordBtn = document.getElementById('recordBtn');
    const recordText = document.getElementById('recordText');
    const recordIcon = document.getElementById('recordIcon');
    const blueprintList = document.getElementById('blueprintList');
    const clearBtn = document.getElementById('clearBtn');
    const stepCount = document.getElementById('stepCount');

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('edge://')) {
        blueprintList.innerHTML = '<div class="empty-state">Cannot run on this page.</div>';
        recordBtn.disabled = true;
        return;
    }

    const currentUrl = tab.url.split('?')[0].split('#')[0];
    let isRecording = false;

    chrome.storage.local.get(['isRecording'], (res) => {
        isRecording = res.isRecording || false;
        updateRecordButton();
    });

    loadBlueprints();

    function updateRecordButton() {
        if (isRecording) {
            recordBtn.className = 'record-btn stop';
            recordText.textContent = 'Stop Recording';
            recordIcon.innerHTML = `<rect x="6" y="6" width="8" height="8" fill="currentColor" />`;
        } else {
            recordBtn.className = 'record-btn start';
            recordText.textContent = 'Start Recording';
            recordIcon.innerHTML = `<circle cx="10" cy="10" r="6" fill="currentColor" />`;
        }
    }

    recordBtn.addEventListener('click', () => {
        isRecording = !isRecording;
        chrome.storage.local.set({ isRecording });
        updateRecordButton();

        chrome.tabs.sendMessage(tab.id, { action: isRecording ? 'startRecording' : 'stopRecording' }).catch(() => {
            blueprintList.innerHTML = '<div class="error-state"><strong>Content script missing.</strong><br/>Please refresh the page and try again.</div>';
            if (isRecording) {
                isRecording = false;
                chrome.storage.local.set({ isRecording: false });
                updateRecordButton();
            }
        });
    });

    clearBtn.addEventListener('click', () => {
        chrome.storage.local.remove([currentUrl], loadBlueprints);
    });

    function loadBlueprints() {
        chrome.storage.local.get([currentUrl], (result) => {
            const blueprint = result[currentUrl] || [];

            // Sort steps by timestamp for display
            const ordered = [...blueprint].sort((a, b) => a.timestamp - b.timestamp);

            if (stepCount) stepCount.textContent = ordered.length > 0 ? `${ordered.length} step${ordered.length > 1 ? 's' : ''}` : '';

            if (ordered.length === 0) {
                blueprintList.innerHTML = '<div class="empty-state bordered">No steps recorded for this URL.</div>';
                return;
            }

            blueprintList.innerHTML = '';
            ordered.forEach((step, index) => {
                const el = document.createElement('div');
                el.className = 'blueprint-item';

                const badge = getBadge(step);
                const label = getStepLabel(step);
                const safeSelector = (step.selector || '').replace(/"/g, '&quot;');

                el.innerHTML = `
                    <div class="step-index">${index + 1}</div>
                    <div class="content">
                        <div class="step-header">
                            <span class="badge ${badge.cls}">${badge.icon} ${badge.text}</span>
                            ${step.type === 'file' ? '<span class="badge badge-file-warn">⚠ Manual Upload</span>' : ''}
                        </div>
                        <div class="selector" title="${safeSelector}">${step.selector || ''}</div>
                        <div class="value">${label}</div>
                    </div>
                    <button class="delete-btn" data-index="${index}" title="Remove step">
                        <svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path></svg>
                    </button>
                `;
                blueprintList.appendChild(el);
            });

            document.querySelectorAll('.delete-btn').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    const idx = parseInt(e.currentTarget.getAttribute('data-index'), 10);
                    deleteStep(ordered[idx]);
                });
            });
        });
    }

    function getBadge(step) {
        if (step.type === 'click') return { cls: 'badge-click', icon: '🖱', text: 'Click' };
        if (step.type === 'file') return { cls: 'badge-file', icon: '📁', text: 'File' };
        const ft = step.fieldType || 'text';
        if (ft === 'checkbox' || ft === 'radio') return { cls: 'badge-check', icon: '☑', text: ft };
        if (ft === 'select') return { cls: 'badge-select', icon: '▾', text: 'Select' };
        return { cls: 'badge-fill', icon: '✏', text: ft };
    }

    function getStepLabel(step) {
        if (step.type === 'click') return `"${step.label || 'Button'}"`;
        if (step.type === 'file') return step.label || 'File Upload';
        if (step.fieldType === 'checkbox' || step.fieldType === 'radio') {
            return step.checked ? '✓ Checked' : '✗ Unchecked';
        }
        const v = (step.value || '');
        return v.length > 28 ? v.substring(0, 28) + '…' : v;
    }

    function deleteStep(stepToDelete) {
        chrome.storage.local.get([currentUrl], (result) => {
            let blueprint = result[currentUrl] || [];
            // Match by selector + type + timestamp
            blueprint = blueprint.filter(s =>
                !(s.selector === stepToDelete.selector && s.type === stepToDelete.type && s.timestamp === stepToDelete.timestamp)
            );
            chrome.storage.local.set({ [currentUrl]: blueprint }, loadBlueprints);
        });
    }

    // ── Export ──────────────────────────────────────────────
    document.getElementById('exportBtn').addEventListener('click', () => {
        chrome.storage.local.get([currentUrl], (result) => {
            const blueprint = result[currentUrl] || [];
            if (blueprint.length === 0) {
                showToast('⚠ Nothing recorded to export.');
                return;
            }

            const payload = {
                meta: {
                    exportedAt: new Date().toISOString(),
                    url: currentUrl,
                    stepCount: blueprint.length,
                    tool: 'DevFlow Autopilot v1'
                },
                blueprint
            };

            const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            // Generate a safe filename from the URL
            const safeName = currentUrl
                .replace(/https?:\/\//, '')
                .replace(/[^a-z0-9]+/gi, '_')
                .substring(0, 60);
            a.href = url;
            a.download = `devflow_${safeName}.json`;
            a.click();
            URL.revokeObjectURL(url);
            showToast(`✓ Exported ${blueprint.length} step${blueprint.length > 1 ? 's' : ''}`);
        });
    });

    // ── Import ──────────────────────────────────────────────
    document.getElementById('importFile').addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = (ev) => {
            try {
                const parsed = JSON.parse(ev.target.result);

                // Accept both {meta, blueprint} and a raw array
                let importedSteps = Array.isArray(parsed) ? parsed : parsed.blueprint;

                if (!Array.isArray(importedSteps) || importedSteps.length === 0) {
                    showToast('✗ Invalid file — no steps found.');
                    return;
                }

                // Merge with existing steps, deduplicating by selector+type
                chrome.storage.local.get([currentUrl], (result) => {
                    let existing = result[currentUrl] || [];

                    importedSteps.forEach(step => {
                        const dup = existing.findIndex(s =>
                            s.selector === step.selector &&
                            s.type === step.type &&
                            s.timestamp === step.timestamp
                        );
                        if (dup !== -1) {
                            existing[dup] = step; // overwrite matching step
                        } else {
                            existing.push(step);
                        }
                    });

                    chrome.storage.local.set({ [currentUrl]: existing }, () => {
                        loadBlueprints();
                        showToast(`✓ Imported ${importedSteps.length} step${importedSteps.length > 1 ? 's' : ''}`);
                    });
                });
            } catch (_) {
                showToast('✗ Failed to parse JSON file.');
            }
        };
        reader.readAsText(file);
        // Reset so same file can be imported again if needed
        e.target.value = '';
    });

    // ── Toast helper ────────────────────────────────────────
    function showToast(message) {
        const toast = document.getElementById('toast');
        toast.textContent = message;
        toast.classList.add('show');
        setTimeout(() => toast.classList.remove('show'), 2800);
    }
});

