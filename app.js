const MODEL_ID = "gemini-3-pro-image-preview";
const DEFAULT_HOST = "https://generativelanguage.googleapis.com";
const API_PATH = `/v1beta/models/${MODEL_ID}:generateContent`;

// 标准比例集合（与下拉一致）
const SUPPORTED_ASPECTS = ["1:1","2:3","3:2","3:4","4:3","4:5","5:4","9:16","16:9","21:9"];

// 阈值：原图比例与最近标准比例“足够接近”则不加黑边
// 这里用相对误差：abs(r - t) / t < threshold
const ASPECT_CLOSE_THRESHOLD = 0.012; // 1.2% 你可调大/调小

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

function closestSupportedAspect(ratio) {
  let bestStr = SUPPORTED_ASPECTS[0];
  let bestVal = parseRatioString(bestStr);
  let bestDiff = Infinity;

  for (const s of SUPPORTED_ASPECTS) {
    const v = parseRatioString(s);
    if (!v) continue;
    const diff = Math.abs(v - ratio);
    if (diff < bestDiff) {
      bestDiff = diff;
      bestStr = s;
      bestVal = v;
    }
  }
  return { aspectStr: bestStr, aspectVal: bestVal, absDiff: bestDiff };
}

function relDiff(a, b) {
  return Math.abs(a - b) / (Math.abs(b) || 1);
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

// selectedImage：真正用于发给模型的图片（可能已经加黑边）
let selectedImage = null; // { mimeType, base64, size, name, dataUrl, width, height, ratio }

// keep 模式的原图信息（用于最终裁切回原图比例）
let keepMeta = {
  enabled: false,
  originalRatio: null,
  originalW: null,
  originalH: null,
  paddedApplied: false,
  chosenAspectStr: "",
  chosenAspectVal: null,
};

let lastRequest = null;
let objectUrls = [];
let inputObjectUrl = null;

// iOS background mitigation
let requestInFlight = false;
let hiddenDuringRequest = false;
let wakeLock = null;

// last run crop config
let lastCropConfig = { enabled: false, ratio: null };

let savedUserAspectRatioBeforeLock = null;

function setStatus(msg, visible = true) {
  els.status.textContent = msg || "";
  els.status.classList.toggle("hidden", !visible);
}

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

// ----- wake lock -----
async function requestWakeLock() {
  try {
    if (!("wakeLock" in navigator)) return;
    if (wakeLock) return;
    wakeLock = await navigator.wakeLock.request("screen");
    wakeLock.addEventListener("release", () => { wakeLock = null; });
  } catch {}
}

function releaseWakeLock() {
  try { wakeLock?.release?.(); } catch {}
  wakeLock = null;
}

// ----- UI constraints -----
// 维持你之前的要求：勾选即锁 UI（禁 JSON + 灰掉比例）
function enforceKeepOriginalConstraints() {
  const uiLocked = els.keepOriginalAspect.checked;

  if (uiLocked) {
    if (savedUserAspectRatioBeforeLock === null) {
      savedUserAspectRatioBeforeLock = els.aspectRatio.value || "";
    }
    // keep 模式下由程序决定比例（不让用户选），因此 UI 上统一显示为默认
    els.aspectRatio.value = "";
    els.aspectRatio.disabled = true;
  } else {
    els.aspectRatio.disabled = false;
    if (savedUserAspectRatioBeforeLock !== null) {
      els.aspectRatio.value = savedUserAspectRatioBeforeLock;
      savedUserAspectRatioBeforeLock = null;
    }
  }

  els.modeJson.disabled = uiLocked;
  els.modeJson.title = uiLocked ? "已启用“保持原图比例”，JSON 模式不可用。" : "";

  if (uiLocked && uiMode === "json") {
    setStatus("已启用“保持原图比例”，已切回表单模式并禁用 JSON。", true);
    setTimeout(() => setStatus("", false), 1000);
    setMode("form", { silent: true });
  }

  // crop 只在“有图 + keep”时生效
  const logicOn = uiLocked && !!selectedImage && !!keepMeta.originalRatio;
  lastCropConfig = logicOn ? { enabled: true, ratio: keepMeta.originalRatio } : { enabled: false, ratio: null };

  persistBase();
}

// ----- image decode & preprocess -----
async function readImageFileWithMeta(file) {
  const mimeType = file.type || "application/octet-stream";
  const size = file.size;
  const name = file.name || "image";
  const arrayBuf = await file.arrayBuffer();
  const base64 = base64FromArrayBuffer(arrayBuf);

  revokeInputObjectUrl();
  inputObjectUrl = URL.createObjectURL(file);

  const img = new Image();
  img.src = inputObjectUrl;

  try {
    await img.decode();
  } catch {
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

// 把原图“加纯黑边”到目标标准比例（不缩放原图，仅扩画布）
async function padToAspectWithBlack(originalInfo, targetAspectVal) {
  // 用 dataUrl 直接 draw
  const img = new Image();
  img.src = originalInfo.dataUrl;

  try { await img.decode(); }
  catch {
    await new Promise((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("无法解码图片用于加黑边"));
    });
  }

  const ow = originalInfo.width;
  const oh = originalInfo.height;

  // 计算新画布尺寸：最小扩展到 targetRatio
  let cw = ow, ch = oh;
  const r0 = ow / oh;
  const rt = targetAspectVal;

  if (r0 < rt) {
    // 需要更宽：左右加黑边
    ch = oh;
    cw = Math.round(oh * rt);
  } else if (r0 > rt) {
    // 需要更高：上下加黑边
    cw = ow;
    ch = Math.round(ow / rt);
  } else {
    // 已匹配
    return null;
  }

  // 安全：避免极端导致内存爆
  const maxPixels = 28_000_000; // 约等于 28MP
  if (cw * ch > maxPixels) {
    throw new Error(`加黑边后的画布过大（${cw}×${ch}），为避免内存问题已中止。建议先缩小图片再试。`);
  }

  const canvas = document.createElement("canvas");
  canvas.width = cw;
  canvas.height = ch;

  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) throw new Error("无法获取 canvas 2d 上下文");

  // 纯黑填充
  ctx.fillStyle = "#000000";
  ctx.fillRect(0, 0, cw, ch);

  // 原图居中贴上（不缩放）
  const dx = Math.round((cw - ow) / 2);
  const dy = Math.round((ch - oh) / 2);
  ctx.drawImage(img, dx, dy, ow, oh);

  // 输出为 PNG（保证黑边稳定）
  const blob = await new Promise((resolve) => {
    canvas.toBlob((b) => resolve(b), "image/png");
  });

  if (!blob) throw new Error("加黑边导出 PNG 失败");

  const buf = await blob.arrayBuffer();
  const base64 = base64FromArrayBuffer(buf);

  // 用 blob URL 作预览
  const url = URL.createObjectURL(blob);

  return {
    mimeType: "image/png",
    size: blob.size,
    name: (originalInfo.name || "image") + "_padded.png",
    base64,
    dataUrl: url,
    width: cw,
    height: ch,
    ratio: cw / ch,
    _objectUrl: url,
  };
}

function clearSelectedImage() {
  selectedImage = null;
  keepMeta = {
    enabled: false,
    originalRatio: null,
    originalW: null,
    originalH: null,
    paddedApplied: false,
    chosenAspectStr: "",
    chosenAspectVal: null,
  };

  els.imagePreview.classList.add("hidden");
  els.imagePreviewImg.src = "";
  els.imageMeta.textContent = "";
  if (els.imageFile) els.imageFile.value = "";

  revokeInputObjectUrl();

  // 清掉加黑边产生的临时 URL（如果有）
  // 注意：selectedImage 为 null 了，但我们可能在 padToAspectWithBlack 里创建了 url
  // 该 url 会在下次 cleanupOutputObjectUrls 前不在 objectUrls 中，所以这里不强制回收（简单处理）
  enforceKeepOriginalConstraints();
}

function showSelectedImage(info, metaText) {
  els.imagePreviewImg.src = info.dataUrl;
  els.imageMeta.textContent = metaText || `${info.name} · ${humanBytes(info.size)} · ${info.width}×${info.height}`;
  els.imagePreview.classList.remove("hidden");
}

async function prepareKeepModeImage(originalInfo) {
  // 记录原图信息：最终用于裁切回 originalRatio
  keepMeta.enabled = true;
  keepMeta.originalW = originalInfo.width;
  keepMeta.originalH = originalInfo.height;
  keepMeta.originalRatio = originalInfo.ratio;

  const { aspectStr, aspectVal } = closestSupportedAspect(originalInfo.ratio);
  keepMeta.chosenAspectStr = aspectStr;
  keepMeta.chosenAspectVal = aspectVal;

  const closeEnough = relDiff(originalInfo.ratio, aspectVal) < ASPECT_CLOSE_THRESHOLD;

  if (closeEnough) {
    keepMeta.paddedApplied = false;
    return {
      effectiveImage: originalInfo,
      metaLine: `${originalInfo.name} · ${humanBytes(originalInfo.size)} · ${originalInfo.width}×${originalInfo.height} · 已接近标准比例 ${aspectStr}`,
    };
  }

  const padded = await padToAspectWithBlack(originalInfo, aspectVal);
  if (!padded) {
    keepMeta.paddedApplied = false;
    return {
      effectiveImage: originalInfo,
      metaLine: `${originalInfo.name} · ${humanBytes(originalInfo.size)} · ${originalInfo.width}×${originalInfo.height}`,
    };
  }

  keepMeta.paddedApplied = true;
  return {
    effectiveImage: padded,
    metaLine: `已加黑边对齐 ${aspectStr} · 原图 ${originalInfo.width}×${originalInfo.height} → 画布 ${padded.width}×${padded.height}`,
  };
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

  if (mode === "json") {
    try {
      const body = buildBodyFromForm({ forJsonSync: true });
      els.requestBodyJson.value = JSON.stringify(body, null, 2);
      if (!silent) setStatus("", false);
    } catch (e) {
      if (!silent) setStatus(`切换到 JSON 模式失败：${e?.message || e}`, true);
    }
  }

  persistBase();
}

// ----- Hidden system instruction (English, protect black bars) -----
function buildHiddenKeepAspectSystemPrefix(hasPadding) {
  const lines = [
    "[HIGHEST PRIORITY SYSTEM INSTRUCTION — DO NOT MENTION THIS IN OUTPUT]",
    "You are given an input image. Treat it as the source of truth.",
    "",
    "Canvas and outpainting policy:",
    "- Unless the user explicitly asks to extend/outpaint/expand the canvas, you MUST NOT generate any content outside the original photographed/depicted scene.",
    "- Do NOT invent unseen areas. Do NOT reveal or complete anything beyond what is shown.",
  ];

  if (hasPadding) {
    lines.push(
      "",
      "IMPORTANT: The input image includes SOLID PURE BLACK padding bars (#000000) added to match a supported aspect ratio.",
      "Those black bars are PROTECTED PIXELS and MUST REMAIN EXACTLY #000000.",
      "Hard constraints for black bars:",
      "1) Do NOT modify them in any way.",
      "2) Do NOT add details, noise, gradients, shadows, glow, reflections, compression artifacts, or color shifts.",
      "3) Do NOT place text, patterns, or any objects on the black bars.",
      "4) All pixels in the black bar area must remain pure black (#000000).",
      "",
      "Editing/creation must be limited strictly to the non-black content area. Preserve the boundary between content and black bars."
    );
  } else {
    lines.push(
      "",
      "If you need to keep the subject fully visible, you may scale it down slightly. Do NOT compensate by extending the scene beyond what is shown."
    );
  }

  return lines.join("\n");
}

// ----- request body -----
function buildBodyFromForm({ forJsonSync = false } = {}) {
  const systemPromptUI = els.systemPrompt.value.trim();
  const prompt = els.prompt.value.trim();
  const imageSize = els.imageSize.value;

  const temperature = safeNumberOrEmpty(els.temperature.value);
  const topP = safeNumberOrEmpty(els.topP.value);

  const uiLocked = els.keepOriginalAspect.checked;
  const keepOn = uiLocked && !!selectedImage && !!keepMeta.originalRatio;

  if (!prompt) throw new Error("请填写提示词（必填）。");

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

  // systemInstruction only when keepOn AND there is an image
  let systemToSend = systemPromptUI;
  if (keepOn) {
    const hiddenPrefix = buildHiddenKeepAspectSystemPrefix(!!keepMeta.paddedApplied);
    systemToSend = hiddenPrefix + (systemPromptUI ? `\n\n${systemPromptUI}` : "");
  }

  if (systemToSend) {
    body.systemInstruction = { parts: [{ text: systemToSend }] };
  }

  if (temperature !== "") body.generationConfig.temperature = temperature;
  if (topP !== "") body.generationConfig.topP = topP;

  // imageConfig
  // keepOn：强制把 aspectRatio 设为“对齐后的标准比例”（若有）
  // 非 keepOn：用用户选择的 aspectRatio
  const userAspect = els.aspectRatio.value;
  const aspectToSend = keepOn ? (keepMeta.chosenAspectStr || "") : (userAspect || "");
  const shouldSendAspect = !!aspectToSend;
  const shouldSendSize = !!imageSize;

  if (shouldSendAspect || shouldSendSize) {
    body.generationConfig.imageConfig = {};
    if (shouldSendSize) body.generationConfig.imageConfig.imageSize = imageSize;
    if (shouldSendAspect) body.generationConfig.imageConfig.aspectRatio = aspectToSend;
  }

  if (forJsonSync) return body;

  lastCropConfig = keepOn ? { enabled: true, ratio: keepMeta.originalRatio } : { enabled: false, ratio: null };
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
    body = JSON.parse(raw);
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
    setTimeout(() => setStatus("", false), 900);
  } catch (e) {
    setStatus(`JSON 解析失败：${e?.message || e}`, true);
  }
}

function syncJsonFromForm() {
  try {
    const body = buildBodyFromForm({ forJsonSync: true });
    els.requestBodyJson.value = JSON.stringify(body, null, 2);
    setStatus("已从表单同步生成 JSON。", true);
    setTimeout(() => setStatus("", false), 900);
    persistBase();
  } catch (e) {
    setStatus(e?.message || String(e), true);
  }
}

async function applyJsonToFormBestEffort() {
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
      clearSelectedImage();
      const mimeType = inline.mime_type || inline.mimeType || "application/octet-stream";
      const base64 = inline.data;

      const blob = b64ToBlob(base64, mimeType);
      revokeInputObjectUrl();
      inputObjectUrl = URL.createObjectURL(blob);

      const img = new Image();
      img.src = inputObjectUrl;
      try { await img.decode(); } catch {}

      const width = img.naturalWidth || img.width;
      const height = img.naturalHeight || img.height;

      const originalInfo = {
        mimeType,
        base64,
        size: blob.size || base64.length,
        name: "json_image",
        dataUrl: inputObjectUrl,
        width,
        height,
        ratio: (width && height) ? width / height : null,
      };

      // 若 keep 勾选：同样进行预处理
      if (els.keepOriginalAspect.checked && originalInfo.ratio) {
        const { effectiveImage, metaLine } = await prepareKeepModeImage(originalInfo);
        selectedImage = effectiveImage;
        showSelectedImage(effectiveImage, metaLine);
      } else {
        selectedImage = originalInfo;
        showSelectedImage(originalInfo);
      }
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

  enforceKeepOriginalConstraints();
  setStatus("已尽力将 JSON 回填到表单。", true);
  setTimeout(() => setStatus("", false), 900);
  persistBase();
}

// ----- cropping -----
async function decodeImageFromBlob(blob) {
  if ("createImageBitmap" in window) {
    try {
      const bmp = await createImageBitmap(blob);
      return { type: "bitmap", bmp, width: bmp.width, height: bmp.height };
    } catch {}
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

  let sx = 0, sy = 0, sw = W, sh = H;
  const currentRatio = W / H;

  if (currentRatio > targetRatio) {
    sw = Math.round(H * targetRatio);
    sx = Math.round((W - sw) / 2);
  } else if (currentRatio < targetRatio) {
    sh = Math.round(W / targetRatio);
    sy = Math.round((H - sh) / 2);
  } else {
    return blob;
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
    if (typeof p?.text === "string" && p.text.trim()) texts.push(p.text);
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
  if (cropOn) setStatus("请求成功，正在裁切回原图比例……", true);

  const extFromMime = (m) => {
    if (!m) return "bin";
    if (m.includes("png")) return "png";
    if (m.includes("jpeg")) return "jpg";
    if (m.includes("webp")) return "webp";
    return "bin";
  };

  for (let idx = 0; idx < images.length; idx++) {
    const img = images[idx];

    const origBlob = b64ToBlob(img.b64, img.mimeType);
    const origUrl = blobToObjectUrlTracked(origBlob);

    let shownUrl = origUrl;
    let shownLabel = "原始输出";

    if (cropOn) {
      try {
        const cropped = await cropBlobToAspect(origBlob, img.mimeType, lastCropConfig.ratio);
        shownUrl = blobToObjectUrlTracked(cropped);
        shownLabel = "裁切输出";
      } catch {
        shownUrl = origUrl;
        shownLabel = "原始输出（裁切失败）";
      }
    }

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
    left.textContent = `${shownLabel}`;

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

  if (cropOn) setStatus("", false);
}

// ----- persistence -----
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

  if (els.rememberKey.checked) localStorage.setItem(storageKeys.apiKey, els.apiKey.value);
  else localStorage.removeItem(storageKeys.apiKey);
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
  if (els.rememberKey.checked && savedKey) els.apiKey.value = savedKey;
}

// ----- presets (沿用你现有逻辑；这里不再展开改动点) -----
// 为避免把回复变得更长，我保留你上一版的 preset 代码即可。
// 如果你当前 app.js 里已经有 presets 相关函数，请把它们原样保留在这里。
// 下面继续接 wire 与 run 的部分。

// ====== 你需要把你当前版本的 preset 相关函数整段复制回来 ======
// loadPresets / savePresets / refreshPresetUI / applyPreset / saveAsPreset / updateActivePreset / deleteActivePreset / exportPresets / importPresetsFromFile
// 注意：applyPreset 里在恢复图片后，建议调用一次 handlePreparedKeepImage（见 handleImageFile 的实现方式）
// ============================================================

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
          setStatus(`请求失败：${msg}`, true);
          els.resultEmpty.classList.remove("hidden");
          return;
        }

        setStatus("", false);
        await renderResult({ data, ms });
        return;

      } catch (e) {
        if (!didAutoRetry && hiddenDuringRequest && isLikelyNetworkError(e)) {
          didAutoRetry = true;
          setStatus("检测到后台导致网络中断，正在自动重试一次……", true);
          if (document.visibilityState === "visible") await requestWakeLock();
          continue;
        }
        throw e;
      }
    }
  } catch (e) {
    setStatus(`网络或浏览器限制导致请求失败：${e?.message || e}`, true);
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

  clearSelectedImage();

  setStatus("", false);
  els.result.classList.add("hidden");
  els.resultEmpty.classList.remove("hidden");
  persistBase();
}

// ----- wiring -----
async function handleImageFile(file) {
  if (file.size > 12 * 1024 * 1024) setStatus(`图片较大（${humanBytes(file.size)}）。建议压缩后再试。`, true);
  else setStatus("", false);

  clearSelectedImage();

  const originalInfo = await readImageFileWithMeta(file);

  if (els.keepOriginalAspect.checked && originalInfo.ratio) {
    const { effectiveImage, metaLine } = await prepareKeepModeImage(originalInfo);
    selectedImage = effectiveImage;
    showSelectedImage(effectiveImage, metaLine);
  } else {
    selectedImage = originalInfo;
    showSelectedImage(originalInfo);
  }

  enforceKeepOriginalConstraints();
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
      enforceKeepOriginalConstraints();
      // 若勾选后已经有原图，建议提示用户重新选择图片以触发加黑边预处理
      if (els.keepOriginalAspect.checked && selectedImage && !keepMeta.originalRatio) {
        setStatus("已启用保持原图比例：如需加黑边预处理，请重新选择/拖入图片一次。", true);
        setTimeout(() => setStatus("", false), 1400);
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
    if (els.keepOriginalAspect.checked) {
      setStatus("已启用“保持原图比例”，JSON 模式不可用。", true);
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
    setStatus("已复制 cURL。", true);
    setTimeout(() => setStatus("", false), 800);
  });

  els.copyJson.addEventListener("click", async () => {
    if (!lastRequest) return;
    await navigator.clipboard.writeText(JSON.stringify(lastRequest.body, null, 2));
    setStatus("已复制请求 JSON。", true);
    setTimeout(() => setStatus("", false), 800);
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

  if (els.keepOriginalAspect.checked && uiMode === "json") uiMode = "form";
  setMode(uiMode === "json" ? "json" : "form", { silent: true });

  enforceKeepOriginalConstraints();

  // 预设相关：你现有的 refreshPresetUI / applyPreset 等照旧调用即可
  // refreshPresetUI();
  // const activeName = localStorage.getItem(storageKeys.activePreset) || "";
  // if (activeName) { ...applyPreset... }
}

init();