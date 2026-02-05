// ====================== Models / Modes ======================
const TASK_GENERATE = "generate";   // gemini-3-pro-image-preview
const TASK_DESCRIBE = "describe";   // gemini-3-pro-preview (image->prompt)

const MODELS = {
  [TASK_GENERATE]: "gemini-3-pro-image-preview",
  [TASK_DESCRIBE]: "gemini-3-pro-preview",
};

const SPECIAL_PRESET_ID = "__SPECIAL_IMAGE_TO_PROMPT__";
const SPECIAL_PRESET_LABEL = "✨ 反推提示词（gemini-3-pro-preview · 不可删除）";

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

// ====================== DOM (with fallbacks) ======================
const els = {
  form: $id("form") || $qs("form"),

  apiHost: $id("apiHost"),
  apiKey: $id("apiKey"),
  rememberKey: $id("rememberKey"),
  useHeaderKey: $id("useHeaderKey"),

  modeForm: $id("modeForm"),
  modeJson: $id("modeJson"),
  formModeWrap: $id("formModeWrap"),
  jsonModeWrap: $id("jsonModeWrap"),

  systemPrompt: $id("systemPrompt"),
  prompt: $id("prompt"),

  // describe-only
  describeTargetWrap: $id("describeTargetWrap"),
  describeTarget: $id("describeTarget"),

  // multi-image
  imageFile: $id("imageFile"),
  dropZone: $id("dropZone"),
  imagesPreview: $id("imagesPreview"),
  imagesMeta: $id("imagesMeta"),
  imagesPreviewGrid: $id("imagesPreviewGrid"),
  clearImages: $id("clearImages"),

  // generate-only
  aspectRatio: $id("aspectRatio"),
  imageSize: $id("imageSize"),
  temperature: $id("temperature"),
  topP: $id("topP"),

  // json editor
  requestBodyJson: $id("requestBodyJson"),
  jsonFormat: $id("jsonFormat"),
  jsonFromForm: $id("jsonFromForm"),
  jsonToForm: $id("jsonToForm"),

  // presets
  presetSelect: $id("presetSelect"),
  presetSave: $id("presetSave"),
  presetUpdate: $id("presetUpdate"),
  presetDelete: $id("presetDelete"),
  presetExport: $id("presetExport"),
  presetImport: $id("presetImport"),

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

// ====================== storage keys (不改旧 key；只新增少量) ======================
const storageKeys = {
  host: "g3_host",
  rememberKey: "g3_remember_key",
  apiKey: "g3_api_key",
  useHeaderKey: "g3_use_header_key",

  uiMode: "g3_ui_mode",
  requestBodyJson: "g3_request_body_json",

  systemPrompt: "g3_system_prompt",
  prompt: "g3_prompt", // 你前一版已引入
  aspectRatio: "g3_aspect_ratio",
  imageSize: "g3_image_size",
  temperature: "g3_temperature",
  topP: "g3_topP",

  // NEW
  taskMode: "g3_task_mode",
  describeTarget: "g3_describe_target",

  presets: "g3_presets_v1",
  activePreset: "g3_active_preset_name",
};

// ====================== state ======================
let uiMode = "form";               // "form" | "json"
let taskMode = TASK_GENERATE;      // generate | describe
let selectedImages = [];           // [{ mimeType, base64, size, name, dataUrl }]
let lastRequest = null;            // { url, headers, body, modelId }
let outputObjectUrls = [];         // blob URLs for output images

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

// ====================== wake lock (best-effort) ======================
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

  // 追加模式（不覆盖）
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

    localStorage.setItem(storageKeys.uiMode, uiMode);
    localStorage.setItem(storageKeys.requestBodyJson, els.requestBodyJson?.value || "");

    localStorage.setItem(storageKeys.systemPrompt, els.systemPrompt?.value || "");
    localStorage.setItem(storageKeys.prompt, els.prompt?.value || "");
    localStorage.setItem(storageKeys.aspectRatio, els.aspectRatio?.value || "");
    localStorage.setItem(storageKeys.imageSize, els.imageSize?.value || "");
    localStorage.setItem(storageKeys.temperature, els.temperature?.value || "");
    localStorage.setItem(storageKeys.topP, els.topP?.value || "");

    // NEW
    localStorage.setItem(storageKeys.taskMode, taskMode);
    localStorage.setItem(storageKeys.describeTarget, els.describeTarget?.value || "full");

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

    uiMode = (localStorage.getItem(storageKeys.uiMode) || "form");
    if (els.requestBodyJson) els.requestBodyJson.value = localStorage.getItem(storageKeys.requestBodyJson) || "";

    if (els.systemPrompt) els.systemPrompt.value = localStorage.getItem(storageKeys.systemPrompt) || "";
    if (els.prompt) els.prompt.value = localStorage.getItem(storageKeys.prompt) || "";
    if (els.aspectRatio) els.aspectRatio.value = localStorage.getItem(storageKeys.aspectRatio) || "";
    if (els.imageSize) els.imageSize.value = localStorage.getItem(storageKeys.imageSize) || "";
    if (els.temperature) els.temperature.value = localStorage.getItem(storageKeys.temperature) || "";
    if (els.topP) els.topP.value = localStorage.getItem(storageKeys.topP) || "";

    // NEW
    taskMode = (localStorage.getItem(storageKeys.taskMode) || TASK_GENERATE);
    if (els.describeTarget) els.describeTarget.value = localStorage.getItem(storageKeys.describeTarget) || "full";

    const savedKey = localStorage.getItem(storageKeys.apiKey) || "";
    if (els.rememberKey?.checked && savedKey && els.apiKey) els.apiKey.value = savedKey;
  } catch { /* ignore */ }
}

// ====================== UI mode switching ======================
function setUiMode(mode) {
  uiMode = mode === "json" ? "json" : "form";

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

  if (uiMode === "json" && els.requestBodyJson) {
    try {
      const body = buildBodyFromForm();
      els.requestBodyJson.value = JSON.stringify(body, null, 2);
      setStatus("", false);
    } catch (e) {
      setStatus(`切换到 JSON 模式：无法从表单生成默认 JSON（${e?.message || e}）。你可以直接编辑 JSON。`, true);
    }
  }

  persistBase();
}

function setTaskMode(mode) {
  taskMode = (mode === TASK_DESCRIBE) ? TASK_DESCRIBE : TASK_GENERATE;

  // toggle describe-only fields
  document.querySelectorAll(".describeOnly").forEach(el => {
    el.classList.toggle("hidden", taskMode !== TASK_DESCRIBE);
  });
  // toggle generate-only fields
  document.querySelectorAll(".genOnly").forEach(el => {
    el.classList.toggle("hidden", taskMode !== TASK_GENERATE);
  });

  if (els.runBtn) {
    els.runBtn.textContent = (taskMode === TASK_DESCRIBE) ? "反推提示词" : "调用 API 生成";
  }

  // 若进入反推模式且系统提示为空，给一个默认高质量“反推指令”
  if (taskMode === TASK_DESCRIBE && els.systemPrompt && !els.systemPrompt.value.trim()) {
    els.systemPrompt.value = DEFAULT_DESCRIBE_SYSTEM_PROMPT;
  }

  persistBase();
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
    const body = buildBodyFromForm();
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

  // system
  const sp = obj?.systemInstruction?.parts?.[0]?.text;
  if (typeof sp === "string" && els.systemPrompt) els.systemPrompt.value = sp;

  // parts: text + images
  const parts = obj?.contents?.[0]?.parts || [];
  let text = "";
  const inlines = [];
  for (const p of parts) {
    if (!text && typeof p?.text === "string") text = p.text;
    const cand = p?.inline_data || p?.inlineData;
    if (cand?.data) inlines.push(cand);
  }
  if (els.prompt) els.prompt.value = text; // 允许为空

  // images: 回填会覆盖当前选择
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

  // generation config (仅图像模式字段)
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

// ====================== Describe Prompt Templates ======================
const DEFAULT_DESCRIBE_SYSTEM_PROMPT =
`你是“图像提示词反推（Image-to-Prompt）”专家与电影级美术指导。
目标：根据用户输入图片，反推出可直接用于 gemini-3-pro-image-preview 生成/复刻的超详细提示词。
要求：
- 输出必须极其具体、细粒度、可执行，尤其“风格/画风”要用尽可能最详细的语言描述。
- 必须给出结构化结果，包含：Prompt（中文）、Prompt（English）、Negative Prompt（可选）、Style/Rendering 细节清单、相机/镜头/构图、光照、色彩、材质、环境氛围等。
- 只描述图片中能推断到的内容；如果不确定，用“可能/倾向于/类似于”表达，不要编造具体品牌或真实人物身份。
- 重点是让另一个模型能复现“视觉效果”，不仅是物体名词。`;

// 5种模式聚焦说明
function focusHintFor(target) {
  switch (target) {
    case "background":
      return "聚焦背景/环境：场景类型、空间结构、材质、光照、天气、氛围、细节陈设；弱化或忽略人物/主体。";
    case "person":
      return "聚焦人物/主体：外观、年龄段、体型、姿态、动作、表情、发型、服饰、配饰、肤色与纹理细节；背景仅做最低限度说明。";
    case "style":
      return "聚焦风格体系：艺术流派/时代感/审美取向、构图语言、色彩策略、光影风格、质感与媒介；给出可迁移“风格模板”，让任何主体都能套用。";
    case "rendering":
      return "聚焦画风/渲染：笔触、线稿、上色方式、阴影算法、边缘处理、颗粒/噪点、胶片/镜头瑕疵、纹理叠加、锐化与景深、HDR/对比曲线等极细节。";
    case "full":
    default:
      return "全图完整复刻：主体+动作+背景+构图+镜头+光照+色彩+材质+风格/画风（必须极其详细）。";
  }
}

function buildDescribeDirective() {
  const target = els.describeTarget?.value || "full";
  const userHint = (els.prompt?.value || "").trim();

  return `
你将收到 1~多张参考图片。请完成“反推提示词”任务，并严格按以下格式输出（Markdown）：

## 1) Prompt（中文，给 gemini-3-pro-image-preview）
- 输出为一段可直接复制使用的、超详细提示词（不要解释，不要加前缀）。
- 必须包含：主体/动作/姿态、背景/场景、构图、镜头与摄影参数（如焦段、景深、机位）、光照、色彩、材质细节、氛围、风格/画风（极其详细）、画质与细节层级、需要避免的歧义。

## 2) Prompt（English, for gemini-3-pro-image-preview）
- 与中文 Prompt 等价，尽量使用行业常用术语，保证可复现风格与质感。

## 3) Negative Prompt（可选）
- 列出应避免的元素与常见瑕疵（例如：extra fingers, blurry, low-res, artifacts, watermark 等），但不要过度胡乱添加。

## 4) Style / Rendering 细节清单（必须非常细）
- 用项目符号列出：画风媒介（摄影/插画/3D/油画/赛璐璐等）、笔触/线条、纹理、颗粒、对比曲线、调色倾向、边缘与轮廓处理、光影模型、反射/折射、噪点与胶片感、后期风格等。

## 5) Composition / Camera / Lighting
- 分别描述：构图规则、主体在画面位置、镜头视角、景深、光源方向与软硬、色温、环境光、阴影特征。

聚焦要求：${focusHintFor(target)}
${userHint ? `用户补充要求：${userHint}` : "用户补充要求：无（可为空）。"}

注意：
- 你的输出目标是“让 gemini-3-pro-image-preview 能复刻视觉效果”，所以风格/画风请用尽可能最细、最具体的语言，不要只写“赛博朋克/写实/二次元”这种泛词。
- 不要输出与任务无关的解释段落。`;
}

// ====================== request building ======================
function buildBodyFromForm() {
  const systemPrompt = (els.systemPrompt?.value || "").trim();
  const prompt = (els.prompt?.value || ""); // 允许空
  const parts = [{ text: prompt }];

  // 多图：按顺序追加
  for (const img of selectedImages) {
    parts.push({
      inline_data: { mime_type: img.mimeType, data: img.base64 },
    });
  }

  if (taskMode === TASK_DESCRIBE) {
    // 反推模式：文本模型 + 指令文本（把指令放到 user text 前面更稳）
    if (selectedImages.length === 0) {
      throw new Error("反推提示词模式要求至少上传 1 张图片。");
    }

    const directive = buildDescribeDirective();
    const describeParts = [{ text: directive }];

    for (const img of selectedImages) {
      describeParts.push({
        inline_data: { mime_type: img.mimeType, data: img.base64 },
      });
    }

    // 仍允许用户 prompt 为空；用户补充要求已在 directive 中引用
    const body = {
      contents: [{
        role: "user",
        parts: describeParts,
      }],
    };

    // systemInstruction：用户系统提示 + 默认反推系统提示
    const combinedSystem = `${systemPrompt ? systemPrompt + "\n\n" : ""}${DEFAULT_DESCRIBE_SYSTEM_PROMPT}`;
    if (combinedSystem.trim()) {
      body.systemInstruction = { parts: [{ text: combinedSystem }] };
    }

    // 不强行设置 responseModalities（默认文本），避免兼容性问题
    return body;
  }

  // 图像生成模式
  const aspectRatio = els.aspectRatio?.value || "";
  const imageSize = els.imageSize?.value || "";
  const temperature = safeNumberOrEmpty(els.temperature?.value);
  const topP = safeNumberOrEmpty(els.topP?.value);

  const body = {
    contents: [{
      role: "user",
      parts,
    }],
    generationConfig: {
      responseModalities: ["Image"],
    },
  };

  if (systemPrompt) {
    body.systemInstruction = { parts: [{ text: systemPrompt }] };
  }

  if (temperature !== "") body.generationConfig.temperature = temperature;
  if (topP !== "") body.generationConfig.topP = topP;

  if (aspectRatio || imageSize) {
    body.generationConfig.imageConfig = {};
    if (aspectRatio) body.generationConfig.imageConfig.aspectRatio = aspectRatio;
    if (imageSize) body.generationConfig.imageConfig.imageSize = imageSize;
  }

  return body;
}

function buildRequest() {
  const modelId = MODELS[taskMode] || MODELS[TASK_GENERATE];

  const host = stripTrailingSlash((els.apiHost?.value || "").trim() || DEFAULT_HOST);
  const apiKey = (els.apiKey?.value || "").trim();
  const useHeaderKey = !!els.useHeaderKey?.checked;

  if (!apiKey) throw new Error("请填写 API Key。");

  const path = apiPathFor(modelId);
  const url = useHeaderKey
    ? `${host}${path}`
    : `${host}${path}?key=${encodeURIComponent(apiKey)}`;

  let body;
  if (uiMode === "json") {
    const raw = (els.requestBodyJson?.value || "").trim();
    if (!raw) throw new Error("JSON 模式下请求体不能为空。");
    try { body = JSON.parse(raw); }
    catch (e) { throw new Error(`JSON 解析失败：${e?.message || e}`); }
  } else {
    body = buildBodyFromForm();
  }

  const headers = { "Content-Type": "application/json" };
  if (useHeaderKey) headers["x-goog-api-key"] = apiKey;

  return { url, headers, body, modelId };
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

// ====================== presets (不保存图片；并加入不可删除特殊模式) ======================
function loadPresets() {
  try {
    const raw = localStorage.getItem(storageKeys.presets);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];

    // migration: strip legacy image fields
    let changed = false;
    const normalized = arr.map(p => {
      if (p && typeof p === "object" && "image" in p) {
        changed = true;
        const { image, ...rest } = p;
        return rest;
      }
      return p;
    });
    if (changed) localStorage.setItem(storageKeys.presets, JSON.stringify(normalized));
    return normalized;
  } catch {
    return [];
  }
}
function savePresets(arr) { localStorage.setItem(storageKeys.presets, JSON.stringify(arr)); }

function refreshPresetUI() {
  const presets = loadPresets();
  const activeName = localStorage.getItem(storageKeys.activePreset) || "";

  if (!els.presetSelect) return;

  els.presetSelect.innerHTML = "";

  // special mode option (always exists)
  const special = document.createElement("option");
  special.value = SPECIAL_PRESET_ID;
  special.textContent = SPECIAL_PRESET_LABEL;
  if (activeName === SPECIAL_PRESET_ID) special.selected = true;
  els.presetSelect.appendChild(special);

  const divider = document.createElement("option");
  divider.disabled = true;
  divider.textContent = "──────────";
  els.presetSelect.appendChild(divider);

  const empty = document.createElement("option");
  empty.value = "";
  empty.textContent = "（无预设/回到默认）";
  if (!activeName) empty.selected = true;
  els.presetSelect.appendChild(empty);

  for (const p of presets) {
    if (!p?.name) continue;
    const opt = document.createElement("option");
    opt.value = p.name;
    opt.textContent = p.name;
    if (p.name === activeName) opt.selected = true;
    els.presetSelect.appendChild(opt);
  }

  const isSpecial = activeName === SPECIAL_PRESET_ID;
  const hasActiveRealPreset = !!activeName && !isSpecial && presets.some(p => p.name === activeName);

  if (els.presetUpdate) els.presetUpdate.disabled = !hasActiveRealPreset;
  if (els.presetDelete) els.presetDelete.disabled = !hasActiveRealPreset;
}

function getCurrentPresetName() {
  return els.presetSelect?.value || (localStorage.getItem(storageKeys.activePreset) || "");
}

function makePresetFromCurrentState() {
  return {
    name: "",
    createdAt: nowISO(),
    updatedAt: nowISO(),
    uiMode,
    taskMode, // NEW: 保存任务类型（生成/反推）
    describeTarget: els.describeTarget?.value || "full",
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

function applyPreset(preset) {
  // 不修改 Host/Key；不修改当前已选图片（预设不保存图片）
  setTaskMode(preset.taskMode === TASK_DESCRIBE ? TASK_DESCRIBE : TASK_GENERATE);
  if (els.describeTarget && preset.describeTarget) els.describeTarget.value = preset.describeTarget;

  setUiMode(preset.uiMode === "json" ? "json" : "form");

  const f = preset.fields || {};
  if (els.systemPrompt) els.systemPrompt.value = f.systemPrompt ?? "";
  if (els.prompt) els.prompt.value = f.prompt ?? "";
  if (els.aspectRatio) els.aspectRatio.value = f.aspectRatio ?? "";
  if (els.imageSize) els.imageSize.value = f.imageSize ?? "";
  if (els.temperature) els.temperature.value = f.temperature ?? "";
  if (els.topP) els.topP.value = f.topP ?? "";

  if (typeof preset.requestBodyJson === "string" && els.requestBodyJson) {
    els.requestBodyJson.value = preset.requestBodyJson;
  }

  persistBase();
  setStatus(`已应用预设：${preset.name}\n（Host/Key 不变；图片不随预设切换）`, true);
  setTimeout(() => setStatus("", false), 1300);
}

function saveAsPreset() {
  const name = (prompt("请输入预设名称（不包含 Host/Key；不包含图片）：") || "").trim();
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

  savePresets(presets);
  localStorage.setItem(storageKeys.activePreset, name);
  refreshPresetUI();
  setStatus(`已保存预设：${name}\n（图片未保存）`, true);
  setTimeout(() => setStatus("", false), 1200);
}

function updateActivePreset() {
  const name = getCurrentPresetName();
  if (!name || name === SPECIAL_PRESET_ID) return;

  const presets = loadPresets();
  const idx = presets.findIndex(p => p.name === name);
  if (idx < 0) return;

  const ok = confirm(`确认更新预设“${name}”？（图片不会被保存）`);
  if (!ok) return;

  const existing = presets[idx];
  const next = makePresetFromCurrentState();
  next.name = name;
  next.createdAt = existing.createdAt || nowISO();
  next.updatedAt = nowISO();
  presets[idx] = next;

  savePresets(presets);
  localStorage.setItem(storageKeys.activePreset, name);
  refreshPresetUI();
  setStatus(`已更新预设：${name}`, true);
  setTimeout(() => setStatus("", false), 1200);
}

function deleteActivePreset() {
  const name = getCurrentPresetName();
  if (!name || name === SPECIAL_PRESET_ID) return;

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
  const payload = { version: 3, exportedAt: nowISO(), presets }; // v3: 包含 taskMode/describeTarget
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

    // 严格丢弃图片字段（旧版本可能含 image）
    const safePreset = {
      name,
      createdAt: p.createdAt || nowISO(),
      updatedAt: nowISO(),
      uiMode: (p.uiMode === "json") ? "json" : "form",
      taskMode: (p.taskMode === TASK_DESCRIBE) ? TASK_DESCRIBE : TASK_GENERATE,
      describeTarget: (typeof p.describeTarget === "string" ? p.describeTarget : "full"),
      fields: {
        systemPrompt: p?.fields?.systemPrompt ?? "",
        prompt: p?.fields?.prompt ?? "",
        aspectRatio: p?.fields?.aspectRatio ?? "",
        imageSize: p?.fields?.imageSize ?? "",
        temperature: p?.fields?.temperature ?? "",
        topP: p?.fields?.topP ?? "",
      },
      requestBodyJson: typeof p.requestBodyJson === "string" ? p.requestBodyJson : "",
    };

    merged.push(safePreset);
    nameSet.add(name);
    added++;
  }

  if (!added) { setStatus("导入完成：未新增任何有效预设。", true); return; }

  savePresets(merged);
  refreshPresetUI();
  setStatus(`导入完成：新增 ${added} 个预设。`, true);
  setTimeout(() => setStatus("", false), 1400);
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
  setStatus(taskMode === TASK_DESCRIBE ? "正在反推提示词……" : "正在请求模型生成……", true);

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
  if (els.systemPrompt) els.systemPrompt.value = "";
  if (els.prompt) els.prompt.value = "";
  if (els.aspectRatio) els.aspectRatio.value = "";
  if (els.imageSize) els.imageSize.value = "";
  if (els.temperature) els.temperature.value = "";
  if (els.topP) els.topP.value = "";
  if (els.requestBodyJson) els.requestBodyJson.value = "";
  if (els.describeTarget) els.describeTarget.value = "full";
  clearAllImages();

  // reset to generate mode (but keep host/key)
  setTaskMode(TASK_GENERATE);
  setUiMode("form");

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

    els.describeTarget?.addEventListener(evt, persistBase);

    els.requestBodyJson?.addEventListener(evt, persistBase);
  });

  els.rememberKey?.addEventListener("change", () => {
    if (!els.rememberKey.checked) localStorage.removeItem(storageKeys.apiKey);
    else localStorage.setItem(storageKeys.apiKey, els.apiKey?.value || "");
  });

  els.apiKey?.addEventListener("input", () => {
    if (els.rememberKey?.checked) localStorage.setItem(storageKeys.apiKey, els.apiKey.value);
  });

  // mode switch
  els.modeForm?.addEventListener("click", () => setUiMode("form"));
  els.modeJson?.addEventListener("click", () => setUiMode("json"));

  // json tools
  els.jsonFormat?.addEventListener("click", formatJsonEditor);
  els.jsonFromForm?.addEventListener("click", syncJsonFromForm);
  els.jsonToForm?.addEventListener("click", applyJsonToFormBestEffort);

  // drag&drop
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
    setTimeout(() => setStatus("", false), 1000);
  });

  els.copyJson?.addEventListener("click", async () => {
    if (!lastRequest) return;
    await navigator.clipboard.writeText(JSON.stringify(lastRequest.body, null, 2));
    setStatus("已复制请求 JSON 到剪贴板。", true);
    setTimeout(() => setStatus("", false), 1000);
  });

  // presets selection includes special mode
  els.presetSelect?.addEventListener("change", () => {
    const value = els.presetSelect.value || "";

    // persist selection
    localStorage.setItem(storageKeys.activePreset, value);

    if (value === SPECIAL_PRESET_ID) {
      setTaskMode(TASK_DESCRIBE);
      refreshPresetUI();
      setStatus("已切换：反推提示词模式（不可删除）。\n请至少上传 1 张图片，然后点击“反推提示词”。", true);
      setTimeout(() => setStatus("", false), 1600);
      return;
    }

    if (!value) {
      setTaskMode(TASK_GENERATE);
      refreshPresetUI();
      return;
    }

    const presets = loadPresets();
    const p = presets.find(x => x.name === value);
    if (p) applyPreset(p);
    refreshPresetUI();
  });

  els.presetSave?.addEventListener("click", saveAsPreset);
  els.presetUpdate?.addEventListener("click", updateActivePreset);
  els.presetDelete?.addEventListener("click", deleteActivePreset);
  els.presetExport?.addEventListener("click", exportPresets);

  els.presetImport?.addEventListener("change", async () => {
    const f = els.presetImport.files?.[0];
    els.presetImport.value = "";
    await importPresetsFromFile(f);
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

  // apply modes
  setTaskMode(taskMode);
  setUiMode(uiMode);

  refreshPresetUI();

  // restore last selection (including special mode)
  const active = localStorage.getItem(storageKeys.activePreset) || "";
  if (els.presetSelect) {
    // if it exists in options, select it; otherwise fallback
    const has = Array.from(els.presetSelect.options).some(o => o.value === active);
    if (has) els.presetSelect.value = active;
  }

  // apply selection effects
  if (active === SPECIAL_PRESET_ID) {
    setTaskMode(TASK_DESCRIBE);
  } else if (!active) {
    setTaskMode(taskMode); // keep restored
  } else {
    const presets = loadPresets();
    const p = presets.find(x => x.name === active);
    if (p) applyPreset(p);
  }

  renderInputImages();
}

// 防止初始化异常导致“事件未绑定 -> 刷新/上传失效/参数丢失”
try {
  init();
} catch (e) {
  setStatus(`初始化异常：${e?.message || e}\n请确认三个文件已完整替换且无残缺。`, true);
}