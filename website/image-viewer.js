const links = [...document.querySelectorAll('a[href$=".png"]')].filter(link => link.querySelector("img"));
if (links.length && typeof HTMLDialogElement.prototype.showModal === "function") {
  const dialog = document.createElement("dialog");
  dialog.className = "image-viewer";
  dialog.setAttribute("aria-label", "Image preview");
  const close = document.createElement("button");
  close.type = "button";
  close.textContent = "Close ×";
  const image = document.createElement("img");
  dialog.append(close, image);
  document.body.append(dialog);
  let opener;
  for (const link of links) link.addEventListener("click", event => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    opener = link;
    image.src = link.href;
    image.alt = link.querySelector("img").alt;
    dialog.showModal();
    document.documentElement.classList.add("image-open");
    close.focus();
  });
  close.addEventListener("click", () => dialog.close());
  dialog.addEventListener("keydown", event => {
    if (event.key === "Tab") { event.preventDefault(); close.focus(); }
  });
  dialog.addEventListener("click", event => {
    const box = dialog.getBoundingClientRect();
    if (event.target === dialog && (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom)) dialog.close();
  });
  dialog.addEventListener("close", () => {
    document.documentElement.classList.remove("image-open");
    image.removeAttribute("src");
    opener?.focus({ preventScroll: true });
  });
}
