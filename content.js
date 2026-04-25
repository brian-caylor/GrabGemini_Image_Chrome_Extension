// --- CONFIGURATION ---
const SELECTORS = {
    cardContainer: '.library-item-card-container',
    openImageBtn: 'div[aria-label^="Preview or open"]'
};

// --- STATE ---
let isDragging = false;
let startX = 0;
let startY = 0;
let selectionBox = null;

// --- HELPER: CHECK PAGE ---
function isMyStuffPage() {
    return document.querySelector(SELECTORS.cardContainer) !== null;
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

    const cards = document.querySelectorAll(SELECTORS.cardContainer);
    
    cards.forEach(container => {
        if (!container.querySelector(SELECTORS.openImageBtn)) return;
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
        
        const container = checkedBoxes[i].closest(SELECTORS.cardContainer);
        if (!container) continue;

        // Target the low-res thumbnail image inside the card
        const imgElement = container.querySelector('img[src*="googleusercontent"]');
        
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