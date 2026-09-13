<script>
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

  // すでにリストに追加済みのQR文字列
  const seenCodes = new Set();
  let resultCount = 0;

  // 安定判定（簡易）：最後に読んだ候補と何フレーム連続か
  const STABLE_THRESHOLD = 3;
  let currentCandidate = null;
  let currentCandidateCount = 0;

  let stream = null;
  let running = false;
  let tickHandle = null;

  // 「次に探すべき領域」のインデックス（0〜3を循環）
  let nextRegionIndex = 0;

  function isUrlLike(text) {
    return /^https?:\/\/[^\s]+$/i.test(text.trim());
  }

  // 軽量グレースケール＋コントラスト
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
    ctx.lineWidth = 4;
    ctx.strokeStyle = color;
    ctx.stroke();
  }

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

      // リセット
      currentCandidate = null;
      currentCandidateCount = 0;
      nextRegionIndex = 0;

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

  /**
   * 画面を 2x2 の4領域に分け、指定された regionIndex の領域だけを解析する。
   * 見つかった場合だけそのコードを返し、なければ null を返す。
   */
  function findOneCodeInRegion(imageData, regionIndex) {
    const { width, height } = imageData;

    const halfW = Math.floor(width / 2);
    const halfH = Math.floor(height / 2);

    const regions = [
      { x: 0,      y: 0,       w: halfW,        h: halfH },          // 0: 左上
      { x: halfW,  y: 0,       w: width-halfW,  h: halfH },          // 1: 右上
      { x: 0,      y: halfH,   w: halfW,        h: height-halfH },   // 2: 左下
      { x: halfW,  y: halfH,   w: width-halfW,  h: height-halfH }    // 3: 右下
    ];

    const region = regions[regionIndex];
    const { x, y, w, h } = region;

    // 領域を切り出し
    const regionData = ctx.getImageData(x, y, w, h);

    // 生画像で試す
    let code = jsQR(regionData.data, w, h, { inversionAttempts: "attemptBoth" });

    // ダメなら軽く強調して再トライ
    if (!code) {
      const enhanced = enhanceSimple(
        new ImageData(
          new Uint8ClampedArray(regionData.data),
          w,
          h
        )
      );
      code = jsQR(enhanced.data, w, h, { inversionAttempts: "attemptBoth" });
    }

    if (!code) return null;

    // すでにリストにあるものなら「もう読んだ」とみなしてスキップ
    if (seenCodes.has(code.data)) {
      return null;
    }

    // 領域内座標 → 全体キャンバス座標に変換
    function mapPoint(p) {
      return { x: p.x + x, y: p.y + y };
    }

    const mappedLocation = {
      topLeftCorner: mapPoint(code.location.topLeftCorner),
      topRightCorner: mapPoint(code.location.topRightCorner),
      bottomRightCorner: mapPoint(code.location.bottomRightCorner),
      bottomLeftCorner: mapPoint(code.location.bottomLeftCorner),
    };

    return {
      data: code.data,
      location: mappedLocation
    };
  }

  function tick() {
    if (!running) return;

    if (video.readyState === video.HAVE_ENOUGH_DATA) {
      // カメラ解像度そのままにキャンバスを追従させる
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;

      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);

      // ★ 今回のフレームでは「nextRegionIndex の領域だけ」探索する
      const code = findOneCodeInRegion(imageData, nextRegionIndex);

      // 次のフレームでは次の領域を優先して見る（0→1→2→3→0…）
      nextRegionIndex = (nextRegionIndex + 1) % 4;

      if (code) {
        const loc = code.location;
        drawLine(loc.topLeftCorner, loc.topRightCorner, "#FF3B58");
        drawLine(loc.topRightCorner, loc.bottomRightCorner, "#FF3B58");
        drawLine(loc.bottomRightCorner, loc.bottomLeftCorner, "#FF3B58");
        drawLine(loc.bottomLeftCorner, loc.topLeftCorner, "#FF3B58");

        const text = code.data;

        // 安定判定（同じコードが連続で見えているか）
        if (text === currentCandidate) {
          currentCandidateCount++;
        } else {
          currentCandidate = text;
          currentCandidateCount = 1;
        }

        // 「ある程度フレーム連続で見えた」と判断できたら追加
        if (currentCandidateCount === STABLE_THRESHOLD) {
          addResult(text);
        }
      } else {
        // 今回のフレームでは新しいコードは見つからなかった
        currentCandidate = null;
        currentCandidateCount = 0;
      }
    }

    tickHandle = requestAnimationFrame(tick);
  }

  startButton.addEventListener("click", startCamera);
  stopButton.addEventListener("click", stopCamera);
</script>
