import React, { useEffect, useMemo, useRef, useState } from "react";

/**
 * Bitmap‑Style Dithering Web App (single‑file React)
 * -------------------------------------------------
 * Features
 * - Upload PNG/JPG/WebP and process fully in‑browser (no server)
 * - Pixel size (mosaic) control
 * - Dithering: None, Floyd–Steinberg, Ordered (Bayer 8x8), Threshold (binary)
 * - Palettes: Presets, Custom hex list, or Extract (K‑means) from the image
 * - Live preview on canvas
 * - Export PNG/JPG (via <canvas>), or SVG (vector rectangles per pixel)
 *
 * Notes
 * - Kept dependency‑free to run anywhere
 * - Performance is decent up to ~4–8MP images; for huge assets, increase pixel size or downscale first
 */

// ---------- Utility helpers ----------
const clamp = (v, lo = 0, hi = 255) => (v < lo ? lo : v > hi ? hi : v);
const toHex = (n) => n.toString(16).padStart(2, "0");
const rgbToHex = (r, g, b) => `#${toHex(r)}${toHex(g)}${toHex(b)}`;
const hexToRgb = (hex) => {
  const h = hex.replace(/[^0-9a-f]/gi, "");
  const m = h.length === 3
    ? h.split("").map((c) => parseInt(c + c, 16))
    : [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  return { r: m[0] ?? 0, g: m[1] ?? 0, b: m[2] ?? 0 };
};
const srgbToLuma = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

const parseHexList = (text) =>
  text
    .split(/[\s,]+/)
    .map((t) => t.trim())
    .filter(Boolean)
    .map((h) => (h.startsWith("#") ? h : `#${h}`))
    .map((h) => hexToRgb(h));

// Squared distance in RGB
const dist2 = (a, b) => {
  const dr = a.r - b.r;
  const dg = a.g - b.g;
  const db = a.b - b.b;
  return dr * dr + dg * dg + db * db;
};

// Find nearest color in palette
const nearestColor = (c, palette) => {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < palette.length; i++) {
    const d = dist2(c, palette[i]);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return palette[best];
};

// Ordered dithering Bayer 8x8 (values 0..63)
const BAYER8 = [
  [0, 48, 12, 60, 3, 51, 15, 63],
  [32, 16, 44, 28, 35, 19, 47, 31],
  [8, 56, 4, 52, 11, 59, 7, 55],
  [40, 24, 36, 20, 43, 27, 39, 23],
  [2, 50, 14, 62, 1, 49, 13, 61],
  [34, 18, 46, 30, 33, 17, 45, 29],
  [10, 58, 6, 54, 9, 57, 5, 53],
  [42, 26, 38, 22, 41, 25, 37, 21],
];

// K‑means palette extraction (simple, deterministic-ish)
function kmeansPalette(imageData, w, h, k = 8, sampleStep = 4, maxIter = 12) {
  const data = imageData;
  const points = [];
  for (let y = 0; y < h; y += sampleStep) {
    for (let x = 0; x < w; x += sampleStep) {
      const i = (y * w + x) * 4;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      points.push({ r, g, b });
    }
  }
  if (points.length === 0) return [];
  // Init centers by random picks (but seeded by grid order)
  const centers = [];
  const step = Math.max(1, Math.floor(points.length / k));
  for (let i = 0; i < k; i++) centers.push({ ...points[i * step] });

  const counts = new Array(k).fill(0);
  const sums = new Array(k).fill(0).map(() => ({ r: 0, g: 0, b: 0 }));

  for (let iter = 0; iter < maxIter; iter++) {
    counts.fill(0);
    for (let j = 0; j < k; j++) sums[j].r = sums[j].g = sums[j].b = 0;

    // Assign
    for (let p = 0; p < points.length; p++) {
      let best = 0;
      let bestD = Infinity;
      for (let c = 0; c < k; c++) {
        const d = dist2(points[p], centers[c]);
        if (d < bestD) {
          bestD = d;
          best = c;
        }
      }
      counts[best]++;
      sums[best].r += points[p].r;
      sums[best].g += points[p].g;
      sums[best].b += points[p].b;
    }

    // Update
    for (let c = 0; c < k; c++) {
      if (counts[c] > 0) {
        centers[c] = {
          r: Math.round(sums[c].r / counts[c]),
          g: Math.round(sums[c].g / counts[c]),
          b: Math.round(sums[c].b / counts[c]),
        };
      }
    }
  }
  // Sort by luma (dark→light)
  centers.sort((a, b) => srgbToLuma(a.r, a.g, a.b) - srgbToLuma(b.r, b.g, b.b));
  return centers;
}

// ---------- Preset palettes ----------
const PRESETS = {
  Monochrome: ["#000000", "#ffffff"].map(hexToRgb),
  "Game Boy (4)": ["#0f380f", "#306230", "#8bac0f", "#9bbc0f"].map(hexToRgb),
  "PICO‑8 (16)": (
    "#000000 #1D2B53 #7E2553 #008751 #AB5236 #5F574F #C2C3C7 #FFF1E8 #FF004D #FFA300 #FFEC27 #00E436 #29ADFF #83769C #FF77A8 #FFCCAA"
      .split(" ")
      .map(hexToRgb)
  ),
  "C64 (16)": (
    "#000000 #FFFFFF #68372B #70A4B2 #6F3D86 #588D43 #352879 #B8C76F #6F4F25 #433900 #9A6759 #444444 #6C6C6C #9AD284 #6C5EB5 #959595"
      .split(" ")
      .map(hexToRgb)
  ),
  "Web 8": ("#000 #555 #AAA #FFF #00A #0A0 #A00 #FA0".split(" ").map(hexToRgb)),
};

// ---------- Core processing ----------
function processBitmap({
  srcData,
  w,
  h,
  pixelSize,
  palette,
  method, // none | fs | ordered | threshold
  ditherStrength, // 0..1 for ordered
  threshold, // 0..255 for threshold method
}) {
  // Step 1: shrink to grid (mosaic) if pixelSize > 1
  const gw = Math.max(1, Math.floor(w / pixelSize));
  const gh = Math.max(1, Math.floor(h / pixelSize));

  const tmp = new OffscreenCanvas(gw, gh);
  const tctx = tmp.getContext("2d", { willReadFrequently: true });
  // Use area averaging by drawing with smoothing on
  tctx.imageSmoothingEnabled = true;
  const src = new ImageData(new Uint8ClampedArray(srcData), w, h);
  tctx.drawImage(imageDataToCanvas(src), 0, 0, w, h, 0, 0, gw, gh);
  const gData = tctx.getImageData(0, 0, gw, gh).data; // Uint8ClampedArray

  // Prepare output small grid (quantized colors)
  const out = new Uint8ClampedArray(gw * gh * 4);

  if (method === "fs") {
    // Floyd–Steinberg error diffusion in RGB to nearest palette
    // We'll keep an error buffer per channel for current and next row
    const errCurrR = new Float32Array(gw + 2);
    const errCurrG = new Float32Array(gw + 2);
    const errCurrB = new Float32Array(gw + 2);
    const errNextR = new Float32Array(gw + 2);
    const errNextG = new Float32Array(gw + 2);
    const errNextB = new Float32Array(gw + 2);

    for (let y = 0; y < gh; y++) {
      errNextR.fill(0); errNextG.fill(0); errNextB.fill(0);
      for (let x = 0; x < gw; x++) {
        const i = (y * gw + x) * 4;
        let r = gData[i] + errCurrR[x];
        let g = gData[i + 1] + errCurrG[x];
        let b = gData[i + 2] + errCurrB[x];
        r = clamp(r); g = clamp(g); b = clamp(b);
        const q = nearestColor({ r, g, b }, palette);
        out[i] = q.r; out[i + 1] = q.g; out[i + 2] = q.b; out[i + 3] = 255;
        const er = r - q.r, eg = g - q.g, eb = b - q.b;
        // Distribute error
        // x+1,y (7/16)
        errCurrR[x + 1] += er * 7 / 16; errCurrG[x + 1] += eg * 7 / 16; errCurrB[x + 1] += eb * 7 / 16;
        // x-1,y+1 (3/16)
        errNextR[x - 1] += er * 3 / 16; errNextG[x - 1] += eg * 3 / 16; errNextB[x - 1] += eb * 3 / 16;
        // x,y+1 (5/16)
        errNextR[x] += er * 5 / 16; errNextG[x] += eg * 5 / 16; errNextB[x] += eb * 5 / 16;
        // x+1,y+1 (1/16)
        errNextR[x + 1] += er * 1 / 16; errNextG[x + 1] += eg * 1 / 16; errNextB[x + 1] += eb * 1 / 16;
      }
      // advance rows
      errCurrR.set(errNextR);
      errCurrG.set(errNextG);
      errCurrB.set(errNextB);
    }
  } else if (method === "ordered") {
    const scale = ditherStrength; // 0..1
    for (let y = 0; y < gh; y++) {
      for (let x = 0; x < gw; x++) {
        const i = (y * gw + x) * 4;
        let r = gData[i];
        let g = gData[i + 1];
        let b = gData[i + 2];
        // Bias RGB by Bayer threshold around -0.5..+0.5 scaled ~32
        const t = (BAYER8[y & 7][x & 7] - 32) / 64; // ~ -0.5..+0.5
        r = clamp(r + t * 64 * scale);
        g = clamp(g + t * 64 * scale);
        b = clamp(b + t * 64 * scale);
        const q = nearestColor({ r, g, b }, palette);
        out[i] = q.r; out[i + 1] = q.g; out[i + 2] = q.b; out[i + 3] = 255;
      }
    }
  } else if (method === "threshold") {
    // Binary threshold to a 2‑color palette; if user picked >2 colors, use two extremes by luma
    let p = palette;
    if (palette.length < 2) p = [{ r: 0, g: 0, b: 0 }, { r: 255, g: 255, b: 255 }];
    if (p.length > 2) {
      // choose darkest & lightest
      const sorted = [...p].sort((a, b) => srgbToLuma(a.r, a.g, a.b) - srgbToLuma(b.r, b.g, b.b));
      p = [sorted[0], sorted[sorted.length - 1]];
    }
    for (let y = 0; y < gh; y++) {
      for (let x = 0; x < gw; x++) {
        const i = (y * gw + x) * 4;
        const r = gData[i], g = gData[i + 1], b = gData[i + 2];
        const lum = srgbToLuma(r, g, b);
        const q = lum < threshold ? p[0] : p[1];
        out[i] = q.r; out[i + 1] = q.g; out[i + 2] = q.b; out[i + 3] = 255;
      }
    }
  } else {
    // no dithering — straight nearest palette
    for (let y = 0; y < gh; y++) {
      for (let x = 0; x < gw; x++) {
        const i = (y * gw + x) * 4;
        const r = gData[i], g = gData[i + 1], b = gData[i + 2];
        const q = nearestColor({ r, g, b }, palette);
        out[i] = q.r; out[i + 1] = q.g; out[i + 2] = q.b; out[i + 3] = 255;
      }
    }
  }

  // Upscale back to canvas pixels by drawing each grid cell as a filled rect
  const outCanvas = new OffscreenCanvas(w, h);
  const octx = outCanvas.getContext("2d");
  const imgData = new ImageData(w, h);
  // We'll paint by rectangles for crisper edges (no smoothing),
  // but export PNG/JPG via a rasterized draw to keep speed reasonable.
  // To show on screen we can just putImageData of a scaled image.
  // Build a coarse pixel map then draw it scaled.
  // Instead of per‑rect draw (slow), we scale image data: create small ImageData then drawImage with smoothing off.
  const small = new ImageData(out, gw, gh);
  octx.imageSmoothingEnabled = false;
  octx.clearRect(0, 0, w, h);
  octx.drawImage(imageDataToCanvas(small), 0, 0, gw, gh, 0, 0, w, h);
  return { outSmall: small, gw, gh, outCanvas };
}

function imageDataToCanvas(imageData) {
  const c = new OffscreenCanvas(imageData.width, imageData.height);
  const ctx = c.getContext("2d");
  ctx.putImageData(imageData, 0, 0);
  return c;
}

// ---------- Main Component ----------
export default function App() {
  const [fileName, setFileName] = useState("");
  const [imgEl, setImgEl] = useState(null);
  const [imgSize, setImgSize] = useState({ w: 0, h: 0 });

  // Controls
  const [pixelSize, setPixelSize] = useState(24);
  const [method, setMethod] = useState("fs"); // none | fs | ordered | threshold
  const [ditherStrength, setDitherStrength] = useState(0.7);
  const [threshold, setThreshold] = useState(128);

  const [paletteMode, setPaletteMode] = useState("preset"); // preset | custom | extract
  const [preset, setPreset] = useState("PICO‑8 (16)");
  const [customText, setCustomText] = useState("#000,#fff");
  const [kColors, setKColors] = useState(8);

  const [bg, setBg] = useState("checkers"); // checkers | dark | light
  const [exportScale, setExportScale] = useState(1);
  const [exportJpgQ, setExportJpgQ] = useState(0.92);

  const srcCanvasRef = useRef(null); // stores original image at natural size
  const outCanvasRef = useRef(null); // display result
  const containerRef = useRef(null);

  const palette = useMemo(() => {
    if (paletteMode === "preset") return PRESETS[preset] || PRESETS.Monochrome;
    if (paletteMode === "custom") {
      const arr = parseHexList(customText);
      return arr.length ? arr : PRESETS.Monochrome;
    }
    // extract: need current image
    if (!srcCanvasRef.current) return PRESETS.Monochrome;
    const ctx = srcCanvasRef.current.getContext("2d", { willReadFrequently: true });
    const { w, h } = { w: srcCanvasRef.current.width, h: srcCanvasRef.current.height };
    const data = ctx.getImageData(0, 0, w, h).data;
    return kmeansPalette(data, w, h, clamp(kColors, 2, 32));
  }, [paletteMode, preset, customText, kColors, imgEl]);

  // Load image into src canvas
  const onFile = async (file) => {
    if (!file) return;
    setFileName(file.name);
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      setImgEl(img);
      setImgSize({ w: img.naturalWidth, h: img.naturalHeight });
      const c = srcCanvasRef.current;
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      const ctx = c.getContext("2d");
      ctx.clearRect(0, 0, c.width, c.height);
      ctx.drawImage(img, 0, 0);
      URL.revokeObjectURL(url);
      // After load, trigger processing
      requestAnimationFrame(processNow);
    };
    img.onerror = () => URL.revokeObjectURL(url);
    img.src = url;
  };

  const onDrop = (e) => {
    e.preventDefault();
    const f = e.dataTransfer.files?.[0];
    onFile(f);
  };

  const processNow = () => {
    if (!srcCanvasRef.current || !outCanvasRef.current) return;
    const sc = srcCanvasRef.current;
    const w = sc.width, h = sc.height;
    const sctx = sc.getContext("2d", { willReadFrequently: true });
    const src = sctx.getImageData(0, 0, w, h).data;

    const { outSmall, gw, gh } = processBitmap({
      srcData: src,
      w, h,
      pixelSize: Math.max(1, pixelSize|0),
      palette,
      method,
      ditherStrength,
      threshold,
    });

    const oc = outCanvasRef.current;
    oc.width = w; oc.height = h;
    const octx = oc.getContext("2d");
    octx.imageSmoothingEnabled = false;
    octx.clearRect(0, 0, w, h);
    // Scale small to full
    octx.drawImage(imageDataToCanvas(outSmall), 0, 0, gw, gh, 0, 0, w, h);
  };

  // reprocess when controls change
  useEffect(() => { processNow(); }, [pixelSize, method, ditherStrength, threshold, palette]);

  // Handle window resize to keep preview nicely fitted (CSS handles most)
  useEffect(() => {
    const onWindow = () => requestAnimationFrame(() => processNow());
    window.addEventListener("resize", onWindow);
    return () => window.removeEventListener("resize", onWindow);
  }, []);

  // Exporters
  const downloadPNG = async () => {
    if (!outCanvasRef.current) return;
    const c = outCanvasRef.current;
    // Scale for export
    const ex = await rasterizeAtScale(c, exportScale);
    ex.toBlob((blob) => triggerDownload(blob, fileName.replace(/\.[^.]+$/, "") + `_pixel_${pixelSize}.png`));
  };
  const downloadJPG = async () => {
    if (!outCanvasRef.current) return;
    const c = outCanvasRef.current;
    const ex = await rasterizeAtScale(c, exportScale);
    const link = document.createElement("a");
    link.download = fileName.replace(/\.[^.]+$/, "") + `_pixel_${pixelSize}.jpg`;
    link.href = ex.toDataURL("image/jpeg", exportJpgQ);
    link.click();
  };
  const downloadSVG = () => {
    if (!srcCanvasRef.current) return;
    // Rebuild the small grid to generate vector rectangles (same pipeline)
    const sc = srcCanvasRef.current;
    const w = sc.width, h = sc.height;
    const sctx = sc.getContext("2d", { willReadFrequently: true });
    const src = sctx.getImageData(0, 0, w, h).data;
    const { outSmall, gw, gh } = processBitmap({
      srcData: src,
      w, h,
      pixelSize: Math.max(1, pixelSize|0),
      palette,
      method,
      ditherStrength,
      threshold,
    });
    const svg = smallImageDataToSVG(outSmall, gw, gh, pixelSize * exportScale);
    const blob = new Blob([svg], { type: "image/svg+xml" });
    triggerDownload(blob, fileName.replace(/\.[^.]+$/, "") + `_pixel_${pixelSize}.svg`);
  };

  return (
    <div className="min-h-screen bg-neutral-900 text-neutral-100">
      <header className="border-b border-neutral-800 sticky top-0 z-10 bg-neutral-900/80 backdrop-blur">
        <div className="max-w-7xl mx-auto px-4 py-3 flex items-center justify-between">
          <h1 className="text-xl sm:text-2xl font-bold tracking-tight">OpenPixel Dither <span className="opacity-60 text-sm align-top">(BDFM‑style)</span></h1>
          <div className="text-xs sm:text-sm opacity-70">All processing happens in your browser.</div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 py-6 grid grid-cols-1 xl:grid-cols-[360px,1fr] gap-6">
        {/* Controls */}
        <section className="space-y-4">
          <Panel title="1) Imagen">
            <div onDrop={onDrop} onDragOver={(e) => e.preventDefault()} className="border-2 border-dashed border-neutral-700 rounded-2xl p-4 flex flex-col items-center justify-center gap-3 text-center">
              <div className="text-neutral-300">Arrastra y suelta una imagen aquí</div>
              <label className="text-sm inline-flex items-center gap-2 cursor-pointer px-3 py-2 rounded-xl bg-neutral-800 hover:bg-neutral-700">
                <span>Subir archivo</span>
                <input type="file" accept="image/*" className="hidden" onChange={(e) => onFile(e.target.files?.[0])} />
              </label>
              {imgEl ? (
                <div className="text-xs opacity-70">{fileName} — {imgSize.w}×{imgSize.h}px</div>
              ) : (
                <div className="text-xs opacity-50">PNG/JPG/WebP</div>
              )}
            </div>
          </Panel>

          <Panel title="2) Paleta de color">
            <div className="space-y-3">
              <RadioTabs value={paletteMode} onChange={setPaletteMode} options={[
                { value: "preset", label: "Preajustes" },
                { value: "custom", label: "Personalizada" },
                { value: "extract", label: "Extraer de la imagen" },
              ]} />

              {paletteMode === "preset" && (
                <div className="space-y-2">
                  <select value={preset} onChange={(e) => setPreset(e.target.value)} className="w-full bg-neutral-800 rounded-xl px-3 py-2">
                    {Object.keys(PRESETS).map((k) => (
                      <option key={k} value={k}>{k}</option>
                    ))}
                  </select>
                  <PaletteSwatches colors={PRESETS[preset]} />
                </div>
              )}

              {paletteMode === "custom" && (
                <div className="space-y-2">
                  <input value={customText} onChange={(e) => setCustomText(e.target.value)} placeholder="#000,#fff,#ff00aa" className="w-full bg-neutral-800 rounded-xl px-3 py-2" />
                  <PaletteSwatches colors={parseHexList(customText)} />
                </div>
              )}

              {paletteMode === "extract" && (
                <div className="space-y-2">
                  <Range label={`N.º de colores: ${kColors}`} min={2} max={24} step={1} value={kColors} onChange={setKColors} />
                  <PaletteSwatches colors={palette} />
                </div>
              )}
            </div>
          </Panel>

          <Panel title="3) Dithering y pixelado">
            <div className="space-y-3">
              <Range label={`Tamaño de píxel: ${pixelSize}px`} min={1} max={64} step={1} value={pixelSize} onChange={setPixelSize} />
              <div>
                <label className="block text-sm mb-1">Método</label>
                <select value={method} onChange={(e) => setMethod(e.target.value)} className="w-full bg-neutral-800 rounded-xl px-3 py-2">
                  <option value="none">Sin dithering</option>
                  <option value="fs">Floyd–Steinberg</option>
                  <option value="ordered">Ordenado (Bayer 8×8)</option>
                  <option value="threshold">Umbral binario</option>
                </select>
              </div>
              {method === "ordered" && (
                <Range label={`Intensidad del patrón: ${ditherStrength.toFixed(2)}`} min={0} max={1} step={0.01} value={ditherStrength} onChange={setDitherStrength} />
              )}
              {method === "threshold" && (
                <Range label={`Umbral: ${threshold}`} min={0} max={255} step={1} value={threshold} onChange={setThreshold} />
              )}

              <button onClick={processNow} className="w-full px-3 py-2 rounded-xl bg-neutral-800 hover:bg-neutral-700">Reprocesar</button>
            </div>
          </Panel>

          <Panel title="4) Exportar">
            <div className="space-y-3">
              <Range label={`Escala de exportación: ×${exportScale.toFixed(2)}`} min={0.25} max={4} step={0.25} value={exportScale} onChange={setExportScale} />
              <div className="flex gap-2">
                <button onClick={downloadPNG} className="flex-1 px-3 py-2 rounded-xl bg-neutral-800 hover:bg-neutral-700">PNG</button>
                <button onClick={downloadJPG} className="flex-1 px-3 py-2 rounded-xl bg-neutral-800 hover:bg-neutral-700">JPG</button>
                <button onClick={downloadSVG} className="flex-1 px-3 py-2 rounded-xl bg-neutral-800 hover:bg-neutral-700">SVG</button>
              </div>
              <div>
                <label className="block text-sm mb-1">Calidad JPG</label>
                <input type="range" min={0.5} max={1} step={0.01} value={exportJpgQ} onChange={(e) => setExportJpgQ(parseFloat(e.target.value))} className="w-full" />
              </div>
              <div className="text-xs opacity-60">SVG genera rectángulos por “píxel”; archivos muy grandes si hay mucha resolución/variedad.</div>
            </div>
          </Panel>

          <div className="text-xs opacity-50 px-1">Hecho con ♥ — corre 100% en tu navegador.</div>
        </section>

        {/* Preview */}
        <section className="relative">
          <div className="flex items-center justify-between mb-3">
            <div className="text-sm opacity-80">Vista previa</div>
            <BgPicker value={bg} onChange={setBg} />
          </div>
          <div className={"relative rounded-2xl overflow-hidden border border-neutral-800 " + bgClass(bg)}>
            <canvas ref={outCanvasRef} className="w-full h-auto block" />
          </div>
          {/* hidden src canvas */}
          <canvas ref={srcCanvasRef} className="hidden" />
        </section>
      </main>
    </div>
  );
}

// ---------- Small UI bits ----------
function Panel({ title, children }) {
  return (
    <div className="rounded-2xl bg-neutral-900/60 border border-neutral-800 p-4">
      <div className="font-semibold mb-3">{title}</div>
      {children}
    </div>
  );
}

function Range({ label, min, max, step, value, onChange }) {
  return (
    <div>
      <div className="flex justify-between items-end mb-1">
        <label className="text-sm">{label}</label>
        <span className="text-xs opacity-60">{min}–{max}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="w-full"
      />
    </div>
  );
}

function RadioTabs({ value, onChange, options }) {
  return (
    <div className="grid grid-cols-3 gap-2">
      {options.map((o) => (
        <button key={o.value}
          onClick={() => onChange(o.value)}
          className={("px-3 py-2 rounded-xl text-sm border " + (value === o.value ? "bg-neutral-800 border-neutral-700" : "bg-neutral-900 border-neutral-800 hover:border-neutral-700"))}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

function PaletteSwatches({ colors = [] }) {
  if (!colors.length) return null;
  return (
    <div className="flex flex-wrap gap-1">
      {colors.map((c, i) => (
        <div key={i} className="flex items-center gap-2 px-2 py-1 rounded-xl bg-neutral-800">
          <span className="w-5 h-5 rounded-md inline-block border border-neutral-700" style={{ background: rgbToHex(c.r, c.g, c.b) }} />
          <code className="text-xs opacity-80">{rgbToHex(c.r, c.g, c.b)}</code>
        </div>
      ))}
    </div>
  );
}

function BgPicker({ value, onChange }) {
  return (
    <div className="flex items-center gap-2">
      <label className="text-sm">Fondo</label>
      <select value={value} onChange={(e) => onChange(e.target.value)} className="bg-neutral-800 px-2 py-1 rounded-lg text-sm">
        <option value="checkers">Damas</option>
        <option value="dark">Oscuro</option>
        <option value="light">Claro</option>
      </select>
    </div>
  );
}

function bgClass(bg) {
  if (bg === "dark") return "bg-neutral-950";
  if (bg === "light") return "bg-neutral-100";
  // checkers
  return "bg-[linear-gradient(45deg,_#111_25%,_transparent_25%),linear-gradient(-45deg,_#111_25%,_transparent_25%),linear-gradient(45deg,_transparent_75%,_#111_75%),linear-gradient(-45deg,_transparent_75%,_#111_75%)] bg-[length:20px_20px] bg-[position:0_0,_0_10px,_10px_-10px,_-10px_0px]";
}

// Rasterize existing canvas at scale
async function rasterizeAtScale(canvas, scale = 1) {
  if (scale === 1) return canvas;
  const w = Math.round(canvas.width * scale);
  const h = Math.round(canvas.height * scale);
  const off = new OffscreenCanvas(w, h);
  const ctx = off.getContext("2d");
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(canvas, 0, 0, w, h);
  return off;
}

function triggerDownload(blob, name) {
  const link = document.createElement("a");
  link.download = name;
  link.href = URL.createObjectURL(blob);
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

// Convert small ImageData to SVG of colored rectangles (row‑wise run‑length to reduce nodes)
function smallImageDataToSVG(small, gw, gh, cell = 12) {
  const data = small.data; // Uint8ClampedArray length gw*gh*4
  const width = gw * cell;
  const height = gh * cell;
  // Build with minimal strings
  let svg = `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`;
  // Rows
  for (let y = 0; y < gh; y++) {
    let x = 0;
    while (x < gw) {
      const i = (y * gw + x) * 4;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const fill = rgbToHex(r, g, b);
      // run length
      let run = 1;
      while (x + run < gw) {
        const j = (y * gw + (x + run)) * 4;
        if (data[j] === r && data[j + 1] === g && data[j + 2] === b) run++; else break;
      }
      const rx = x * cell;
      const ry = y * cell;
      const rw = run * cell;
      svg += `<rect x="${rx}" y="${ry}" width="${rw}" height="${cell}" fill="${fill}"/>`;
      x += run;
    }
  }
  svg += "</svg>";
  return svg;
}
