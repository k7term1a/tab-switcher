const ROOT_ID = "__tab_switcher_overlay_root__";

let tabs = [];
let selectedTabId = null;
let visible = false;
let confirmOnAltRelease = false;
let root = null;
let grid = null;

chrome.runtime.onMessage.addListener((message) => {
    if (!message || typeof message.type !== "string") {
        return;
    }

    if (message.type === "render-switcher") {
        tabs = Array.isArray(message.tabs) ? message.tabs : [];
        selectedTabId = message.selectedTabId ?? null;
        confirmOnAltRelease = Boolean(message.confirmOnAltRelease);
        showOverlay();
        render();
        return;
    }

    if (message.type === "hide-switcher") {
        hideOverlay();
    }
});

window.addEventListener("keydown", (event) => {
    if (!visible) {
        return;
    }

    if (event.key === "Tab") {
        event.preventDefault();
        sendMessage({
            type: "cycle-selection",
            direction: event.shiftKey ? "previous" : "next",
        });
        return;
    }

    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
        event.preventDefault();
        sendMessage({ type: "cycle-selection", direction: "next" });
        return;
    }

    if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
        event.preventDefault();
        sendMessage({ type: "cycle-selection", direction: "previous" });
        return;
    }

    if (event.key === "Enter") {
        event.preventDefault();
        sendMessage({ type: "confirm-selection" });
        return;
    }

    if (event.key === "Escape") {
        event.preventDefault();
        sendMessage({ type: "cancel-switcher" });
    }
}, true);

window.addEventListener("keyup", (event) => {
    if (!visible) {
        return;
    }

    if (event.key === "Alt" && confirmOnAltRelease) {
        event.preventDefault();
        confirmOnAltRelease = false;
        sendMessage({ type: "confirm-selection" });
    }
}, true);

(async function bootstrap() {
    try {
        const state = await sendMessage({ type: "get-switcher-state" });
        tabs = Array.isArray(state?.tabs) ? state.tabs : [];
        selectedTabId = state?.selectedTabId ?? null;
        if (state?.isVisible) {
            confirmOnAltRelease = true;
            showOverlay();
            render();
        }
    } catch {
        // No-op: content script can load before service worker is awake.
    }
})();

function showOverlay() {
    ensureElements();
    if (!root) {
        return;
    }
    visible = true;
    root.classList.add("is-visible");
}

function hideOverlay() {
    visible = false;
    confirmOnAltRelease = false;
    if (root) {
        root.classList.remove("is-visible");
    }
}

function ensureElements() {
    if (root && grid) {
        return;
    }

    root = document.getElementById(ROOT_ID);
    if (!root) {
        root = document.createElement("div");
        root.id = ROOT_ID;
        root.innerHTML = "<section class=\"ts-grid\" aria-label=\"Open tabs\"></section>";
        document.documentElement.append(root);
    }

    grid = root.querySelector(".ts-grid");
}

function render() {
    if (!grid) {
        return;
    }

    grid.innerHTML = "";

    for (const tab of tabs) {
        const card = document.createElement("button");
        card.type = "button";
        card.className = "ts-card" + (tab.id === selectedTabId ? " is-selected" : "");
        card.addEventListener("mouseenter", () => {
            sendMessage({ type: "set-selection", tabId: tab.id });
        });
        card.addEventListener("click", () => {
            sendMessage({ type: "set-selection", tabId: tab.id });
            sendMessage({ type: "confirm-selection" });
        });

        const preview = document.createElement("img");
        preview.className = "ts-preview";
        preview.alt = tab.title || "Tab preview";
        preview.src = buildFallbackPreview(tab);

        const meta = document.createElement("div");
        meta.className = "ts-meta";

        const title = document.createElement("h2");
        title.className = "ts-title";
        title.textContent = tab.title || "Untitled tab";

        const host = document.createElement("div");
        host.className = "ts-host";

        const favicon = document.createElement("img");
        favicon.src = tab.favIconUrl || "chrome://favicon/" + (tab.url || "");
        favicon.alt = "";

        const hostText = document.createElement("span");
        hostText.textContent = tab.hostname || "New tab";

        host.append(favicon, hostText);

        const tags = document.createElement("div");
        tags.className = "ts-tags";
        if (tab.active) {
            tags.append(createTag("Current"));
        }
        if (tab.pinned) {
            tags.append(createTag("Pinned"));
        }
        if (tab.audible && !tab.muted) {
            tags.append(createTag("Playing Audio"));
        }
        if (tab.muted) {
            tags.append(createTag("Muted"));
        }

        meta.append(title, host, tags);
        card.append(preview, meta);
        grid.append(card);
    }
}

function createTag(text) {
    const tag = document.createElement("span");
    tag.className = "ts-tag";
    tag.textContent = text;
    return tag;
}

function buildFallbackPreview(tab) {
    const safeHost = (tab.hostname || "New tab").replace(/</g, "").slice(0, 24);
    const safeTitle = (tab.title || "Untitled tab").replace(/</g, "").slice(0, 48);

    const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="640" height="360">
      <defs>
        <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="#354f74"/>
          <stop offset="1" stop-color="#243248"/>
        </linearGradient>
      </defs>
      <rect width="640" height="360" fill="url(#bg)"/>
      <rect x="28" y="30" width="584" height="40" rx="10" fill="rgba(255,255,255,0.12)"/>
      <text x="44" y="56" fill="#dce7f6" font-size="20" font-family="Segoe UI, sans-serif">${escapeXml(
        safeHost
    )}</text>
      <text x="44" y="120" fill="#ffffff" font-size="30" font-family="Segoe UI, sans-serif">${escapeXml(
        safeTitle
    )}</text>
      <rect x="44" y="154" width="552" height="160" rx="12" fill="rgba(0,0,0,0.2)"/>
    </svg>
  `;

    return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
}

function escapeXml(value) {
    return value
        .replace(/&/g, "&amp;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&apos;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}

function sendMessage(message) {
    return chrome.runtime.sendMessage(message);
}
