/// <reference types="vite/client" />
import type { WebviewTag } from "electron";
import type { RuneBridge } from "../shared/api";

declare global {
  interface Window {
    rune: RuneBridge;
  }
}

declare module "solid-js" {
  namespace JSX {
    interface IntrinsicElements {
      webview: HTMLAttributes<WebviewTag> & { src?: string; partition?: string };
    }
  }
}
