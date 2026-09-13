// main.mjs

// jsQR は index.html の <script src="...jsQR.min.js"> で読み込まれている前提

const video = document.createElement("video");
const canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d", { willReadFrequently: true });

const statusText = document.getElementById("statusText");
const overlayText = document.getElementById("overlayText");
const outputContainer = document.getElementById("output");
const resultsContainer = document.getElementById("resultsContainer");
const countTag = document.getElementById("countTag");
const startButton = document.getElementById("startButton");
const stopButton = document.getElementById("stopButton");

// すでにリストに追加したQR文字列
const seenCodes = new Set();
let resultCount = 0;

let stream = null;
let running = false;
let tickHandle = null;

// ========= ユーティリティ =========

function isUrlLike(text) {
  return /^https?:\/\/[^\s]+$/i.test(text.trim());
}

// 軽量グレースケール＋コントラスト強調（小さいQR向け）
function enhanceSimple(imageData) {
  const data = imageData.data;
  const contrast = 1.4;
  const mid = 128;

  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];

    let v = 0.299 * r + 0.587 * g + 0.114 * b;
    v = (v - mid) * contrast + mid;
    if (v < 0) v = 0;
    if (v > 255) v = 255;

    data[i] = data[i + 1] = data[i + 2] = v;
  }
  return imageData;
}

function drawLine(begin, end, color) {
  ctx.beginPath();
  ctx.moveTo(begin.x, begin.y);
  ctx.lineTo(end.x, end.y);
  ctx.lineWidth = 2;
  ctx.strokeStyle = color;
  ctx.stroke();
}

// ========= 結果UI =========

function addResult(codeText) {
  if (seenCodes.has(codeText)) return;

  seenCodes.add(codeText);
  resultCount++;
  countTag.textContent = resultCount + "件";
  outputContainer.hidden = false;

  const item = document.createElement("div");
  item.className = "result-item";

  const meta = document.createElement("div");
  meta.className = "result-meta";

  const idx = document.createElement("span");
  idx.className = "result-index";
  idx.textContent = "#" + resultCount;

  const type = document.createElement("span");
  type.className = "result-type";
  type.textContent = isUrlLike(codeText) ? "URL" : "テキスト";

  meta.appendChild(idx);
  meta.appendChild(type);

  const textEl = document.createElement("div");
  textEl.className = "result-text";
  textEl.textContent = codeText;

  item.appendChild(meta);
  item.appendChild(textEl);
  resultsContainer.appendChild(item);
}

// ========= 6×6 固定グリッド検出 =========

/**
 * 1フレームを 6×6 に固定分割し、それぞれのセルについて
 * jsQR をかけて読めたQRを返す。
 *
 * 戻り値: [{ data, location }, ...]
 */
function detectGridCodes(imageData) {
  const { width, height } = imageData;

  const COLS = 6;
  const ROWS = 6;

  const cellW = width / COLS;
  const cellH = height / ROWS;

  const results = [];
  const alreadySeenThisFrame = new Set();

  // セルごとに左上→右下へ順番に試す
  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLS; col++) {
      const x0 = Math.floor(col * cellW);
      const y0 = Math.floor(row * cellH);
      const x1 = Math.floor((col + 1) * cellW);
      const y1 = Math.floor((row + 1) * cellH);

      // 少し内側を切り出す（セル境界付近のノイズを避ける）
      const marginX = Math.floor((x1 - x0) * 0.1);
      const marginY = Math.floor((y1 - y0) * 0.1);

      const x = x0 + marginX;
      const y = y0 + marginY;
      const w = Math.max(8, (x1 - x0) - marginX * 2);
      const h = Math.max(8, (y1 - y0) - marginY * 2);

      if (w <= 0 || h <= 0) continue;

      const regionData = ctx.getImageData(x, y, w, h);

      // 1回目：生画像
      let code = jsQR(regionData.data, w, h, {
        inversionAttempts: "attemptBoth",
      });

      // 2回目：軽く強調
      if (!code) {
        const enhanced = enhanceSimple(
          new ImageData(
            new Uint8ClampedArray(regionData.data),
            w,
            h
          )
        );
        code = jsQR(enhanced.data, w, h, {
          inversionAttempts: "attemptBoth",
        });
      }

      if (!code || !code.data) continue;

      const text = code.data;

      // このフレーム内で重複していたらスキップ
      if (alreadySeenThisFrame.has(text)) continue;
      alreadySeenThisFrame.add(text);

      // 領域内座標 → フルキャンバス座標に変換
      function mapPoint(p) {
        return { x: p.x + x, y: p.y + y };
      }

      results.push({
        data: text,
        location: {
          topLeftCorner: mapPoint(code.location.topLeftCorner),
          topRightCorner: mapPoint(code.location.topRightCorner),
          bottomRightCorner: mapPoint(code.location.bottomRightCorner),
          bottomLeftCorner: mapPoint(code.location.bottomLeftCorner),
        },
        cell: { row, col }
      });
    }
  }

  return results;
}

// ========= メインループ =========

function tick() {
  if (!running) return;

  if (video.readyState === video.HAVE_ENOUGH_DATA) {
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;

    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);

    // ★ このフレームで 6×6 グリッド全セルを走査
    const codes = detectGridCodes(imageData);

    for (const c of codes) {
      const loc = c.location;

      drawLine(loc.topLeftCorner, loc.topRightCorner, "#FF3B58");
      drawLine(loc.topRightCorner, loc.bottomRightCorner, "#FF3B58");
      drawLine(loc.bottomRightCorner, loc.bottomLeftCorner, "#FF3B58");
      drawLine(loc.bottomLeftCorner, loc.topLeftCorner, "#FF3B58");

      addResult(c.data);
    }
  }

  tickHandle = requestAnimationFrame(tick);
}

// ========= カメラ開始・停止 =========

async function startCamera() {
  if (running) return;
  try {
    statusText.textContent = "カメラを起動中です...";
    overlayText.textContent = "起動中...";

    stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: "environment",
        frameRate: { ideal: 30, max: 60 }
      }
    });

    video.srcObject = stream;
    video.setAttribute("playsinline", true);
    await video.play();

    running = true;
    startButton.disabled = true;
    stopButton.disabled = false;

    overlayText.classList.add("hidden");
    statusText.textContent = "カメラ起動中。6×6のQR表を画面いっぱいになるくらいに映してください。";
    canvas.hidden = false;

    tickHandle = requestAnimationFrame(tick);
  } catch (err) {
    statusText.textContent = "カメラにアクセスできません: " + err.message;
    overlayText.textContent = "エラー";
  }
}

function stopCamera() {
  if (!running) return;

  running = false;

  if (tickHandle !== null) {
    cancelAnimationFrame(tickHandle);
    tickHandle = null;
  }

  if (stream) {
    stream.getTracks().forEach(track => track.stop());
    stream = null;
  }

  video.srcObject = null;

  canvas.hidden = true;
  overlayText.classList.remove("hidden");
  overlayText.textContent = "カメラオフ";
  statusText.textContent = "カメラは停止中です。「カメラ開始」をタップしてください。";

  startButton.disabled = false;
  stopButton.disabled = true;
}

startButton.addEventListener("click", startCamera);
stopButton.addEventListener("click", stopCamera);
