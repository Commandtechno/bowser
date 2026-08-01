// minimal right-click menu primitive - positions itself at the cursor, closes on outside
// click/scroll/Escape/blur. Styling lives in Layout.astro's global stylesheet since this
// module builds plain DOM nodes rather than going through lit-html.

export type TContextMenuItem =
  | { type: "action"; label: string; onClick: () => void; disabled?: boolean; danger?: boolean; title?: string }
  | { type: "separator" };

let closeCurrent: (() => void) | null = null;

export const openContextMenu = (x: number, y: number, items: TContextMenuItem[]): void => {
  closeCurrent?.();

  const menu = document.createElement("div");
  menu.className = "ctx-menu";

  for (const item of items) {
    if (item.type === "separator") {
      menu.appendChild(document.createElement("div")).className = "ctx-menu-sep";
      continue;
    }
    const btn = document.createElement("button");
    btn.className = "ctx-menu-item" + (item.danger ? " danger" : "");
    btn.textContent = item.label;
    btn.disabled = !!item.disabled;
    if (item.title) btn.title = item.title;
    btn.addEventListener("click", () => {
      close();
      item.onClick();
    });
    menu.appendChild(btn);
  }

  document.body.appendChild(menu);

  const rect = menu.getBoundingClientRect();
  const left = Math.max(8, Math.min(x, window.innerWidth - rect.width - 8));
  const top = Math.max(8, Math.min(y, window.innerHeight - rect.height - 8));
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;

  const onDocMouseDown = (e: MouseEvent) => {
    if (!menu.contains(e.target as Node)) close();
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") close();
  };
  const onScroll = () => close();

  function close() {
    menu.remove();
    document.removeEventListener("mousedown", onDocMouseDown, true);
    document.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("scroll", onScroll, true);
    window.removeEventListener("blur", close);
    if (closeCurrent === close) closeCurrent = null;
  }

  closeCurrent = close;

  // defer binding a frame so the same mousedown/contextmenu event that opened this
  // menu doesn't immediately bubble into onDocMouseDown and close it right away
  setTimeout(() => {
    document.addEventListener("mousedown", onDocMouseDown, true);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("blur", close);
  }, 0);
};
