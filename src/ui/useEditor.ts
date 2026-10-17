import { useSyncExternalStore } from "react";
import type { Editor } from "../interaction/editor";

/** Re-renders the calling component whenever the editor reports a change. */
export function useEditor(editor: Editor): number {
  return useSyncExternalStore(
    (fn) => editor.subscribe(fn),
    () => editor.version,
  );
}
