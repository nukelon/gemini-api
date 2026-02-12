// ====================== Models ======================
const MODEL_IMAGE = "gemini-3-pro-image-preview";
const MODEL_DESC  = "gemini-3-pro-preview";

const DEFAULT_HOST = "https://generativelanguage.googleapis.com";
const apiPathFor = (modelId) => `/v1beta/models/${modelId}:generateContent`;

// ====================== utils ======================
const $id = (id) => document.getElementById(id);
const $qs = (sel) => document.querySelector(sel);

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

function timestampTag() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function isLikelyNetworkError(err) {
  const name = String(err?.name || "");
  const msg = String(err?.message || "");
  if (name === "TypeError") return true;
  if (/network/i.test(msg)) return true;
  if (/load failed/i.test(msg)) return true; // Safari
  return false;
}

// ====================== DOM ======================
const els = {
  form: $id("form") || $qs("form"),

  apiHost: $id("apiHost"),
  apiKey: $id("apiKey"),
  rememberKey: $id("rememberKey"),
  useHeaderKey: $id("useHeaderKey"),

  // tabs
  tabGen: $id("tabGen"),
  tabDesc: $id("tabDesc"),
  paneGen: $id("paneGen"),
  paneDesc: $id("paneDesc"),
  presetbar: $id("presetbar"),

  // shared images
  imageFile: $id("imageFile"),
  dropZone: $id("dropZone"),
  imagesPreview: $id("imagesPreview"),
  imagesMeta: $id("imagesMeta"),
  imagesPreviewGrid: $id("imagesPreviewGrid"),
  clearImages: $id("clearImages"),

  // generate mode: json/form switch
  modeForm: $id("modeForm"),
  modeJson: $id("modeJson"),
  formModeWrap: $id("formModeWrap"),
  jsonModeWrap: $id("jsonModeWrap"),

  // describe mode: json/form switch
  descModeForm: $id("descModeForm"),
  descModeJson: $id("descModeJson"),
  descFormModeWrap: $id("descFormModeWrap"),
  descJsonModeWrap: $id("descJsonModeWrap"),

  systemPrompt: $id("systemPrompt"),
  prompt: $id("prompt"),
  aspectRatio: $id("aspectRatio"),
  imageSize: $id("imageSize"),
  temperature: $id("temperature"),
  topP: $id("topP"),

  requestBodyJson: $id("requestBodyJson"),
  jsonFormat: $id("jsonFormat"),
  jsonFromForm: $id("jsonFromForm"),
  jsonToForm: $id("jsonToForm"),

  // generate presets (header)
  presetSelect: $id("presetSelect"),
  presetSave: $id("presetSave"),
  presetUpdate: $id("presetUpdate"),
  presetDelete: $id("presetDelete"),
  presetExport: $id("presetExport"),
  presetImport: $id("presetImport"),

  // describe mode
  descPreset: $id("descPreset"),
  descPrompt: $id("descPrompt"),
  descSystemPrompt: $id("descSystemPrompt"),
  descTemperature: $id("descTemperature"),
  descMediaResolution: $id("descMediaResolution"),
  descThinkingLevel: $id("descThinkingLevel"),
  descRequestBodyJson: $id("descRequestBodyJson"),
  descJsonFormat: $id("descJsonFormat"),
  descJsonFromForm: $id("descJsonFromForm"),
  descJsonToForm: $id("descJsonToForm"),

  // actions
  runBtn: $id("runBtn"),
  resetBtn: $id("resetBtn"),
  status: $id("status"),

  // result
  resultEmpty: $id("resultEmpty"),
  result: $id("result"),
  modelName: $id("modelName"),
  latency: $id("latency"),
  copyCurl: $id("copyCurl"),
  copyJson: $id("copyJson"),
  textOutWrap: $id("textOutWrap"),
  textOut: $id("textOut"),
  imagesOutWrap: $id("imagesOutWrap"),
  imagesOut: $id("imagesOut"),
  rawJson: $id("rawJson"),
};

// ====================== storage keys ======================
// 不改旧 key；只新增：g3_active_tab / g3_desc_* / g3_desc_preset_id
const storageKeys = {
  host: "g3_host",
  rememberKey: "g3_remember_key",
  apiKey: "g3_api_key",
  useHeaderKey: "g3_use_header_key",

  // gen ui mode/json body
  uiMode: "g3_ui_mode",
  requestBodyJson: "g3_request_body_json",

  // desc ui mode/json body
  descUiMode: "g3_desc_ui_mode",
  descRequestBodyJson: "g3_desc_request_body_json",

  // gen fields
  systemPrompt: "g3_system_prompt",
  prompt: "g3_prompt",
  aspectRatio: "g3_aspect_ratio",
  imageSize: "g3_image_size",
  temperature: "g3_temperature",
  topP: "g3_topP",

  // presets
  genPresets: "g3_gen_presets_v2",
  descPresets: "g3_desc_presets_v1",
  activeGenPreset: "g3_active_gen_preset_name",
  activeDescPreset: "g3_active_desc_preset_name",

  // NEW: tabs
  activeTab: "g3_active_tab", // "gen" | "desc"

  // NEW: describe fields
  descPresetId: "g3_desc_preset_id",      // full/background/person/style
  descPrompt: "g3_desc_prompt",
  descSystemPrompt: "g3_desc_system_prompt",
  descTemperature: "g3_desc_temperature",
  descMediaResolution: "g3_desc_media_resolution",
  descThinkingLevel: "g3_desc_thinking_level",
};

// ====================== state ======================
let activeTab = "gen"; // "gen" | "desc"
let uiMode = "form";   // generate: "form" | "json"
let descUiMode = "form"; // describe: "form" | "json"
let selectedImages = []; // [{ mimeType, base64, size, name, dataUrl }]

let lastRequest = null;  // { url, headers, body, modelId }
let outputObjectUrls = [];

// iOS background mitigation
let requestInFlight = false;
let hiddenDuringRequest = false;
let wakeLock = null;

// ====================== status ======================
function setStatus(msg, visible = true) {
  if (!els.status) return;
  els.status.textContent = msg || "";
  els.status.classList.toggle("hidden", !visible);
}

// ====================== wake lock ======================
async function requestWakeLock() {
  try {
    if (!("wakeLock" in navigator)) return;
    if (wakeLock) return;
    wakeLock = await navigator.wakeLock.request("screen");
    wakeLock.addEventListener("release", () => { wakeLock = null; });
  } catch { /* ignore */ }
}
function releaseWakeLock() {
  try { wakeLock?.release?.(); } catch {}
  wakeLock = null;
}

// ====================== images (multi) ======================
async function readImageFile(file) {
  const mimeType = file.type || "application/octet-stream";
  const size = file.size;
  const name = file.name || "image";
  const arrayBuf = await file.arrayBuffer();
  const base64 = base64FromArrayBuffer(arrayBuf);
  const dataUrl = URL.createObjectURL(file); // preview only
  return { mimeType, size, name, base64, dataUrl };
}

function revokeImagePreviewUrls() {
  for (const img of selectedImages) {
    if (img?.dataUrl) URL.revokeObjectURL(img.dataUrl);
  }
}

function clearAllImages() {
  revokeImagePreviewUrls();
  selectedImages = [];
  if (els.imagesPreview) els.imagesPreview.classList.add("hidden");
  if (els.imagesPreviewGrid) els.imagesPreviewGrid.innerHTML = "";
  if (els.imagesMeta) els.imagesMeta.textContent = "";
  if (els.imageFile) els.imageFile.value = "";
}

function removeImageAt(index) {
  const img = selectedImages[index];
  if (img?.dataUrl) URL.revokeObjectURL(img.dataUrl);
  selectedImages.splice(index, 1);
  renderInputImages();
}

function renderInputImages() {
  if (!els.imagesPreview || !els.imagesPreviewGrid || !els.imagesMeta) return;

  if (selectedImages.length === 0) {
    els.imagesPreview.classList.add("hidden");
    els.imagesPreviewGrid.innerHTML = "";
    els.imagesMeta.textContent = "";
    return;
  }

  const total = selectedImages.reduce((acc, x) => acc + (x.size || 0), 0);
  els.imagesMeta.textContent = `已选择 ${selectedImages.length} 张 · 总计 ${humanBytes(total)}`;

  els.imagesPreviewGrid.innerHTML = "";
  selectedImages.forEach((img, idx) => {
    const item = document.createElement("div");
    item.className = "previewitem";

    const im = document.createElement("img");
    im.src = img.dataUrl;
    im.alt = `输入图片 ${idx + 1}`;

    const bar = document.createElement("div");
    bar.className = "previewitem-bar";

    const name = document.createElement("div");
    name.className = "previewitem-name";
    name.textContent = img.name;

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn secondary";
    btn.style.padding = "6px 10px";
    btn.style.fontSize = "12px";
    btn.textContent = "移除";
    btn.addEventListener("click", () => removeImageAt(idx));

    bar.appendChild(name);
    bar.appendChild(btn);

    item.appendChild(im);
    item.appendChild(bar);

    els.imagesPreviewGrid.appendChild(item);
  });

  els.imagesPreview.classList.remove("hidden");
}

async function handleImageFiles(fileList) {
  const files = Array.from(fileList || []).filter(f => (f?.type || "").startsWith("image/") || !f?.type);
  if (!files.length) return;

  const big = files.find(f => f.size > 12 * 1024 * 1024);
  if (big) setStatus(`检测到较大图片（${big.name} · ${humanBytes(big.size)}）。移动端可能较慢。`, true);

  // 追加（不覆盖）
  for (const f of files) {
    const info = await readImageFile(f);
    selectedImages.push(info);
  }
  renderInputImages();
  persistBase();
}

// ====================== output images ======================
function cleanupOutputObjectUrls() {
  for (const u of outputObjectUrls) URL.revokeObjectURL(u);
  outputObjectUrls = [];
}

function b64ToBlobUrl(b64, mimeType) {
  const binary = atob(b64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
  const blob = new Blob([bytes], { type: mimeType || "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  outputObjectUrls.push(url);
  return { url, blob };
}

// ====================== persistence ======================
function persistBase() {
  try {
    localStorage.setItem(storageKeys.host, els.apiHost?.value?.trim?.() || "");
    localStorage.setItem(storageKeys.rememberKey, String(!!els.rememberKey?.checked));
    localStorage.setItem(storageKeys.useHeaderKey, String(!!els.useHeaderKey?.checked));

    localStorage.setItem(storageKeys.activeTab, activeTab);

    // generate UI mode + json body
    localStorage.setItem(storageKeys.uiMode, uiMode);
    localStorage.setItem(storageKeys.requestBodyJson, els.requestBodyJson?.value || "");

    // describe UI mode + json body
    localStorage.setItem(storageKeys.descUiMode, descUiMode);
    localStorage.setItem(storageKeys.descRequestBodyJson, els.descRequestBodyJson?.value || "");

    // generate fields
    localStorage.setItem(storageKeys.systemPrompt, els.systemPrompt?.value || "");
    localStorage.setItem(storageKeys.prompt, els.prompt?.value || "");
    localStorage.setItem(storageKeys.aspectRatio, els.aspectRatio?.value || "");
    localStorage.setItem(storageKeys.imageSize, els.imageSize?.value || "");
    localStorage.setItem(storageKeys.temperature, els.temperature?.value || "");
    localStorage.setItem(storageKeys.topP, els.topP?.value || "");

    // describe fields
    localStorage.setItem(storageKeys.descPresetId, els.descPreset?.value || "full");
    localStorage.setItem(storageKeys.descPrompt, els.descPrompt?.value || "");
    localStorage.setItem(storageKeys.descSystemPrompt, els.descSystemPrompt?.value || "");
    localStorage.setItem(storageKeys.descTemperature, els.descTemperature?.value || "");
    localStorage.setItem(storageKeys.descMediaResolution, els.descMediaResolution?.value || "");
    localStorage.setItem(storageKeys.descThinkingLevel, els.descThinkingLevel?.value || "");

    if (els.rememberKey?.checked) {
      localStorage.setItem(storageKeys.apiKey, els.apiKey?.value || "");
    } else {
      localStorage.removeItem(storageKeys.apiKey);
    }
  } catch { /* ignore */ }
}

function restoreBase() {
  try {
    if (els.apiHost) els.apiHost.value = localStorage.getItem(storageKeys.host) || "";
    if (els.rememberKey) els.rememberKey.checked = (localStorage.getItem(storageKeys.rememberKey) || "false") === "true";
    if (els.useHeaderKey) els.useHeaderKey.checked = (localStorage.getItem(storageKeys.useHeaderKey) || "false") === "true";

    activeTab = localStorage.getItem(storageKeys.activeTab) || "gen";

    uiMode = localStorage.getItem(storageKeys.uiMode) || "form";
    if (els.requestBodyJson) els.requestBodyJson.value = localStorage.getItem(storageKeys.requestBodyJson) || "";

    descUiMode = localStorage.getItem(storageKeys.descUiMode) || "form";
    if (els.descRequestBodyJson) els.descRequestBodyJson.value = localStorage.getItem(storageKeys.descRequestBodyJson) || "";

    if (els.systemPrompt) els.systemPrompt.value = localStorage.getItem(storageKeys.systemPrompt) || "";
    if (els.prompt) els.prompt.value = localStorage.getItem(storageKeys.prompt) || "";
    if (els.aspectRatio) els.aspectRatio.value = localStorage.getItem(storageKeys.aspectRatio) || "";
    if (els.imageSize) els.imageSize.value = localStorage.getItem(storageKeys.imageSize) || "";
    if (els.temperature) els.temperature.value = localStorage.getItem(storageKeys.temperature) || "";
    if (els.topP) els.topP.value = localStorage.getItem(storageKeys.topP) || "";

    if (els.descPreset) els.descPreset.value = localStorage.getItem(storageKeys.descPresetId) || "full";
    if (els.descPrompt) els.descPrompt.value = localStorage.getItem(storageKeys.descPrompt) || "";
    if (els.descSystemPrompt) els.descSystemPrompt.value = localStorage.getItem(storageKeys.descSystemPrompt) || "";
    if (els.descTemperature) els.descTemperature.value = localStorage.getItem(storageKeys.descTemperature) || "";
    if (els.descMediaResolution) els.descMediaResolution.value = localStorage.getItem(storageKeys.descMediaResolution) || "";
    if (els.descThinkingLevel) els.descThinkingLevel.value = localStorage.getItem(storageKeys.descThinkingLevel) || "";

    const savedKey = localStorage.getItem(storageKeys.apiKey) || "";
    if (els.rememberKey?.checked && savedKey && els.apiKey) els.apiKey.value = savedKey;
  } catch { /* ignore */ }
}

// ====================== Tabs ======================
function setActiveTab(tab) {
  activeTab = (tab === "desc") ? "desc" : "gen";

  if (els.tabGen) {
    els.tabGen.classList.toggle("active", activeTab === "gen");
    els.tabGen.setAttribute("aria-selected", String(activeTab === "gen"));
  }
  if (els.tabDesc) {
    els.tabDesc.classList.toggle("active", activeTab === "desc");
    els.tabDesc.setAttribute("aria-selected", String(activeTab === "desc"));
  }

  if (els.paneGen) els.paneGen.classList.toggle("hidden", activeTab !== "gen");
  if (els.paneDesc) els.paneDesc.classList.toggle("hidden", activeTab !== "desc");

  refreshPresetUI();

  // run button label
  if (els.runBtn) els.runBtn.textContent = (activeTab === "desc") ? "反推提示词" : "调用 API 生成";

  if (activeTab === "desc") {
    setDescUiMode(descUiMode);
  } else {
    setUiMode(uiMode);
  }

  // default: describe preset is full, and system prompt auto-filled (only if empty)
  if (activeTab === "desc") {
    const pid = els.descPreset?.value || "full";
    if (els.descSystemPrompt && !els.descSystemPrompt.value.trim()) {
      els.descSystemPrompt.value = DESCRIBE_PRESETS[pid] || DESCRIBE_PRESETS.full;
    }
  }

  persistBase();
}

// ====================== Generate: ui mode switching ======================
function setUiMode(mode) {
  uiMode = (mode === "json") ? "json" : "form";

  // only meaningful inside generate tab; still keep consistent for storage
  if (els.modeForm) {
    els.modeForm.classList.toggle("active", uiMode === "form");
    els.modeForm.setAttribute("aria-selected", String(uiMode === "form"));
  }
  if (els.modeJson) {
    els.modeJson.classList.toggle("active", uiMode === "json");
    els.modeJson.setAttribute("aria-selected", String(uiMode === "json"));
  }
  if (els.formModeWrap) els.formModeWrap.classList.toggle("hidden", uiMode !== "form");
  if (els.jsonModeWrap) els.jsonModeWrap.classList.toggle("hidden", uiMode !== "json");

  // entering JSON mode: generate default from form
  if (activeTab === "gen" && uiMode === "json" && els.requestBodyJson) {
    try {
      const body = buildGenerateBodyFromForm();
      els.requestBodyJson.value = JSON.stringify(body, null, 2);
      setStatus("", false);
    } catch (e) {
      setStatus(`切换到 JSON 模式：无法从表单生成默认 JSON（${e?.message || e}）。你可以直接编辑 JSON。`, true);
    }
  }

  persistBase();
}


function setDescUiMode(mode) {
  descUiMode = (mode === "json") ? "json" : "form";

  if (els.descModeForm) {
    els.descModeForm.classList.toggle("active", descUiMode === "form");
    els.descModeForm.setAttribute("aria-selected", String(descUiMode === "form"));
  }
  if (els.descModeJson) {
    els.descModeJson.classList.toggle("active", descUiMode === "json");
    els.descModeJson.setAttribute("aria-selected", String(descUiMode === "json"));
  }

  if (els.descFormModeWrap) els.descFormModeWrap.classList.toggle("hidden", descUiMode !== "form");
  if (els.descJsonModeWrap) els.descJsonModeWrap.classList.toggle("hidden", descUiMode !== "json");

  if (activeTab === "desc" && descUiMode === "json" && els.descRequestBodyJson) {
    try {
      const body = buildDescribeBodyFromForm();
      els.descRequestBodyJson.value = JSON.stringify(body, null, 2);
      setStatus("", false);
    } catch (e) {
      setStatus(`切换到反推 JSON 模式失败：${e?.message || e}`, true);
    }
  }

  persistBase();
}

function formatDescJsonEditor() {
  const raw = (els.descRequestBodyJson?.value || "").trim();
  if (!raw) { setStatus("反推 JSON 为空。", true); return; }
  try {
    const obj = JSON.parse(raw);
    els.descRequestBodyJson.value = JSON.stringify(obj, null, 2);
    setStatus("已格式化反推 JSON。", true);
    setTimeout(() => setStatus("", false), 900);
  } catch (e) {
    setStatus(`JSON 解析失败：${e?.message || e}`, true);
  }
}

function syncDescJsonFromForm() {
  try {
    const body = buildDescribeBodyFromForm();
    if (els.descRequestBodyJson) els.descRequestBodyJson.value = JSON.stringify(body, null, 2);
    setStatus("已从反推表单同步 JSON。", true);
    setTimeout(() => setStatus("", false), 900);
    persistBase();
  } catch (e) {
    setStatus(e?.message || String(e), true);
  }
}

function applyDescJsonToFormBestEffort() {
  const raw = (els.descRequestBodyJson?.value || "").trim();
  if (!raw) { setStatus("反推 JSON 为空，无法回填。", true); return; }

  let obj;
  try { obj = JSON.parse(raw); }
  catch (e) { setStatus(`JSON 解析失败：${e?.message || e}`, true); return; }

  const sp = obj?.systemInstruction?.parts?.[0]?.text;
  if (typeof sp === "string" && els.descSystemPrompt) els.descSystemPrompt.value = sp;

  const parts = obj?.contents?.[0]?.parts || [];
  let text = "";
  const inlines = [];
  for (const p of parts) {
    if (!text && typeof p?.text === "string") text = p.text;
    const cand = p?.inline_data || p?.inlineData;
    if (cand?.data) inlines.push(cand);
  }
  if (els.descPrompt) els.descPrompt.value = text;

  clearAllImages();
  if (inlines.length) {
    for (const inline of inlines) {
      const mimeType = inline.mime_type || inline.mimeType || "application/octet-stream";
      const base64 = inline.data;
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const blob = new Blob([bytes], { type: mimeType });
      const dataUrl = URL.createObjectURL(blob);
      selectedImages.push({ mimeType, base64, size: blob.size, name: "json_image", dataUrl });
    }
    renderInputImages();
  }

  const gc = obj?.generationConfig || {};
  if (typeof gc.temperature === "number" && els.descTemperature) els.descTemperature.value = String(gc.temperature);
  if (typeof gc.mediaResolution === "string" && els.descMediaResolution) els.descMediaResolution.value = gc.mediaResolution;
  if (typeof gc?.thinkingConfig?.thinkingLevel === "string" && els.descThinkingLevel) {
    els.descThinkingLevel.value = gc.thinkingConfig.thinkingLevel;
  }

  persistBase();
  setStatus("已尝试将反推 JSON 回填到表单。", true);
  setTimeout(() => setStatus("", false), 900);
}

function formatJsonEditor() {
  const raw = (els.requestBodyJson?.value || "").trim();
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
    const body = buildGenerateBodyFromForm();
    if (els.requestBodyJson) els.requestBodyJson.value = JSON.stringify(body, null, 2);
    setStatus("已从表单同步生成 JSON。", true);
    setTimeout(() => setStatus("", false), 900);
    persistBase();
  } catch (e) {
    setStatus(e?.message || String(e), true);
  }
}

function applyJsonToFormBestEffort() {
  const raw = (els.requestBodyJson?.value || "").trim();
  if (!raw) { setStatus("JSON 为空，无法回填。", true); return; }

  let obj;
  try { obj = JSON.parse(raw); }
  catch (e) { setStatus(`JSON 解析失败：${e?.message || e}`, true); return; }

  const sp = obj?.systemInstruction?.parts?.[0]?.text;
  if (typeof sp === "string" && els.systemPrompt) els.systemPrompt.value = sp;

  const parts = obj?.contents?.[0]?.parts || [];
  let text = "";
  const inlines = [];
  for (const p of parts) {
    if (!text && typeof p?.text === "string") text = p.text;
    const cand = p?.inline_data || p?.inlineData;
    if (cand?.data) inlines.push(cand);
  }
  if (els.prompt) els.prompt.value = text;

  // images: overwrite current selection
  clearAllImages();
  if (inlines.length) {
    for (const inline of inlines) {
      const mimeType = inline.mime_type || inline.mimeType || "application/octet-stream";
      const base64 = inline.data;
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const blob = new Blob([bytes], { type: mimeType });
      const dataUrl = URL.createObjectURL(blob);
      selectedImages.push({ mimeType, base64, size: blob.size, name: "json_image", dataUrl });
    }
    renderInputImages();
  }

  const gc = obj?.generationConfig || {};
  if (typeof gc.temperature === "number" && els.temperature) els.temperature.value = String(gc.temperature);
  if (typeof gc.topP === "number" && els.topP) els.topP.value = String(gc.topP);

  const ic = gc.imageConfig || {};
  if (typeof ic.aspectRatio === "string" && els.aspectRatio) els.aspectRatio.value = ic.aspectRatio;
  if (typeof ic.imageSize === "string" && els.imageSize) els.imageSize.value = ic.imageSize;

  setStatus("已尽力将 JSON 回填到表单。", true);
  setTimeout(() => setStatus("", false), 1200);
  persistBase();
}

// ====================== Describe presets (system prompt templates) ======================
// 要求：英文、只输出提示词本体、不输出负面提示词；按预设范围描述；类 Danbooru 标签可选
function baseDescribeSystemPrompt({ focusRule, scopeRule, formatBlock }) {
  return `You are an Image-to-Prompt reverse-engineering assistant.
Your task: analyze one or more reference images and output ONE high-quality English prompt for the image generation model "${MODEL_IMAGE}".

OUTPUT RULES:
- ${focusRule}
- Output only the prompt body. No explanations, no prefacing text, no meta commentary.
- Do not output any negative prompt.
- English only.

QUALITY RULES:
- Be concrete, visual, measurable, and reproducible; avoid vague wording.
- Preserve faithful visual reconstruction rather than adding creative content.
- Keep dense, high-granularity detail inside the allowed scope.
- Use precise nouns/adjectives, quantifiable cues, and clear spatial/material relationships.
- For style/rendering details when in scope, be exceptionally specific: medium traits, line/edge behavior, shape language, shading model, color response, contrast curve, tone mapping, texture fidelity, grain/noise pattern, post-processing artifacts, and overall rendering pipeline feel.
- ${scopeRule}

TAGS POLICY (optional):
- You may add a short "Tags:" line in Danbooru-like style only when it clearly improves prompt usability.
- Tags are optional, and never a replacement for detailed natural-language description.

FORMAT:
${formatBlock}`.trim();
}

const DESCRIBE_PRESETS = {
  full: baseDescribeSystemPrompt({
    focusRule: `Focus = FULL SCENE: describe all major visual dimensions for faithful reconstruction.`,
    scopeRule: `Include subject, action/pose, clothing/accessories, environment, lighting, camera/composition, and very detailed style/rendering traits.`,
    formatBlock: `[Subject]
...
[Action / Pose]
...
[Clothing / Accessories]
...
[Background / Environment]
...
[Lighting]
...
[Camera / Composition]
...
[Style & Rendering]
...
[Quality / Fidelity]
...`
  }),
  background: baseDescribeSystemPrompt({
    focusRule: `Focus = BACKGROUND / ENVIRONMENT ONLY: describe only environment-domain information and omit every non-environment detail.`,
    scopeRule: `Do not describe person identity, pose, clothing, or standalone style-pipeline analysis unless directly visible as environment properties.`,
    formatBlock: `[Background / Environment]
...
[Layout / Architecture / Props]
...
[Materials / Textures]
...
[Lighting / Atmosphere / Weather]
...
[Camera / Framing (environment only)]
...
[Quality / Fidelity]
...`
  }),
  person: baseDescribeSystemPrompt({
    focusRule: `Focus = SUBJECT / PERSON ONLY: describe only person-domain information and omit every non-person detail.`,
    scopeRule: `Do not describe background world-building or standalone style-pipeline analysis; keep all details person-centric.`,
    formatBlock: `[Subject Identity / Appearance]
...
[Face / Hair / Expression]
...
[Body / Pose / Gesture]
...
[Clothing / Accessories]
...
[Surface Detail (skin / fabric / small features)]
...
[Quality / Fidelity]
...`
  }),
  style: baseDescribeSystemPrompt({
    focusRule: `Focus = STYLE & RENDERING ONLY: describe only reusable style/rendering characteristics and omit semantic scene/subject content.`,
    scopeRule: `Do not describe subject/background semantics; provide deep, reusable style/medium/rendering/post-processing characteristics only.`,
    formatBlock: `[Style Family / Medium]
...
[Line / Edge / Shape Language]
...
[Shading / Rendering Behavior]
...
[Color / Contrast / Tone Mapping]
...
[Texture / Grain / Post-processing]
...
[Quality / Fidelity]
...`
  }),
};

function applyDescribePreset(presetId) {
  const pid = DESCRIBE_PRESETS[presetId] ? presetId : "full";
  if (els.descSystemPrompt) els.descSystemPrompt.value = DESCRIBE_PRESETS[pid];
  if (els.descPreset) els.descPreset.value = pid;
  persistBase();
  setStatus(`已应用反推预设：${pid === "full" ? "全图" : pid === "background" ? "仅背景" : pid === "person" ? "仅人物" : "仅风格/画风"}`, true);
  setTimeout(() => setStatus("", false), 900);
}

// ====================== presets ======================
const LOCKED_DESC_PRESET_NAMES = new Set(["全图", "仅背景", "仅人物", "仅风格/画风"]);

function seedDefaultDescPresets() {
  const existing = loadPresetsByTab("desc");
  if (existing.length) return;
  const now = nowISO();
  const defaults = [
    { name: "全图", descPresetId: "full", fields: { descPrompt: "", descSystemPrompt: DESCRIBE_PRESETS.full, temperature: "", mediaResolution: "", thinkingLevel: "" } },
    { name: "仅背景", descPresetId: "background", fields: { descPrompt: "", descSystemPrompt: DESCRIBE_PRESETS.background, temperature: "", mediaResolution: "", thinkingLevel: "" } },
    { name: "仅人物", descPresetId: "person", fields: { descPrompt: "", descSystemPrompt: DESCRIBE_PRESETS.person, temperature: "", mediaResolution: "", thinkingLevel: "" } },
    { name: "仅风格/画风", descPresetId: "style", fields: { descPrompt: "", descSystemPrompt: DESCRIBE_PRESETS.style, temperature: "", mediaResolution: "", thinkingLevel: "" } },
  ].map((x) => ({ ...x, createdAt: now, updatedAt: now, mode: "form", isDefault: true, kind: "desc" }));
  localStorage.setItem(storageKeys.descPresets, JSON.stringify(defaults));
}

function presetKeyByTab(tab){ return tab === "desc" ? storageKeys.descPresets : storageKeys.genPresets; }
function activePresetKeyByTab(tab){ return tab === "desc" ? storageKeys.activeDescPreset : storageKeys.activeGenPreset; }

function loadPresetsByTab(tab) {
  try {
    const raw = localStorage.getItem(presetKeyByTab(tab));
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}
function savePresetsByTab(tab, arr) { localStorage.setItem(presetKeyByTab(tab), JSON.stringify(arr)); }

function makePresetFromCurrentState(tab) {
  if (tab === "desc") {
    return {
      name: "",
      createdAt: nowISO(),
      updatedAt: nowISO(),
      kind: "desc",
      mode: descUiMode,
      descPresetId: els.descPreset?.value || "full",
      fields: {
        descPrompt: els.descPrompt?.value || "",
        descSystemPrompt: els.descSystemPrompt?.value || "",
        temperature: els.descTemperature?.value || "",
        mediaResolution: els.descMediaResolution?.value || "",
        thinkingLevel: els.descThinkingLevel?.value || "",
      },
      requestBodyJson: els.descRequestBodyJson?.value || "",
      isDefault: false,
    };
  }

  return {
    name: "",
    createdAt: nowISO(),
    updatedAt: nowISO(),
    kind: "gen",
    mode: uiMode,
    fields: {
      systemPrompt: els.systemPrompt?.value || "",
      prompt: els.prompt?.value || "",
      aspectRatio: els.aspectRatio?.value || "",
      imageSize: els.imageSize?.value || "",
      temperature: els.temperature?.value || "",
      topP: els.topP?.value || "",
    },
    requestBodyJson: els.requestBodyJson?.value || "",
  };
}

function applyPreset(preset, tab) {
  if (tab === "desc") {
    setDescUiMode(preset.mode === "json" ? "json" : "form");
    const f = preset.fields || {};
    if (els.descPreset) els.descPreset.value = preset.descPresetId || "full";
    if (els.descPrompt) els.descPrompt.value = f.descPrompt ?? "";
    if (els.descSystemPrompt) els.descSystemPrompt.value = f.descSystemPrompt ?? "";
    if (els.descTemperature) els.descTemperature.value = f.temperature ?? "";
    if (els.descMediaResolution) els.descMediaResolution.value = f.mediaResolution ?? "";
    if (els.descThinkingLevel) els.descThinkingLevel.value = f.thinkingLevel ?? "";
    if (typeof preset.requestBodyJson === "string" && els.descRequestBodyJson) els.descRequestBodyJson.value = preset.requestBodyJson;
    persistBase();
    setStatus(`已应用反推预设：${preset.name}`, true);
    setTimeout(() => setStatus("", false), 900);
    return;
  }

  setUiMode(preset.mode === "json" ? "json" : "form");
  const f = preset.fields || {};
  if (els.systemPrompt) els.systemPrompt.value = f.systemPrompt ?? "";
  if (els.prompt) els.prompt.value = f.prompt ?? "";
  if (els.aspectRatio) els.aspectRatio.value = f.aspectRatio ?? "";
  if (els.imageSize) els.imageSize.value = f.imageSize ?? "";
  if (els.temperature) els.temperature.value = f.temperature ?? "";
  if (els.topP) els.topP.value = f.topP ?? "";
  if (typeof preset.requestBodyJson === "string" && els.requestBodyJson) els.requestBodyJson.value = preset.requestBodyJson;
  persistBase();
  setStatus(`已应用图像生成预设：${preset.name}
（Host/Key 不变；图片不随预设切换）`, true);
  setTimeout(() => setStatus("", false), 1100);
}

function refreshPresetUI() {
  const tab = activeTab;
  const presets = loadPresetsByTab(tab);
  const activeName = localStorage.getItem(activePresetKeyByTab(tab)) || "";
  if (!els.presetSelect) return;
  els.presetSelect.innerHTML = "";
  const empty = document.createElement("option");
  empty.value = "";
  empty.textContent = "（无预设）";
  els.presetSelect.appendChild(empty);
  for (const p of presets) {
    if (!p?.name) continue;
    const opt = document.createElement("option");
    opt.value = p.name;
    opt.textContent = p.name;
    if (p.name === activeName) opt.selected = true;
    els.presetSelect.appendChild(opt);
  }
  const activePreset = presets.find((p) => p.name === activeName);
  const hasActive = !!activePreset;
  if (els.presetUpdate) els.presetUpdate.disabled = !hasActive;
  if (els.presetDelete) els.presetDelete.disabled = !hasActive || (tab === "desc" && activePreset?.isDefault);
}

function saveAsPreset() {
  const tab = activeTab;
  const name = (prompt(`请输入${tab === "desc" ? "提示词反推" : "图像生成"}预设名称：`) || "").trim();
  if (!name) return;
  const presets = loadPresetsByTab(tab);
  const idx = presets.findIndex((p) => p.name === name);
  if (idx >= 0 && !confirm(`预设“${name}”已存在，是否覆盖？`)) return;
  const existing = idx >= 0 ? presets[idx] : null;
  const next = makePresetFromCurrentState(tab);
  next.name = name;
  next.createdAt = existing?.createdAt || nowISO();
  next.updatedAt = nowISO();
  if (idx >= 0) presets[idx] = next; else presets.push(next);
  savePresetsByTab(tab, presets);
  localStorage.setItem(activePresetKeyByTab(tab), name);
  refreshPresetUI();
}

function updateActivePreset() {
  const tab = activeTab;
  const name = els.presetSelect?.value || "";
  if (!name) return;
  const presets = loadPresetsByTab(tab);
  const idx = presets.findIndex((p) => p.name === name);
  if (idx < 0) return;
  if (tab === "desc" && presets[idx].isDefault) { setStatus("默认四个预设不可更新。", true); return; }
  if (!confirm(`确认更新预设“${name}”？`)) return;
  const next = makePresetFromCurrentState(tab);
  next.name = name;
  next.createdAt = presets[idx].createdAt || nowISO();
  next.updatedAt = nowISO();
  next.isDefault = !!presets[idx].isDefault;
  presets[idx] = next;
  savePresetsByTab(tab, presets);
  refreshPresetUI();
}

function deleteActivePreset() {
  const tab = activeTab;
  const name = els.presetSelect?.value || "";
  if (!name) return;
  const presets = loadPresetsByTab(tab);
  const target = presets.find((p) => p.name === name);
  if (tab === "desc" && target?.isDefault) { setStatus("默认四个预设不可删除。", true); return; }
  if (!confirm(`确认删除预设“${name}”？该操作不可撤销。`)) return;
  savePresetsByTab(tab, presets.filter((p) => p.name !== name));
  localStorage.removeItem(activePresetKeyByTab(tab));
  refreshPresetUI();
}

function exportAllPresets() {
  const payload = {
    version: 4,
    exportedAt: nowISO(),
    genPresets: loadPresetsByTab("gen"),
    descPresets: loadPresetsByTab("desc"),
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `gemini3_all_presets_${timestampTag()}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  setStatus("已批量导出所有模式预设。", true);
}

async function importAllPresetsFromFile(file) {
  if (!file) return;
  let text = "";
  try { text = await file.text(); } catch (e) { setStatus(`读取导入文件失败：${e?.message || e}`, true); return; }
  let obj;
  try { obj = JSON.parse(text); } catch (e) { setStatus(`导入失败：JSON 解析错误：${e?.message || e}`, true); return; }

  const incomingGen = Array.isArray(obj?.genPresets) ? obj.genPresets : [];
  const incomingDesc = Array.isArray(obj?.descPresets) ? obj.descPresets : [];

  if (incomingGen.length) savePresetsByTab("gen", incomingGen);
  if (incomingDesc.length) {
    const merged = [...incomingDesc];
    const names = new Set(merged.map((x) => x.name));
    for (const n of LOCKED_DESC_PRESET_NAMES) {
      if (!names.has(n)) {
        const id = n === "全图" ? "full" : n === "仅背景" ? "background" : n === "仅人物" ? "person" : "style";
        merged.push({ name: n, descPresetId: id, mode: "form", isDefault: true, kind: "desc", createdAt: nowISO(), updatedAt: nowISO(), fields: { descPrompt: "", descSystemPrompt: DESCRIBE_PRESETS[id], temperature: "", mediaResolution: "", thinkingLevel: "" }, requestBodyJson: "" });
      }
    }
    savePresetsByTab("desc", merged);
  }

  refreshPresetUI();
  setStatus("已批量导入预设。", true);
}

// ====================== Request building ======================
function buildCommonRequestBase(modelId) {
  const host = stripTrailingSlash((els.apiHost?.value || "").trim() || DEFAULT_HOST);
  const apiKey = (els.apiKey?.value || "").trim();
  const useHeaderKey = !!els.useHeaderKey?.checked;

  if (!apiKey) throw new Error("请填写 API Key。");

  const path = apiPathFor(modelId);
  const url = useHeaderKey
    ? `${host}${path}`
    : `${host}${path}?key=${encodeURIComponent(apiKey)}`;

  const headers = { "Content-Type": "application/json" };
  if (useHeaderKey) headers["x-goog-api-key"] = apiKey;

  return { url, headers };
}

// --- generate body ---
function buildGenerateBodyFromForm() {
  const systemPrompt = (els.systemPrompt?.value || "").trim();
  const prompt = (els.prompt?.value || ""); // allow empty
  const aspectRatio = els.aspectRatio?.value || "";
  const imageSize = els.imageSize?.value || "";

  const temperature = safeNumberOrEmpty(els.temperature?.value);
  const topP = safeNumberOrEmpty(els.topP?.value);

  const parts = [{ text: prompt }];

  for (const img of selectedImages) {
    parts.push({ inline_data: { mime_type: img.mimeType, data: img.base64 } });
  }

  const body = {
    contents: [{ role: "user", parts }],
    generationConfig: { responseModalities: ["Image"] },
  };

  if (systemPrompt) body.systemInstruction = { parts: [{ text: systemPrompt }] };
  if (temperature !== "") body.generationConfig.temperature = temperature;
  if (topP !== "") body.generationConfig.topP = topP;

  if (aspectRatio || imageSize) {
    body.generationConfig.imageConfig = {};
    if (aspectRatio) body.generationConfig.imageConfig.aspectRatio = aspectRatio;
    if (imageSize) body.generationConfig.imageConfig.imageSize = imageSize;
  }

  return body;
}

// --- describe body ---
function buildDescribeBodyFromForm() {
  if (selectedImages.length === 0) {
    throw new Error("提示词反推模式要求至少上传 1 张图片。");
  }

  const sys = (els.descSystemPrompt?.value || "").trim();
  const userPrompt = (els.descPrompt?.value || "");
  const temperature = safeNumberOrEmpty(els.descTemperature?.value);
  const mediaResolution = els.descMediaResolution?.value || "";
  const thinkingLevel = els.descThinkingLevel?.value || "";

  const parts = [{ text: userPrompt }];
  for (const img of selectedImages) {
    parts.push({ inline_data: { mime_type: img.mimeType, data: img.base64 } });
  }

  const body = { contents: [{ role: "user", parts }] };
  if (sys) body.systemInstruction = { parts: [{ text: sys }] };

  const generationConfig = {};
  if (temperature !== "") generationConfig.temperature = temperature;
  if (mediaResolution) generationConfig.mediaResolution = mediaResolution;
  if (thinkingLevel) generationConfig.thinkingConfig = { thinkingLevel };
  if (Object.keys(generationConfig).length) body.generationConfig = generationConfig;

  return body;
}

function buildRequest() {
  if (activeTab === "desc") {
    const modelId = MODEL_DESC;
    const base = buildCommonRequestBase(modelId);
    let body;
    if (descUiMode === "json") {
      const raw = (els.descRequestBodyJson?.value || "").trim();
      if (!raw) throw new Error("反推 JSON 为空。请填写请求体 JSON 或切回表单模式。");
      try { body = JSON.parse(raw); }
      catch (e) { throw new Error(`反推 JSON 解析失败：${e?.message || e}`); }
    } else {
      body = buildDescribeBodyFromForm();
    }
    return { ...base, body, modelId };
  }

  // generate tab
  const modelId = MODEL_IMAGE;
  const base = buildCommonRequestBase(modelId);

  let body;
  if (uiMode === "json") {
    const raw = (els.requestBodyJson?.value || "").trim();
    if (!raw) throw new Error("JSON 模式下请求体不能为空。");
    try { body = JSON.parse(raw); }
    catch (e) { throw new Error(`JSON 解析失败：${e?.message || e}`); }
  } else {
    body = buildGenerateBodyFromForm();
  }

  return { ...base, body, modelId };
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

// ====================== render result ======================
function renderResult({ data, ms, modelId }) {
  if (els.resultEmpty) els.resultEmpty.classList.add("hidden");
  if (els.result) els.result.classList.remove("hidden");

  if (els.modelName) els.modelName.textContent = modelId;
  if (els.latency) els.latency.textContent = `${ms.toFixed(0)} ms`;
  if (els.rawJson) els.rawJson.textContent = JSON.stringify(data, null, 2);

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

  if (els.textOutWrap && els.textOut) {
    if (texts.length) {
      els.textOutWrap.classList.remove("hidden");
      els.textOut.textContent = texts.join("\n\n---\n\n");
    } else {
      els.textOutWrap.classList.add("hidden");
      els.textOut.textContent = "";
    }
  }

  if (els.imagesOut) els.imagesOut.innerHTML = "";
  cleanupOutputObjectUrls();

  if (els.imagesOutWrap && els.imagesOut) {
    if (images.length) {
      els.imagesOutWrap.classList.remove("hidden");
      const tag = timestampTag();

      images.forEach((img, idx) => {
        const { url } = b64ToBlobUrl(img.b64, img.mimeType);
        const ext =
          img.mimeType.includes("png") ? "png" :
          img.mimeType.includes("jpeg") ? "jpg" :
          img.mimeType.includes("webp") ? "webp" : "bin";

        const filename = `gemini3_${modelId}_${tag}_${String(idx + 1).padStart(2, "0")}.${ext}`;

        const card = document.createElement("div");
        card.className = "imgcard";

        const imageEl = document.createElement("img");
        imageEl.src = url;
        imageEl.alt = `输出图片 ${idx + 1}`;

        const bar = document.createElement("div");
        bar.className = "bar";

        const left = document.createElement("div");
        left.textContent = `${img.mimeType || "image"} · ${filename}`;
        left.style.color = "rgba(233,237,245,0.85)";
        left.style.fontSize = "12px";

        const right = document.createElement("div");
        right.style.display = "flex";
        right.style.gap = "12px";
        right.style.flexWrap = "wrap";
        right.style.alignItems = "center";

        const openA = document.createElement("a");
        openA.className = "link";
        openA.href = url;
        openA.target = "_blank";
        openA.rel = "noopener";
        openA.textContent = "打开原图";

        const dlA = document.createElement("a");
        dlA.className = "link";
        dlA.href = url;
        dlA.download = filename;
        dlA.textContent = "下载";

        right.appendChild(openA);
        right.appendChild(dlA);

        bar.appendChild(left);
        bar.appendChild(right);

        card.appendChild(imageEl);
        card.appendChild(bar);

        els.imagesOut.appendChild(card);
      });
    } else {
      els.imagesOutWrap.classList.add("hidden");
    }
  }
}

// ====================== run ======================
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
  setStatus(activeTab === "desc" ? "正在反推提示词……" : "正在请求模型生成……", true);

  if (els.resultEmpty) els.resultEmpty.classList.add("hidden");
  if (els.result) els.result.classList.add("hidden");
  if (els.textOutWrap) els.textOutWrap.classList.add("hidden");
  if (els.imagesOutWrap) els.imagesOutWrap.classList.add("hidden");
  if (els.rawJson) els.rawJson.textContent = "";
  cleanupOutputObjectUrls();

  let req;
  try { req = buildRequest(); }
  catch (e) {
    setStatus(e?.message || String(e), true);
    if (els.resultEmpty) els.resultEmpty.classList.remove("hidden");
    return;
  }

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
          if (els.resultEmpty) els.resultEmpty.classList.remove("hidden");
          return;
        }

        setStatus("", false);
        renderResult({ data, ms, modelId: req.modelId });
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
      `网络或浏览器限制导致请求失败：${e?.message || e}\n\n（提示：iOS Safari 后台可能冻结网络；建议尽量保持前台完成一次请求。）`,
      true
    );
    if (els.resultEmpty) els.resultEmpty.classList.remove("hidden");
  } finally {
    requestInFlight = false;
    hiddenDuringRequest = false;
    releaseWakeLock();
  }
}

// ====================== reset ======================
function resetNonFixedFields() {
  // shared
  clearAllImages();

  // gen fields
  if (els.systemPrompt) els.systemPrompt.value = "";
  if (els.prompt) els.prompt.value = "";
  if (els.aspectRatio) els.aspectRatio.value = "";
  if (els.imageSize) els.imageSize.value = "";
  if (els.temperature) els.temperature.value = "";
  if (els.topP) els.topP.value = "";
  if (els.requestBodyJson) els.requestBodyJson.value = "";

  // desc fields: default full preset
  if (els.descPreset) els.descPreset.value = "full";
  if (els.descPrompt) els.descPrompt.value = "";
  if (els.descSystemPrompt) els.descSystemPrompt.value = DESCRIBE_PRESETS.full;
  if (els.descTemperature) els.descTemperature.value = "";
  if (els.descMediaResolution) els.descMediaResolution.value = "";
  if (els.descThinkingLevel) els.descThinkingLevel.value = "";
  if (els.descRequestBodyJson) els.descRequestBodyJson.value = "";

  setUiMode("form");
  setDescUiMode("form");

  setStatus("", false);
  if (els.result) els.result.classList.add("hidden");
  if (els.resultEmpty) els.resultEmpty.classList.remove("hidden");
  persistBase();
}

// ====================== wiring ======================
function wireEvents() {
  if (!els.form) {
    setStatus("初始化失败：未找到 form 元素。请确认 index.html 中 <form id=\"form\"> 存在。", true);
    return;
  }

  // persist on change
  ["input", "change"].forEach((evt) => {
    els.apiHost?.addEventListener(evt, persistBase);
    els.apiKey?.addEventListener(evt, persistBase);
    els.rememberKey?.addEventListener(evt, persistBase);
    els.useHeaderKey?.addEventListener(evt, persistBase);

    els.systemPrompt?.addEventListener(evt, persistBase);
    els.prompt?.addEventListener(evt, persistBase);
    els.aspectRatio?.addEventListener(evt, persistBase);
    els.imageSize?.addEventListener(evt, persistBase);
    els.temperature?.addEventListener(evt, persistBase);
    els.topP?.addEventListener(evt, persistBase);
    els.requestBodyJson?.addEventListener(evt, persistBase);

    els.descPreset?.addEventListener(evt, persistBase);
    els.descPrompt?.addEventListener(evt, persistBase);
    els.descSystemPrompt?.addEventListener(evt, persistBase);
    els.descTemperature?.addEventListener(evt, persistBase);
    els.descMediaResolution?.addEventListener(evt, persistBase);
    els.descThinkingLevel?.addEventListener(evt, persistBase);
    els.descRequestBodyJson?.addEventListener(evt, persistBase);
  });

  els.rememberKey?.addEventListener("change", () => {
    if (!els.rememberKey.checked) localStorage.removeItem(storageKeys.apiKey);
    else localStorage.setItem(storageKeys.apiKey, els.apiKey?.value || "");
  });

  els.apiKey?.addEventListener("input", () => {
    if (els.rememberKey?.checked) localStorage.setItem(storageKeys.apiKey, els.apiKey.value);
  });

  // tabs
  els.tabGen?.addEventListener("click", () => setActiveTab("gen"));
  els.tabDesc?.addEventListener("click", () => setActiveTab("desc"));

  // gen/desc ui mode
  els.modeForm?.addEventListener("click", () => setUiMode("form"));
  els.modeJson?.addEventListener("click", () => setUiMode("json"));
  els.descModeForm?.addEventListener("click", () => setDescUiMode("form"));
  els.descModeJson?.addEventListener("click", () => setDescUiMode("json"));

  // json tools
  els.jsonFormat?.addEventListener("click", formatJsonEditor);
  els.jsonFromForm?.addEventListener("click", syncJsonFromForm);
  els.jsonToForm?.addEventListener("click", applyJsonToFormBestEffort);
  els.descJsonFormat?.addEventListener("click", formatDescJsonEditor);
  els.descJsonFromForm?.addEventListener("click", syncDescJsonFromForm);
  els.descJsonToForm?.addEventListener("click", applyDescJsonToFormBestEffort);

  // describe preset: overwrite system prompt
  els.descPreset?.addEventListener("change", () => {
    const pid = els.descPreset.value || "full";
    applyDescribePreset(pid);
  });

  // drag & drop
  const onDrag = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (els.dropZone) els.dropZone.style.borderColor = "rgba(140, 160, 255, 0.45)";
  };
  const onLeave = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (els.dropZone) els.dropZone.style.borderColor = "rgba(255,255,255,0.2)";
  };

  els.dropZone?.addEventListener("dragenter", onDrag);
  els.dropZone?.addEventListener("dragover", onDrag);
  els.dropZone?.addEventListener("dragleave", onLeave);
  els.dropZone?.addEventListener("drop", async (e) => {
    onLeave(e);
    const files = e.dataTransfer?.files;
    if (files?.length) await handleImageFiles(files);
  });

  els.imageFile?.addEventListener("change", async () => {
    const files = els.imageFile.files;
    if (files?.length) await handleImageFiles(files);
  });

  els.clearImages?.addEventListener("click", () => {
    clearAllImages();
    persistBase();
  });

  // submit 防刷新
  els.form.addEventListener("submit", async (e) => {
    e.preventDefault();
    e.stopPropagation();

    if (els.runBtn) els.runBtn.disabled = true;
    try { await run(); }
    finally { if (els.runBtn) els.runBtn.disabled = false; }
  });

  els.resetBtn?.addEventListener("click", resetNonFixedFields);

  els.copyCurl?.addEventListener("click", async () => {
    if (!lastRequest) return;
    await navigator.clipboard.writeText(makeCurl(lastRequest));
    setStatus("已复制 cURL 到剪贴板。", true);
    setTimeout(() => setStatus("", false), 900);
  });

  els.copyJson?.addEventListener("click", async () => {
    if (!lastRequest) return;
    await navigator.clipboard.writeText(JSON.stringify(lastRequest.body, null, 2));
    setStatus("已复制请求 JSON 到剪贴板。", true);
    setTimeout(() => setStatus("", false), 900);
  });

  // presets (all modes)
  els.presetSelect?.addEventListener("change", () => {
    const tab = activeTab;
    const name = els.presetSelect.value || "";
    if (!name) {
      localStorage.removeItem(activePresetKeyByTab(tab));
      refreshPresetUI();
      return;
    }
    localStorage.setItem(activePresetKeyByTab(tab), name);
    const presets = loadPresetsByTab(tab);
    const p = presets.find(x => x.name === name);
    if (p) applyPreset(p, tab);
    refreshPresetUI();
  });

  els.presetSave?.addEventListener("click", saveAsPreset);
  els.presetUpdate?.addEventListener("click", updateActivePreset);
  els.presetDelete?.addEventListener("click", deleteActivePreset);
  els.presetExport?.addEventListener("click", exportAllPresets);

  els.presetImport?.addEventListener("change", async () => {
    const f = els.presetImport.files?.[0];
    els.presetImport.value = "";
    await importAllPresetsFromFile(f);
  });

  // iOS background
  document.addEventListener("visibilitychange", async () => {
    if (requestInFlight && document.visibilityState === "hidden") hiddenDuringRequest = true;
    if (requestInFlight && document.visibilityState === "visible") await requestWakeLock();
  });
}

// ====================== init ======================
function init() {
  restoreBase();
  wireEvents();
  seedDefaultDescPresets();
  refreshPresetUI();
  renderInputImages();

  // ensure describe preset default = full
  const pid = els.descPreset?.value || "full";
  if (els.descSystemPrompt && !els.descSystemPrompt.value.trim()) {
    els.descSystemPrompt.value = DESCRIBE_PRESETS[pid] || DESCRIBE_PRESETS.full;
  }

  // apply stored modes/tab
  setUiMode(uiMode);
  setDescUiMode(descUiMode);
  setActiveTab(activeTab);

  // if entering desc tab, ensure system prompt consistent with selected preset if empty
  if (activeTab === "desc" && els.descSystemPrompt && !els.descSystemPrompt.value.trim()) {
    applyDescribePreset(els.descPreset?.value || "full");
  }
}

// 防止初始化异常导致“事件未绑定 -> 刷新/上传失效/参数丢失”
try {
  init();
} catch (e) {
  setStatus(`初始化异常：${e?.message || e}\n请确认三个文件已完整替换且无残缺。`, true);
}
