/** Poll `check` every 20 ms until it holds, or throw `message` after `timeoutMs`. */
export async function until(
  check: () => boolean | Promise<boolean>,
  message = "condition never held",
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise((r) => setTimeout(r, 20));
  }
}
