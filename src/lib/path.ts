export type TPath = string[];

export const getCurrentPath = (): TPath =>
  decodeURIComponent(window.location.hash.replace("#", ""))
    .split("/")
    .filter(seg => seg.length > 0);

export const updatePath = (path: TPath) => {
  window.location.hash = path.join("/");
};

window.onhashchange = () => {
  window.dispatchEvent(new Event("pathUpdate"));
};

window.dispatchEvent(new Event("pathUpdate"));
