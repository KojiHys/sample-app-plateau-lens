import "cesium/Build/Cesium/Widgets/widgets.css";
import "./styles.css";
import {
  Cartesian2,
  type Cesium3DTile,
  Cesium3DTileFeature,
  ScreenSpaceEventType,
  type Cesium3DTileset,
  type Viewer,
} from "cesium";
import { AuthError, createAuth } from "./auth.ts";
import {
  initializeCloudViewsUi,
  type CloudMessage,
} from "./cloud-views-ui.ts";
import { loadRuntimeConfig } from "./config.ts";
import {
  CATEGORY_FILTERS,
  CATEGORY_FILTER_KEYS,
  NUMERIC_FILTER_KEYS,
  NUMERIC_FILTERS,
  TILESET_RANGES,
  type CategoryFilterKey,
  type NumericFilterKey,
} from "./cesium/attributes.ts";
import {
  captureCameraState,
  restoreCameraState,
} from "./cesium/camera-state.ts";
import { buildFeatureDetails } from "./cesium/feature-details.ts";
import { runPreflight } from "./cesium/preflight.ts";
import {
  STYLE_COLORS,
  colorForCategory,
  createTilesetStyle,
} from "./cesium/style-expression.ts";
import {
  collectCategoryValues,
  mergeCategoryValues,
  type CategoryValues,
} from "./cesium/tile-content.ts";
import { createIonIndependentViewer, createPlateauTileset } from "./cesium/viewer.ts";
import {
  createInitialTilesetLoadState,
  transitionInitialTilesetLoad,
  type InitialTilesetLoadState,
} from "./tileset-load-state.ts";
import {
  applyVerticalEvacuationPreset,
  categoryValueKey,
  cloneFilterState,
  createDefaultFilterState,
  decodeViewState,
  encodeViewState,
  type CameraState,
  type CategoryValue,
  type ColorMode,
  type ViewStateSnapshot,
} from "./view-state.ts";
import {
  createViewsApi,
  ViewsApiError,
  type SavedView,
} from "./views-api.ts";

function requiredElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) {
    throw new Error(`${selector} element was not found`);
  }
  return element;
}

const locationUrl = new URL(window.location.href);
const showDiagnostics = locationUrl.searchParams.get("diagnostics") === "1";
const stateParameter = locationUrl.searchParams.get("state");
const restoredSnapshot = stateParameter ? decodeViewState(stateParameter) : null;

let filterState = restoredSnapshot
  ? cloneFilterState(restoredSnapshot.filter)
  : createDefaultFilterState();
let lastCameraState: CameraState | null = restoredSnapshot?.camera ?? null;
let viewer: Viewer | null = null;
let tileset: Cesium3DTileset | null = null;
let discoveredCategories: CategoryValues = {
  districtsAndZones: [],
  usage: [],
};

function copyCameraState(camera: CameraState): CameraState {
  return {
    destination: { ...camera.destination },
    orientation: { ...camera.orientation },
  };
}

function restoreEncodedStateFromCurrentUrl(): boolean {
  const encoded = new URL(window.location.href).searchParams.get("state");
  const snapshot = encoded ? decodeViewState(encoded) : null;
  if (!snapshot) {
    return false;
  }

  filterState = cloneFilterState(snapshot.filter);
  lastCameraState = snapshot.camera ? copyCameraState(snapshot.camera) : null;
  syncAllControls();
  if (viewer && lastCameraState) {
    restoreCameraState(viewer.camera, lastCameraState);
  }
  applyFilterState();
  return true;
}

function applySavedViewState(savedView: SavedView): void {
  filterState = cloneFilterState(savedView.filterState);
  lastCameraState = copyCameraState(savedView.cameraState);
  syncAllControls();
  if (viewer) {
    restoreCameraState(viewer.camera, lastCameraState);
  }

  const url = new URL(window.location.href);
  url.searchParams.delete("viewId");
  url.searchParams.delete("state");
  window.history.replaceState(
    window.history.state,
    "",
    `${url.pathname}${url.search}${url.hash}`,
  );
  applyFilterState();
}

function currentViewSnapshot(): ViewStateSnapshot | null {
  const camera = viewer
    ? captureCameraState(viewer.camera)
    : lastCameraState
      ? copyCameraState(lastCameraState)
      : null;
  if (!camera) {
    return null;
  }
  return {
    camera,
    filter: cloneFilterState(filterState),
  };
}

function authCallbackMessage(error: unknown): CloudMessage {
  if (error instanceof AuthError) {
    if (error.code === "oauth_error") {
      return { text: "ログインがキャンセルされました。", tone: "info" };
    }
    if (error.code === "invalid_state" || error.code === "invalid_callback") {
      return {
        text: "ログイン応答を安全に確認できませんでした。もう一度ログインしてください。",
        tone: "error",
      };
    }
  }
  return { text: "ログイン処理を完了できませんでした。", tone: "error" };
}

function sharedViewMessage(error: unknown): CloudMessage {
  if (error instanceof ViewsApiError) {
    if (error.status === 404) {
      return { text: "共有ビューが見つかりませんでした。", tone: "error" };
    }
    if (error.status === 400) {
      return { text: "共有ビューIDが正しくありません。", tone: "error" };
    }
    if (error.kind === "network") {
      return { text: "共有ビューを取得できませんでした。通信状態を確認してください。", tone: "error" };
    }
  }
  return { text: "共有ビューを読み込めませんでした。", tone: "error" };
}

const app = requiredElement<HTMLDivElement>("#app");
app.removeAttribute("aria-live");
app.innerHTML = `
  <main class="app-shell">
    <header class="app-header">
      <div class="brand-block">
        <p class="eyebrow">PLATEAU 3D都市モデル活用サンプル（非公式）</p>
        <h1>PLATEAU Lens</h1>
      </div>
      <p class="header-notice">
        「垂直避難の受け入れ先候補」は属性による抽出例です。実際の避難施設指定や安全性を示しません。
      </p>
      <div class="header-actions">
        <output id="load-status" class="status-badge" role="status" aria-live="polite">初期化中</output>
        <button id="copy-share-url" class="secondary-button" type="button" aria-describedby="share-feedback">
          状態URLをコピー
        </button>
        <button id="auth-button" class="secondary-button" type="button">ログイン</button>
        <span id="auth-summary" class="auth-summary">認証状態を確認中…</span>
        <span id="share-feedback" class="share-feedback" role="status" aria-live="polite"></span>
      </div>
    </header>

    <div class="workspace">
      <aside class="filters-panel" aria-labelledby="filters-title">
        <div class="panel-heading">
          <div>
            <p class="panel-kicker">千代田区 LOD2</p>
            <h2 id="filters-title">建物を絞り込む</h2>
          </div>
          <span class="client-side-label">ブラウザ内処理</span>
        </div>

        <section class="preset-section" aria-labelledby="preset-title">
          <h3 id="preset-title">デモ用プリセット</h3>
          <button id="evacuation-preset" class="primary-button" type="button">
            垂直避難の受け入れ先候補
          </button>
          <p>浸水深0.5m以上・地上4階以上・屋根投影面積1,000m²以上を適用します。</p>
        </section>

        <section class="cloud-views-section" aria-labelledby="cloud-views-title">
          <div class="section-heading-row">
            <h3 id="cloud-views-title">保存ビュー</h3>
            <button id="refresh-views" class="text-button" type="button">一覧を更新</button>
          </div>
          <p id="auth-summary-panel" class="visually-hidden">認証状態は画面上部に表示されます。</p>
          <form id="save-view-form" class="save-view-form">
            <label for="view-title">ビュー名</label>
            <div class="save-view-row">
              <input id="view-title" name="title" type="text" maxlength="50" autocomplete="off" placeholder="例：垂直避難候補_千代田" required />
              <button id="save-view-button" class="primary-button" type="submit">保存</button>
            </div>
          </form>
          <div id="saved-share" class="saved-share" hidden>
            <a id="saved-share-link" target="_blank" rel="noreferrer"></a>
            <button id="copy-saved-share" class="text-button" type="button">リンクをコピー</button>
          </div>
          <output id="cloud-status" class="cloud-status" role="status" aria-live="polite"></output>
          <ul id="saved-views-list" class="saved-views-list" aria-label="自分の保存ビュー"></ul>
          <p class="capability-note">共有リンクを知っている人はログインなしで閲覧できます。機密情報は保存しないでください。</p>
        </section>

        <section class="control-section" aria-labelledby="numeric-title">
          <div class="section-heading-row">
            <h3 id="numeric-title">数値フィルター</h3>
            <span>下限 / 上限</span>
          </div>
          <div id="numeric-filters" class="numeric-filters"></div>
        </section>

        <section class="control-section" aria-labelledby="category-title">
          <h3 id="category-title">分類フィルター</h3>
          <p class="section-help">表示する分類にチェックを入れてください。値はロード済み建物から収集します。</p>
          <div class="category-groups">
            <fieldset class="category-filter">
              <legend>${CATEGORY_FILTERS.usage.label}</legend>
              <div id="usage-options" class="category-options"></div>
            </fieldset>
            <fieldset class="category-filter">
              <legend>${CATEGORY_FILTERS.districtsAndZones.label}</legend>
              <div id="district-options" class="category-options"></div>
            </fieldset>
          </div>
        </section>

        <section class="control-section" aria-labelledby="color-title">
          <h3 id="color-title">着色</h3>
          <fieldset class="color-options">
            <legend class="visually-hidden">建物の着色方法</legend>
            <label><input type="radio" name="color-mode" value="none" />なし</label>
            <label><input type="radio" name="color-mode" value="usage" />用途</label>
            <label><input type="radio" name="color-mode" value="height" />高さ</label>
            <label><input type="radio" name="color-mode" value="floodDepth" />浸水深</label>
          </fieldset>
        </section>
      </aside>

      <section class="map-stage" aria-label="千代田区3D都市モデル地図">
        <div id="cesium-container"></div>

        <aside id="legend" class="legend" aria-labelledby="legend-title"></aside>

        <aside id="attribute-panel" class="attribute-panel" aria-labelledby="attribute-title" aria-live="polite" tabindex="-1" hidden>
          <div class="attribute-heading">
            <div>
              <p class="panel-kicker">選択中の建物</p>
              <h2 id="attribute-title">主要属性</h2>
            </div>
            <button id="close-attributes" class="icon-button" type="button" aria-label="属性パネルを閉じる">×</button>
          </div>
          <dl id="attribute-values"></dl>
        </aside>

        <aside class="diagnostics" aria-labelledby="diagnostics-title" ${showDiagnostics ? "" : "hidden"}>
          <h2 id="diagnostics-title">事前検証</h2>
          <dl>
            <div><dt>ion非依存</dt><dd id="ion-result">確認中</dd></div>
            <div><dt>日本語属性式</dt><dd id="expression-result">確認中</dd></div>
          </dl>
          <p>現在の表示には、UIで生成した <code>show</code> / <code>color</code> 式を適用しています。</p>
        </aside>

        <div class="persistent-notices">
          <p class="safety-notice"><strong>注意：</strong>抽出結果は実際の避難施設指定や安全性を示すものではありません。</p>
          <p class="attribution">
            出典：国土交通省
            <a href="https://www.mlit.go.jp/plateau/" target="_blank" rel="noreferrer">Project PLATEAU「千代田区3D都市モデル」</a>
            を加工して作成。利用条件：
            <a href="https://www.mlit.go.jp/plateau/site-policy/" target="_blank" rel="noreferrer">公共データ利用規約（第1.0版／PDL1.0、CC BY 4.0互換）</a>
            ・<a href="https://creativecommons.org/licenses/by/4.0/deed.ja" target="_blank" rel="noreferrer">CC BY 4.0</a>
          </p>
        </div>
      </section>
    </div>
  </main>
`;

const container = requiredElement<HTMLElement>("#cesium-container");
const status = requiredElement<HTMLOutputElement>("#load-status");
const ionResult = requiredElement<HTMLElement>("#ion-result");
const expressionResult = requiredElement<HTMLElement>("#expression-result");
const numericFilters = requiredElement<HTMLElement>("#numeric-filters");
const usageOptions = requiredElement<HTMLElement>("#usage-options");
const districtOptions = requiredElement<HTMLElement>("#district-options");
const legend = requiredElement<HTMLElement>("#legend");
const attributePanel = requiredElement<HTMLElement>("#attribute-panel");
const attributeValues = requiredElement<HTMLElement>("#attribute-values");
const shareFeedback = requiredElement<HTMLElement>("#share-feedback");
const cloudStatus = requiredElement<HTMLOutputElement>("#cloud-status");

interface NumericControl {
  fieldset: HTMLFieldSetElement;
  lower: HTMLInputElement;
  output: HTMLOutputElement;
  upper: HTMLInputElement;
}

const numericControls = new Map<NumericFilterKey, NumericControl>();

function formatNumber(value: number, step: number): string {
  const decimalIndex = String(step).indexOf(".");
  const maximumFractionDigits = decimalIndex < 0 ? 0 : String(step).length - decimalIndex - 1;
  return new Intl.NumberFormat("ja-JP", {
    maximumFractionDigits,
    minimumFractionDigits: 0,
  }).format(value);
}

function updateNumericControl(key: NumericFilterKey): void {
  const control = numericControls.get(key);
  if (!control) {
    return;
  }
  const definition = NUMERIC_FILTERS[key];
  const selected = filterState.numeric[key];
  control.lower.value = String(selected.min);
  control.upper.value = String(selected.max);
  control.lower.setAttribute(
    "aria-valuetext",
    `${formatNumber(selected.min, definition.step)} ${definition.unit}`,
  );
  control.upper.setAttribute(
    "aria-valuetext",
    `${formatNumber(selected.max, definition.step)} ${definition.unit}`,
  );
  control.output.value = `${formatNumber(selected.min, definition.step)} ～ ${formatNumber(selected.max, definition.step)} ${definition.unit}`;
  control.fieldset.dataset.active = String(
    selected.min !== definition.min || selected.max !== definition.max,
  );
}

function updateNumericRange(
  key: NumericFilterKey,
  bound: "min" | "max",
  rawValue: number,
): void {
  if (!Number.isFinite(rawValue)) {
    return;
  }

  const next = cloneFilterState(filterState);
  const current = next.numeric[key];
  const limits = TILESET_RANGES[key];
  if (bound === "min") {
    current.min = Math.min(Math.max(rawValue, limits.min), current.max);
  } else {
    current.max = Math.max(Math.min(rawValue, limits.max), current.min);
  }
  filterState = next;
  updateNumericControl(key);
  applyFilterState();
}

function createRangeInput(
  key: NumericFilterKey,
  bound: "min" | "max",
  labelText: string,
): { input: HTMLInputElement; label: HTMLLabelElement } {
  const definition = NUMERIC_FILTERS[key];
  const id = `${key}-${bound}`;
  const label = document.createElement("label");
  label.className = "range-control";
  label.htmlFor = id;

  const labelName = document.createElement("span");
  labelName.textContent = labelText;
  const input = document.createElement("input");
  input.id = id;
  input.type = "range";
  input.min = String(definition.min);
  input.max = String(definition.max);
  input.step = String(definition.step);
  input.setAttribute("aria-label", `${definition.label}の${labelText}`);
  input.addEventListener("input", () => updateNumericRange(key, bound, input.valueAsNumber));

  label.append(labelName, input);
  return { input, label };
}

function renderNumericControls(): void {
  for (const key of NUMERIC_FILTER_KEYS) {
    const definition = NUMERIC_FILTERS[key];
    const fieldset = document.createElement("fieldset");
    fieldset.className = "range-filter";

    const fieldLegend = document.createElement("legend");
    fieldLegend.textContent = definition.label;
    const measuredRange = document.createElement("span");
    measuredRange.className = "measured-range";
    measuredRange.textContent = `実測 ${formatNumber(definition.min, definition.step)}–${formatNumber(definition.max, definition.step)} ${definition.unit}`;

    const lower = createRangeInput(key, "min", "下限");
    const upper = createRangeInput(key, "max", "上限");
    const output = document.createElement("output");
    output.className = "range-output";
    output.setAttribute("for", `${lower.input.id} ${upper.input.id}`);
    output.setAttribute("aria-live", "polite");

    const controls = document.createElement("div");
    controls.className = "range-controls";
    controls.append(lower.label, upper.label);
    fieldset.append(fieldLegend, measuredRange, controls, output);
    numericFilters.append(fieldset);
    numericControls.set(key, {
      fieldset,
      lower: lower.input,
      output,
      upper: upper.input,
    });
    updateNumericControl(key);
  }
}

function displayCategoryValue(value: CategoryValue): string {
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  return String(value);
}

function updateCategoryExclusion(
  category: CategoryFilterKey,
  value: CategoryValue,
  included: boolean,
): void {
  const next = cloneFilterState(filterState);
  const valueKey = categoryValueKey(value);
  const withoutValue = next.categoryExclusions[category].filter(
    (candidate) => categoryValueKey(candidate) !== valueKey,
  );
  next.categoryExclusions[category] = included ? withoutValue : [...withoutValue, value];
  filterState = next;
  applyFilterState();
}

function renderCategoryGroup(
  category: CategoryFilterKey,
  values: readonly CategoryValue[],
  target: HTMLElement,
): void {
  const focusedKey =
    document.activeElement instanceof HTMLInputElement &&
    target.contains(document.activeElement)
      ? document.activeElement.dataset.categoryValueKey
      : undefined;
  target.replaceChildren();
  if (values.length === 0) {
    const empty = document.createElement("p");
    empty.className = "category-empty";
    empty.textContent = "建物データから収集中…";
    target.append(empty);
    return;
  }

  const count = document.createElement("p");
  count.className = "category-count";
  count.setAttribute("role", "status");
  count.setAttribute("aria-live", "polite");
  count.textContent = `${values.length}種類を検出`;
  const list = document.createElement("div");
  list.className = "checkbox-list";
  const excluded = new Set(filterState.categoryExclusions[category].map(categoryValueKey));

  values.forEach((value, index) => {
    const input = document.createElement("input");
    const valueKey = categoryValueKey(value);
    input.type = "checkbox";
    input.id = `${category}-option-${index}`;
    input.dataset.categoryValueKey = valueKey;
    input.checked = !excluded.has(valueKey);
    input.addEventListener("change", () => {
      updateCategoryExclusion(category, value, input.checked);
    });

    const label = document.createElement("label");
    label.htmlFor = input.id;
    const labelText = document.createElement("span");
    labelText.textContent = displayCategoryValue(value);
    label.append(input, labelText);
    list.append(label);
  });

  target.append(count, list);
  if (focusedKey) {
    const replacement = [...target.querySelectorAll<HTMLInputElement>("input")].find(
      (input) => input.dataset.categoryValueKey === focusedKey,
    );
    replacement?.focus({ preventScroll: true });
  }
}

function renderCategoryControls(): void {
  renderCategoryGroup("usage", discoveredCategories.usage, usageOptions);
  renderCategoryGroup(
    "districtsAndZones",
    discoveredCategories.districtsAndZones,
    districtOptions,
  );
}

function isColorMode(value: string): value is ColorMode {
  return value === "none" || value === "usage" || value === "height" || value === "floodDepth";
}

function syncColorControls(): void {
  for (const radio of document.querySelectorAll<HTMLInputElement>('input[name="color-mode"]')) {
    radio.checked = radio.value === filterState.colorMode;
  }
}

function createLegendRow(color: string, text: string): HTMLDivElement {
  const row = document.createElement("div");
  row.className = "legend-row";
  const swatch = document.createElement("span");
  swatch.className = "legend-swatch";
  swatch.style.backgroundColor = color;
  const label = document.createElement("span");
  label.textContent = text;
  row.append(swatch, label);
  return row;
}

function renderLegend(): void {
  legend.replaceChildren();
  const heading = document.createElement("h2");
  heading.id = "legend-title";
  heading.textContent = "凡例";
  legend.append(heading);

  if (filterState.colorMode === "none") {
    legend.append(createLegendRow(STYLE_COLORS.neutral, "単色表示"));
    return;
  }

  if (filterState.colorMode === "usage") {
    const subtitle = document.createElement("p");
    subtitle.className = "legend-subtitle";
    subtitle.textContent = "建物用途";
    legend.append(subtitle);
    if (discoveredCategories.usage.length === 0) {
      const empty = document.createElement("p");
      empty.className = "legend-empty";
      empty.textContent = "用途を収集中…";
      legend.append(empty);
    } else {
      const entries = document.createElement("div");
      entries.className = "legend-entries";
      for (const value of discoveredCategories.usage) {
        entries.append(createLegendRow(colorForCategory(value), displayCategoryValue(value)));
      }
      legend.append(entries);
    }
    legend.append(createLegendRow(STYLE_COLORS.missing, "値なし"));
    return;
  }

  const key = filterState.colorMode;
  const definition = NUMERIC_FILTERS[key];
  const colors = STYLE_COLORS[key];
  const subtitle = document.createElement("p");
  subtitle.className = "legend-subtitle";
  subtitle.textContent = definition.label;
  const gradient = document.createElement("div");
  gradient.className = "legend-gradient";
  gradient.style.background = `linear-gradient(90deg, ${colors.low}, ${colors.high})`;
  const scale = document.createElement("div");
  scale.className = "legend-scale";
  const low = document.createElement("span");
  low.textContent = `${formatNumber(definition.min, definition.step)} ${definition.unit}`;
  const high = document.createElement("span");
  high.textContent = `${formatNumber(definition.max, definition.step)} ${definition.unit}`;
  scale.append(low, high);
  legend.append(subtitle, gradient, scale, createLegendRow(STYLE_COLORS.missing, "値なし"));
}

function persistViewState(): void {
  if (viewer) {
    lastCameraState = captureCameraState(viewer.camera) ?? lastCameraState;
  }
  const encoded = encodeViewState({ camera: lastCameraState, filter: filterState });
  const url = new URL(window.location.href);
  url.searchParams.set("state", encoded);
  window.history.replaceState(
    window.history.state,
    "",
    `${url.pathname}${url.search}${url.hash}`,
  );
}

function applyFilterState(): void {
  if (tileset) {
    tileset.style = createTilesetStyle(filterState, discoveredCategories.usage);
  }
  renderLegend();
  persistViewState();
}

function syncAllControls(): void {
  for (const key of NUMERIC_FILTER_KEYS) {
    updateNumericControl(key);
  }
  renderCategoryControls();
  syncColorControls();
  renderLegend();
}

function hideAttributePanel(): void {
  attributePanel.hidden = true;
  attributeValues.replaceChildren();
}

function showFeatureDetails(feature: Cesium3DTileFeature, focusPanel = false): void {
  const fragment = document.createDocumentFragment();
  for (const detail of buildFeatureDetails(feature)) {
    const row = document.createElement("div");
    const term = document.createElement("dt");
    term.textContent = detail.label;
    const description = document.createElement("dd");
    description.textContent = detail.value;
    row.append(term, description);
    fragment.append(row);
  }
  attributeValues.replaceChildren(fragment);
  attributePanel.hidden = false;
  if (focusPanel) {
    attributePanel.focus({ preventScroll: true });
  }
}

async function copyShareUrl(): Promise<void> {
  persistViewState();
  let copied = false;
  try {
    await navigator.clipboard.writeText(window.location.href);
    copied = true;
  } catch {
    const input = document.createElement("textarea");
    input.value = window.location.href;
    input.setAttribute("readonly", "");
    input.className = "clipboard-fallback";
    document.body.append(input);
    input.select();
    copied = document.execCommand("copy");
    input.remove();
  }
  shareFeedback.textContent = copied
    ? "コピーしました"
    : "コピーできませんでした。アドレスバーからコピーしてください。";
  window.setTimeout(() => {
    shareFeedback.textContent = "";
  }, 4_000);
}

function categoriesChanged(previous: CategoryValues, next: CategoryValues): boolean {
  return (
    previous.usage.length !== next.usage.length ||
    previous.districtsAndZones.length !== next.districtsAndZones.length
  );
}

renderNumericControls();
renderCategoryControls();
syncColorControls();
renderLegend();

for (const radio of document.querySelectorAll<HTMLInputElement>('input[name="color-mode"]')) {
  radio.addEventListener("change", () => {
    if (!radio.checked || !isColorMode(radio.value)) {
      return;
    }
    const next = cloneFilterState(filterState);
    next.colorMode = radio.value;
    filterState = next;
    applyFilterState();
  });
}

requiredElement<HTMLButtonElement>("#evacuation-preset").addEventListener("click", () => {
  filterState = applyVerticalEvacuationPreset(filterState);
  syncAllControls();
  applyFilterState();
});
requiredElement<HTMLButtonElement>("#copy-share-url").addEventListener("click", () => {
  void copyShareUrl();
});
requiredElement<HTMLButtonElement>("#close-attributes").addEventListener(
  "click",
  hideAttributePanel,
);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !attributePanel.hidden) {
    hideAttributePanel();
  }
});

async function start(): Promise<void> {
  const config = await loadRuntimeConfig();
  const auth = createAuth(config);
  let initialCloudMessage: CloudMessage | undefined;

  try {
    const callbackResult = await auth.handleCallback();
    if (callbackResult.handled) {
      restoreEncodedStateFromCurrentUrl();
      initialCloudMessage = {
        text: "ログインしました。現在のビューを保存できます。",
        tone: "success",
      };
    }
  } catch (error: unknown) {
    initialCloudMessage = authCallbackMessage(error);
  }

  let viewsApi: ReturnType<typeof createViewsApi> | null = null;
  try {
    viewsApi = createViewsApi(config, window.fetch.bind(window), () =>
      auth.getIdToken(),
    );
  } catch (error: unknown) {
    if (!(error instanceof ViewsApiError) || error.kind !== "configuration") {
      initialCloudMessage = {
        text: "保存APIを初期化できませんでした。",
        tone: "error",
      };
    }
  }

  const sharedViewId = new URL(window.location.href).searchParams.get("viewId");
  if (sharedViewId && viewsApi) {
    try {
      const sharedView = await viewsApi.get(sharedViewId);
      applySavedViewState(sharedView);
      initialCloudMessage = {
        text: `共有ビュー「${sharedView.title}」を読み込みました。`,
        tone: "success",
      };
    } catch (error: unknown) {
      initialCloudMessage = sharedViewMessage(error);
    }
  } else if (sharedViewId) {
    initialCloudMessage = {
      text: "共有ビューを開くためのAPIが設定されていません。",
      tone: "error",
    };
  }

  void initializeCloudViewsUi({
    api: viewsApi,
    applySavedView: applySavedViewState,
    auth,
    getSnapshot: currentViewSnapshot,
    ...(initialCloudMessage === undefined ? {} : { initialMessage: initialCloudMessage }),
  }).catch((error: unknown) => {
    console.error("Cloud views UI failed to initialize", error);
    cloudStatus.textContent = "クラウド保存UIを初期化できませんでした。";
    cloudStatus.dataset.tone = "error";
  });

  const initialReport = runPreflight();
  expressionResult.textContent = initialReport.japaneseAttributeExpressionPassed
    ? "合格"
    : "不合格";
  expressionResult.dataset.result = initialReport.japaneseAttributeExpressionPassed
    ? "pass"
    : "fail";

  const createdViewer = createIonIndependentViewer(container);
  viewer = createdViewer;
  createdViewer.canvas.tabIndex = 0;
  createdViewer.canvas.setAttribute(
    "aria-label",
    "千代田区の3D都市モデル。ドラッグで回転、ホイールで拡大縮小。Enterキーで画面中央の建物属性を表示します。",
  );
  if (lastCameraState) {
    restoreCameraState(createdViewer.camera, lastCameraState);
  }
  createdViewer.camera.moveEnd.addEventListener(persistViewState);
  const inspectBuildingAt = (position: Cartesian2, focusPanel: boolean): void => {
    const picked = createdViewer.scene.pick(position);
    if (picked instanceof Cesium3DTileFeature) {
      showFeatureDetails(picked, focusPanel);
    } else {
      hideAttributePanel();
    }
  };
  createdViewer.screenSpaceEventHandler.setInputAction((event: unknown) => {
    const movement = event as { position: Cartesian2 };
    inspectBuildingAt(movement.position, false);
  }, ScreenSpaceEventType.LEFT_CLICK);
  createdViewer.canvas.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") {
      return;
    }
    event.preventDefault();
    inspectBuildingAt(
      new Cartesian2(createdViewer.canvas.clientWidth / 2, createdViewer.canvas.clientHeight / 2),
      true,
    );
  });

  status.textContent = "3D Tiles 読込中";
  delete status.dataset.result;

  type TilesetSource = "primary" | "fallback";
  interface ActiveTilesetLifecycle {
    categoryFrame: number | null;
    categoryRenderPending: boolean;
    diagnosticsComplete: boolean;
    diagnosticsFrame: number | null;
    failureCount: number;
    generation: number;
    initialLoadState: InitialTilesetLoadState;
    initialTimeout: number | null;
    loadedTileCount: number;
    observedTileContents: WeakSet<object>;
    removeListeners: Array<() => void>;
    source: TilesetSource;
    tileset: Cesium3DTileset;
  }

  const fallbackAvailable =
    config.fallbackTilesetUrl.length > 0 &&
    config.fallbackTilesetUrl !== config.tilesetUrl;
  const initialTileTimeoutMs = 15_000;
  let generation = 0;
  let activeLifecycle: ActiveTilesetLifecycle | null = null;
  let fallbackAttempted = false;

  const isCurrentGeneration = (candidateGeneration: number): boolean =>
    generation === candidateGeneration &&
    activeLifecycle?.generation === candidateGeneration;

  const destroyUnmountedTileset = (candidate: Cesium3DTileset): void => {
    if (!candidate.isDestroyed()) {
      candidate.destroy();
    }
  };

  const detachActiveTileset = (candidateGeneration: number): void => {
    const lifecycle = activeLifecycle;
    if (!lifecycle || lifecycle.generation !== candidateGeneration) {
      return;
    }
    for (const removeListener of lifecycle.removeListeners) {
      removeListener();
    }
    if (lifecycle.initialTimeout !== null) {
      window.clearTimeout(lifecycle.initialTimeout);
    }
    if (lifecycle.categoryFrame !== null) {
      window.cancelAnimationFrame(lifecycle.categoryFrame);
    }
    if (lifecycle.diagnosticsFrame !== null) {
      window.cancelAnimationFrame(lifecycle.diagnosticsFrame);
    }
    activeLifecycle = null;
    if (tileset === lifecycle.tileset) {
      tileset = null;
    }
    const removed = createdViewer.scene.primitives.remove(lifecycle.tileset);
    if (!removed) {
      destroyUnmountedTileset(lifecycle.tileset);
    }
  };

  const resetDiscoveredCategories = (): void => {
    discoveredCategories = { districtsAndZones: [], usage: [] };
    renderCategoryControls();
    renderLegend();
  };

  const finishDiagnostics = (lifecycle: ActiveTilesetLifecycle): void => {
    if (!isCurrentGeneration(lifecycle.generation) || lifecycle.diagnosticsComplete) {
      return;
    }
    lifecycle.diagnosticsComplete = true;
    const report = runPreflight();
    const ionIndependent = report.ionRequests.length === 0;
    const preflightPassed =
      ionIndependent && report.japaneseAttributeExpressionPassed;
    ionResult.textContent = ionIndependent ? "合格" : "不合格";
    ionResult.dataset.result = ionIndependent ? "pass" : "fail";
    expressionResult.textContent = report.japaneseAttributeExpressionPassed
      ? "合格"
      : "不合格";
    expressionResult.dataset.result = report.japaneseAttributeExpressionPassed
      ? "pass"
      : "fail";
    document.documentElement.dataset.preflight = preflightPassed ? "pass" : "fail";

    if (lifecycle.failureCount > 0) {
      status.textContent = "一部タイル読込エラー";
      status.dataset.result = "fail";
    } else {
      status.textContent = preflightPassed ? "表示準備完了" : "事前検証を要確認";
      status.dataset.result = preflightPassed ? "pass" : "fail";
    }
  };

  const scheduleDiagnostics = (lifecycle: ActiveTilesetLifecycle): void => {
    if (lifecycle.diagnosticsFrame !== null || lifecycle.diagnosticsComplete) {
      return;
    }
    lifecycle.diagnosticsFrame = window.requestAnimationFrame(() => {
      lifecycle.diagnosticsFrame = null;
      finishDiagnostics(lifecycle);
    });
  };

  async function switchToFallback(candidateGeneration: number): Promise<void> {
    if (
      fallbackAttempted ||
      !fallbackAvailable ||
      !isCurrentGeneration(candidateGeneration)
    ) {
      return;
    }
    fallbackAttempted = true;
    generation += 1;
    const fallbackGeneration = generation;
    detachActiveTileset(candidateGeneration);
    resetDiscoveredCategories();
    status.textContent = "代替データを読込中";
    delete status.dataset.result;
    ionResult.textContent = "未完了";
    delete ionResult.dataset.result;

    try {
      const fallbackTileset = await createPlateauTileset(config.fallbackTilesetUrl);
      if (generation !== fallbackGeneration) {
        destroyUnmountedTileset(fallbackTileset);
        return;
      }
      mountTileset(fallbackTileset, "fallback", fallbackGeneration);
    } catch (error: unknown) {
      if (generation !== fallbackGeneration) {
        return;
      }
      console.error("Fallback 3D Tiles failed to load", error);
      status.textContent = "3D Tiles 読込エラー";
      status.dataset.result = "fail";
      ionResult.textContent = "未完了";
      ionResult.dataset.result = "fail";
    }
  }

  function mountTileset(
    candidate: Cesium3DTileset,
    source: TilesetSource,
    candidateGeneration: number,
  ): void {
    const lifecycle: ActiveTilesetLifecycle = {
      categoryFrame: null,
      categoryRenderPending: false,
      diagnosticsComplete: false,
      diagnosticsFrame: null,
      failureCount: 0,
      generation: candidateGeneration,
      initialLoadState: createInitialTilesetLoadState(),
      initialTimeout: null,
      loadedTileCount: 0,
      observedTileContents: new WeakSet<object>(),
      removeListeners: [],
      source,
      tileset: candidate,
    };
    activeLifecycle = lifecycle;
    tileset = candidate;
    candidate.style = createTilesetStyle(filterState, discoveredCategories.usage);
    status.textContent = source === "fallback" ? "代替3D Tiles 読込中" : "3D Tiles 読込中";
    delete status.dataset.result;

    const processTile = (tile: Cesium3DTile): void => {
      if (
        !isCurrentGeneration(candidateGeneration) ||
        lifecycle.observedTileContents.has(tile.content)
      ) {
        return;
      }
      lifecycle.observedTileContents.add(tile.content);
      const featuresLength = Number(tile.content.featuresLength);
      const actualFeaturesLength = Number.isFinite(featuresLength) ? featuresLength : 0;

      if (source === "primary") {
        const transition = transitionInitialTilesetLoad(
          lifecycle.initialLoadState,
          { type: "tile-content-loaded", featuresLength: actualFeaturesLength },
        );
        lifecycle.initialLoadState = transition.state;
        if (transition.state.primaryContentLoaded && lifecycle.initialTimeout !== null) {
          window.clearTimeout(lifecycle.initialTimeout);
          lifecycle.initialTimeout = null;
        }
      }

      if (actualFeaturesLength <= 0) {
        return;
      }
      lifecycle.loadedTileCount += 1;
      if (lifecycle.loadedTileCount === 1) {
        scheduleDiagnostics(lifecycle);
      }
      const merged = mergeCategoryValues(
        discoveredCategories,
        collectCategoryValues(tile.content),
      );
      const didChange = categoriesChanged(discoveredCategories, merged);
      discoveredCategories = merged;
      lifecycle.categoryRenderPending = lifecycle.categoryRenderPending || didChange;

      if (lifecycle.categoryRenderPending && lifecycle.categoryFrame === null) {
        lifecycle.categoryFrame = window.requestAnimationFrame(() => {
          lifecycle.categoryFrame = null;
          if (!isCurrentGeneration(candidateGeneration)) {
            return;
          }
          const shouldRenderCategories = lifecycle.categoryRenderPending;
          lifecycle.categoryRenderPending = false;
          if (shouldRenderCategories) {
            renderCategoryControls();
            if (filterState.colorMode === "usage") {
              candidate.style = createTilesetStyle(
                filterState,
                discoveredCategories.usage,
              );
              renderLegend();
            }
          }
        });
      }
    };

    lifecycle.removeListeners.push(
      candidate.tileLoad.addEventListener(processTile),
      candidate.tileVisible.addEventListener(processTile),
      candidate.tileFailed.addEventListener((failure: unknown) => {
        if (!isCurrentGeneration(candidateGeneration)) {
          return;
        }
        lifecycle.failureCount += 1;
        console.warn("PLATEAU tile failed to load", failure);

        if (source === "primary") {
          const transition = transitionInitialTilesetLoad(
            lifecycle.initialLoadState,
            { type: "tile-failed" },
          );
          lifecycle.initialLoadState = transition.state;
          if (transition.shouldStartFallback) {
            void switchToFallback(candidateGeneration);
            return;
          }
        }

        status.textContent =
          lifecycle.loadedTileCount > 0 ? "一部タイル読込エラー" : "3D Tiles 読込エラー";
        status.dataset.result = "fail";
        if (lifecycle.loadedTileCount === 0) {
          ionResult.textContent = "未完了";
          ionResult.dataset.result = "fail";
        }
      }),
      candidate.initialTilesLoaded.addEventListener(() => {
        if (lifecycle.loadedTileCount > 0) {
          scheduleDiagnostics(lifecycle);
        }
      }),
    );

    if (source === "primary" && fallbackAvailable) {
      lifecycle.initialTimeout = window.setTimeout(() => {
        if (!isCurrentGeneration(candidateGeneration)) {
          return;
        }
        const transition = transitionInitialTilesetLoad(
          lifecycle.initialLoadState,
          { type: "timeout" },
        );
        lifecycle.initialLoadState = transition.state;
        if (transition.shouldStartFallback) {
          void switchToFallback(candidateGeneration);
        }
      }, initialTileTimeoutMs);
    }

    createdViewer.scene.primitives.add(candidate);
    persistViewState();
  }

  const initialGeneration = ++generation;
  try {
    const primaryTileset = await createPlateauTileset(config.tilesetUrl);
    if (generation !== initialGeneration) {
      destroyUnmountedTileset(primaryTileset);
      return;
    }
    mountTileset(primaryTileset, "primary", initialGeneration);
  } catch (primaryError: unknown) {
    if (generation !== initialGeneration) {
      return;
    }
    if (!fallbackAvailable) {
      throw primaryError;
    }
    fallbackAttempted = true;
    status.textContent = "代替データを読込中";
    const fallbackTileset = await createPlateauTileset(config.fallbackTilesetUrl);
    if (generation !== initialGeneration) {
      destroyUnmountedTileset(fallbackTileset);
      return;
    }
    mountTileset(fallbackTileset, "fallback", initialGeneration);
  }
}

start().catch((error: unknown) => {
  console.error(error);
  status.textContent = "読込エラー";
  status.dataset.result = "fail";
  ionResult.textContent = "未完了";
  ionResult.dataset.result = "fail";
});
