import type { AuthClient } from "./auth.ts";
import {
  ViewsApiError,
  type SavedView,
  type SavedViewSummary,
  type ViewsApi,
} from "./views-api.ts";
import type { ViewStateSnapshot } from "./view-state.ts";

export type CloudMessageTone = "error" | "info" | "success";

export interface CloudMessage {
  readonly text: string;
  readonly tone: CloudMessageTone;
}

export interface CloudViewsUiOptions {
  readonly api: ViewsApi | null;
  readonly applySavedView: (view: SavedView) => void;
  readonly auth: AuthClient;
  readonly getSnapshot: () => ViewStateSnapshot | null;
  readonly initialMessage?: CloudMessage;
  readonly root?: ParentNode;
  readonly confirmDelete?: (message: string) => boolean;
  readonly navigate?: (url: string) => void;
  readonly now?: () => Date;
}

export interface SavedViewReconciliation {
  readonly items: readonly SavedViewSummary[];
  readonly pendingCreates: readonly SavedViewSummary[];
}

export function createOptimisticSavedView(
  title: string,
  viewId: string,
  now: () => Date = () => new Date(),
): SavedViewSummary {
  return {
    createdAt: now().toISOString(),
    title,
    viewId,
  };
}

export function reconcileSavedViews(
  serverItems: readonly SavedViewSummary[],
  pendingCreates: readonly SavedViewSummary[],
  deletedViewIds: ReadonlySet<string>,
): SavedViewReconciliation {
  const visibleServerItems: SavedViewSummary[] = [];
  const serverViewIds = new Set<string>();
  for (const item of serverItems) {
    if (deletedViewIds.has(item.viewId) || serverViewIds.has(item.viewId)) {
      continue;
    }
    serverViewIds.add(item.viewId);
    visibleServerItems.push(item);
  }

  const remainingPendingCreates: SavedViewSummary[] = [];
  const pendingViewIds = new Set<string>();
  for (const item of pendingCreates) {
    if (
      deletedViewIds.has(item.viewId) ||
      serverViewIds.has(item.viewId) ||
      pendingViewIds.has(item.viewId)
    ) {
      continue;
    }
    pendingViewIds.add(item.viewId);
    remainingPendingCreates.push(item);
  }

  return {
    items: [...remainingPendingCreates, ...visibleServerItems],
    pendingCreates: remainingPendingCreates,
  };
}

function requiredElement<T extends Element>(root: ParentNode, selector: string): T {
  const element = root.querySelector<T>(selector);
  if (!element) {
    throw new Error(`${selector} element was not found`);
  }
  return element;
}

function userMessage(error: unknown, action: "delete" | "list" | "load" | "save"): string {
  if (error instanceof ViewsApiError) {
    if (error.status === 401) {
      return "ログインの有効期限が切れました。もう一度ログインしてください。";
    }
    if (error.status === 403) {
      return "このビューを削除する権限がありません。";
    }
    if (error.status === 404) {
      return "保存ビューが見つかりませんでした。";
    }
    if (error.kind === "network") {
      return "保存APIへ接続できませんでした。通信状態を確認してください。";
    }
    if (error.kind === "configuration") {
      return "クラウド保存機能が設定されていません。";
    }
  }

  const fallbacks = {
    delete: "ビューを削除できませんでした。",
    list: "保存ビューの一覧を取得できませんでした。",
    load: "保存ビューを読み込めませんでした。",
    save: "ビューを保存できませんでした。",
  } as const;
  return fallbacks[action];
}

function formatCreatedAt(value: string): string {
  return new Intl.DateTimeFormat("ja-JP", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

export async function initializeCloudViewsUi(
  options: CloudViewsUiOptions,
): Promise<void> {
  const root = options.root ?? document;
  const authButton = requiredElement<HTMLButtonElement>(root, "#auth-button");
  const authSummary = requiredElement<HTMLElement>(root, "#auth-summary");
  const form = requiredElement<HTMLFormElement>(root, "#save-view-form");
  const titleInput = requiredElement<HTMLInputElement>(root, "#view-title");
  const saveButton = requiredElement<HTMLButtonElement>(root, "#save-view-button");
  const refreshButton = requiredElement<HTMLButtonElement>(root, "#refresh-views");
  const list = requiredElement<HTMLUListElement>(root, "#saved-views-list");
  const cloudStatus = requiredElement<HTMLOutputElement>(root, "#cloud-status");
  const sharePanel = requiredElement<HTMLElement>(root, "#saved-share");
  const shareLink = requiredElement<HTMLAnchorElement>(root, "#saved-share-link");
  const copyButton = requiredElement<HTMLButtonElement>(root, "#copy-saved-share");
  const navigate =
    options.navigate ?? ((url: string): void => window.location.assign(url));
  const confirmDelete =
    options.confirmDelete ??
    ((message: string): boolean => window.confirm(message));
  const now = options.now ?? (() => new Date());

  let currentShareUrl = "";
  const deletedViewIds = new Set<string>();
  let latestServerItems: readonly SavedViewSummary[] = [];
  let optimisticCreatedItems: readonly SavedViewSummary[] = [];
  let listRequestSequence = 0;

  const setMessage = (message: CloudMessage): void => {
    cloudStatus.textContent = message.text;
    cloudStatus.dataset.tone = message.tone;
  };

  const sessionAvailable = (): boolean => options.auth.getSession() !== null;

  const syncSessionUi = (): void => {
    const signedIn = sessionAvailable();
    const cloudReady = options.api !== null;
    authButton.disabled = !options.auth.available;
    authButton.textContent = signedIn ? "ログアウト" : "ログイン";
    authSummary.textContent = signedIn
      ? "ログイン中。保存とマイビューを利用できます。"
      : options.auth.available
        ? "未ログイン。共有ビューの閲覧はログイン不要です。"
        : "クラウド保存は未設定です。Tier 1のURL共有は利用できます。";
    titleInput.disabled = !signedIn || !cloudReady;
    saveButton.disabled = !signedIn || !cloudReady;
    refreshButton.disabled = !signedIn || !cloudReady;
    list.dataset.signedIn = String(signedIn);
  };

  const renderList = (items: readonly SavedViewSummary[]): void => {
    list.replaceChildren();
    if (items.length === 0) {
      const item = document.createElement("li");
      item.className = "saved-view-empty";
      item.textContent = "保存したビューはありません。";
      list.append(item);
      return;
    }

    for (const summary of items) {
      const item = document.createElement("li");
      item.className = "saved-view-item";

      const openButton = document.createElement("button");
      openButton.type = "button";
      openButton.className = "saved-view-open";
      const title = document.createElement("span");
      title.className = "saved-view-title";
      title.textContent = summary.title;
      const createdAt = document.createElement("time");
      createdAt.dateTime = summary.createdAt;
      createdAt.textContent = formatCreatedAt(summary.createdAt);
      openButton.append(title, createdAt);
      openButton.addEventListener("click", async () => {
        if (!options.api) {
          return;
        }
        openButton.disabled = true;
        setMessage({ text: "保存ビューを読み込んでいます…", tone: "info" });
        try {
          const savedView = await options.api.get(summary.viewId);
          options.applySavedView(savedView);
          setMessage({
            text: `「${summary.title}」を地図へ復元しました。`,
            tone: "success",
          });
        } catch (error: unknown) {
          setMessage({ text: userMessage(error, "load"), tone: "error" });
        } finally {
          openButton.disabled = false;
        }
      });

      const deleteButton = document.createElement("button");
      deleteButton.type = "button";
      deleteButton.className = "saved-view-delete";
      deleteButton.textContent = "削除";
      deleteButton.setAttribute("aria-label", `「${summary.title}」を削除`);
      deleteButton.addEventListener("click", async () => {
        if (
          !options.api ||
          !confirmDelete(`「${summary.title}」を削除します。この操作は取り消せません。`)
        ) {
          return;
        }
        deleteButton.disabled = true;
        try {
          await options.api.delete(summary.viewId);
          deletedViewIds.add(summary.viewId);
          optimisticCreatedItems = optimisticCreatedItems.filter(
            (item) => item.viewId !== summary.viewId,
          );
          renderReconciledList();
          setMessage({ text: `「${summary.title}」を削除しました。`, tone: "success" });
          await refreshList();
        } catch (error: unknown) {
          setMessage({ text: userMessage(error, "delete"), tone: "error" });
          deleteButton.disabled = false;
          syncSessionUi();
        }
      });

      item.append(openButton, deleteButton);
      list.append(item);
    }
  };

  const renderReconciledList = (): void => {
    const reconciliation = reconcileSavedViews(
      latestServerItems,
      optimisticCreatedItems,
      deletedViewIds,
    );
    optimisticCreatedItems = reconciliation.pendingCreates;
    renderList(reconciliation.items);
  };

  const refreshList = async (): Promise<void> => {
    const sequence = ++listRequestSequence;
    if (!options.api || !sessionAvailable()) {
      latestServerItems = [];
      optimisticCreatedItems = [];
      deletedViewIds.clear();
      list.replaceChildren();
      syncSessionUi();
      return;
    }

    refreshButton.disabled = true;
    list.setAttribute("aria-busy", "true");
    try {
      const items = await options.api.list();
      if (sequence === listRequestSequence) {
        latestServerItems = items;
        renderReconciledList();
      }
    } catch (error: unknown) {
      if (sequence === listRequestSequence) {
        setMessage({ text: userMessage(error, "list"), tone: "error" });
      }
    } finally {
      if (sequence === listRequestSequence) {
        list.removeAttribute("aria-busy");
        syncSessionUi();
      }
    }
  };

  authButton.addEventListener("click", async () => {
    authButton.disabled = true;
    try {
      if (sessionAvailable()) {
        const logoutUrl = options.auth.logout();
        syncSessionUi();
        if (logoutUrl) {
          navigate(logoutUrl);
        }
        return;
      }

      const authorizeUrl = await options.auth.createAuthorizeUrl(
        window.location.href,
      );
      if (authorizeUrl) {
        navigate(authorizeUrl);
      } else {
        setMessage({ text: "認証機能が設定されていません。", tone: "error" });
      }
    } catch {
      setMessage({ text: "ログイン処理を開始できませんでした。", tone: "error" });
    } finally {
      authButton.disabled = !options.auth.available;
    }
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!options.api || !sessionAvailable()) {
      setMessage({ text: "保存するにはログインが必要です。", tone: "error" });
      syncSessionUi();
      return;
    }

    const snapshot = options.getSnapshot();
    if (!snapshot?.camera) {
      setMessage({ text: "地図の準備が完了してから保存してください。", tone: "error" });
      return;
    }

    saveButton.disabled = true;
    setMessage({ text: "ビューを保存しています…", tone: "info" });
    const title = titleInput.value.trim();
    try {
      const result = await options.api.create({
        title,
        filterState: snapshot.filter,
        cameraState: snapshot.camera,
      });
      optimisticCreatedItems = [
        createOptimisticSavedView(title, result.viewId, now),
        ...optimisticCreatedItems.filter((item) => item.viewId !== result.viewId),
      ];
      renderReconciledList();
      currentShareUrl = result.shareUrl;
      shareLink.href = result.shareUrl;
      shareLink.textContent = "保存したビューの共有リンク";
      sharePanel.hidden = false;
      titleInput.value = "";
      setMessage({ text: "ビューを保存しました。共有リンクはログインなしで開けます。", tone: "success" });
      await refreshList();
    } catch (error: unknown) {
      setMessage({ text: userMessage(error, "save"), tone: "error" });
    } finally {
      syncSessionUi();
    }
  });

  refreshButton.addEventListener("click", () => {
    void refreshList();
  });

  copyButton.addEventListener("click", async () => {
    if (currentShareUrl.length === 0) {
      return;
    }
    try {
      await navigator.clipboard.writeText(currentShareUrl);
      setMessage({ text: "保存ビューの共有リンクをコピーしました。", tone: "success" });
    } catch {
      setMessage({
        text: "リンクをコピーできませんでした。表示されたリンクをコピーしてください。",
        tone: "error",
      });
    }
  });

  syncSessionUi();
  if (options.initialMessage) {
    setMessage(options.initialMessage);
  } else if (!options.auth.available || !options.api) {
    setMessage({
      text: "クラウド保存は未設定です。共有URLボタンは利用できます。",
      tone: "info",
    });
  } else if (sessionAvailable()) {
    setMessage({ text: "ログイン済みです。", tone: "success" });
  } else {
    setMessage({ text: "ログインすると現在のビューを保存できます。", tone: "info" });
  }

  await refreshList();
}
