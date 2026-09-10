const key = document.querySelector("#licence-key");
const message = document.querySelector("#key-message");
document.querySelector("#copy-key")?.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(key.value);
    message.textContent = "Key copied.";
  } catch {
    key.focus(); key.select();
    message.textContent = "Key selected. Use your device’s Copy command.";
  }
});
// Clear the revealed certificate from a restored history page.
window.addEventListener("pageshow", (event) => { if (event.persisted) window.location.replace("/account"); });
