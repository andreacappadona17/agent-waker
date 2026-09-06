/**
 * Changes a setting without rewriting the file.
 *
 * A configuration file is the user's document. Serialising it back from the
 * parsed model would silently delete their comments, their ordering and any
 * key a newer version wrote that this one does not understand. So edits are
 * surgical: the document keeps its shape and only the named value moves.
 *
 * The result is validated before it is returned, because the one file this
 * program must always be able to read is the one it just wrote.
 */

import { isMap, parseDocument, type Document } from "yaml";

import { parseConfig } from "#src/config/config.js";

export interface ConfigEdit {
  readonly path: readonly string[];
  readonly value: string | number | boolean;
}

/** Times must stay quoted, or a YAML 1.1 reader sees `07:00` as 420. */
function needsQuoting(value: ConfigEdit["value"]): boolean {
  return typeof value === "string" && /^\d{1,2}:\d{2}$/.test(value);
}

/** The comments attached to a node, which belong to the user, not to us. */
interface Annotated {
  comment?: string | null;
  commentBefore?: string | null;
  type?: string;
}

function applyEdit(document: Document, edit: ConfigEdit): void {
  const previous = document.getIn([...edit.path], true) as
    Annotated | undefined;

  document.setIn([...edit.path], edit.value);

  const written = document.getIn([...edit.path], true) as Annotated;

  // Replacing a node would otherwise take its comments with it. They are the
  // user's own words about this setting; a changed value is not a reason to
  // delete them, and `schedule set` reports the change so they can revise.
  if (previous?.comment != null) written.comment = previous.comment;
  if (previous?.commentBefore != null) {
    written.commentBefore = previous.commentBefore;
  }

  if (needsQuoting(edit.value)) written.type = "QUOTE_DOUBLE";
}

/**
 * Applies edits to configuration text.
 *
 * @throws {Error} when the file cannot be parsed, or when the result would not
 * load.
 */
export function editConfig(
  source: string,
  edits: readonly ConfigEdit[],
): string {
  const document = parseDocument(source);
  const [failure] = document.errors;

  if (failure !== undefined) {
    throw new Error(
      `The configuration cannot be edited because it cannot be read: ${failure.message.split("\n")[0] ?? ""}`,
    );
  }

  if (document.contents !== null && !isMap(document.contents)) {
    throw new Error("The configuration is not a mapping of settings.");
  }

  for (const edit of edits) applyEdit(document, edit);

  const rendered = document.toString();

  // Validated before it is handed back: a file this program wrote and cannot
  // read is the worst outcome available.
  parseConfig(rendered, "the edited configuration");

  return rendered.endsWith("\n") ? rendered : `${rendered}\n`;
}
