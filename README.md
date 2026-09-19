# PDF 工具

圖片 / PDF 合併、轉圖、拆分、頁面編輯。兩種用法，自己選：

## 🌐 線上版（免安裝，推薦）

直接開網址就能用，手機也行，檔案全程在你瀏覽器內處理、**不會上傳**：

👉 **https://dodosomething.github.io/pdf-tool/**

功能：
- **合併**：圖片＋PDF 合併成單一 PDF
- **PDF → 圖片**：轉 JPG/PNG（多張自動打包 zip）
- **拆分**：擷取指定頁碼為單一 PDF，或每頁拆成單檔（打包 zip）
- **頁面編輯**：對 PDF 逐頁旋轉、刪頁、拖曳重排 → 輸出新 PDF
- 清單縮圖預覽、拖曳排序
- **可裝成 App**：支援 PWA，手機／桌面可「加到主畫面」當獨立 App 開，含品牌 favicon 與主畫面圖示（藍底白色文件）

## 💻 桌面版（可離線）

想離線、大量處理 → 下載 [`desktop/`](desktop/) 資料夾。

- **Windows**：雙擊 `啟動.bat`
- **Mac**：雙擊 `啟動.command`

首次啟動會自動建環境、裝套件（約 1 分鐘），之後秒開。
需先安裝 [Python 3](https://www.python.org/downloads/)。詳見 [desktop/README.md](desktop/README.md)。

---

## 技術

- 線上版：純前端 JS（[pdf-lib](https://pdf-lib.js.org/) 合併/拆分/頁面編輯、[pdf.js](https://mozilla.github.io/pdf.js/) 轉圖與縮圖、JSZip 打包），零後端
- 圖示：`favicon.svg`（分頁圖示，內嵌 SVG）＋ `manifest.webmanifest` ＋ `icons/`（apple-touch-icon 180、icon-192/512），供 PWA 加到主畫面用
- 桌面版：Python + tkinter + Pillow + pdf2image + poppler + pypdf（拆分）

> 桌面版功能：合併、PDF↔圖片、拆分。縮圖與頁面編輯為線上版限定。
