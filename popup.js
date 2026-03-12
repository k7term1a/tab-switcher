const DEFAULT_PREVIEW_WIDTH = 400;
const PREVIEW_WIDTH_MIN = 280;
const PREVIEW_WIDTH_MAX = 640;
const PREVIEW_WIDTH_STEP = 20;
const STORAGE_KEY = "previewWidth";
const PREVIEW_CACHE_STORAGE_KEY = "tabPreviewCache";

const previewWidthInput = document.getElementById("previewWidth");
const previewWidthNumberInput = document.getElementById("previewWidthNumber");
const saveState = document.getElementById("saveState");
const cacheStats = document.getElementById("cacheStats");
const shortcutList = document.getElementById("shortcutList");
const openShortcutsButton = document.getElementById("openShortcuts");

initialize().catch((error) => {
    console.error("Failed to initialize popup:", error);
});

async function initialize() {
    const storedWidth = await loadPreviewWidth();
    setPreviewWidthControls(storedWidth);

    previewWidthInput.addEventListener("input", () => {
        const width = clampWidth(Number(previewWidthInput.value));
        setPreviewWidthControls(width);
    });

    previewWidthInput.addEventListener("change", async () => {
        const width = normalizeWidthForSave(Number(previewWidthInput.value));
        setPreviewWidthControls(width);
        await savePreviewWidth(width);
    });

    previewWidthNumberInput.addEventListener("input", () => {
        const rawText = previewWidthNumberInput.value.trim();
        if (!rawText) {
            return;
        }

        const raw = Number(rawText);
        if (Number.isNaN(raw)) {
            return;
        }

        const clamped = clampWidth(raw);
        previewWidthInput.value = String(clamped);
    });

    previewWidthNumberInput.addEventListener("change", async () => {
        const width = normalizeWidthForSave(Number(previewWidthNumberInput.value));
        setPreviewWidthControls(width);
        await savePreviewWidth(width);
    });

    openShortcutsButton.addEventListener("click", async () => {
        await chrome.tabs.create({ url: "chrome://extensions/shortcuts" });
    });

    chrome.storage.onChanged.addListener((changes, areaName) => {
        if (areaName !== "local" || !changes?.[PREVIEW_CACHE_STORAGE_KEY]) {
            return;
        }

        const newValue = changes[PREVIEW_CACHE_STORAGE_KEY].newValue;
        renderPreviewCacheStats(newValue);
    });

    await renderCommandShortcuts();
    await refreshPreviewCacheStats();
}

async function loadPreviewWidth() {
    const result = await chrome.storage.sync.get(STORAGE_KEY);
    return clampWidth(result?.[STORAGE_KEY]);
}

function clampWidth(width) {
    if (typeof width !== "number" || Number.isNaN(width)) {
        return DEFAULT_PREVIEW_WIDTH;
    }

    return Math.min(PREVIEW_WIDTH_MAX, Math.max(PREVIEW_WIDTH_MIN, width));
}

function setPreviewWidthControls(width) {
    previewWidthInput.value = String(width);
    previewWidthNumberInput.value = String(width);
}

function normalizeWidthForSave(width) {
    const clamped = clampWidth(width);
    const stepsFromMin = Math.round((clamped - PREVIEW_WIDTH_MIN) / PREVIEW_WIDTH_STEP);
    return PREVIEW_WIDTH_MIN + stepsFromMin * PREVIEW_WIDTH_STEP;
}

async function savePreviewWidth(width) {
    await chrome.storage.sync.set({ [STORAGE_KEY]: width });
    saveState.textContent = "已儲存";
    window.setTimeout(() => {
        if (saveState.textContent === "已儲存") {
            saveState.textContent = "";
        }
    }, 900);
}

async function renderCommandShortcuts() {
    const commands = await chrome.commands.getAll();
    const relevant = commands.filter(
        (command) =>
            command.name === "open-tab-switcher" ||
            command.name === "open-tab-switcher-reverse"
    );

    shortcutList.innerHTML = "";

    for (const command of relevant) {
        const item = document.createElement("li");
        const key = command.shortcut || "未設定";
        item.textContent = `${command.description}: ${key}`;
        shortcutList.append(item);
    }

    if (!relevant.length) {
        const item = document.createElement("li");
        item.textContent = "找不到快捷鍵設定";
        shortcutList.append(item);
    }
}

async function refreshPreviewCacheStats() {
    const result = await chrome.storage.local.get(PREVIEW_CACHE_STORAGE_KEY);
    renderPreviewCacheStats(result?.[PREVIEW_CACHE_STORAGE_KEY]);
}

function renderPreviewCacheStats(storedValue) {
    const entries = normalizePreviewCacheEntries(storedValue);
    const bytes = estimatePreviewCacheBytes(entries);
    cacheStats.textContent = `快取統計：${entries.length} 筆 / ${formatBytes(bytes)}`;
}

function normalizePreviewCacheEntries(storedValue) {
    if (!storedValue) {
        return [];
    }

    if (Array.isArray(storedValue)) {
        return storedValue.filter(
            (entry) =>
                Array.isArray(entry) &&
                entry.length === 2 &&
                typeof entry[0] === "string" &&
                typeof entry[1] === "string"
        );
    }

    if (typeof storedValue === "object") {
        return Object.entries(storedValue).filter(
            ([tabId, previewDataUrl]) =>
                typeof tabId === "string" && typeof previewDataUrl === "string"
        );
    }

    return [];
}

function estimatePreviewCacheBytes(entries) {
    try {
        const payload = JSON.stringify({ [PREVIEW_CACHE_STORAGE_KEY]: entries });
        return new TextEncoder().encode(payload).length;
    } catch {
        return 0;
    }
}

function formatBytes(bytes) {
    if (bytes < 1024) {
        return `${bytes} B`;
    }

    const kib = bytes / 1024;
    if (kib < 1024) {
        return `${kib.toFixed(1)} KiB`;
    }

    return `${(kib / 1024).toFixed(2)} MiB`;
}
