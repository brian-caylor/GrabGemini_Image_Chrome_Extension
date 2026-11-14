// --- CONFIGURATION ---
// Gemini changes its markup from time to time, so each lookup tries a list of
// selectors in order. The first entry is the one the My Stuff gallery used when
// this extension shipped; the rest are looser fallbacks.
const SELECTORS = {
    cardContainers: [
        '.library-item-card-container',
        '[class*="library-item-card"]',
        '[class*="library-item"][class*="container"]'
    ],
    // A card qualifies if it holds a generated image. This does not depend on
    // the UI language, unlike the old aria-label check.
    cardImage: 'img[src*="googleusercontent"]',
    // Kept as a secondary signal for cards whose image hasn't loaded yet.
    // English-only, so it is never required on its own.
    openImageBtn: 'div[aria-label^="Preview or open"]'
};

const CARD_ATTR = 'data-grabgemini-card';
const LOG_PREFIX = '[GrabGemini]';
let warnedNoQualifyingCards = false;

// --- HELPER: FIND CARDS ---
function findCards() {
    for (const selector of SELECTORS.cardContainers) {
        const cards = document.querySelectorAll(selector);
        if (cards.length > 0) return { cards, selector };
    }
    return { cards: [], selector: null };
}

// Fallback selectors are loose, so there a card must hold exactly one image;
// that keeps a whole grid wrapper from being treated as one card.
function cardQualifies(container, isFallback) {
    const images = container.querySelectorAll(SELECTORS.cardImage).length;
    if (isFallback && images > 1) return false;
    return images > 0 || container.querySelector(SELECTORS.openImageBtn) !== null;
}

// The card a checkbox belongs to, whichever selector matched it.
function cardOf(checkbox) {
    return checkbox.closest(`[${CARD_ATTR}]`);
}

// --- STATE ---
let isDragging = false;
let startX = 0;
let startY = 0;
let selectionBox = null;

// --- HELPER: CHECK PAGE ---
function isMyStuffPage() {
    return findCards().cards.length > 0;
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
    const { cards, selector } = findCards();
    if (cards.length === 0) return;

    const isFallback = selector !== SELECTORS.cardContainers[0];
    let qualifying = 0;

    cards.forEach(container => {
        // Fallback selectors can match nested elements; only use the outermost card.
        if (container.parentElement && container.parentElement.closest(`[${CARD_ATTR}]`)) return;
        if (!cardQualifies(container, isFallback)) return;
        qualifying++;
        if (container.querySelector('.bulk-checkbox')) return;

        container.setAttribute(CARD_ATTR, '');

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

    // Cards were found but none look like image cards: Gemini's markup has
    // probably changed again. Say so once instead of failing silently.
    if (qualifying === 0 && !warnedNoQualifyingCards) {
        warnedNoQualifyingCards = true;
        console.warn(`${LOG_PREFIX} Found ${cards.length} cards with "${selector}" but none contain an image matching "${SELECTORS.cardImage}". Gemini's page structure may have changed.`);
    }
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

// --- THE INSTANT API DANCE ---
async function downloadSelected() {
    const checkedBoxes = document.querySelectorAll('.bulk-checkbox:checked');
    if (checkedBoxes.length === 0) {
        alert("Please select at least one image.");
        return;
    }

    // THE NEW, SPEED-FOCUSED CONFIRMATION PROMPT
    const confirmMsg = `Ready to instantly download ${checkedBoxes.length} images?\n\nClick OK to blast them straight to your downloads folder!`;
    if (!confirm(confirmMsg)) return;

    const execBtn = document.getElementById('bulk-dl-execute');
    
    for (let i = 0; i < checkedBoxes.length; i++) {
        execBtn.textContent = `Downloading ${i + 1}/${checkedBoxes.length}...`;
        
        const container = cardOf(checkedBoxes[i]);
        if (!container) continue;

        // Target the low-res thumbnail image inside the card
        const imgElement = container.querySelector(SELECTORS.cardImage);
        
        if (imgElement && imgElement.src) {
            // Google CDN Magic: Split the URL at the '=' to remove the compression sizing 
            // and append '=s0' to request the raw, uncompressed master file.
            const highResUrl = imgElement.src.split('=')[0] + '=s0';
            
            // Send the raw URL to our background script to bypass Chrome's security locks
            chrome.runtime.sendMessage({ 
                action: "downloadImage", 
                url: highResUrl 
            });

            // A tiny 200ms pause just so we don't accidentally overload the background processor
            await new Promise(r => setTimeout(r, 200));
        }
        
        checkedBoxes[i].checked = false;
        checkedBoxes[i].dispatchEvent(new Event('change'));
    }

    execBtn.textContent = "Done!";
    setTimeout(() => { execBtn.textContent = "Download Selected (0)"; }, 2000);
}

// --- DRAG TO SELECT (LASSO) LOGIC ---
document.addEventListener('mousedown', (e) => {
    if (!isMyStuffPage()) return; 

    if (e.target.closest('button') || 
        e.target.closest('.bulk-checkbox') || 
        e.target.closest('#bulk-dl-panel')) return;

    e.preventDefault();

    isDragging = true;
    startX = e.clientX;
    startY = e.clientY;

    selectionBox.style.width = '0px';
    selectionBox.style.height = '0px';
    selectionBox.style.left = startX + 'px';
    selectionBox.style.top = startY + 'px';
    selectionBox.style.display = 'block';
});

document.addEventListener('mousemove', (e) => {
    if (!isDragging || !isMyStuffPage()) return;

    const currentX = e.clientX;
    const currentY = e.clientY;

    const width = Math.abs(currentX - startX);
    const height = Math.abs(currentY - startY);
    const left = Math.min(currentX, startX);
    const top = Math.min(currentY, startY);

    selectionBox.style.width = width + 'px';
    selectionBox.style.height = height + 'px';
    selectionBox.style.left = left + 'px';
    selectionBox.style.top = top + 'px';

    checkCollisions(left, top, width, height);
});

document.addEventListener('mouseup', () => {
    isDragging = false;
    if (selectionBox) selectionBox.style.display = 'none';
});

function checkCollisions(boxX, boxY, boxW, boxH) {
    const checkboxes = document.querySelectorAll('.bulk-checkbox');

    checkboxes.forEach(cb => {
        const container = cardOf(cb);
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

// --- MUTATION OBSERVER (OPTIMIZED WITH DEBOUNCE) ---
let debounceTimer;

const observer = new MutationObserver(() => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
        injectControlPanel(); 
        if (isMyStuffPage()) {
            attachCheckboxes();
        }
    }, 300);
});

observer.observe(document.body, { childList: true, subtree: true });

setTimeout(() => {
    injectControlPanel();
    if (isMyStuffPage()) {
        attachCheckboxes();
    }
}, 1000);