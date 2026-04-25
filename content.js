// --- CONFIGURATION ---
const SELECTORS = {
    cardContainer: '.library-item-card-container',
    openImageBtn: 'div[aria-label^="Preview or open"]',
    downloadBtn: 'button[aria-label="Download full size image"], button[data-test-id="download-generated-image-button"]'
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

// --- HELPER: WAIT FOR NATIVE DOWNLOAD BUTTON ---
function waitForLightboxDownloadButton(timeout) {
    return new Promise((resolve) => {
        const checkForBtn = () => {
            const dlBtn = document.querySelector(SELECTORS.downloadBtn);
            return (dlBtn && dlBtn.getBoundingClientRect().width > 0) ? dlBtn : null;
        };

        let found = checkForBtn();
        if (found) return resolve(found);

        const interval = setInterval(() => {
            found = checkForBtn();
            if (found) {
                clearInterval(interval);
                resolve(found);
            }
        }, 50);

        setTimeout(() => {
            clearInterval(interval);
            resolve(null);
        }, timeout);
    });
}

// --- HELPER: WAIT FOR MODAL TO VANISH ---
function waitForModalToClose(timeout = 2000) {
    return new Promise((resolve) => {
        const isClosed = () => {
            const dlBtn = document.querySelector(SELECTORS.downloadBtn);
            return !dlBtn || dlBtn.getBoundingClientRect().width === 0;
        };

        if (isClosed()) return resolve();

        const interval = setInterval(() => {
            if (isClosed()) {
                clearInterval(interval);
                resolve();
            }
        }, 50);

        setTimeout(() => {
            clearInterval(interval);
            resolve();
        }, timeout);
    });
}

// --- THE SUPERCHARGED LIGHTBOX DANCE (GEMINI EDITION) ---
async function downloadSelected() {
    let initialCount = document.querySelectorAll('.bulk-checkbox:checked').length;
    if (initialCount === 0) {
        alert("Please select at least one image.");
        return;
    }

    const confirmMsg = `Ready to blast through ${initialCount} images? \n\nCRITICAL: Keep your hands off the mouse and keyboard while the script runs!`;
    if (!confirm(confirmMsg)) return;

    const execBtn = document.getElementById('bulk-dl-execute');
    let currentIteration = 1;

    while (document.querySelectorAll('.bulk-checkbox:checked').length > 0) {
        execBtn.textContent = `Downloading ${currentIteration}/${initialCount}...`;
        
        const activeCheckbox = document.querySelectorAll('.bulk-checkbox:checked')[0];
        const container = activeCheckbox.closest(SELECTORS.cardContainer);

        if (!container) {
            activeCheckbox.checked = false;
            activeCheckbox.dispatchEvent(new Event('change'));
            continue;
        }

        const openBtn = container.querySelector(SELECTORS.openImageBtn);

        if (openBtn) {
            openBtn.scrollIntoView({ behavior: 'instant', block: 'center' });
            await new Promise(r => setTimeout(r, 100));

            openBtn.click();

            const dlBtn = await waitForLightboxDownloadButton(3000);
            
            if (dlBtn) {
                dlBtn.click();
                
                await new Promise(r => setTimeout(r, 450));

                document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
                
                await waitForModalToClose(); 
                await new Promise(r => setTimeout(r, 200)); // Breather for Angular UI to settle
            } else {
                document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
                await waitForModalToClose();
                await new Promise(r => setTimeout(r, 200)); 
            }
        }
        
        activeCheckbox.checked = false;
        activeCheckbox.dispatchEvent(new Event('change'));
        
        currentIteration++;
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