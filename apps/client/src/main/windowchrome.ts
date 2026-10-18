/** Shared dark chrome with native, working window controls on each OS. */
export type WindowChrome = {
  titleBarStyle?: "hiddenInset" | "hidden";
  titleBarOverlay?: { color: string; symbolColor: string; height: number };
  backgroundColor: string;
  title: string;
};

export const WINDOW_BG = "#090a09";
export const WINDOW_CONTROL_HEIGHT = 32;

export function windowChrome(platform: NodeJS.Platform): WindowChrome {
  if (platform === "darwin") {
    return { titleBarStyle: "hiddenInset", backgroundColor: WINDOW_BG, title: "" };
  }
  if (platform === "win32") {
    // Hidden alone removes Windows controls. The overlay explicitly restores them.
    return {
      titleBarStyle: "hidden",
      titleBarOverlay: { color: WINDOW_BG, symbolColor: "#c7c9bf", height: WINDOW_CONTROL_HEIGHT },
      backgroundColor: WINDOW_BG,
      title: "Tunnex",
    };
  }
  return { backgroundColor: WINDOW_BG, title: "Tunnex" };
}
