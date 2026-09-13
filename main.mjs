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

/**
 * 1フレームの imageData から、マスクしながら最大 maxCount 個までコードを読む
 * 戻り値: [{ data, location }, ...]
 */
function detectMultipleCodes(imageData, maxCount = 8) {
  const { width, height } = imageData;
  const results = [];

  // 作業用コピー（元のimageDataはそのまま画面表示に使う）
  let work = new ImageData(
    new Uint8ClampedArray(imageData.data),
    width,
    height
  );

  for (let i = 0; i < maxCount; i++) {
    // 1. 生画像でトライ
    let code = jsQR(work.data, width, height, {
      inversionAttempts: "attemptBoth",
    });

    // 2. ダメなら軽く強調して再トライ
    if (!code) {
      const enhanced = enhanceSimple(
        new ImageData(
          new Uint8ClampedArray(work.data),
          width,
          height
        )
      );
      code = jsQR(enhanced.data, width, height, {
        inversionAttempts: "attemptBoth",
      });
    }

    if (!code) {
      break; // これ以上は見つからなさそう
    }

    if (!code.data || seenCodes.has(code.data)) {
      // 既知のコード or 空文字 → この領域だけ塗って続行
      maskCodeArea(work, code.location, width, height);
      continue;
    }

    // 新規コード
    results.push({
      data: code.data,
      location: code.location
    });

    // 次のループではこのコード領域を真っ白にして、他のコードを探す
    maskCodeArea(work, code.location, width, height);
  }

  return results;
}

/**
 * 検出されたQRコードの領域を、作業用イメージ work の上で白く塗りつぶす
 * （次の jsQR ではこのコードを無視させるため）
 */
function maskCodeArea(work, location, imgW, imgH) {
  // だいたいの外接矩形をとる
  const xs = [
    location.topLeftCorner.x,
    location.topRightCorner.x,
    location.bottomRightCorner.x,
    location.bottomLeftCorner.x
  ];
  const ys = [
    location.topLeftCorner.y,
    location.topRightCorner.y,
    location.bottomRightCorner.y,
    location.bottomLeftCorner.y
  ];

  let xMin = Math.max(0, Math.min(...xs) - 4);
  let xMax = Math.min(imgW, Math.max(...xs) + 4);
  let yMin = Math.max(0, Math.min(...ys) - 4);
  let yMax = Math.min(imgH, Math.max(...ys) + 4);

  const data = work.data;

  for (let y = yMin; y < yMax; y++) {
    for (let x = xMin; x < xMax; x++) {
      const idx = (y * imgW + x) * 4;
      data[idx] = 255;     // R
      data[idx + 1] = 255; // G
      data[idx + 2] = 255; // B
      // alpha はそのまま or 255
    }
  }
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

    // ★ このフレームでまとめて複数検出（上限はほどほどに）
    const codes = detectMultipleCodes(imageData, 8);

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
    statusText.textContent = "カメラ起動中。複数のQRコードを同時に映しても順番に読み取ります。";
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

// ========= イベント =========

startButton.addEventListener("click", startCamera);
stopButton.addEventListener("click", stopCamera);
