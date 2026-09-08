/** Tool-derived strings reach the DOM through textContent only, never innerHTML. */
export function appendTextChild(
  parent: ParentNode,
  tag: string,
  text: string,
  className?: string,
): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  node.textContent = text;
  parent.appendChild(node);
  return node;
}

/** A detached element, ready to be filled in and appended by its caller. */
export function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
