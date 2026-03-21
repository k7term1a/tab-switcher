const SESSION_TIMEOUT_MS = 2600;
const BLOCKED_URL_PREFIXES = [
    "https://chrome.google.com/webstore",
    "https://chromewebstore.google.com",
];
const PREVIEW_STORAGE_KEY = "tabPreviewCache";
const PREVIEW_SAVE_DEBOUNCE_MS = 450;
const LOCAL_STORAGE_QUOTA_BYTES = chrome.storage.local.QUOTA_BYTES || 10 * 1024 * 1024;
const PREVIEW_STORAGE_MAX_BYTES = Math.floor(LOCAL_STORAGE_QUOTA_BYTES * 0.9);

let sourceWindowId = null;
let overlayHostTabId = null;
let selectedTabId = null;
let lastTriggerAt = 0;
let cachedTabs = [];
const tabPreviewCache = new Map();
let previewSaveTimer = null;
const previewCacheReadyPromise = loadPreviewCacheFromStorage();

chrome.commands.onCommand.addListener((command) => {
    if (command === "open-tab-switcher") {
        startOrAdvanceSwitcher().catch((error) => {
            console.error("Failed to open switcher:", error);
        });
    } else if (command === "open-tab-switcher-reverse") {
        startOrAdvanceSwitcher(-1).catch((error) => {
            console.error("Failed to open reverse switcher:", error);
        });
    }
});

chrome.action.onClicked.addListener(() => {
    startOrAdvanceSwitcher().catch((error) => {
        console.error("Failed to open switcher from action:", error);
    });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || typeof message.type !== "string") {
        return false;
    }

    if (message.type === "get-switcher-state") {
        sendResponse({
            tabs: cachedTabs,
            selectedTabId,
            sourceWindowId,
            isVisible: overlayHostTabId !== null,
        });
        return false;
    }

    if (message.type === "cycle-selection") {
        cycleSelection(message.direction === "previous" ? -1 : 1)
            .then(() => sendResponse({ ok: true }))
            .catch((error) => sendResponse({ ok: false, error: String(error) }));
        return true;
    }

    if (message.type === "set-selection") {
        selectedTabId = message.tabId;
        lastTriggerAt = Date.now();
        broadcastState().catch((error) => {
            console.error("Failed to update switcher state:", error);
        });
        sendResponse({ ok: true });
        return false;
    }

    if (message.type === "select-and-confirm") {
        selectedTabId = message.tabId;
        lastTriggerAt = Date.now();
        confirmSelection()
            .then(() => sendResponse({ ok: true }))
            .catch((error) => sendResponse({ ok: false, error: String(error) }));
        return true;
    }

    if (message.type === "confirm-selection") {
        confirmSelection()
            .then(() => sendResponse({ ok: true }))
            .catch((error) => sendResponse({ ok: false, error: String(error) }));
        return true;
    }

    if (message.type === "cancel-switcher") {
        cancelSwitcher()
            .then(() => sendResponse({ ok: true }))
            .catch((error) => sendResponse({ ok: false, error: String(error) }));
        return true;
    }

    if (message.type === "close-tab") {
        closeTabFromSwitcher(message.tabId)
            .then(() => sendResponse({ ok: true }))
            .catch((error) => sendResponse({ ok: false, error: String(error) }));
        return true;
    }

    return false;
});

chrome.windows.onRemoved.addListener((windowId) => {
    if (windowId === sourceWindowId) {
        resetSession();
    }
});

chrome.windows.onFocusChanged.addListener((windowId) => {
    if (sourceWindowId === null || overlayHostTabId === null) {
        return;
    }

    // Alt+Tab can move focus out of Chrome and skip keyup events in the page.
    if (windowId !== sourceWindowId) {
        cancelSwitcher().catch((error) => {
            console.error("Failed to cancel switcher on focus change:", error);
        });
    }
});

chrome.tabs.onRemoved.addListener((tabId) => {
    tabPreviewCache.delete(tabId);
    queuePersistPreviewCache();

    if (tabId === overlayHostTabId) {
        resetSession();
        return;
    }

    if (!cachedTabs.length) {
        return;
    }

    cachedTabs = cachedTabs.filter((tab) => tab.id !== tabId);
    if (selectedTabId === tabId) {
        selectedTabId = cachedTabs[0]?.id ?? null;
    }

    broadcastState().catch((error) => {
        console.error("Failed to update after tab removal:", error);
    });
});

chrome.tabs.onActivated.addListener(async ({ tabId, windowId }) => {
    if (overlayHostTabId !== null) {
        return;
    }

    await captureAndCachePreview(tabId, windowId);
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
    if (changeInfo.status !== "complete" || !tab.active || typeof tab.windowId !== "number") {
        return;
    }

    if (overlayHostTabId !== null) {
        return;
    }

    await captureAndCachePreview(tabId, tab.windowId);
});

async function startOrAdvanceSwitcher(direction = 1) {
    await previewCacheReadyPromise;

    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!activeTab || typeof activeTab.id !== "number" || typeof activeTab.windowId !== "number") {
        return;
    }

    const overlayReady = await ensureOverlayReady(activeTab);
    if (!overlayReady) {
        console.warn("Tab switcher overlay cannot run on this page.");
        return;
    }

    const tabs = await chrome.tabs.query({ windowId: activeTab.windowId });
    const switchableTabs = sortTabsByRecentUsage(tabs.filter(isTabSwitchable));
    if (switchableTabs.length <= 1) {
        return;
    }

    const now = Date.now();
    const sameSession =
        sourceWindowId === activeTab.windowId &&
        now - lastTriggerAt < SESSION_TIMEOUT_MS &&
        selectedTabId !== null;

    const activeIndex = switchableTabs.findIndex((tab) => tab.id === activeTab.id);
    const selectedIndex = switchableTabs.findIndex((tab) => tab.id === selectedTabId);

    let nextIndex = 0;
    if (sameSession && selectedIndex >= 0) {
        nextIndex = getWrappedIndex(selectedIndex + direction, switchableTabs.length);
    } else {
        nextIndex = getWrappedIndex(Math.max(activeIndex, 0) + direction, switchableTabs.length);
    }

    sourceWindowId = activeTab.windowId;
    overlayHostTabId = activeTab.id;
    selectedTabId = switchableTabs[nextIndex].id ?? null;
    lastTriggerAt = now;

    if (!sameSession) {
        await captureAndCachePreview(activeTab.id, activeTab.windowId);
    }
    cachedTabs = buildTabCards(switchableTabs);
    await broadcastState();
}

function getWrappedIndex(index, length) {
    return ((index % length) + length) % length;
}

async function ensureOverlayReady(tab) {
    if (typeof tab.id !== "number") {
        return false;
    }

    if (!isInjectableUrl(tab.url)) {
        return false;
    }

    const hasAccess = await hasTabAccess(tab.url);
    if (!hasAccess) {
        return false;
    }

    try {
        const response = await chrome.tabs.sendMessage(tab.id, { type: "ping-switcher" });
        if (response?.ok) {
            return true;
        }
    } catch {
        // Content script is not available yet; inject below.
    }

    try {
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["switcher.js"] });
        const response = await chrome.tabs.sendMessage(tab.id, { type: "ping-switcher" });
        return Boolean(response?.ok);
    } catch {
        return false;
    }
}

function isInjectableUrl(url) {
    if (!url) {
        return false;
    }

    if (!/^(https?|file):/i.test(url)) {
        return false;
    }

    const normalizedUrl = url.toLowerCase();
    return !BLOCKED_URL_PREFIXES.some((prefix) => normalizedUrl.startsWith(prefix));
}

async function hasTabAccess(url) {
    if (!url) {
        return false;
    }

    if (url.startsWith("file:")) {
        try {
            return await chrome.extension.isAllowedFileSchemeAccess();
        } catch {
            return false;
        }
    }

    try {
        const origin = new URL(url).origin;
        if (!/^https?:/i.test(origin)) {
            return false;
        }

        return await chrome.permissions.contains({
            origins: [`${origin}/*`],
        });
    } catch {
        return false;
    }
}

function isTabSwitchable(tab) {
    return typeof tab?.id === "number" && isInjectableUrl(tab.url ?? "");
}

async function cycleSelection(direction) {
    if (!cachedTabs.length || selectedTabId === null) {
        return;
    }

    const currentIndex = cachedTabs.findIndex((tab) => tab.id === selectedTabId);
    const nextIndex =
        currentIndex < 0
            ? 0
            : (currentIndex + direction + cachedTabs.length) % cachedTabs.length;

    selectedTabId = cachedTabs[nextIndex]?.id ?? selectedTabId;
    lastTriggerAt = Date.now();
    await broadcastState();
}

async function confirmSelection() {
    if (selectedTabId === null || sourceWindowId === null) {
        await hideOverlay();
        resetSession();
        return;
    }

    try {
        await chrome.tabs.update(selectedTabId, { active: true });
        await chrome.windows.update(sourceWindowId, { focused: true });
    } catch (error) {
        console.warn("Failed to focus selected tab:", error);
    }

    await hideOverlay();
    resetSession();
}

async function cancelSwitcher() {
    await hideOverlay();
    resetSession();
}

async function closeTabFromSwitcher(tabId) {
    await previewCacheReadyPromise;

    if (typeof tabId !== "number") {
        return;
    }

    try {
        await chrome.tabs.remove(tabId);
    } catch {
        return;
    }

    if (sourceWindowId === null) {
        return;
    }

    const tabsInWindow = await chrome.tabs.query({ windowId: sourceWindowId });
    const switchableTabs = sortTabsByRecentUsage(tabsInWindow.filter(isTabSwitchable));

    if (!switchableTabs.length) {
        await cancelSwitcher();
        return;
    }

    if (!switchableTabs.some((tab) => tab.id === selectedTabId)) {
        selectedTabId = switchableTabs[0]?.id ?? null;
    }

    cachedTabs = buildTabCards(switchableTabs);
    await broadcastState();
}

async function broadcastState() {
    if (overlayHostTabId === null) {
        return;
    }

    try {
        await chrome.tabs.sendMessage(overlayHostTabId, {
            type: "render-switcher",
            tabs: cachedTabs,
            selectedTabId,
            sourceWindowId,
            confirmOnAltRelease: true,
        });
    } catch {
        // Content script may not exist for restricted pages.
    }
}

async function hideOverlay() {
    if (overlayHostTabId === null) {
        return;
    }

    try {
        await chrome.tabs.sendMessage(overlayHostTabId, { type: "hide-switcher" });
    } catch {
        // Content script may not exist for chrome:// pages.
    }
}

function resetSession() {
    sourceWindowId = null;
    overlayHostTabId = null;
    selectedTabId = null;
    lastTriggerAt = 0;
    cachedTabs = [];
}

function buildTabCards(tabs) {
    return tabs.map((tab) => {
        const tabUrl = tab.url ?? "";
        const hostname = getHostname(tabUrl);

        return {
            id: tab.id,
            title: tab.title ?? "Untitled tab",
            url: tabUrl,
            hostname,
            favIconUrl: tab.favIconUrl ?? "",
            active: Boolean(tab.active),
            audible: Boolean(tab.audible),
            muted: Boolean(tab.mutedInfo?.muted),
            pinned: Boolean(tab.pinned),
            previewDataUrl: tabPreviewCache.get(tab.id) ?? null,
        };
    });
}

function sortTabsByRecentUsage(tabs) {
    return [...tabs]
        .map((tab, index) => ({ tab, index }))
        .sort((left, right) => {
            const leftAccessed = Number(left.tab.lastAccessed) || 0;
            const rightAccessed = Number(right.tab.lastAccessed) || 0;
            if (rightAccessed !== leftAccessed) {
                return rightAccessed - leftAccessed;
            }

            return left.index - right.index;
        })
        .map((entry) => entry.tab);
}

async function captureAndCachePreview(tabId, windowId) {
    await previewCacheReadyPromise;

    if (typeof tabId !== "number" || typeof windowId !== "number") {
        return;
    }

    try {
        const dataUrl = await chrome.tabs.captureVisibleTab(windowId, {
            format: "jpeg",
            quality: 58,
        });

        if (dataUrl) {
            setPreviewCacheEntry(tabId, dataUrl);
            queuePersistPreviewCache();
        }
    } catch {
        // Some pages (edge://, chrome://, store pages) cannot be captured.
    }
}

async function loadPreviewCacheFromStorage() {
    try {
        const result = await chrome.storage.local.get(PREVIEW_STORAGE_KEY);
        const stored = result?.[PREVIEW_STORAGE_KEY];
        if (!stored) {
            return;
        }

        if (Array.isArray(stored)) {
            for (const entry of stored) {
                if (!Array.isArray(entry) || entry.length !== 2) {
                    continue;
                }

                const [tabIdValue, previewDataUrl] = entry;
                const tabId = Number(tabIdValue);
                if (!Number.isInteger(tabId)) {
                    continue;
                }

                if (typeof previewDataUrl !== "string" || !previewDataUrl.startsWith("data:image/")) {
                    continue;
                }

                setPreviewCacheEntry(tabId, previewDataUrl);
            }

            return;
        }

        if (typeof stored !== "object") {
            return;
        }

        for (const [tabIdString, previewDataUrl] of Object.entries(stored)) {
            const tabId = Number(tabIdString);
            if (!Number.isInteger(tabId)) {
                continue;
            }

            if (typeof previewDataUrl !== "string" || !previewDataUrl.startsWith("data:image/")) {
                continue;
            }

            setPreviewCacheEntry(tabId, previewDataUrl);
        }

        queuePersistPreviewCache();
    } catch (error) {
        console.warn("Failed to load preview cache from local storage:", error);
    }
}

function queuePersistPreviewCache() {
    if (previewSaveTimer !== null) {
        clearTimeout(previewSaveTimer);
    }

    previewSaveTimer = setTimeout(() => {
        previewSaveTimer = null;
        persistPreviewCache().catch((error) => {
            console.warn("Failed to persist preview cache:", error);
        });
    }, PREVIEW_SAVE_DEBOUNCE_MS);
}

async function persistPreviewCache() {
    const serializedEntries = buildSerializedPreviewEntries();
    const trimmedEntries = trimEntriesToStorageBudget(serializedEntries, PREVIEW_STORAGE_MAX_BYTES);
    replacePreviewCacheFromSerializedEntries(trimmedEntries);

    await chrome.storage.local.set({
        [PREVIEW_STORAGE_KEY]: trimmedEntries,
    });
}

function setPreviewCacheEntry(tabId, previewDataUrl) {
    if (!Number.isInteger(tabId) || typeof previewDataUrl !== "string") {
        return;
    }

    if (tabPreviewCache.has(tabId)) {
        tabPreviewCache.delete(tabId);
    }

    tabPreviewCache.set(tabId, previewDataUrl);
}

function buildSerializedPreviewEntries() {
    return Array.from(tabPreviewCache.entries(), ([tabId, previewDataUrl]) => [
        String(tabId),
        previewDataUrl,
    ]);
}

function trimEntriesToStorageBudget(entries, maxBytes) {
    const normalizedEntries = Array.isArray(entries) ? [...entries] : [];
    while (
        normalizedEntries.length > 0 &&
        estimatePreviewStorageBytes(normalizedEntries) > maxBytes
    ) {
        normalizedEntries.shift();
    }

    return normalizedEntries;
}

function estimatePreviewStorageBytes(entries) {
    try {
        const payload = JSON.stringify({ [PREVIEW_STORAGE_KEY]: entries });
        return new TextEncoder().encode(payload).length;
    } catch {
        return Number.MAX_SAFE_INTEGER;
    }
}

function replacePreviewCacheFromSerializedEntries(entries) {
    tabPreviewCache.clear();
    for (const entry of entries) {
        if (!Array.isArray(entry) || entry.length !== 2) {
            continue;
        }

        const tabId = Number(entry[0]);
        const previewDataUrl = entry[1];
        if (!Number.isInteger(tabId) || typeof previewDataUrl !== "string") {
            continue;
        }

        tabPreviewCache.set(tabId, previewDataUrl);
    }
}

function getHostname(url) {
    if (!url) {
        return "New tab";
    }

    try {
        return new URL(url).hostname || "New tab";
    } catch {
        return "Chrome page";
    }
}
