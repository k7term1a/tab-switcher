const SESSION_TIMEOUT_MS = 2600;

let sourceWindowId = null;
let overlayHostTabId = null;
let selectedTabId = null;
let lastTriggerAt = 0;
let cachedTabs = [];

chrome.commands.onCommand.addListener((command) => {
    if (command === "open-tab-switcher") {
        startOrAdvanceSwitcher().catch((error) => {
            console.error("Failed to open switcher:", error);
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

    return false;
});

chrome.windows.onRemoved.addListener((windowId) => {
    if (windowId === sourceWindowId) {
        resetSession();
    }
});

chrome.tabs.onRemoved.addListener((tabId) => {
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

async function startOrAdvanceSwitcher() {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!activeTab || typeof activeTab.id !== "number" || typeof activeTab.windowId !== "number") {
        return;
    }

    const tabs = await chrome.tabs.query({ windowId: activeTab.windowId });
    if (tabs.length <= 1) {
        return;
    }

    const now = Date.now();
    const sameSession =
        sourceWindowId === activeTab.windowId &&
        now - lastTriggerAt < SESSION_TIMEOUT_MS &&
        selectedTabId !== null;

    const activeIndex = tabs.findIndex((tab) => tab.active);
    const selectedIndex = tabs.findIndex((tab) => tab.id === selectedTabId);

    let nextIndex = 0;
    if (sameSession && selectedIndex >= 0) {
        nextIndex = (selectedIndex + 1) % tabs.length;
    } else {
        nextIndex = (Math.max(activeIndex, 0) + 1) % tabs.length;
    }

    sourceWindowId = activeTab.windowId;
    overlayHostTabId = activeTab.id;
    selectedTabId = tabs[nextIndex].id ?? null;
    lastTriggerAt = now;

    cachedTabs = buildTabCards(tabs);
    await broadcastState();
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
            previewDataUrl: null,
        };
    });
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
