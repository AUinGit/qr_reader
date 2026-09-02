// qr-from-image.mjs

import fs from "fs";
import { Jimp } from "jimp";
import jsQR from "jsqr";

async function main() {
  const [, , imagePath] = process.argv;

  if (!imagePath) {
    console.error("使い方: node qr-from-image.mjs image.png");
    process.exit(1);
  }

  if (!fs.existsSync(imagePath)) {
    console.error(`ファイルが見つかりません: ${imagePath}`);
    process.exit(1);
  }

  try {
    const image = await Jimp.read(imagePath);

    const { data, width, height } = image.bitmap;

    // jsQR が期待する Uint8ClampedArray にそろえる
    const clampedData =
      data instanceof Uint8ClampedArray ? data : new Uint8ClampedArray(data);

    const qr = jsQR(clampedData, width, height);

    if (!qr) {
      console.log("QRコードが見つかりませんでした。");
      process.exit(0);
    }

    console.log("検出されたQRコードの内容:");
    console.log(qr.data);
  } catch (err) {
    console.error("画像の読み込みまたは解析に失敗しました:");
    console.error(err);
    process.exit(1);
  }
}

main();

