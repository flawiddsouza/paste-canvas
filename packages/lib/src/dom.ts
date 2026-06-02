/**
 * True when the event target is a field the user types into — a text input,
 * a textarea, or any contentEditable element (e.g. the tab-title editor).
 *
 * Used to suppress canvas keyboard and paste shortcuts while the user is
 * editing text, so keystrokes don't leak out to the viewport / selected items.
 */
export function isEditableTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement
    && (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT' || target.isContentEditable);
}
