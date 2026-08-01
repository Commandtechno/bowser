// in-app replacement for window.confirm - a lazily-created singleton <dialog>, same
// on-first-use pattern as lib/toast.ts's container. Styling lives in Layout.astro's global
// stylesheet, same as toast/context-menu, since it's built outside any one component's scope.

export type TConfirmOptions = {
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  // when set, shows a "don't ask again" checkbox; checking it persists the choice under this
  // key so future calls with the same key resolve true immediately, no dialog shown
  key?: string;
};

let dialogEl: HTMLDialogElement | null = null;
let messageEl: HTMLParagraphElement;
let skipLabelEl: HTMLLabelElement;
let skipCheckbox: HTMLInputElement;
let confirmBtn: HTMLButtonElement;
let cancelBtn: HTMLButtonElement;

const skipStorageKey = (key: string): string => `confirmSkip:${key}`;

const ensureDialog = (): HTMLDialogElement => {
  if (dialogEl) return dialogEl;

  dialogEl = document.createElement("dialog");
  dialogEl.className = "confirm-dialog";
  dialogEl.innerHTML = `
    <p class="confirm-message"></p>
    <label class="confirm-skip" hidden><input type="checkbox" /> don't ask again</label>
    <div class="confirm-actions">
      <button type="button" class="confirm-cancel"></button>
      <button type="button" class="confirm-ok"></button>
    </div>
  `;
  document.body.appendChild(dialogEl);

  messageEl = dialogEl.querySelector(".confirm-message")!;
  skipLabelEl = dialogEl.querySelector(".confirm-skip")!;
  skipCheckbox = skipLabelEl.querySelector("input")!;
  cancelBtn = dialogEl.querySelector(".confirm-cancel")!;
  confirmBtn = dialogEl.querySelector(".confirm-ok")!;

  return dialogEl;
};

// resolves true (confirmed) or false (cancelled/dismissed) - never throws, never blocks
// the main thread the way window.confirm does
export const confirmAction = (opts: TConfirmOptions): Promise<boolean> => {
  if (opts.key && localStorage.getItem(skipStorageKey(opts.key)) === "1") return Promise.resolve(true);

  const dialog = ensureDialog();
  messageEl.textContent = opts.message;
  confirmBtn.textContent = opts.confirmLabel ?? "confirm";
  confirmBtn.classList.toggle("danger", !!opts.danger);
  cancelBtn.textContent = opts.cancelLabel ?? "cancel";
  skipCheckbox.checked = false;
  skipLabelEl.hidden = !opts.key;

  return new Promise<boolean>(resolve => {
    const finish = (result: boolean) => {
      if (result && opts.key && skipCheckbox.checked) localStorage.setItem(skipStorageKey(opts.key), "1");
      confirmBtn.removeEventListener("click", onConfirm);
      cancelBtn.removeEventListener("click", onCancel);
      dialog.removeEventListener("cancel", onCancel);
      dialog.removeEventListener("click", onBackdrop);
      dialog.close();
      resolve(result);
    };
    const onConfirm = () => finish(true);
    const onCancel = () => finish(false);
    // Escape triggers the dialog's native "cancel" event; clicking the backdrop (the dialog
    // element itself, not its children) should behave the same way
    const onBackdrop = (e: MouseEvent) => {
      if (e.target === dialog) finish(false);
    };

    confirmBtn.addEventListener("click", onConfirm);
    cancelBtn.addEventListener("click", onCancel);
    dialog.addEventListener("cancel", onCancel);
    dialog.addEventListener("click", onBackdrop);
    dialog.showModal();
  });
};
