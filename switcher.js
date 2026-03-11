if (window.__TAB_SWITCHER_OVERLAY_LOADED__) {
    // The script can be injected multiple times; keep a single active instance.
} else {
    window.__TAB_SWITCHER_OVERLAY_LOADED__ = true;

    const ROOT_ID = "__tab_switcher_overlay_root__";

    let tabs = [];
    let selectedTabId = null;
    let visible = false;
    let confirmOnAltRelease = false;
    let root = null;
    let shadowRootRef = null;
    let overlay = null;
    let grid = null;
    let viewportListenersBound = false;

    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
        if (!message || typeof message.type !== "string") {
            return;
        }

        if (message.type === "ping-switcher") {
            sendResponse({ ok: true });
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

    window.addEventListener(
        "keydown",
        (event) => {
            if (!visible) {
                return;
            }

            const isReverseKey = event.code === "KeyW" || event.key.toLowerCase() === "w";
            const hasAltModifier = event.altKey || event.getModifierState?.("AltGraph");
            if (hasAltModifier && isReverseKey) {
                event.preventDefault();
                sendMessage({ type: "cycle-selection", direction: "previous" });
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
        },
        true
    );

    window.addEventListener(
        "keyup",
        (event) => {
            if (!visible) {
                return;
            }

            if (event.key === "Alt" && confirmOnAltRelease) {
                event.preventDefault();
                confirmOnAltRelease = false;
                sendMessage({ type: "confirm-selection" });
            }
        },
        true
    );

    window.addEventListener(
        "blur",
        () => {
            requestCancelAndHide();
        },
        true
    );

    document.addEventListener("visibilitychange", () => {
        if (document.hidden) {
            requestCancelAndHide();
        }
    });

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
        if (!root || !overlay) {
            return;
        }
        syncViewportSize();
        bindViewportListeners();
        visible = true;
        root.classList.add("is-visible");
        overlay.classList.add("is-visible");
    }

    function hideOverlay() {
        visible = false;
        confirmOnAltRelease = false;
        if (root) {
            root.classList.remove("is-visible");
        }
        if (overlay) {
            overlay.classList.remove("is-visible");
        }
    }

    function ensureElements() {
        if (root && shadowRootRef && overlay && grid) {
            return;
        }

        root = document.getElementById(ROOT_ID);
        if (!root) {
            root = document.createElement("div");
            root.id = ROOT_ID;
            (document.body || document.documentElement).append(root);
        }

        shadowRootRef = root.shadowRoot || root.attachShadow({ mode: "open" });
        if (!shadowRootRef.querySelector(".ts-overlay")) {
            const stylesheet = document.createElement("link");
            stylesheet.rel = "stylesheet";
            stylesheet.href = chrome.runtime.getURL("switcher.css");

            const shell = document.createElement("div");
            shell.className = "ts-overlay";
            shell.innerHTML = '<section class="ts-grid" aria-label="Open tabs"></section>';

            shadowRootRef.append(stylesheet, shell);
        }

        overlay = shadowRootRef.querySelector(".ts-overlay");
        grid = shadowRootRef.querySelector(".ts-grid");
    }

    function bindViewportListeners() {
        if (viewportListenersBound) {
            return;
        }

        viewportListenersBound = true;
        window.addEventListener("resize", syncViewportSize, { passive: true });
        window.visualViewport?.addEventListener("resize", syncViewportSize, { passive: true });
        window.visualViewport?.addEventListener("scroll", syncViewportSize, { passive: true });
    }

    function syncViewportSize() {
        if (!root) {
            return;
        }

        const vw = Math.max(1, Math.round(window.visualViewport?.width || window.innerWidth || 1));
        const vh = Math.max(1, Math.round(window.visualViewport?.height || window.innerHeight || 1));
        root.style.setProperty("--ts-overlay-width", `${vw}px`);
        root.style.setProperty("--ts-overlay-height", `${vh}px`);
    }

    function render() {
        if (!grid) {
            return;
        }

        grid.innerHTML = "";

        for (const tab of tabs) {
            const card = document.createElement("div");
            card.setAttribute("role", "button");
            card.tabIndex = 0;
            card.dataset.tabId = String(tab.id);
            card.className = "ts-card" + (tab.id === selectedTabId ? " is-selected" : "");
            card.addEventListener("mousedown", (event) => {
                if (event.button !== 0) {
                    return;
                }

                event.preventDefault();
                sendMessage({ type: "select-and-confirm", tabId: tab.id });
            });
            card.addEventListener("click", (event) => {
                event.preventDefault();
                sendMessage({ type: "select-and-confirm", tabId: tab.id });
            });

            const preview = document.createElement("img");
            preview.className = "ts-preview";
            preview.alt = tab.title || "Tab preview";
            preview.src = tab.previewDataUrl || buildFallbackPreview(tab);

            const closeBtn = document.createElement("button");
            closeBtn.type = "button";
            closeBtn.className = "ts-close-tab";
            closeBtn.setAttribute("aria-label", "Close tab");
            closeBtn.textContent = "\u00d7";
            closeBtn.addEventListener("mousedown", (event) => {
                event.preventDefault();
                event.stopPropagation();
            });
            closeBtn.addEventListener("click", (event) => {
                event.preventDefault();
                event.stopPropagation();
                sendMessage({ type: "close-tab", tabId: tab.id });
            });

            const meta = document.createElement("div");
            meta.className = "ts-meta";

            const title = document.createElement("h2");
            title.className = "ts-title";

            const titleIcon = document.createElement("img");
            titleIcon.className = "ts-title-icon";
            titleIcon.src = getSafeFavicon(tab);
            titleIcon.alt = "";

            const titleText = document.createElement("span");
            titleText.textContent = tab.title || "Untitled tab";

            title.append(titleIcon, titleText);

            const header = document.createElement("div");
            header.className = "ts-header";
            header.append(title, closeBtn);

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

            const previewWrap = document.createElement("div");
            previewWrap.className = "ts-preview-wrap";
            previewWrap.append(preview, tags);

            meta.append(header);
            card.append(meta, previewWrap);
            grid.append(card);
        }

        scrollSelectedCardIntoView();
    }

    function scrollSelectedCardIntoView() {
        if (!grid || selectedTabId === null) {
            return;
        }

        const selected = grid.querySelector(`.ts-card[data-tab-id="${selectedTabId}"]`);
        if (!selected) {
            return;
        }

        const gridRect = grid.getBoundingClientRect();
        const cardRect = selected.getBoundingClientRect();

        const overflowTop = cardRect.top < gridRect.top;
        const overflowBottom = cardRect.bottom > gridRect.bottom;
        const overflowLeft = cardRect.left < gridRect.left;
        const overflowRight = cardRect.right > gridRect.right;

        if (!overflowTop && !overflowBottom && !overflowLeft && !overflowRight) {
            return;
        }

        selected.scrollIntoView({
            block: "nearest",
            inline: "nearest",
            behavior: "smooth",
        });
    }

    function requestCancelAndHide() {
        if (!visible) {
            return;
        }

        hideOverlay();
        sendMessage({ type: "cancel-switcher" }).catch(() => {
            // Ignore failures when runtime is not available during focus transitions.
        });
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
          <stop offset="0" stop-color="#50535a"/>
          <stop offset="1" stop-color="#2c2f35"/>
        </linearGradient>
      </defs>
      <rect width="640" height="360" fill="url(#bg)"/>
      <rect x="28" y="30" width="584" height="40" rx="10" fill="rgba(255,255,255,0.12)"/>
      <text x="44" y="56" fill="#e7e9ed" font-size="20" font-family="Segoe UI, sans-serif">${escapeXml(
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

    function getSafeFavicon(tab) {
        if (tab.favIconUrl) {
            return tab.favIconUrl;
        }

        const url = tab.url || "";
        if (/^https?:/i.test(url)) {
            return "https://www.google.com/s2/favicons?domain_url=" + encodeURIComponent(url) + "&sz=32";
        }

        return buildFallbackFavicon();
    }

    function buildFallbackFavicon() {
        const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">
      <rect width="32" height="32" rx="7" fill="#4d525b"/>
      <circle cx="16" cy="16" r="7" fill="#d2d5db"/>
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
}
