import assert from "node:assert/strict";
import { initTheme, type ExtensionContext } from "@earendil-works/pi-coding-agent";

type Factory = Parameters<ExtensionContext["ui"]["custom"]>[0];
type NativeFactory<T> = (tui: Parameters<Factory>[0], theme: Parameters<Factory>[1], keys: Parameters<Factory>[2], done: (value: T) => void) => ReturnType<Factory>;

/** Test-only SDK interaction: submit the actual unchanged buffer, never manufacture approval. */
export function syntheticPacketCustom(beforeSubmit?: (text: string) => void | Promise<void>): ExtensionContext["ui"]["custom"] {
  return async <T>(factory: NativeFactory<T>): Promise<T> => {
    initTheme("dark", false);
    return await new Promise<T>((resolve, reject) => {
      const tui = { requestRender() {}, terminal: { rows: 40, columns: 80 } } as Parameters<Factory>[0];
      const keys = { matches: () => false } as unknown as Parameters<Factory>[2];
      void Promise.resolve(factory(tui, {} as Parameters<Factory>[1], keys, resolve)).then(async component => {
        try {
          assert.ok("children" in component && Array.isArray(component.children));
          const editor = component.children.find((child: { getExpandedText?: () => string }) => typeof child.getExpandedText === "function");
          assert.ok(editor); const text: string = editor.getExpandedText();
          await beforeSubmit?.(text);
          assert.equal(typeof component.handleInput, "function"); component.handleInput!("\r");
        } finally { component.dispose?.(); }
      }).catch(reject);
    });
  };
}
