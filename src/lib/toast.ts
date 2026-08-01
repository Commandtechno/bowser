// ephemeral bottom-corner notifications - styling lives in Layout.astro's global stylesheet

let container: HTMLDivElement | null = null;

const ensureContainer = (): HTMLDivElement => {
  if (container && document.body.contains(container)) return container;
  container = document.createElement("div");
  container.className = "toast-container";
  document.body.appendChild(container);
  return container;
};

export const showToast = (message: string, kind: "info" | "success" | "error" = "info"): void => {
  const root = ensureContainer();
  const el = document.createElement("div");
  el.className = `toast toast-${kind}`;
  el.textContent = message;
  root.appendChild(el);

  requestAnimationFrame(() => el.classList.add("show"));
  setTimeout(() => {
    el.classList.remove("show");
    setTimeout(() => el.remove(), 200);
  }, 3500);
};
