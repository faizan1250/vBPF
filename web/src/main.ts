export const title = "vBPF";

export function banner(): string {
  return `${title} dev on :5173`;
}

if (typeof document !== "undefined") {
  const root = document.querySelector("#app");
  if (root !== null) {
    root.textContent = banner();
  }
}
