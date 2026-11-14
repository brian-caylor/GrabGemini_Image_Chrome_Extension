// --- CONFIGURATION ---
const SELECTORS = {
    cardContainer: '[data-grabgemini-card]',
    openImageBtn: '[aria-label^="Preview or open"]',
    downloadMenuItem: '[role="menuitem"]'
};

// --- STATE ---
let isDragging = false;
let startX = 0;
let startY = 0;
let selectionBox = null;
let isDragCandidate = false;
let suppressNextClick = false;

const DRAG_THRESHOLD = 6;
const INTERACTIVE_SELECTOR = [
    'a',
    'button',
    'input',
    'textarea',
    'select',
    '[role="button"]',
    '[role="link"]',
    '[contenteditable="true"]',
    '#bulk-dl-panel'
].join(',');

// --- STATE (CONTINUED) ---
let isDownloadingVideo = false;
let isProcessingMediaQueue = false;
let isExtensionContextInvalid = false;
let pageObserver = null;

// --- HELPER: SAFE MESSAGING ---
function hasExtensionRuntime() {
    try {
        return typeof chrome !== 'undefined' &&
               chrome.runtime &&
               typeof chrome.runtime.id === 'string' &&
               typeof chrome.runtime.sendMessage === 'function';
    } catch (error) {
        return false;
    }
}

function showRefreshRequired() {
    if (isExtensionContextInvalid) return;
    isExtensionContextInvalid = true;

    if (pageObserver) pageObserver.disconnect();

    sessionStorage.removeItem('grabgemini_download_pending');
    sessionStorage.removeItem('grabgemini_video_queue');

    document.querySelectorAll('.bulk-checkbox-container').forEach(element => element.remove());
    document.querySelectorAll('.bulk-selected-img').forEach(element => {
        element.classList.remove('bulk-selected-img');
    });

    if (selectionBox) selectionBox.style.display = 'none';

    const panel = document.getElementById('bulk-dl-panel');
    if (!panel) return;

    const message = document.createElement('span');
    message.textContent = 'GrabGemini was updated. Refresh Gemini to continue.';

    const refreshBtn = document.createElement('button');
    refreshBtn.textContent = 'Refresh Gemini';
    refreshBtn.onclick = () => window.location.reload();

    panel.replaceChildren(message, refreshBtn);
    panel.style.display = 'flex';
}

async function safeSendMessage(message) {
    if (!hasExtensionRuntime()) {
        showRefreshRequired();
        return null;
    }

    try {
        return await chrome.runtime.sendMessage(message);
    } catch (error) {
        showRefreshRequired();
        return null;
    }
}

// --- HELPER: CHECK PAGE ---
function isMyStuffPage() {
    return document.querySelector(SELECTORS.openImageBtn) !== null;
}

function isChatPage() {
    return window.location.pathname.startsWith('/app');
}

function getLibraryCards() {
    const openButtons = document.querySelectorAll(SELECTORS.openImageBtn);
    const containers = new Set();

    openButtons.forEach((button) => {
        // Gemini places the preview button and media action controls in a
        // shared wrapper. Mark it so generated class names can change safely.
        const container = button.parentElement;
        if (!container || !button.querySelector('img')) return;

        container.dataset.grabgeminiCard = '';
        containers.add(container);
    });

    return Array.from(containers);
}

function isMediaCard(container) {
    const icon = container.querySelector('mat-icon');
    if (!icon) return false;
    const iconName = icon.getAttribute('fonticon') || icon.getAttribute('data-mat-icon-name') || icon.textContent || '';
    const lowerName = iconName.toLowerCase().trim();

    return lowerName.includes('movie') ||
           lowerName.includes('music') ||
           lowerName.includes('audio') ||
           lowerName.includes('volume') ||
           lowerName.includes('play') ||
           lowerName.includes('sound') ||
           lowerName.includes('track') ||
           lowerName.includes('headphone') ||
           lowerName.includes('mic');
}

function triggerClick(element) {
    if (!element) return false;

    try {
        element.click();
        return true;
    } catch (clickError) {
        // Fallback for non-HTMLElement controls in older Gemini layouts.
        try {
            const clickEvent = new MouseEvent('click', {
                bubbles: true,
                cancelable: true,
                view: window
            });
            return element.dispatchEvent(clickEvent);
        } catch (dispatchError) {
            return false;
        }
    }
}

function clickCard(card) {
    if (!card) return;
    console.log("GrabGemini: Programmatically clicking card", card);

    // The reliable open trigger is the "Preview or open" element — clicking the
    // container/img/overlay alone does NOT navigate to the media's chat page.
    const openTrigger = card.querySelector(SELECTORS.openImageBtn) ||
                        (card.getAttribute('aria-label')?.startsWith('Preview or open') ? card : null);
    if (openTrigger) {
        console.log("GrabGemini: Clicking 'Preview or open' trigger");
        triggerClick(openTrigger);
        return;
    }

    // Fallbacks for older/other Gemini layouts
    triggerClick(card);
    const img = card.querySelector('img');
    if (img) {
        console.log("GrabGemini: Clicking card image child");
        triggerClick(img);
    }
    const overlay = card.querySelector('.thumbnail-overlay') || card.querySelector('.footer-overlay');
    if (overlay) {
        console.log("GrabGemini: Clicking card overlay child");
        triggerClick(overlay);
    }
}

// Find Gemini's own "Download video" / "Download track" button within a scope.
function findDownloadButton(root) {
    return Array.from(root.querySelectorAll('button,[role="button"]'))
        .find(b => /^download\b/i.test((b.getAttribute('aria-label') || '').trim()));
}

function findAudioOnlyMenuItem() {
    return Array.from(document.querySelectorAll(SELECTORS.downloadMenuItem))
        .find(item => {
            const label = `${item.getAttribute('aria-label') || ''} ${item.textContent || ''}`
                .replace(/\s+/g, ' ')
                .trim();

            return /audio only/i.test(label) &&
                   /mp3/i.test(label) &&
                   item.offsetParent !== null;
        });
}

function waitForAudioOnlyMenuItem(timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
        const startTime = Date.now();

        function check() {
            const item = findAudioOnlyMenuItem();
            if (item) {
                resolve(item);
                return;
            }

            if (Date.now() - startTime > timeoutMs) {
                reject(new Error("Timeout waiting for Gemini's Audio only MP3 option"));
                return;
            }

            setTimeout(check, 100);
        }

        check();
    });
}

async function triggerNativeMediaDownload(button) {
    const label = (button.getAttribute('aria-label') || '').trim();
    triggerClick(button);

    // Gemini changed music downloads in June 2026: "Download track" now opens
    // a format menu instead of downloading immediately. Select the MP3 option.
    if (/download track/i.test(label)) {
        const audioOnlyItem = await waitForAudioOnlyMenuItem();
        console.log("GrabGemini: Selecting Gemini's Audio only MP3 option");
        triggerClick(audioOnlyItem);
    }

    // Give Gemini time to hand the authenticated media request to Chrome before
    // navigating back to the library for the next queued item.
    await new Promise(resolve => setTimeout(resolve, 2200));
}

// Wait for Gemini to render its native download button for the anchored media.
// Media is lazy-loaded, so we nudge the scroll to force the message into view.
// Scoped to the hash's message container so multi-media threads grab the right one.
function waitForDownloadButton(hash, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
        const startTime = Date.now();
        const hashId = hash ? hash.replace('#', '') : '';
        let nudges = 0;

        function check() {
            let btn = null;
            if (hashId) {
                const el = document.querySelector(`[id*="${hashId}"]`);
                if (el) btn = findDownloadButton(el.closest('message-content') || el);
            }
            if (!btn) btn = findDownloadButton(document);

            if (btn && btn.offsetParent !== null) {
                resolve(btn);
                return;
            }

            if (Date.now() - startTime > timeoutMs) {
                reject(new Error("Timeout waiting for Gemini download button"));
                return;
            }

            // Nudge the conversation scroll to trigger lazy rendering of the media.
            const scroller = document.querySelector('infinite-scroller, main, [role="main"]') ||
                             document.scrollingElement;
            if (scroller) scroller.scrollBy(0, (nudges++ % 2 ? -1 : 1) * 1000);
            setTimeout(check, 700);
        }

        check();
    });
}

// --- INITIALIZE UI ---
function injectControlPanel() {
    let panel = document.getElementById('bulk-dl-panel');

    if (!panel) {
        panel = document.createElement('div');
        panel.id = 'bulk-dl-panel';

        const selectAllBtn = document.createElement('button');
        selectAllBtn.textContent = 'Select All on Screen';
        selectAllBtn.onclick = selectAllOnScreen;

        const deselectAllBtn = document.createElement('button');
        deselectAllBtn.textContent = 'Deselect All';
        deselectAllBtn.onclick = deselectAll;
        deselectAllBtn.style.backgroundColor = '#444746';
        deselectAllBtn.onmouseover = () => deselectAllBtn.style.backgroundColor = '#555';
        deselectAllBtn.onmouseout = () => deselectAllBtn.style.backgroundColor = '#444746';

        const downloadBtn = document.createElement('button');
        downloadBtn.textContent = 'Download Selected (0)';
        downloadBtn.id = 'bulk-dl-execute';
        downloadBtn.onclick = downloadSelected;

        panel.appendChild(selectAllBtn);
        panel.appendChild(deselectAllBtn);
        panel.appendChild(downloadBtn);
        document.body.appendChild(panel);
    }

    panel.style.display = isMyStuffPage() ? 'flex' : 'none';

    if (!selectionBox) {
        selectionBox = document.createElement('div');
        selectionBox.id = 'bulk-selection-box';
        document.body.appendChild(selectionBox);
    }
}

// --- CORE LOGIC ---
function attachCheckboxes() {
    if (!isMyStuffPage()) return;

    const cards = getLibraryCards();

    cards.forEach(container => {
        if (container.querySelector('.bulk-checkbox')) return;

        if (getComputedStyle(container).position === 'static') {
            container.style.position = 'relative';
        }

        const cbWrapper = document.createElement('div');
        cbWrapper.className = 'bulk-checkbox-container';
        cbWrapper.onclick = (e) => e.stopPropagation();

        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.className = 'bulk-checkbox';

        cb.addEventListener('change', (e) => {
            if (e.target.checked) {
                container.classList.add('bulk-selected-img');
            } else {
                container.classList.remove('bulk-selected-img');
            }
            updateDownloadCount();
        });

        cbWrapper.appendChild(cb);
        container.appendChild(cbWrapper);
    });
}

function updateDownloadCount() {
    const count = document.querySelectorAll('.bulk-checkbox:checked').length;
    const btn = document.getElementById('bulk-dl-execute');
    if (btn) {
        btn.textContent = `Download Selected (${count})`;
    }
}

function selectAllOnScreen() {
    const checkboxes = document.querySelectorAll('.bulk-checkbox');
    checkboxes.forEach(cb => {
        if (!cb.checked) {
            cb.checked = true;
            cb.dispatchEvent(new Event('change'));
        }
    });
}

function deselectAll() {
    const checkedBoxes = document.querySelectorAll('.bulk-checkbox:checked');
    checkedBoxes.forEach(cb => {
        cb.checked = false;
        cb.dispatchEvent(new Event('change'));
    });
}

function buildHighResImageUrls(rawUrl) {
    try {
        const url = new URL(rawUrl);
        const isGoogleImage = url.protocol === 'https:' &&
            (url.hostname === 'googleusercontent.com' ||
                url.hostname.endsWith('.googleusercontent.com'));

        if (!isGoogleImage) return null;

        const sizeDirective = /=[a-z]+\d*(?:-[a-z]+\d*)*$/i;
        const setSize = (size) => {
            const sizedUrl = new URL(url.href);
            sizedUrl.pathname = sizeDirective.test(sizedUrl.pathname)
                ? sizedUrl.pathname.replace(sizeDirective, `=${size}`)
                : `${sizedUrl.pathname}=${size}`;
            return sizedUrl.href;
        };

        return {
            primaryUrl: setSize('s0'),
            fallbackUrl: setSize('s2048')
        };
    } catch {
        return null;
    }
}

// --- DIRECT IMAGE + NATIVE MEDIA DOWNLOADS ---
async function downloadSelected() {
    if (!hasExtensionRuntime()) {
        showRefreshRequired();
        return;
    }

    const checkedBoxes = Array.from(document.querySelectorAll('.bulk-checkbox:checked'));
    if (checkedBoxes.length === 0) {
        alert("Please select at least one item.");
        return;
    }

    const confirmMsg = `Ready to instantly download ${checkedBoxes.length} items?\n\nClick OK to blast them straight to your downloads folder!`;
    if (!confirm(confirmMsg)) return;

    const execBtn = document.getElementById('bulk-dl-execute');
    execBtn.disabled = true;

    const imageElements = [];
    const mediaCardIndices = [];
    const failures = [];
    let downloadedImageCount = 0;

    const cards = getLibraryCards();

    checkedBoxes.forEach(cb => {
        const container = cb.closest(SELECTORS.cardContainer);
        if (!container) return;

        const cardIndex = cards.indexOf(container);
        if (isMediaCard(container)) {
            if (cardIndex !== -1) {
                mediaCardIndices.push(cardIndex);
            }
        } else {
            imageElements.push({ cb, container });
        }
    });

    // Download images immediately and only clear confirmed items.
    for (let i = 0; i < imageElements.length; i++) {
        execBtn.textContent = `Downloading image ${i + 1}/${imageElements.length}...`;
        const { cb, container } = imageElements[i];
        const imgElement = container.querySelector('img[src*="googleusercontent"]');
        const urls = imgElement?.src ? buildHighResImageUrls(imgElement.src) : null;

        if (!urls) {
            failures.push(`Image ${i + 1}: no supported image URL was found.`);
            continue;
        }

        const result = await safeSendMessage({
            action: 'downloadImage',
            url: urls.primaryUrl,
            fallbackUrl: urls.fallbackUrl
        });

        if (!result) return;
        if (!result.ok) {
            failures.push(`Image ${i + 1}: ${result.error || 'download failed.'}`);
            continue;
        }

        downloadedImageCount++;
        cb.checked = false;
        cb.dispatchEvent(new Event('change'));
    }

    // Handle video/audio queue
    if (mediaCardIndices.length > 0) {
        execBtn.textContent = `Starting media downloads...`;

        // Uncheck all media checkboxes to prevent reprocessing
        checkedBoxes.forEach(cb => {
            const container = cb.closest(SELECTORS.cardContainer);
            if (container && isMediaCard(container)) {
                cb.checked = false;
                cb.dispatchEvent(new Event('change'));
            }
        });

        sessionStorage.setItem('grabgemini_download_pending', 'true');

        const firstIndex = mediaCardIndices.shift();
        sessionStorage.setItem('grabgemini_video_queue', JSON.stringify(mediaCardIndices));

        const firstCard = cards[firstIndex];
        if (firstCard) {
            clickCard(firstCard);
        } else {
            sessionStorage.removeItem('grabgemini_download_pending');
            sessionStorage.removeItem('grabgemini_video_queue');
        }
    } else {
        execBtn.disabled = false;
        execBtn.textContent = failures.length > 0
            ? `Downloaded ${downloadedImageCount}; ${failures.length} failed`
            : `Downloaded ${downloadedImageCount}`;

        if (failures.length > 0) {
            console.warn('GrabGemini download failures:', failures);
        }

        setTimeout(updateDownloadCount, 2500);
    }
}

// --- DRAG TO SELECT (LASSO) LOGIC ---
document.addEventListener('mousedown', (e) => {
    if (!isMyStuffPage() || e.button !== 0) return;
    if (e.target.closest(INTERACTIVE_SELECTOR)) return;

    isDragCandidate = true;
    startX = e.clientX;
    startY = e.clientY;
});

document.addEventListener('mousemove', (e) => {
    if ((!isDragCandidate && !isDragging) || !isMyStuffPage()) return;

    const currentX = e.clientX;
    const currentY = e.clientY;

    const width = Math.abs(currentX - startX);
    const height = Math.abs(currentY - startY);

    if (!isDragging) {
        if (width < DRAG_THRESHOLD && height < DRAG_THRESHOLD) return;

        isDragging = true;
        window.getSelection()?.removeAllRanges();
        selectionBox.style.display = 'block';
    }

    e.preventDefault();

    const left = Math.min(currentX, startX);
    const top = Math.min(currentY, startY);

    selectionBox.style.width = width + 'px';
    selectionBox.style.height = height + 'px';
    selectionBox.style.left = left + 'px';
    selectionBox.style.top = top + 'px';

    checkCollisions(left, top, width, height);
});

document.addEventListener('mouseup', () => {
    if (isDragging) {
        suppressNextClick = true;
        setTimeout(() => { suppressNextClick = false; }, 0);
    }

    isDragCandidate = false;
    isDragging = false;
    if (selectionBox) selectionBox.style.display = 'none';
});

document.addEventListener('click', (e) => {
    if (!suppressNextClick) return;

    e.preventDefault();
    e.stopImmediatePropagation();
    suppressNextClick = false;
}, true);

window.addEventListener('blur', () => {
    isDragCandidate = false;
    isDragging = false;
    if (selectionBox) selectionBox.style.display = 'none';
});

function checkCollisions(boxX, boxY, boxW, boxH) {
    const checkboxes = document.querySelectorAll('.bulk-checkbox');

    checkboxes.forEach(cb => {
        const container = cb.closest(SELECTORS.cardContainer);
        if (!container) return;

        const rect = container.getBoundingClientRect();

        const overlap = !(rect.right < boxX ||
                          rect.left > boxX + boxW ||
                          rect.bottom < boxY ||
                          rect.top > boxY + boxH);

        if (overlap) {
            if (!cb.checked) {
                cb.checked = true;
                cb.dispatchEvent(new Event('change'));
            }
        }
    });
}

// --- VIDEO QUEUE PROCESSING ---
window.addEventListener('hashchange', () => {
    isDownloadingVideo = false;
    isProcessingMediaQueue = false;
});

function processVideoQueue() {
    if (sessionStorage.getItem('grabgemini_download_pending') !== 'true') return;
    if (isProcessingMediaQueue) return;

    let queue = [];
    try {
        queue = JSON.parse(sessionStorage.getItem('grabgemini_video_queue') || '[]');
    } catch (e) {
        return;
    }

    if (queue.length === 0) {
        sessionStorage.removeItem('grabgemini_download_pending');
        sessionStorage.removeItem('grabgemini_video_queue');
        return;
    }

    isProcessingMediaQueue = true;
    waitForCardsAndProcessNext(queue);
}

function waitForCardsAndProcessNext(queue, attempts = 0) {
    const cards = getLibraryCards();
    if (cards.length > 0) {
        const nextIndex = queue.shift();
        sessionStorage.setItem('grabgemini_video_queue', JSON.stringify(queue));

        if (nextIndex >= 0 && nextIndex < cards.length) {
            const card = cards[nextIndex];
            clickCard(card);
        } else {
            const checkedCheckbox = document.querySelector('.bulk-checkbox:checked');
            if (checkedCheckbox) {
                const card = checkedCheckbox.closest(SELECTORS.cardContainer);
                if (card) clickCard(card);
            } else {
                sessionStorage.removeItem('grabgemini_download_pending');
                sessionStorage.removeItem('grabgemini_video_queue');
                isProcessingMediaQueue = false;
            }
        }
    } else {
        if (attempts < 30) {
            setTimeout(() => waitForCardsAndProcessNext(queue, attempts + 1), 300);
        } else {
            console.debug("GrabGemini: Cards did not load in time.");
            sessionStorage.removeItem('grabgemini_download_pending');
            sessionStorage.removeItem('grabgemini_video_queue');
            isProcessingMediaQueue = false;
        }
    }
}

window.addEventListener('hashchange', () => {
    isDownloadingVideo = false;
    if (isChatPage()) {
        checkChatPageVideo();
    }
});

function waitForHash(timeoutMs = 4000) {
    return new Promise((resolve) => {
        if (window.location.hash) {
            resolve(window.location.hash);
            return;
        }

        const startTime = Date.now();
        const interval = setInterval(() => {
            if (window.location.hash) {
                clearInterval(interval);
                resolve(window.location.hash);
            } else if (Date.now() - startTime > timeoutMs) {
                clearInterval(interval);
                resolve('');
            }
        }, 100);
    });
}

async function checkChatPageVideo() {
    if (sessionStorage.getItem('grabgemini_download_pending') !== 'true') return;
    if (isDownloadingVideo) return;

    isDownloadingVideo = true;
    try {
        console.log("GrabGemini: Pending media download detected. Waiting for hash url anchor...");
        const hash = await waitForHash();
        console.log("GrabGemini: Hash anchor resolved:", hash);

        // Drive Gemini's own download button. The media file URL is auth-gated
        // (contribution.usercontent.google.com), so re-downloading it ourselves
        // fails; Gemini's native button handles the authenticated download for us.
        console.log("GrabGemini: Waiting for Gemini's native download button...");
        const btn = await waitForDownloadButton(hash);
        console.log("GrabGemini: Found native button, clicking:", btn.getAttribute('aria-label'));
        btn.scrollIntoView({ block: 'center' });
        await triggerNativeMediaDownload(btn);

        let queue = [];
        try {
            queue = JSON.parse(sessionStorage.getItem('grabgemini_video_queue') || '[]');
        } catch (e) {}

        if (queue.length > 0) {
            console.log("GrabGemini: Navigating back to download the next item in queue...");
            history.back();
        } else {
            console.log("GrabGemini: All media downloads complete!");
            sessionStorage.removeItem('grabgemini_download_pending');
            sessionStorage.removeItem('grabgemini_video_queue');
        }
    } catch (e) {
        console.debug("GrabGemini: Failed to trigger native media download:", e);
        sessionStorage.removeItem('grabgemini_download_pending');
        sessionStorage.removeItem('grabgemini_video_queue');
    } finally {
        isDownloadingVideo = false;
    }
}

// --- MUTATION OBSERVER (OPTIMIZED WITH DEBOUNCE) ---
let debounceTimer;

pageObserver = new MutationObserver(() => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
        if (!hasExtensionRuntime()) {
            showRefreshRequired();
            return;
        }
        if (isExtensionContextInvalid) return;
        injectControlPanel();
        if (isMyStuffPage()) {
            attachCheckboxes();
            processVideoQueue();
        } else if (isChatPage()) {
            checkChatPageVideo();
        }
    }, 300);
});

pageObserver.observe(document.body, { childList: true, subtree: true });

setTimeout(() => {
    injectControlPanel();
    if (isMyStuffPage()) {
        attachCheckboxes();
        processVideoQueue();
    } else if (isChatPage()) {
        checkChatPageVideo();
    }
}, 1000);
