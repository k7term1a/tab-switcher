const SESSION_TIMEOUT_MS = 2600;

let sourceWindowId = null;
let overlayHostTabId = null;
let selectedTabId = null;
let lastTriggerAt = 0;
let cachedTabs = [];
const tabPreviewCache = new Map();

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
    const switchableTabs = tabs.filter(isTabSwitchable);
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

    return /^(https?|file):/i.test(url);
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
    const switchableTabs = tabsInWindow.filter(isTabSwitchable);

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

async function captureAndCachePreview(tabId, windowId) {
    if (typeof tabId !== "number" || typeof windowId !== "number") {
        return;
    }

    try {
        const dataUrl = await chrome.tabs.captureVisibleTab(windowId, {
            format: "jpeg",
            quality: 58,
        });

        if (dataUrl) {
            tabPreviewCache.set(tabId, dataUrl);
        }
    } catch {
        // Some pages (edge://, chrome://, store pages) cannot be captured.
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
