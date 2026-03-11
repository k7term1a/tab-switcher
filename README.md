# Tab Switcher Overlay (Chrome Extension)

這個 extension 會在快捷鍵觸發時，顯示一個類似 Windows `Alt+Tab` 的分頁切換視窗。

功能重點:

- 顯示目前視窗中的所有分頁
- 以方框高亮目前選取分頁
- 可用 `Tab / Shift+Tab / 方向鍵` 切換選取
- `Enter` 確認切換，`Esc` 取消
- 也可點擊卡片直接切換

## 如何載入

1. 開啟 `chrome://extensions`
2. 開啟右上角 `Developer mode`
3. 點 `Load unpacked`
4. 選擇本資料夾: `vibe-chreom-extension`

## 快捷鍵

預設快捷鍵是 `Alt+Q`。

你可以到 `chrome://extensions/shortcuts` 修改為自己習慣的組合鍵。

注意:

- `Ctrl+Tab` 在 Chrome 屬於瀏覽器保留快捷鍵，通常無法被 extension 攔截或覆寫。
- 如果你的環境無法設定 `Ctrl+Tab`，請使用其他組合，例如 `Alt+Q`、`Ctrl+Shift+.` 等。

## 檔案說明

- `manifest.json`: Extension 設定 (MV3)
- `background.js`: 快捷鍵觸發、切換狀態管理、視窗開關
- `switcher.html`: 切換視窗頁面
- `switcher.css`: UI 樣式
- `switcher.js`: 卡片渲染與鍵盤操作
# vibe-chrome-extension
