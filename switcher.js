const grid = document.getElementById("grid");

let tabs = [];
let selectedTabId = null;

chrome.runtime.onMessage.addListener((message) => {
    if (!message || message.type !== "render-switcher") {
        return;
    }

    tabs = Array.isArray(message.tabs) ? message.tabs : [];
    selectedTabId = message.selectedTabId ?? null;
    render();
});

window.addEventListener("keydown", (event) => {
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
});

window.addEventListener("blur", () => {
    // Keep behavior close to Alt+Tab: leaving switcher confirms current selection.
    sendMessage({ type: "confirm-selection" });
});

(async function bootstrap() {
    try {
        const state = await sendMessage({ type: "get-switcher-state" });
        tabs = Array.isArray(state?.tabs) ? state.tabs : [];
        selectedTabId = state?.selectedTabId ?? null;
        render();
    } catch (error) {
        console.error("Failed to get switcher state:", error);
    }
})();

function render() {
    if (!grid) {
        return;
    }

    grid.innerHTML = "";

    for (const tab of tabs) {
        const card = document.createElement("button");
        card.type = "button";
        card.className = "card" + (tab.id === selectedTabId ? " is-selected" : "");
        card.addEventListener("mouseenter", () => {
            sendMessage({ type: "set-selection", tabId: tab.id });
        });
        card.addEventListener("click", () => {
            sendMessage({ type: "set-selection", tabId: tab.id });
            sendMessage({ type: "confirm-selection" });
        });

        const preview = document.createElement("img");
        preview.className = "preview";
        preview.alt = tab.title || "Tab preview";
        preview.src = tab.previewDataUrl || buildFallbackPreview(tab);

        const meta = document.createElement("div");
        meta.className = "meta";

        const title = document.createElement("h2");
        title.className = "title";
        title.textContent = tab.title || "Untitled tab";

        const host = document.createElement("div");
        host.className = "host";

        const favicon = document.createElement("img");
        favicon.src = tab.favIconUrl || "chrome://favicon/" + (tab.url || "");
        favicon.alt = "";

        const hostText = document.createElement("span");
        hostText.textContent = tab.hostname || "New tab";

        host.append(favicon, hostText);

        const tags = document.createElement("div");
        tags.className = "tags";
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
    tag.className = "tag";
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
