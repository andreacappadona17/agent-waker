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

import {
  isCollection,
  isMap,
  isScalar,
  parseDocument,
  YAMLMap,
  type Document,
} from "yaml";

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

/**
 * Makes sure every step of the path is something a value can be set inside.
 *
 * `setIn` throws when an intermediate node exists but is not a collection, and
 * two shapes that parse perfectly well hit that: `claude:` with nothing after
 * it is a null scalar, and `codex: *anchor` is an alias. Both used to be
 * unreachable, because only two-deep paths were ever edited.
 *
 * A null scalar becomes an empty map — there was nothing there to keep. An
 * alias is refused instead: replacing it would silently drop whatever the
 * anchor carried, and this file exists to avoid deleting the user's work.
 */
function ensureCollections(document: Document, path: readonly string[]): void {
  for (let depth = 1; depth < path.length; depth += 1) {
    const prefix = path.slice(0, depth);
    const node: unknown = document.getIn(prefix, true);

    if (node === undefined || isCollection(node)) continue;

    if (isScalar(node) && node.value === null) {
      document.setIn(prefix, new YAMLMap());
      continue;
    }

    throw new Error(
      `The configuration cannot be edited automatically: ${prefix.join(
        ".",
      )} is an alias or a plain value where a mapping is needed. Edit it by hand.`,
    );
  }
}

function applyEdit(document: Document, edit: ConfigEdit): void {
  ensureCollections(document, edit.path);

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
