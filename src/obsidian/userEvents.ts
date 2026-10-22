// CodeMirror userEvent annotations that mean a person edited the text (ADR 0003, S3):
// typing, deleting, undo/redo and drag-and-drop. Reloads from disk are "set"; plugin
// writes carry no userEvent.

const HUMAN_EVENT = /^(input|delete|undo|redo|move)(\.|$)/;

export function isHumanUserEvent(userEvent: string | undefined): boolean {
  return userEvent !== undefined && HUMAN_EVENT.test(userEvent);
}
