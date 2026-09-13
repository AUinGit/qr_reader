// main.mjs

// jsQR は index.html の <script src="...jsQR.min.js"> で読み込まれている前提。
// ここではグローバル変数 jsQR を直接使う。

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

// 解析用オフスクリーンキャンバス（スケールごとに使い回す）
const offscreen = document.createElement("canvas");
const offctx = offscreen.getContext("2d", { willReadFrequently: true });

// このフレーム内で二重登録しないためのセット
let seenThisFrame = new Set();

// ========= ユーティリティ =========

function isUrlLike(text) {
  return /^https?:\/\/[^\s]+$/i.test(text.trim());
}

// 軽量グレースケール＋コントラスト強調（汎用用）
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
  textEl.textContent = codeText;

  item.appendChild(meta);
  item.appendChild(textEl);
  resultsContainer.appendChild(item);
}

// ========= マスクしながら複数検出（スケール付き） =========

/**
 * workImageData 上で、QRコードを見つけてはその領域を白塗りしつつ、
 * 最大 maxPerScale 個まで繰り返し検出する。
 * scale は「この workImageData が元画像の何倍／何分の1か」。
 * 戻り値: [{ data, location }, ...] location は元キャンバス座標系。
 */
function detectOnSingleScale(workImageData, scale, maxPerScale, fullWidth, fullHeight) {
  const results = [];
  const w = workImageData.width;
  const h = workImageData.height;

  // 作業コピー（ここで書き換えてマスクしていく）
  let work = new ImageData(
    new Uint8ClampedArray(workImageData.data),
    w,
    h
  );

  for (let i = 0; i < maxPerScale; i++) {
    let code = jsQR(work.data, w, h, {
      inversionAttempts: "attemptBoth",
    });

    if (!code) {
      const enhanced = enhanceSimple(
        new ImageData(
          new Uint8ClampedArray(work.data),
          w,
          h
        )
      );
      code = jsQR(enhanced.data, w, h, {
        inversionAttempts: "attemptBoth",
      });
    }

    if (!code || !code.data) break;

    const text = code.data;
    if (seenThisFrame.has(text)) {
      // このフレーム内でも既に扱ったコードなら、領域だけ塗って続行
      maskLocation(work, code.location, w, h);
      continue;
    }
    seenThisFrame.add(text);

    // スケールを元にフル解像度座標へ変換
    function mapPoint(p) {
      return {
        x: Math.min(fullWidth,  Math.max(0, p.x / scale)),
        y: Math.min(fullHeight, Math.max(0, p.y / scale)),
      };
    }

    const mappedLoc = {
      topLeftCorner:     mapPoint(code.location.topLeftCorner),
      topRightCorner:    mapPoint(code.location.topRightCorner),
      bottomRightCorner: mapPoint(code.location.bottomRightCorner),
      bottomLeftCorner:  mapPoint(code.location.bottomLeftCorner),
    };

    results.push({
      data: text,
      location: mappedLoc,
    });

    // 次のコードを探すために、今見つけた領域を白塗り
    maskLocation(work, code.location, w, h);
  }

  return results;
}

/**
 * jsQR の location 情報を元に、その周辺領域を workImageData 上で白塗りする。
 */
function maskLocation(workImageData, location, imgW, imgH) {
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

  let xMin = Math.max(0, Math.floor(Math.min(...xs) - 3));
  let xMax = Math.min(imgW, Math.ceil(Math.max(...xs) + 3));
  let yMin = Math.max(0, Math.floor(Math.min(...ys) - 3));
  let yMax = Math.min(imgH, Math.ceil(Math.max(...ys) + 3));

  const data = workImageData.data;

  for (let y = yMin; y < yMax; y++) {
    for (let x = xMin; x < xMax; x++) {
      const idx = (y * imgW + x) * 4;
      data[idx]     = 255; // R
      data[idx + 1] = 255; // G
      data[idx + 2] = 255; // B
      // alpha はそのまま
    }
  }
}

/**
 * 1フレームについて、複数スケールでマスク付き検出を行う。
 * 戻り値: [{ data, location }, ...] （location はフルキャンバス座標）
 */
function detectMultiScale(imageData, fullWidth, fullHeight) {
  const results = [];

  // 解析スケールの候補：元サイズ、0.75倍、0.5倍
  const scales = [1.0, 0.75, 0.5];
  const MAX_PER_SCALE = 4; // 1スケールあたりの上限

  for (const scale of scales) {
    const sw = Math.floor(fullWidth * scale);
    const sh = Math.floor(fullHeight * scale);

    if (sw < 40 || sh < 40) continue; // 小さすぎると意味がない

    offscreen.width = sw;
    offscreen.height = sh;
    offctx.imageSmoothingEnabled = false;
    offctx.drawImage(canvas, 0, 0, sw, sh);

    const scaledImageData = offctx.getImageData(0, 0, sw, sh);

    const found = detectOnSingleScale(
      scaledImageData,
      scale,
      MAX_PER_SCALE,
      fullWidth,
      fullHeight
    );

    if (found.length > 0) {
      results.push(...found);
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

    // このフレームで見つけたコードの重複制御用セットをリセット
    seenThisFrame = new Set();

    const codes = detectMultiScale(imageData, canvas.width, canvas.height);

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
    statusText.textContent =
      "カメラ起動中。複数QRを画面中央〜全体に映してみてください（大きめ推奨）。";
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
