function isAllowedImageUrl(rawUrl) {
    try {
        const url = new URL(rawUrl);
        return url.protocol === 'https:' &&
            (url.hostname === 'googleusercontent.com' ||
                url.hostname.endsWith('.googleusercontent.com'));
    } catch {
        return false;
    }
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action !== 'downloadImage') return false;

    if (!isAllowedImageUrl(request.url) ||
        (request.fallbackUrl && !isAllowedImageUrl(request.fallbackUrl))) {
        sendResponse({ ok: false, error: 'The image URL is not a supported Google image URL.' });
        return false;
    }

    let filename = request.filename;

    if (!filename) {
        try {
            const urlFilename = new URL(request.url).searchParams.get('filename');
            if (urlFilename) filename = urlFilename;
        } catch {
            // The URL was already validated above.
        }
    }

    if (!filename) {
        filename = `Gemini_Generation_${Date.now()}.png`;
    }

    downloadWithFallback(
        request.url,
        filename,
        request.fallbackUrl,
        sendResponse
    );

    // Keep the message channel open through the initial/fallback attempt.
    return true;
});

function downloadWithFallback(url, filename, fallbackUrl, sendResponse) {
    chrome.downloads.download({
        url,
        filename,
        conflictAction: 'uniquify'
    }, (downloadId) => {
        const error = chrome.runtime.lastError;

        if (error || downloadId === undefined) {
            if (fallbackUrl) {
                // Leave the failed callback before retrying so its scoped
                // chrome.runtime.lastError cannot leak into the fallback.
                setTimeout(() => {
                    downloadWithFallback(fallbackUrl, filename, null, sendResponse);
                }, 0);
                return;
            }

            sendResponse({
                ok: false,
                error: error?.message || 'Chrome did not start the download.'
            });
            return;
        }

        sendResponse({ ok: true, downloadId });

        if (!fallbackUrl) return;

        // Some Google URLs start successfully and are interrupted later. Retry
        // those once with the bounded high-resolution fallback.
        const onChanged = (delta) => {
            if (delta.id !== downloadId || !delta.state) return;

            if (delta.state.current === 'interrupted') {
                chrome.downloads.onChanged.removeListener(onChanged);
                downloadWithFallback(fallbackUrl, filename, null, () => {});
            } else if (delta.state.current === 'complete') {
                chrome.downloads.onChanged.removeListener(onChanged);
            }
        };

        chrome.downloads.onChanged.addListener(onChanged);
    });
}
