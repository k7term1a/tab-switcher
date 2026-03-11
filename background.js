const FINALIZE_DELAY_MS = 900;
const SESSION_TIMEOUT_MS = 1300;

let switcherWindowId = null;
let sourceWindowId = null;
let selectedTabId = null;
let finalizeTimer = null;
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
        resetFinalizeTimer();
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
    if (windowId === switcherWindowId) {
        resetSession();
    }
});

chrome.tabs.onRemoved.addListener((tabId) => {
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
    selectedTabId = tabs[nextIndex].id ?? null;
    lastTriggerAt = now;

    cachedTabs = await buildTabCards(tabs, activeTab.windowId);

    await ensureSwitcherWindow();
    await broadcastState();
    resetFinalizeTimer();
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
    resetFinalizeTimer();
    await broadcastState();
}

async function confirmSelection() {
    clearFinalizeTimer();

    if (selectedTabId === null || sourceWindowId === null) {
        await closeSwitcherWindow();
        resetSession();
        return;
    }

    try {
        await chrome.tabs.update(selectedTabId, { active: true });
        await chrome.windows.update(sourceWindowId, { focused: true });
    } catch (error) {
        console.warn("Failed to focus selected tab:", error);
    }

    await closeSwitcherWindow();
    resetSession();
}

async function cancelSwitcher() {
    clearFinalizeTimer();
    await closeSwitcherWindow();
    resetSession();
}

function resetFinalizeTimer() {
    clearFinalizeTimer();
    finalizeTimer = setTimeout(() => {
        confirmSelection().catch((error) => {
            console.error("Failed to finalize switcher selection:", error);
        });
    }, FINALIZE_DELAY_MS);
}

function clearFinalizeTimer() {
    if (finalizeTimer) {
        clearTimeout(finalizeTimer);
        finalizeTimer = null;
    }
}

async function ensureSwitcherWindow() {
    if (switcherWindowId !== null) {
        try {
            await chrome.windows.get(switcherWindowId);
            return;
        } catch {
            switcherWindowId = null;
        }
    }

    const sourceWindow = sourceWindowId !== null ? await chrome.windows.get(sourceWindowId) : null;
    const width = Math.min(980, Math.max(720, Math.floor((sourceWindow?.width ?? 1200) * 0.78)));
    const height = Math.min(680, Math.max(420, Math.floor((sourceWindow?.height ?? 800) * 0.72)));

    const left = typeof sourceWindow?.left === "number" && typeof sourceWindow?.width === "number"
        ? sourceWindow.left + Math.floor((sourceWindow.width - width) / 2)
        : undefined;
    const top = typeof sourceWindow?.top === "number" && typeof sourceWindow?.height === "number"
        ? sourceWindow.top + Math.floor((sourceWindow.height - height) / 2)
        : undefined;

    const createdWindow = await chrome.windows.create({
        url: chrome.runtime.getURL("switcher.html"),
        type: "popup",
        width,
        height,
        left,
        top,
        focused: true,
    });

    switcherWindowId = createdWindow.id ?? null;
}

async function closeSwitcherWindow() {
    if (switcherWindowId === null) {
        return;
    }

    try {
        await chrome.windows.remove(switcherWindowId);
    } catch {
        // Window may already be closed.
    }

    switcherWindowId = null;
}

async function broadcastState() {
    await chrome.runtime.sendMessage({
        type: "render-switcher",
        tabs: cachedTabs,
        selectedTabId,
        sourceWindowId,
    });
}

function resetSession() {
    clearFinalizeTimer();
    switcherWindowId = null;
    sourceWindowId = null;
    selectedTabId = null;
    lastTriggerAt = 0;
    cachedTabs = [];
}

async function buildTabCards(tabs, windowId) {
    let previewDataUrl = null;

    try {
        previewDataUrl = await chrome.tabs.captureVisibleTab(windowId, {
            format: "jpeg",
            quality: 70,
        });
    } catch (error) {
        console.warn("Failed to capture tab preview:", error);
    }

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
            previewDataUrl: tab.active ? previewDataUrl : null,
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
