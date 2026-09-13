// main.mjs

// jsQR は index.html の <script src="...jsQR.min.js"> で読み込まれていて、
// グローバル変数 jsQR として存在している前提。

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

// 「種」となるQRコード（位置情報付き）
const seedCodes = []; // { data, rect: {x,y,w,h} }
// 「次に調べるべき近傍矩形」のキュー
const neighborQueue = []; // { x, y, w, h }

let stream = null;
let running = false;
let tickHandle = null;

// ========= ユーティリティ =========

function isUrlLike(text) {
  return /^https?:\/\/[^\s]+$/i.test(text.trim());
}

function distance(p1, p2) {
  const dx = p1.x - p2.x;
  const dy = p1.y - p2.y;
  return Math.sqrt(dx * dx + dy * dy);
}

function clampRect(rect, maxW, maxH) {
  let { x, y, w, h } = rect;
  if (w <= 0 || h <= 0) return null;

  if (x < 0) {
    w += x;
    x = 0;
  }
  if (y < 0) {
    h += y;
    y = 0;
  }
  if (x + w > maxW) {
    w = maxW - x;
  }
  if (y + h > maxH) {
    h = maxH - y;
  }
  if (w <= 10 || h <= 10) return null;
  return { x, y, w, h };
}

function enhanceSimple(imageData) {
  const data = imageData.data;
  const contrast = 1.5;
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
  ctx.lineWidth = 3;
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

  const trimmed = codeText.trim();
  if (isUrlLike(trimmed)) {
    const a = document.createElement("a");
    a.href = trimmed;
    a.textContent = trimmed;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    textEl.appendChild(a);
  } else {
    textEl.textContent = codeText;
  }

  item.appendChild(meta);
  item.appendChild(textEl);
  resultsContainer.appendChild(item);
}

// ========= 検出ロジック =========

// フルフレームから「1個だけ」QRを探す
function findOneCodeOnFullFrame(imageData) {
  const { width, height, data } = imageData;

  let code = jsQR(data, width, height, { inversionAttempts: "attemptBoth" });
  if (code) return code;

  const enhanced = enhanceSimple(
    new ImageData(new Uint8ClampedArray(data), width, height)
  );
  code = jsQR(enhanced.data, width, height, { inversionAttempts: "attemptBoth" });
  return code || null;
}

// 任意の矩形 rect 内だけを対象に QR を探す
function findCodeInRect(imageData, rect) {
  const { x, y, w, h } = rect;
  const regionData = ctx.getImageData(x, y, w, h);

  let code = jsQR(regionData.data, w, h, { inversionAttempts: "attemptBoth" });
  if (!code) {
    const enhanced = enhanceSimple(
      new ImageData(new Uint8ClampedArray(regionData.data), w, h)
    );
    code = jsQR(enhanced.data, w, h, { inversionAttempts: "attemptBoth" });
  }
  if (!code) return null;

  const text = code.data;
  if (!text) return null;

  function mapPoint(p) {
    return { x: p.x + x, y: p.y + y };
  }

  return {
    data: text,
    location: {
      topLeftCorner: mapPoint(code.location.topLeftCorner),
      topRightCorner: mapPoint(code.location.topRightCorner),
      bottomRightCorner: mapPoint(code.location.bottomRightCorner),
      bottomLeftCorner: mapPoint(code.location.bottomLeftCorner),
    }
  };
}

// 新しく見つかったQRを「種」として登録し、近傍矩形をキューへ追加
function registerNewSeed(foundCode, canvasW, canvasH) {
  const loc = foundCode.location;

  const w = distance(loc.topLeftCorner, loc.topRightCorner);
  const h = distance(loc.topLeftCorner, loc.bottomLeftCorner);
  if (w <= 0 || h <= 0) return;

  const cx = (loc.topLeftCorner.x + loc.bottomRightCorner.x) / 2;
  const cy = (loc.topLeftCorner.y + loc.bottomRightCorner.y) / 2;

  const padX = w * 0.4;
  const padY = h * 0.4;

  const selfRect = clampRect(
    {
      x: cx - w / 2 - padX,
      y: cy - h / 2 - padY,
      w: w + padX * 2,
      h: h + padY * 2
    },
    canvasW,
    canvasH
  );
  if (selfRect) neighborQueue.push(selfRect);

  const leftRect = clampRect(
    {
      x: cx - (1.5 * w) - padX,
      y: cy - h / 2 - padY,
      w: w + padX * 2,
      h: h + padY * 2
    },
    canvasW,
    canvasH
  );
  if (leftRect) neighborQueue.push(leftRect);

  const rightRect = clampRect(
    {
      x: cx + 0.5 * w - padX,
      y: cy - h / 2 - padY,
      w: w + padX * 2,
      h: h + padY * 2
    },
    canvasW,
    canvasH
  );
  if (rightRect) neighborQueue.push(rightRect);

  const topRect = clampRect(
    {
      x: cx - w / 2 - padX,
      y: cy - (1.5 * h) - padY,
      w: w + padX * 2,
      h: h + padY * 2
    },
    canvasW,
    canvasH
  );
  if (topRect) neighborQueue.push(topRect);

  const bottomRect = clampRect(
    {
      x: cx - w / 2 - padX,
      y: cy + 0.5 * h - padY,
      w: w + padX * 2,
      h: h + padY * 2
    },
    canvasW,
    canvasH
  );
  if (bottomRect) neighborQueue.push(bottomRect);

  seedCodes.push({
    data: foundCode.data,
    rect: { x: cx - w / 2, y: cy - h / 2, w, h }
  });

  addResult(foundCode.data);
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

    let foundInThisFrame = null;

    if (seedCodes.length === 0) {
      const code = findOneCodeOnFullFrame(imageData);
      if (code && !seenCodes.has(code.data)) {
        const mapped = {
          data: code.data,
          location: code.location
        };
        registerNewSeed(mapped, canvas.width, canvas.height);
        foundInThisFrame = mapped;
      }
    } else {
      const MAX_RECTS_PER_FRAME = 2;
      for (let i = 0; i < MAX_RECTS_PER_FRAME; i++) {
        const rect = neighborQueue.shift();
        if (!rect) break;
        const code = findCodeInRect(imageData, rect);
        if (code && !seenCodes.has(code.data)) {
          registerNewSeed(code, canvas.width, canvas.height);
          foundInThisFrame = code;
          break;
        }
      }

      if (!foundInThisFrame && neighborQueue.length === 0) {
        const code = findOneCodeOnFullFrame(imageData);
        if (code && !seenCodes.has(code.data)) {
          const mapped = {
            data: code.data,
            location: code.location
          };
          registerNewSeed(mapped, canvas.width, canvas.height);
          foundInThisFrame = mapped;
        }
      }
    }

    if (foundInThisFrame) {
      const loc = foundInThisFrame.location;
      drawLine(loc.topLeftCorner, loc.topRightCorner, "#FF3B58");
      drawLine(loc.topRightCorner, loc.bottomRightCorner, "#FF3B58");
      drawLine(loc.bottomRightCorner, loc.bottomLeftCorner, "#FF3B58");
      drawLine(loc.bottomLeftCorner, loc.topLeftCorner, "#FF3B58");
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
    statusText.textContent = "カメラ起動中。複数のQRコードを順番に読み取ります。";
    canvas.hidden = false;

    seedCodes.length = 0;
    neighborQueue.length = 0;

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
