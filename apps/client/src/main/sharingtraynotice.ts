// LS-CLIENT-1: closing the window keeps active shares running in the tray. The first time
// that happens, say so once with a non-blocking notification and remember it locally.
// Electron-free so it is testable in CI; index.ts supplies the store and the notifier.
export interface KeepSharingNotice { title: string; body: string }

export function keepSharingNotice(count: number): KeepSharingNotice {
  return {
    title: "Local Sharing is still on",
    body: `Tunnex is still sharing ${count} ${count === 1 ? "app" : "apps"}. Quit Tunnex to stop sharing.`,
  };
}

/**
 * Shows the notice when the window hides with active shares and it was never shown.
 * Returns true only when it was shown and remembered. Never throws: hiding the window
 * must not depend on notifications or settings storage.
 */
export function noticeOnWindowHidden(
  count: number,
  store: { shown(): boolean; markShown(): void },
  show: (notice: KeepSharingNotice) => boolean,
): boolean {
  try {
    if (count <= 0 || store.shown()) return false;
    if (!show(keepSharingNotice(count))) return false;
    store.markShown();
    return true;
  } catch {
    return false;
  }
}
