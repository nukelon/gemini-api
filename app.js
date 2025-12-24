const MODEL_ID = "gemini-3-pro-image-preview";
const DEFAULT_HOST = "https://generativelanguage.googleapis.com";
const API_PATH = `/v1beta/models/${MODEL_ID}:generateContent`;

const $ = (id) => document.getElementById(id);

function stripTrailingSlash(s) { return s.replace(/\/+$/, ""); }

function safeNumberOrEmpty(v) {
  const t = String(v ?? "").trim();
  if (!t) return "";
  const n = Number(t);
  return Number.isFinite(n) ? n : "";
}

function humanBytes(bytes) {
  const units = ["B", "KB", "MB", "GB"];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function base64FromArrayBuffer(buf) {
  const bytes = new Uint8Array(buf);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function nowISO() { return new Date().toISOString(); }

function isLikelyNetworkError(err) {
  const name = String(err?.name || "");
  const msg = String(err?.message || "");
  if (name === "TypeError") return true;
  if (/network/i.test(msg)) return true;
  if (/load failed/i.test(msg)) return true; // Safari
  return false;
}

function parseRatioString(s) {
  const t = String(s || "").trim();
  const m = /^(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)$/.exec(t);
  if (!m) return null;
  const a = Number(m[1]), b = Number(m[2]);
  if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0 || b <= 0) return null;
  return a / b;
}

function bestSupportedAspectRatio(targetRatio) {
  // Must match the select options in UI
  const options = ["1:1","2:3","3:2","3:4","4:3","4:5","5:4","9:16","16:9","21:9"];
  let best = options[0];
  let bestDiff = Infinity;

  for (const s of options) {
    const r = parseRatioString(s);
    if (!r) continue;
    const diff = Math.abs(r - targetRatio);
    if (diff < bestDiff) { bestDiff = diff; best = s; }
  }
  return best;
}

const els = {
  form: $("form"),

  apiHost: $("apiHost"),
  apiKey: $("apiKey"),
  rememberKey: $("rememberKey"),
  useHeaderKey: $("useHeaderKey"),

  modeForm: $("modeForm"),
  modeJson: $("modeJson"),
  formModeWrap: $("formModeWrap"),
  jsonModeWrap: $("jsonModeWrap"),

  systemPrompt: $("systemPrompt"),
  prompt: $("prompt"),
  imageFile: $("imageFile"),
  dropZone: $("dropZone"),
  imagePreview: $("imagePreview"),
  imagePreviewImg: $("imagePreviewImg"),
  imageMeta: $("imageMeta"),
  clearImage: $("clearImage"),
  aspectRatio: $("aspectRatio"),
  imageSize: $("imageSize"),
  temperature: $("temperature"),
  topP: $("topP"),

  keepOriginalAspect: $("keepOriginalAspect"),

  requestBodyJson: $("requestBodyJson"),
  jsonFormat: $("jsonFormat"),
  jsonFromForm: $("jsonFromForm"),
  jsonToForm: $("jsonToForm"),

  presetSelect: $("presetSelect"),
  presetSave: $("presetSave"),
  presetUpdate: $("presetUpdate"),
  presetDelete: $("presetDelete"),
  presetExport: $("presetExport"),
  presetImport: $("presetImport"),

  runBtn: $("runBtn"),
  resetBtn: $("resetBtn"),
  status: $("status"),

  resultEmpty: $("resultEmpty"),
  result: $("result"),
  modelName: $("modelName"),
  latency: $("latency"),
  copyCurl: $("copyCurl"),
  copyJson: $("copyJson"),
  textOutWrap: $("textOutWrap"),
  textOut: $("textOut"),
  imagesOutWrap: $("imagesOutWrap"),
  imagesOut: $("imagesOut"),
  rawJson: $("rawJson"),
};

const storageKeys = {
  host: "g3_host",
  rememberKey: "g3_remember_key",
  apiKey: "g3_api_key",
  useHeaderKey: "g3_use_header_key",

  uiMode: "g3_ui_mode",
  requestBodyJson: "g3_request_body_json",

  systemPrompt: "g3_system_prompt",
  aspectRatio: "g3_aspect_ratio",
  imageSize: "g3_image_size",
  temperature: "g3_temperature",
  topP: "g3_topP",

  keepOriginalAspect: "g3_keep_original_aspect",

  presets: "g3_presets_v1",
  activePreset: "g3_active_preset_name",
};

let uiMode = "form"; // "form" | "json"

// selectedImage includes original dimensions/ratio (critical for keep-original-aspect)
let selectedImage = null; // { mimeType, base64, size, name, dataUrl, width, height, ratio }

let lastRequest = null;
let objectUrls = [];      // output blob URLs (cleanup)
let inputObjectUrl = null; // input preview URL (separate lifecycle)

let requestInFlight = false;
let hiddenDuringRequest = false;
let wakeLock = null;

// cropping config for the last run
let lastCropConfig = { enabled: false, ratio: null }; // ratio = input width/height

function setStatus(msg, visible = true) {
  els.status.textContent = msg || "";
  els.status.classList.toggle("hidden", !visible);
}

// ----- object URL mgmt -----
function cleanupOutputObjectUrls() {
  for (const u of objectUrls) URL.revokeObjectURL(u);
  objectUrls = [];
}

function revokeInputObjectUrl() {
  if (inputObjectUrl) {
    URL.revokeObjectURL(inputObjectUrl);
    inputObjectUrl = null;
  }
}

function b64ToBlob(b64, mimeType) {
  const binary = atob(b64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mimeType || "application/octet-stream" });
}

function blobToObjectUrlTracked(blob) {
  const url = URL.createObjectURL(blob);
  objectUrls.push(url);
  return url;
}

// ----- wake lock (best-effort) -----
async function requestWakeLock() {
  try {
    if (!("wakeLock" in navigator)) return;
    if (wakeLock) return;
    wakeLock = await navigator.wakeLock.request("screen");
    wakeLock.addEventListener("release", () => { wakeLock = null; });
  } catch {
    // ignore
  }
}

function releaseWakeLock() {
  try { wakeLock?.release?.(); } catch {}
  wakeLock = null;
}

// ----- keep-original-aspect UI enforcement -----
function enforceKeepOriginalAvailability() {
  const hasImage = !!selectedImage;

  els.keepOriginalAspect.disabled = !hasImage;
  if (!hasImage && els.keepOriginalAspect.checked) {
    els.keepOriginalAspect.checked = false;
  }

  // When enabled, JSON mode must be disabled and aspectRatio must be locked
  const keepOn = hasImage && els.keepOriginalAspect.checked;

  els.aspectRatio.disabled = keepOn;

  els.modeJson.disabled = keepOn;
  els.modeJson.title = keepOn ? "已开启“保持原图比例”，JSON 模式不可用。" : "";

  if (keepOn) {
    if (uiMode === "json") {
      setStatus("已开启“保持原图比例”，已自动切回表单模式并禁用 JSON 模式。", true);
      setTimeout(() => setStatus("", false), 1400);
      setMode("form", { silent: true });
    }
  }

  persistBase();
}

// ----- image handling -----
async function readImageFileWithMeta(file) {
  const mimeType = file.type || "application/octet-stream";
  const size = file.size;
  const name = file.name || "image";
  const arrayBuf = await file.arrayBuffer();
  const base64 = base64FromArrayBuffer(arrayBuf);

  revokeInputObjectUrl();
  inputObjectUrl = URL.createObjectURL(file);

  // Load dimensions
  const img = new Image();
  img.src = inputObjectUrl;
  try {
    await img.decode();
  } catch {
    // Some Safari versions may not support decode reliably; fallback to load event
    await new Promise((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("无法解析图片尺寸"));
    });
  }

  const width = img.naturalWidth || img.width;
  const height = img.naturalHeight || img.height;
  const ratio = width && height ? (width / height) : null;

  return { mimeType, size, name, base64, dataUrl: inputObjectUrl, width, height, ratio };
}

function clearSelectedImage() {
  selectedImage = null;
  els.imagePreview.classList.add("hidden");
  els.imagePreviewImg.src = "";
  els.imageMeta.textContent = "";
  if (els.imageFile) els.imageFile.value = "";
  revokeInputObjectUrl();
  enforceKeepOriginalAvailability();
}

function showSelectedImage(info) {
  els.imagePreviewImg.src = info.dataUrl;
  const dim = (info.width && info.height) ? ` · ${info.width}×${info.height}` : "";
  els.imageMeta.textContent = `${info.name} · ${humanBytes(info.size)} · ${info.mimeType}${dim}`;
  els.imagePreview.classList.remove("hidden");
}

// ----- mode switching -----
function setMode(mode, { silent = false } = {}) {
  uiMode = mode;

  els.modeForm.classList.toggle("active", mode === "form");
  els.modeJson.classList.toggle("active", mode === "json");

  els.modeForm.setAttribute("aria-selected", String(mode === "form"));
  els.modeJson.setAttribute("aria-selected", String(mode === "json"));

  els.formModeWrap.classList.toggle("hidden", mode !== "form");
  els.jsonModeWrap.classList.toggle("hidden", mode !== "json");

  // On entering JSON mode: sync from form by default
  if (mode === "json") {
    try {
      const body = buildBodyFromForm({ forJsonSync: true });
      els.requestBodyJson.value = JSON.stringify(body, null, 2);
      if (!silent) setStatus("", false);
    } catch (e) {
      if (!silent) setStatus(`切换到 JSON 模式：无法从表单生成默认 JSON（${e?.message || e}）。你可以直接编辑 JSON。`, true);
    }
  }

  persistBase();
}

// ----- request body -----
function buildHiddenKeepAspectSystemPrefix(inputRatio, chosenAspectRatioStr) {
  // Must be invisible in UI: only prepended to systemInstruction sent to API.
  // Keep it explicit to maximize instruction adherence.
  const ratioText = (inputRatio && Number.isFinite(inputRatio)) ? inputRatio.toFixed(6) : "unknown";
  return [
    "【隐藏系统指令（无需在输出中提及）】",
    "你将生成“最终可裁切成与输入图片相同宽高比”的图像。",
    `输入图片宽高比约为：${ratioText}（宽/高）。`,
    `生成时请优先选择尽可能接近该比例的画幅（若你必须在固定比例中选择，则选择最接近者：${chosenAspectRatioStr}）。`,
    "如果无法生成与输入比例一致的画幅：",
    "1) 仅允许在输入画幅以外的区域使用“纯黑(#000000)填充”，不得在画幅外生成任何额外内容；",
    "2) 输入画幅内的主体内容应完整、居中且不被裁切；",
    "3) 不得在画幅外出现任何文字、图案或背景内容（只能是纯黑）。",
    "你的目标是：在后续网页居中裁切回输入比例时，裁切后画面不损失主体内容，且画幅外仅为纯黑填充。",
  ].join("\n");
}

function buildBodyFromForm({ forJsonSync = false } = {}) {
  const systemPromptUI = els.systemPrompt.value.trim();
  const prompt = els.prompt.value.trim();
  const imageSize = els.imageSize.value;

  const temperature = safeNumberOrEmpty(els.temperature.value);
  const topP = safeNumberOrEmpty(els.topP.value);

  const keepOn = !!selectedImage && els.keepOriginalAspect.checked;

  if (!prompt) throw new Error("请填写提示词（必填）。");
  if (keepOn && !selectedImage?.ratio) throw new Error("无法获取原图宽高比，请更换图片重试。");

  // Determine aspect ratio
  let aspectRatio = els.aspectRatio.value;
  let chosen = "";

  if (keepOn) {
    chosen = bestSupportedAspectRatio(selectedImage.ratio);
    aspectRatio = chosen; // lock to closest supported ratio for generation
  }

  const parts = [{ text: prompt }];
  if (selectedImage) {
    parts.push({
      inline_data: {
        mime_type: selectedImage.mimeType,
        data: selectedImage.base64,
      },
    });
  }

  const body = {
    contents: [{
      role: "user",
      parts,
    }],
    generationConfig: {
      responseModalities: ["Image"],
    },
  };

  // systemInstruction: prepend hidden prefix when keepOn
  let systemToSend = systemPromptUI;
  if (keepOn) {
    const hiddenPrefix = buildHiddenKeepAspectSystemPrefix(selectedImage.ratio, chosen);
    systemToSend = hiddenPrefix + (systemPromptUI ? `\n\n${systemPromptUI}` : "");
  }

  if (systemToSend) {
    body.systemInstruction = { parts: [{ text: systemToSend }] };
  }

  if (temperature !== "") body.generationConfig.temperature = temperature;
  if (topP !== "") body.generationConfig.topP = topP;

  if (aspectRatio || imageSize) {
    body.generationConfig.imageConfig = {};
    if (aspectRatio) body.generationConfig.imageConfig.aspectRatio = aspectRatio;
    if (imageSize) body.generationConfig.imageConfig.imageSize = imageSize;
  }

  // In JSON sync mode, we do not want to change UI state; just generate JSON
  if (forJsonSync) return body;

  // Save crop config for this run
  lastCropConfig = keepOn ? { enabled: true, ratio: selectedImage.ratio } : { enabled: false, ratio: null };

  return body;
}

function buildRequest() {
  const host = stripTrailingSlash(els.apiHost.value.trim() || DEFAULT_HOST);
  const apiKey = els.apiKey.value.trim();
  const useHeaderKey = els.useHeaderKey.checked;

  if (!apiKey) throw new Error("请填写 API Key。");

  const url = useHeaderKey
    ? `${host}${API_PATH}`
    : `${host}${API_PATH}?key=${encodeURIComponent(apiKey)}`;

  let body;
  if (uiMode === "json") {
    const raw = els.requestBodyJson.value.trim();
    if (!raw) throw new Error("JSON 模式下请求体不能为空。");
    try {
      body = JSON.parse(raw);
    } catch (e) {
      throw new Error(`JSON 解析失败：${e?.message || e}`);
    }
    // JSON 模式禁止 keepOriginalAspect，因此此处不设置 lastCropConfig
    lastCropConfig = { enabled: false, ratio: null };
  } else {
    body = buildBodyFromForm();
  }

  const headers = { "Content-Type": "application/json" };
  if (useHeaderKey) headers["x-goog-api-key"] = apiKey;

  return { url, headers, body };
}

function makeCurl({ url, headers, body }) {
  const h = Object.entries(headers)
    .map(([k, v]) => `-H ${JSON.stringify(`${k}: ${v}`)}`)
    .join(" \\\n  ");
  return [
    "curl -s -X POST \\",
    `  ${JSON.stringify(url)} \\`,
    `  ${h} \\`,
    `  -d ${JSON.stringify(JSON.stringify(body))}`,
    "",
  ].join("\n");
}

// ----- JSON editor tools -----
function formatJsonEditor() {
  const raw = els.requestBodyJson.value.trim();
  if (!raw) { setStatus("JSON 为空。", true); return; }
  try {
    const obj = JSON.parse(raw);
    els.requestBodyJson.value = JSON.stringify(obj, null, 2);
    setStatus("已格式化 JSON。", true);
    setTimeout(() => setStatus("", false), 1000);
  } catch (e) {
    setStatus(`JSON 解析失败：${e?.message || e}`, true);
  }
}

function syncJsonFromForm() {
  if (els.keepOriginalAspect.checked && selectedImage) {
    setStatus("已开启“保持原图比例”，JSON 同步功能不可用。", true);
    return;
  }
  try {
    const body = buildBodyFromForm({ forJsonSync: true });
    els.requestBodyJson.value = JSON.stringify(body, null, 2);
    setStatus("已从表单同步生成 JSON。", true);
    setTimeout(() => setStatus("", false), 1000);
    persistBase();
  } catch (e) {
    setStatus(e?.message || String(e), true);
  }
}

async function applyJsonToFormBestEffort() {
  if (els.keepOriginalAspect.checked && selectedImage) {
    setStatus("已开启“保持原图比例”，JSON 回填功能不可用。", true);
    return;
  }

  const raw = els.requestBodyJson.value.trim();
  if (!raw) { setStatus("JSON 为空，无法回填。", true); return; }

  let obj;
  try { obj = JSON.parse(raw); }
  catch (e) { setStatus(`JSON 解析失败：${e?.message || e}`, true); return; }

  try {
    const sp = obj?.systemInstruction?.parts?.[0]?.text;
    if (typeof sp === "string") els.systemPrompt.value = sp;
  } catch {}

  try {
    const parts = obj?.contents?.[0]?.parts || [];
    let text = "";
    let inline = null;

    for (const p of parts) {
      if (!text && typeof p?.text === "string") text = p.text;
      const cand = p?.inline_data || p?.inlineData;
      if (!inline && cand?.data) inline = cand;
    }
    if (text) els.prompt.value = text;

    if (inline?.data) {
      // Replace selectedImage from base64 (best effort)
      clearSelectedImage();
      const mimeType = inline.mime_type || inline.mimeType || "application/octet-stream";
      const base64 = inline.data;

      const blob = b64ToBlob(base64, mimeType);
      revokeInputObjectUrl();
      inputObjectUrl = URL.createObjectURL(blob);

      const img = new Image();
      img.src = inputObjectUrl;
      try { await img.decode(); } catch {}

      selectedImage = {
        mimeType,
        base64,
        size: blob.size || base64.length,
        name: "json_image",
        dataUrl: inputObjectUrl,
        width: img.naturalWidth || img.width,
        height: img.naturalHeight || img.height,
        ratio: (img.naturalWidth && img.naturalHeight) ? img.naturalWidth / img.naturalHeight : null,
      };
      showSelectedImage(selectedImage);
    }
  } catch {}

  try {
    const gc = obj?.generationConfig || {};
    if (typeof gc.temperature === "number") els.temperature.value = String(gc.temperature);
    if (typeof gc.topP === "number") els.topP.value = String(gc.topP);
    const ic = gc.imageConfig || {};
    if (typeof ic.aspectRatio === "string") els.aspectRatio.value = ic.aspectRatio;
    if (typeof ic.imageSize === "string") els.imageSize.value = ic.imageSize;
  } catch {}

  setStatus("已尽力将 JSON 回填到表单（可能存在字段不完全匹配）。", true);
  setTimeout(() => setStatus("", false), 1400);
  persistBase();
}

// ----- cropping -----
async function decodeImageFromBlob(blob) {
  // Prefer createImageBitmap; fallback to Image
  if ("createImageBitmap" in window) {
    try {
      const bmp = await createImageBitmap(blob);
      return { type: "bitmap", bmp, width: bmp.width, height: bmp.height };
    } catch {
      // fallback
    }
  }

  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    try { await img.decode(); }
    catch {
      await new Promise((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error("无法解码输出图片"));
      });
    }
    const w = img.naturalWidth || img.width;
    const h = img.naturalHeight || img.height;
    return { type: "img", img, width: w, height: h };
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function cropBlobToAspect(blob, mimeType, targetRatio) {
  const decoded = await decodeImageFromBlob(blob);
  const W = decoded.width;
  const H = decoded.height;
  if (!W || !H || !targetRatio) return blob;

  // Compute center crop rectangle to match targetRatio
  let sx = 0, sy = 0, sw = W, sh = H;
  const currentRatio = W / H;

  if (currentRatio > targetRatio) {
    // too wide -> crop width
    sw = Math.round(H * targetRatio);
    sx = Math.round((W - sw) / 2);
  } else if (currentRatio < targetRatio) {
    // too tall -> crop height
    sh = Math.round(W / targetRatio);
    sy = Math.round((H - sh) / 2);
  } else {
    return blob; // already matching
  }

  const canvas = document.createElement("canvas");
  canvas.width = sw;
  canvas.height = sh;
  const ctx = canvas.getContext("2d", { alpha: true });

  if (!ctx) return blob;

  if (decoded.type === "bitmap") {
    ctx.drawImage(decoded.bmp, sx, sy, sw, sh, 0, 0, sw, sh);
    decoded.bmp.close?.();
  } else {
    ctx.drawImage(decoded.img, sx, sy, sw, sh, 0, 0, sw, sh);
  }

  const outType = (mimeType && mimeType.startsWith("image/")) ? mimeType : "image/png";

  const outBlob = await new Promise((resolve) => {
    canvas.toBlob((b) => resolve(b || blob), outType, outType === "image/jpeg" ? 0.95 : undefined);
  });

  return outBlob;
}

// ----- render -----
function timestampTag() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

async function renderResult({ data, ms }) {
  els.resultEmpty.classList.add("hidden");
  els.result.classList.remove("hidden");

  els.modelName.textContent = MODEL_ID;
  els.latency.textContent = `${ms.toFixed(0)} ms`;

  els.rawJson.textContent = JSON.stringify(data, null, 2);

  const candidates = data?.candidates || [];
  const first = candidates[0]?.content?.parts || [];
  const texts = [];
  const images = [];

  for (const p of first) {
    if (typeof p?.text === "string" && p.text.trim()) {
      texts.push(p.text);
      continue;
    }
    const inline = p.inlineData || p.inline_data;
    if (inline?.data) {
      const mimeType = inline.mimeType || inline.mime_type || "image/png";
      images.push({ b64: inline.data, mimeType });
    }
  }

  if (texts.length) {
    els.textOutWrap.classList.remove("hidden");
    els.textOut.textContent = texts.join("\n\n---\n\n");
  } else {
    els.textOutWrap.classList.add("hidden");
    els.textOut.textContent = "";
  }

  els.imagesOut.innerHTML = "";
  cleanupOutputObjectUrls();

  if (!images.length) {
    els.imagesOutWrap.classList.add("hidden");
    return;
  }

  els.imagesOutWrap.classList.remove("hidden");
  const tag = timestampTag();

  const cropOn = lastCropConfig.enabled && Number.isFinite(lastCropConfig.ratio) && lastCropConfig.ratio > 0;
  if (cropOn) {
    setStatus("请求成功，正在按原图比例裁切输出……", true);
  }

  for (let idx = 0; idx < images.length; idx++) {
    const img = images[idx];

    const origBlob = b64ToBlob(img.b64, img.mimeType);
    const origUrl = blobToObjectUrlTracked(origBlob);

    let shownBlob = origBlob;
    let shownUrl = origUrl;
    let shownLabel = "原始输出";

    if (cropOn) {
      try {
        const cropped = await cropBlobToAspect(origBlob, img.mimeType, lastCropConfig.ratio);
        shownBlob = cropped;
        shownUrl = blobToObjectUrlTracked(cropped);
        shownLabel = "裁切输出";
      } catch {
        // If crop fails, fallback to original
        shownBlob = origBlob;
        shownUrl = origUrl;
        shownLabel = "原始输出（裁切失败，已回退）";
      }
    }

    const extFromMime = (m) => {
      if (!m) return "bin";
      if (m.includes("png")) return "png";
      if (m.includes("jpeg")) return "jpg";
      if (m.includes("webp")) return "webp";
      return "bin";
    };

    const ext = extFromMime(img.mimeType);
    const baseName = `gemini3_image_${tag}_${String(idx + 1).padStart(2, "0")}`;
    const shownName = cropOn ? `${baseName}_cropped.${ext}` : `${baseName}.${ext}`;
    const origName = `${baseName}_original.${ext}`;

    const card = document.createElement("div");
    card.className = "imgcard";

    const imageEl = document.createElement("img");
    imageEl.src = shownUrl;
    imageEl.alt = `输出图片 ${idx + 1}`;

    const bar = document.createElement("div");
    bar.className = "bar";

    const top = document.createElement("div");
    top.className = "barTop";

    const left = document.createElement("div");
    left.className = "smallMuted";
    left.textContent = `${shownLabel} · ${img.mimeType || "image"}`;

    const right = document.createElement("div");
    right.style.display = "flex";
    right.style.gap = "12px";
    right.style.flexWrap = "wrap";
    right.style.alignItems = "center";

    const openShown = document.createElement("a");
    openShown.className = "link";
    openShown.href = shownUrl;
    openShown.target = "_blank";
    openShown.rel = "noopener";
    openShown.textContent = "打开";

    const dlShown = document.createElement("a");
    dlShown.className = "link";
    dlShown.href = shownUrl;
    dlShown.download = shownName;
    dlShown.textContent = "下载";

    right.appendChild(openShown);
    right.appendChild(dlShown);

    top.appendChild(left);
    top.appendChild(right);

    bar.appendChild(top);

    if (cropOn) {
      const bottom = document.createElement("div");
      bottom.className = "barBottom";

      const openOrig = document.createElement("a");
      openOrig.className = "link";
      openOrig.href = origUrl;
      openOrig.target = "_blank";
      openOrig.rel = "noopener";
      openOrig.textContent = "查看原始输出";

      const dlOrig = document.createElement("a");
      dlOrig.className = "link";
      dlOrig.href = origUrl;
      dlOrig.download = origName;
      dlOrig.textContent = "下载原始输出";

      bottom.appendChild(openOrig);
      bottom.appendChild(dlOrig);
      bar.appendChild(bottom);
    }

    card.appendChild(imageEl);
    card.appendChild(bar);

    els.imagesOut.appendChild(card);
  }

  if (cropOn) {
    setStatus("", false);
  }
}

// ----- persistence (base state, excluding presets content itself) -----
function persistBase() {
  localStorage.setItem(storageKeys.host, els.apiHost.value.trim());
  localStorage.setItem(storageKeys.rememberKey, String(els.rememberKey.checked));
  localStorage.setItem(storageKeys.useHeaderKey, String(els.useHeaderKey.checked));

  localStorage.setItem(storageKeys.uiMode, uiMode);
  localStorage.setItem(storageKeys.requestBodyJson, els.requestBodyJson.value);

  localStorage.setItem(storageKeys.systemPrompt, els.systemPrompt.value);
  localStorage.setItem(storageKeys.aspectRatio, els.aspectRatio.value);
  localStorage.setItem(storageKeys.imageSize, els.imageSize.value);
  localStorage.setItem(storageKeys.temperature, els.temperature.value);
  localStorage.setItem(storageKeys.topP, els.topP.value);

  localStorage.setItem(storageKeys.keepOriginalAspect, String(els.keepOriginalAspect.checked));

  if (els.rememberKey.checked) {
    localStorage.setItem(storageKeys.apiKey, els.apiKey.value);
  } else {
    localStorage.removeItem(storageKeys.apiKey);
  }
}

function restoreBase() {
  els.apiHost.value = localStorage.getItem(storageKeys.host) || "";
  els.rememberKey.checked = (localStorage.getItem(storageKeys.rememberKey) || "false") === "true";
  els.useHeaderKey.checked = (localStorage.getItem(storageKeys.useHeaderKey) || "false") === "true";

  uiMode = (localStorage.getItem(storageKeys.uiMode) || "form");
  els.requestBodyJson.value = localStorage.getItem(storageKeys.requestBodyJson) || "";

  els.systemPrompt.value = localStorage.getItem(storageKeys.systemPrompt) || "";
  els.aspectRatio.value = localStorage.getItem(storageKeys.aspectRatio) || "";
  els.imageSize.value = localStorage.getItem(storageKeys.imageSize) || "";
  els.temperature.value = localStorage.getItem(storageKeys.temperature) || "";
  els.topP.value = localStorage.getItem(storageKeys.topP) || "";

  els.keepOriginalAspect.checked = (localStorage.getItem(storageKeys.keepOriginalAspect) || "false") === "true";

  const savedKey = localStorage.getItem(storageKeys.apiKey) || "";
  if (els.rememberKey.checked && savedKey) {
    els.apiKey.value = savedKey;
  }
}

// ----- presets -----
function loadPresets() {
  try {
    const raw = localStorage.getItem(storageKeys.presets);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr;
  } catch {
    return [];
  }
}

function savePresets(arr) {
  localStorage.setItem(storageKeys.presets, JSON.stringify(arr));
}

function refreshPresetUI() {
  const presets = loadPresets();
  const activeName = localStorage.getItem(storageKeys.activePreset) || "";

  els.presetSelect.innerHTML = "";
  const empty = document.createElement("option");
  empty.value = "";
  empty.textContent = "（无预设）";
  els.presetSelect.appendChild(empty);

  for (const p of presets) {
    const opt = document.createElement("option");
    opt.value = p.name;
    opt.textContent = p.name;
    if (p.name === activeName) opt.selected = true;
    els.presetSelect.appendChild(opt);
  }

  const hasActive = !!activeName && presets.some(p => p.name === activeName);
  els.presetUpdate.disabled = !hasActive;
  els.presetDelete.disabled = !hasActive;
}

function getCurrentPresetName() {
  return els.presetSelect.value || (localStorage.getItem(storageKeys.activePreset) || "");
}

function makePresetFromCurrentState() {
  return {
    name: "",
    createdAt: nowISO(),
    updatedAt: nowISO(),
    mode: uiMode,
    fields: {
      systemPrompt: els.systemPrompt.value,
      prompt: els.prompt.value,
      aspectRatio: els.aspectRatio.value,
      imageSize: els.imageSize.value,
      temperature: els.temperature.value,
      topP: els.topP.value,
      keepOriginalAspect: !!selectedImage && els.keepOriginalAspect.checked,
    },
    image: selectedImage ? {
      mimeType: selectedImage.mimeType,
      base64: selectedImage.base64,
      name: selectedImage.name,
      size: selectedImage.size,
      width: selectedImage.width,
      height: selectedImage.height,
    } : null,
    requestBodyJson: els.requestBodyJson.value,
  };
}

function applyPreset(preset) {
  // DO NOT touch host/key
  // Image first (affects keepOriginal availability)
  clearSelectedImage();

  if (preset.image?.base64) {
    const mimeType = preset.image.mimeType || "application/octet-stream";
    const base64 = preset.image.base64;

    const blob = b64ToBlob(base64, mimeType);
    revokeInputObjectUrl();
    inputObjectUrl = URL.createObjectURL(blob);

    const img = new Image();
    img.src = inputObjectUrl;

    const finalize = async () => {
      try { await img.decode(); } catch {}
      const width = img.naturalWidth || preset.image.width || img.width;
      const height = img.naturalHeight || preset.image.height || img.height;
      selectedImage = {
        mimeType,
        base64,
        size: preset.image.size || blob.size,
        name: preset.image.name || "preset_image",
        dataUrl: inputObjectUrl,
        width,
        height,
        ratio: (width && height) ? width / height : null,
      };
      showSelectedImage(selectedImage);
      enforceKeepOriginalAvailability();
    };

    finalize();
  }

  // Fields
  const f = preset.fields || {};
  els.systemPrompt.value = f.systemPrompt ?? "";
  els.prompt.value = f.prompt ?? "";
  els.aspectRatio.value = f.aspectRatio ?? "";
  els.imageSize.value = f.imageSize ?? "";
  els.temperature.value = f.temperature ?? "";
  els.topP.value = f.topP ?? "";
  els.keepOriginalAspect.checked = !!f.keepOriginalAspect;

  // Mode
  setMode(preset.mode === "json" ? "json" : "form", { silent: true });

  if (typeof preset.requestBodyJson === "string") {
    els.requestBodyJson.value = preset.requestBodyJson;
  }

  // Enforce constraints after everything applied
  enforceKeepOriginalAvailability();

  persistBase();
  setStatus(`已应用预设：${preset.name}\n（Host / Key 未改变）`, true);
  setTimeout(() => setStatus("", false), 1400);
}

function saveAsPreset() {
  const name = (prompt("请输入预设名称（Host / Key 不会保存到预设中）：") || "").trim();
  if (!name) return;

  const presets = loadPresets();
  const existing = presets.find(p => p.name === name);

  if (existing) {
    const ok = confirm(`预设“${name}”已存在，是否覆盖？`);
    if (!ok) return;
    const next = makePresetFromCurrentState();
    next.name = name;
    next.createdAt = existing.createdAt || nowISO();
    next.updatedAt = nowISO();
    presets[presets.findIndex(p => p.name === name)] = next;
  } else {
    const next = makePresetFromCurrentState();
    next.name = name;
    presets.push(next);
  }

  try {
    savePresets(presets);
  } catch (e) {
    setStatus(`保存失败：可能是本地存储空间不足（预设图片会占用较多空间）。\n${e?.message || e}`, true);
    return;
  }

  localStorage.setItem(storageKeys.activePreset, name);
  refreshPresetUI();
  setStatus(`已保存预设：${name}`, true);
  setTimeout(() => setStatus("", false), 1200);
}

function updateActivePreset() {
  const name = getCurrentPresetName();
  if (!name) return;

  const presets = loadPresets();
  const idx = presets.findIndex(p => p.name === name);
  if (idx < 0) return;

  const ok = confirm(`确认更新预设“${name}”？`);
  if (!ok) return;

  const existing = presets[idx];
  const next = makePresetFromCurrentState();
  next.name = name;
  next.createdAt = existing.createdAt || nowISO();
  next.updatedAt = nowISO();
  presets[idx] = next;

  try {
    savePresets(presets);
  } catch (e) {
    setStatus(`更新失败：可能是本地存储空间不足。\n${e?.message || e}`, true);
    return;
  }

  localStorage.setItem(storageKeys.activePreset, name);
  refreshPresetUI();
  setStatus(`已更新预设：${name}`, true);
  setTimeout(() => setStatus("", false), 1200);
}

function deleteActivePreset() {
  const name = getCurrentPresetName();
  if (!name) return;

  const ok = confirm(`确认删除预设“${name}”？该操作不可撤销。`);
  if (!ok) return;

  const presets = loadPresets().filter(p => p.name !== name);
  savePresets(presets);

  localStorage.removeItem(storageKeys.activePreset);
  refreshPresetUI();
  setStatus(`已删除预设：${name}`, true);
  setTimeout(() => setStatus("", false), 1200);
}

function exportPresets() {
  const presets = loadPresets();
  const payload = { version: 1, exportedAt: nowISO(), presets };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);

  const a = document.createElement("a");
  a.href = url;
  a.download = `gemini3_presets_${timestampTag()}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();

  setTimeout(() => URL.revokeObjectURL(url), 5000);
  setStatus(`已导出预设：${presets.length} 个`, true);
  setTimeout(() => setStatus("", false), 1200);
}

async function importPresetsFromFile(file) {
  if (!file) return;

  let text = "";
  try { text = await file.text(); }
  catch (e) { setStatus(`读取导入文件失败：${e?.message || e}`, true); return; }

  let obj;
  try { obj = JSON.parse(text); }
  catch (e) { setStatus(`导入失败：JSON 解析错误：${e?.message || e}`, true); return; }

  const incoming = Array.isArray(obj?.presets) ? obj.presets : (Array.isArray(obj) ? obj : []);
  if (!incoming.length) { setStatus("导入失败：未发现 presets 数组。", true); return; }

  const existing = loadPresets();
  const nameSet = new Set(existing.map(p => p.name));
  const merged = [...existing];
  let added = 0;

  for (const p of incoming) {
    if (!p?.name) continue;
    let name = String(p.name).trim();
    if (!name) continue;

    if (nameSet.has(name)) {
      let i = 1;
      while (nameSet.has(`${name}（导入${i}）`)) i++;
      name = `${name}（导入${i}）`;
    }

    const safePreset = {
      name,
      createdAt: p.createdAt || nowISO(),
      updatedAt: nowISO(),
      mode: (p.mode === "json") ? "json" : "form",
      fields: {
        systemPrompt: p?.fields?.systemPrompt ?? "",
        prompt: p?.fields?.prompt ?? "",
        aspectRatio: p?.fields?.aspectRatio ?? "",
        imageSize: p?.fields?.imageSize ?? "",
        temperature: p?.fields?.temperature ?? "",
        topP: p?.fields?.topP ?? "",
        keepOriginalAspect: !!p?.fields?.keepOriginalAspect,
      },
      image: p?.image?.base64 ? {
        mimeType: p.image.mimeType || "application/octet-stream",
        base64: p.image.base64,
        name: p.image.name || "preset_image",
        size: p.image.size || p.image.base64.length,
        width: p.image.width,
        height: p.image.height,
      } : null,
      requestBodyJson: typeof p.requestBodyJson === "string" ? p.requestBodyJson : "",
    };

    merged.push(safePreset);
    nameSet.add(name);
    added++;
  }

  if (!added) { setStatus("导入完成：未新增任何有效预设。", true); return; }

  try { savePresets(merged); }
  catch (e) {
    setStatus(`导入失败：可能是本地存储空间不足（预设图片会占用较多空间）。\n${e?.message || e}`, true);
    return;
  }

  refreshPresetUI();
  setStatus(`导入完成：新增 ${added} 个预设。`, true);
  setTimeout(() => setStatus("", false), 1400);
}

// ----- fetch -----
async function doFetchOnce(req) {
  const t0 = performance.now();
  const resp = await fetch(req.url, {
    method: "POST",
    headers: req.headers,
    body: JSON.stringify(req.body),
  });
  const data = await resp.json().catch(() => ({}));
  const t1 = performance.now();
  return { resp, data, ms: (t1 - t0) };
}

async function run() {
  persistBase();
  setStatus("正在请求模型生成……", true);

  els.resultEmpty.classList.add("hidden");
  els.result.classList.add("hidden");
  els.textOutWrap.classList.add("hidden");
  els.imagesOutWrap.classList.add("hidden");
  els.rawJson.textContent = "";
  cleanupOutputObjectUrls();

  let req;
  try { req = buildRequest(); }
  catch (e) { setStatus(e.message || String(e), true); return; }

  lastRequest = req;

  requestInFlight = true;
  hiddenDuringRequest = false;
  await requestWakeLock();

  let didAutoRetry = false;

  try {
    while (true) {
      try {
        const { resp, data, ms } = await doFetchOnce(req);

        if (!resp.ok) {
          const msg = data?.error?.message || `HTTP ${resp.status} ${resp.statusText}`;
          setStatus(`请求失败：${msg}\n\n（提示：若你使用自定义 Host，请确认它支持该路径与鉴权方式。）`, true);
          els.resultEmpty.classList.remove("hidden");
          return;
        }

        // Render (may async crop)
        setStatus("", false);
        await renderResult({ data, ms });
        return;

      } catch (e) {
        if (!didAutoRetry && hiddenDuringRequest && isLikelyNetworkError(e)) {
          didAutoRetry = true;
          setStatus("检测到请求过程中页面进入后台导致网络中断，正在自动重试一次……", true);
          if (document.visibilityState === "visible") await requestWakeLock();
          continue;
        }
        throw e;
      }
    }
  } catch (e) {
    setStatus(
      `网络或浏览器限制导致请求失败：${e?.message || e}\n\n（提示：iOS Safari 后台可能冻结网络；建议尽量保持前台直到完成，或使用自定义 Host/反代提升可用性。）`,
      true
    );
    els.resultEmpty.classList.remove("hidden");
  } finally {
    requestInFlight = false;
    hiddenDuringRequest = false;
    releaseWakeLock();
  }
}

// ----- reset -----
function resetNonFixedFields() {
  els.systemPrompt.value = "";
  els.prompt.value = "";
  els.aspectRatio.value = "";
  els.imageSize.value = "";
  els.temperature.value = "";
  els.topP.value = "";
  els.requestBodyJson.value = "";
  els.keepOriginalAspect.checked = false;
  clearSelectedImage();

  setStatus("", false);
  els.result.classList.add("hidden");
  els.resultEmpty.classList.remove("hidden");
  persistBase();
}

// ----- wiring -----
async function handleImageFile(file) {
  if (file.size > 12 * 1024 * 1024) {
    setStatus(`图片较大（${humanBytes(file.size)}）。建议压缩后再试；保存到预设时也更容易触发存储空间不足。`, true);
  } else {
    setStatus("", false);
  }

  clearSelectedImage();
  const info = await readImageFileWithMeta(file);
  selectedImage = info;
  showSelectedImage(info);

  enforceKeepOriginalAvailability();
  persistBase();
}

function wireEvents() {
  ["input", "change"].forEach((evt) => {
    els.apiHost.addEventListener(evt, persistBase);
    els.apiKey.addEventListener(evt, persistBase);
    els.rememberKey.addEventListener(evt, persistBase);
    els.useHeaderKey.addEventListener(evt, persistBase);

    els.systemPrompt.addEventListener(evt, persistBase);
    els.prompt.addEventListener(evt, persistBase);
    els.aspectRatio.addEventListener(evt, persistBase);
    els.imageSize.addEventListener(evt, persistBase);
    els.temperature.addEventListener(evt, persistBase);
    els.topP.addEventListener(evt, persistBase);

    els.requestBodyJson.addEventListener(evt, persistBase);
    els.keepOriginalAspect.addEventListener(evt, () => {
      enforceKeepOriginalAvailability();
      if (els.keepOriginalAspect.checked) {
        setStatus("已开启“保持原图比例”：将自动选择最接近原图的生成比例，并在网页端裁切回原图比例；同时禁用 JSON 模式。", true);
        setTimeout(() => setStatus("", false), 1600);
      }
    });
  });

  els.rememberKey.addEventListener("change", () => {
    if (!els.rememberKey.checked) localStorage.removeItem(storageKeys.apiKey);
    else localStorage.setItem(storageKeys.apiKey, els.apiKey.value);
  });

  els.apiKey.addEventListener("input", () => {
    if (els.rememberKey.checked) localStorage.setItem(storageKeys.apiKey, els.apiKey.value);
  });

  els.modeForm.addEventListener("click", () => setMode("form"));
  els.modeJson.addEventListener("click", () => {
    if (els.keepOriginalAspect.checked && selectedImage) {
      setStatus("已开启“保持原图比例”，JSON 模式不可用。", true);
      return;
    }
    setMode("json");
  });

  els.jsonFormat.addEventListener("click", formatJsonEditor);
  els.jsonFromForm.addEventListener("click", syncJsonFromForm);
  els.jsonToForm.addEventListener("click", applyJsonToFormBestEffort);

  const onDrag = (e) => {
    e.preventDefault();
    e.stopPropagation();
    els.dropZone.style.borderColor = "rgba(140, 160, 255, 0.45)";
  };
  const onLeave = (e) => {
    e.preventDefault();
    e.stopPropagation();
    els.dropZone.style.borderColor = "rgba(255,255,255,0.2)";
  };
  els.dropZone.addEventListener("dragenter", onDrag);
  els.dropZone.addEventListener("dragover", onDrag);
  els.dropZone.addEventListener("dragleave", onLeave);
  els.dropZone.addEventListener("drop", async (e) => {
    onLeave(e);
    const f = e.dataTransfer?.files?.[0];
    if (!f) return;
    await handleImageFile(f);
  });

  els.imageFile.addEventListener("change", async () => {
    const f = els.imageFile.files?.[0];
    if (!f) return;
    await handleImageFile(f);
  });

  els.clearImage.addEventListener("click", () => clearSelectedImage());

  els.form.addEventListener("submit", async (e) => {
    e.preventDefault();
    els.runBtn.disabled = true;
    try { await run(); }
    finally { els.runBtn.disabled = false; }
  });

  els.resetBtn.addEventListener("click", resetNonFixedFields);

  els.copyCurl.addEventListener("click", async () => {
    if (!lastRequest) return;
    await navigator.clipboard.writeText(makeCurl(lastRequest));
    setStatus("已复制 cURL 到剪贴板。", true);
    setTimeout(() => setStatus("", false), 1200);
  });

  els.copyJson.addEventListener("click", async () => {
    if (!lastRequest) return;
    await navigator.clipboard.writeText(JSON.stringify(lastRequest.body, null, 2));
    setStatus("已复制请求 JSON 到剪贴板。", true);
    setTimeout(() => setStatus("", false), 1200);
  });

  // presets
  els.presetSelect.addEventListener("change", () => {
    const name = els.presetSelect.value || "";
    if (!name) {
      localStorage.removeItem(storageKeys.activePreset);
      refreshPresetUI();
      return;
    }
    localStorage.setItem(storageKeys.activePreset, name);
    const presets = loadPresets();
    const p = presets.find(x => x.name === name);
    if (p) applyPreset(p);
    refreshPresetUI();
  });

  els.presetSave.addEventListener("click", saveAsPreset);
  els.presetUpdate.addEventListener("click", updateActivePreset);
  els.presetDelete.addEventListener("click", deleteActivePreset);
  els.presetExport.addEventListener("click", exportPresets);

  els.presetImport.addEventListener("change", async () => {
    const f = els.presetImport.files?.[0];
    els.presetImport.value = "";
    await importPresetsFromFile(f);
  });

  document.addEventListener("visibilitychange", async () => {
    if (requestInFlight && document.visibilityState === "hidden") hiddenDuringRequest = true;
    if (requestInFlight && document.visibilityState === "visible") await requestWakeLock();
  });
}

// ----- init -----
function init() {
  restoreBase();
  wireEvents();

  setMode(uiMode === "json" ? "json" : "form", { silent: true });

  // No image at startup unless loaded via preset -> keepOriginal must be disabled
  enforceKeepOriginalAvailability();

  refreshPresetUI();
  const activeName = localStorage.getItem(storageKeys.activePreset) || "";
  if (activeName) {
    const presets = loadPresets();
    const p = presets.find(x => x.name === activeName);
    if (p) applyPreset(p);
  }
}

init();