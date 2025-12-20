const MODEL_ID = "gemini-3-pro-image-preview";
const DEFAULT_HOST = "https://generativelanguage.googleapis.com";
const API_PATH = `/v1beta/models/${MODEL_ID}:generateContent`;

const $ = (id) => document.getElementById(id);

const els = {
  form: $("form"),
  apiHost: $("apiHost"),
  apiKey: $("apiKey"),
  rememberKey: $("rememberKey"),
  useHeaderKey: $("useHeaderKey"),
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
  systemPrompt: "g3_system_prompt",
  aspectRatio: "g3_aspect_ratio",
  imageSize: "g3_image_size",
  temperature: "g3_temperature",
  topP: "g3_topP",
};

let selectedImage = null; // { file, mimeType, base64, size, name, dataUrl }
let lastRequest = null;   // { url, headers, body }
let objectUrls = [];      // generated blob URLs for cleanup

function setStatus(msg, visible = true) {
  els.status.textContent = msg || "";
  els.status.classList.toggle("hidden", !visible);
}

function humanBytes(bytes) {
  const units = ["B", "KB", "MB", "GB"];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function stripTrailingSlash(s) {
  return s.replace(/\/+$/, "");
}

function safeNumberOrEmpty(v) {
  const t = String(v ?? "").trim();
  if (!t) return "";
  const n = Number(t);
  return Number.isFinite(n) ? n : "";
}

function base64FromArrayBuffer(buf) {
  // Avoid stack overflow for large buffers
  const bytes = new Uint8Array(buf);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

async function readImageFile(file) {
  const mimeType = file.type || "application/octet-stream";
  const size = file.size;
  const name = file.name || "image";
  const arrayBuf = await file.arrayBuffer();
  const base64 = base64FromArrayBuffer(arrayBuf);

  // For preview only (smaller & faster)
  const dataUrl = URL.createObjectURL(file);

  return { file, mimeType, size, name, base64, dataUrl };
}

function clearSelectedImage() {
  if (selectedImage?.dataUrl) URL.revokeObjectURL(selectedImage.dataUrl);
  selectedImage = null;
  els.imagePreview.classList.add("hidden");
  els.imagePreviewImg.src = "";
  els.imageMeta.textContent = "";
  els.imageFile.value = "";
}

function showSelectedImage(info) {
  els.imagePreviewImg.src = info.dataUrl;
  els.imageMeta.textContent = `${info.name} · ${humanBytes(info.size)} · ${info.mimeType}`;
  els.imagePreview.classList.remove("hidden");
}

function persist() {
  localStorage.setItem(storageKeys.host, els.apiHost.value.trim());
  localStorage.setItem(storageKeys.rememberKey, String(els.rememberKey.checked));
  localStorage.setItem(storageKeys.useHeaderKey, String(els.useHeaderKey.checked));
  localStorage.setItem(storageKeys.systemPrompt, els.systemPrompt.value);
  localStorage.setItem(storageKeys.aspectRatio, els.aspectRatio.value);
  localStorage.setItem(storageKeys.imageSize, els.imageSize.value);
  localStorage.setItem(storageKeys.temperature, els.temperature.value);
  localStorage.setItem(storageKeys.topP, els.topP.value);

  if (els.rememberKey.checked) {
    localStorage.setItem(storageKeys.apiKey, els.apiKey.value);
  } else {
    localStorage.removeItem(storageKeys.apiKey);
  }
}

function restore() {
  els.apiHost.value = localStorage.getItem(storageKeys.host) || "";
  els.rememberKey.checked = (localStorage.getItem(storageKeys.rememberKey) || "false") === "true";
  els.useHeaderKey.checked = (localStorage.getItem(storageKeys.useHeaderKey) || "false") === "true";
  els.systemPrompt.value = localStorage.getItem(storageKeys.systemPrompt) || "";
  els.aspectRatio.value = localStorage.getItem(storageKeys.aspectRatio) || "";
  els.imageSize.value = localStorage.getItem(storageKeys.imageSize) || "";
  els.temperature.value = localStorage.getItem(storageKeys.temperature) || "";
  els.topP.value = localStorage.getItem(storageKeys.topP) || "";

  const savedKey = localStorage.getItem(storageKeys.apiKey) || "";
  if (els.rememberKey.checked && savedKey) {
    els.apiKey.value = savedKey;
  }
}

function buildRequest() {
  const host = stripTrailingSlash(els.apiHost.value.trim() || DEFAULT_HOST);
  const apiKey = els.apiKey.value.trim();
  const useHeaderKey = els.useHeaderKey.checked;

  const systemPrompt = els.systemPrompt.value.trim();
  const prompt = els.prompt.value.trim();

  const aspectRatio = els.aspectRatio.value;
  const imageSize = els.imageSize.value;

  const temperature = safeNumberOrEmpty(els.temperature.value);
  const topP = safeNumberOrEmpty(els.topP.value);

  if (!apiKey) throw new Error("请填写 API Key。");
  if (!prompt) throw new Error("请填写提示词（必填）。");

  const url = useHeaderKey
    ? `${host}${API_PATH}`
    : `${host}${API_PATH}?key=${encodeURIComponent(apiKey)}`;

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

  if (systemPrompt) {
    body.systemInstruction = {
      parts: [{ text: systemPrompt }],
    };
  }

  if (temperature !== "") body.generationConfig.temperature = temperature;
  if (topP !== "") body.generationConfig.topP = topP;

  if (aspectRatio || imageSize) {
    body.generationConfig.imageConfig = {};
    if (aspectRatio) body.generationConfig.imageConfig.aspectRatio = aspectRatio;
    if (imageSize) body.generationConfig.imageConfig.imageSize = imageSize;
  }

  const headers = {
    "Content-Type": "application/json",
  };
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

function cleanupObjectUrls() {
  for (const u of objectUrls) URL.revokeObjectURL(u);
  objectUrls = [];
}

function b64ToBlobUrl(b64, mimeType) {
  const binary = atob(b64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
  const blob = new Blob([bytes], { type: mimeType || "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  objectUrls.push(url);
  return { url, blob };
}

function timestampTag() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function renderResult({ data, ms }) {
  els.resultEmpty.classList.add("hidden");
  els.result.classList.remove("hidden");

  els.modelName.textContent = MODEL_ID;
  els.latency.textContent = `${ms.toFixed(0)} ms`;

  els.rawJson.textContent = JSON.stringify(data, null, 2);

  // Extract parts (text + images)
  const candidates = data?.candidates || [];
  const first = candidates[0]?.content?.parts || [];
  const texts = [];
  const images = [];

  for (const p of first) {
    if (typeof p?.text === "string" && p.text.trim()) {
      texts.push(p.text);
      continue;
    }

    // Response can be inlineData (camelCase) or inline_data (snake_case)
    const inline = p.inlineData || p.inline_data;
    if (inline?.data) {
      const mimeType = inline.mimeType || inline.mime_type || "image/png";
      images.push({ b64: inline.data, mimeType });
    }
  }

  // Text
  if (texts.length) {
    els.textOutWrap.classList.remove("hidden");
    els.textOut.textContent = texts.join("\n\n---\n\n");
  } else {
    els.textOutWrap.classList.add("hidden");
    els.textOut.textContent = "";
  }

  // Images
  els.imagesOut.innerHTML = "";
  cleanupObjectUrls();

  if (images.length) {
    els.imagesOutWrap.classList.remove("hidden");
    const tag = timestampTag();

    images.forEach((img, idx) => {
      const { url } = b64ToBlobUrl(img.b64, img.mimeType);
      const ext =
        img.mimeType.includes("png") ? "png" :
        img.mimeType.includes("jpeg") ? "jpg" :
        img.mimeType.includes("webp") ? "webp" : "bin";

      const filename = `gemini3_image_${tag}_${String(idx + 1).padStart(2, "0")}.${ext}`;

      const card = document.createElement("div");
      card.className = "imgcard";

      const imageEl = document.createElement("img");
      imageEl.src = url;
      imageEl.alt = `生成图片 ${idx + 1}`;

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

async function run() {
  persist();
  setStatus("正在请求模型生成……", true);

  // Clear prior output
  els.resultEmpty.classList.add("hidden");
  els.result.classList.add("hidden");
  els.textOutWrap.classList.add("hidden");
  els.imagesOutWrap.classList.add("hidden");
  els.rawJson.textContent = "";
  cleanupObjectUrls();

  let req;
  try {
    req = buildRequest();
  } catch (e) {
    setStatus(e.message || String(e), true);
    return;
  }

  lastRequest = req;

  const t0 = performance.now();
  try {
    const resp = await fetch(req.url, {
      method: "POST",
      headers: req.headers,
      body: JSON.stringify(req.body),
    });

    const data = await resp.json().catch(() => ({}));
    const t1 = performance.now();

    if (!resp.ok) {
      const msg = data?.error?.message || `HTTP ${resp.status} ${resp.statusText}`;
      setStatus(`请求失败：${msg}\n\n（提示：若你使用自定义 Host，请确认它支持该路径与鉴权方式。）`, true);
      els.resultEmpty.classList.remove("hidden");
      return;
    }

    setStatus("", false);
    renderResult({ data, ms: (t1 - t0) });
  } catch (e) {
    setStatus(`网络或浏览器拦截导致请求失败：${e.message || e}\n\n（提示：可尝试切换 Host 为你的反代/网关。）`, true);
    els.resultEmpty.classList.remove("hidden");
  }
}

function wireEvents() {
  // Persist on change
  ["input", "change"].forEach((evt) => {
    els.apiHost.addEventListener(evt, persist);
    els.apiKey.addEventListener(evt, persist);
    els.rememberKey.addEventListener(evt, persist);
    els.useHeaderKey.addEventListener(evt, persist);
    els.systemPrompt.addEventListener(evt, persist);
    els.aspectRatio.addEventListener(evt, persist);
    els.imageSize.addEventListener(evt, persist);
    els.temperature.addEventListener(evt, persist);
    els.topP.addEventListener(evt, persist);
  });

  els.rememberKey.addEventListener("change", () => {
    if (!els.rememberKey.checked) {
      localStorage.removeItem(storageKeys.apiKey);
    } else {
      localStorage.setItem(storageKeys.apiKey, els.apiKey.value);
    }
  });

  els.apiKey.addEventListener("input", () => {
    if (els.rememberKey.checked) localStorage.setItem(storageKeys.apiKey, els.apiKey.value);
  });

  // Drag & drop
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

  els.dropZone.addEventListener("keydown", () => {
    // Let native file input handle accessibility
  });

  els.imageFile.addEventListener("change", async () => {
    const f = els.imageFile.files?.[0];
    if (!f) return;
    await handleImageFile(f);
  });

  els.clearImage.addEventListener("click", () => {
    clearSelectedImage();
  });

  els.form.addEventListener("submit", async (e) => {
    e.preventDefault();
    els.runBtn.disabled = true;
    try {
      await run();
    } finally {
      els.runBtn.disabled = false;
    }
  });

  els.resetBtn.addEventListener("click", () => {
    // Reset non-key fields
    els.apiHost.value = localStorage.getItem(storageKeys.host) || "";
    els.systemPrompt.value = "";
    els.prompt.value = "";
    els.aspectRatio.value = "";
    els.imageSize.value = "";
    els.temperature.value = "";
    els.topP.value = "";
    clearSelectedImage();
    setStatus("", false);
    els.result.classList.add("hidden");
    els.resultEmpty.classList.remove("hidden");
    persist();
  });

  els.copyCurl.addEventListener("click", async () => {
    if (!lastRequest) return;
    const curl = makeCurl(lastRequest);
    await navigator.clipboard.writeText(curl);
    setStatus("已复制 cURL 到剪贴板。", true);
    setTimeout(() => setStatus("", false), 1200);
  });

  els.copyJson.addEventListener("click", async () => {
    if (!lastRequest) return;
    const json = JSON.stringify(lastRequest.body, null, 2);
    await navigator.clipboard.writeText(json);
    setStatus("已复制请求 JSON 到剪贴板。", true);
    setTimeout(() => setStatus("", false), 1200);
  });
}

async function handleImageFile(file) {
  // Soft guard: large files can exceed API limits or be slow on mobile
  if (file.size > 12 * 1024 * 1024) {
    setStatus(`图片较大（${humanBytes(file.size)}）。建议压缩到更小尺寸/体积后再试。`, true);
  } else {
    setStatus("", false);
  }

  clearSelectedImage();
  const info = await readImageFile(file);
  selectedImage = info;
  showSelectedImage(info);
}

function init() {
  restore();
  wireEvents();
}

init();
