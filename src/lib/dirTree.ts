// lazily-loaded ascii folder tree shared by Sidebar.astro (links) and MoveDialog.astro (pick
// buttons) - each passes in its own per-folder label and whole-tree re-render
import { html, type TemplateResult } from "lit-html";

export const createDirTree = (renderLabel: (name: string, path: string[]) => TemplateResult, rerender: () => void) => {
  // path key ("" for root, else "a/b/c") -> child dir names, null while loading
  const cache = new Map<string, string[] | null>();
  const expanded = new Set<string>();

  const load = async (key: string) => {
    cache.set(key, null);
    rerender();
    const res = await fetch(`/api/list?path=${encodeURIComponent(key)}`);
    cache.set(key, res.ok ? (await res.json()).dirs : []);
    rerender();
  };

  const onToggle = (key: string, isOpen: boolean) => {
    if (isOpen) {
      expanded.add(key);
      if (!cache.has(key)) load(key);
    } else {
      expanded.delete(key);
    }
  };

  const renderChildren = (path: string[], pre: string): unknown => {
    const dirs = cache.get(path.join("/"));
    if (dirs === undefined) return null;
    if (dirs === null) return html`<div class="loading"><span class="pre">${pre}</span>loading...</div>`;

    return dirs.map((name, index) => {
      const childPath = [...path, name];
      const childKey = childPath.join("/");
      const isLast = index === dirs.length - 1;
      const isExpanded = expanded.has(childKey);
      const childPre = pre + (isLast ? "   " : "│  ");

      return html`
        <details ?open=${isExpanded} @toggle=${(e: Event) => onToggle(childKey, (e.target as HTMLDetailsElement).open)}>
          <summary><span class="pre">${pre}${isLast ? "└" : "├"}─ </span>${renderLabel(name, childPath)}</summary>
          ${isExpanded ? renderChildren(childPath, childPre) : ""}
        </details>
      `;
    });
  };

  return { cache, expanded, load, renderChildren };
};
