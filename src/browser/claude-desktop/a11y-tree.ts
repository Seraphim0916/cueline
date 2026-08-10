/**
 * Parser for the accessibility tree a Claude Code host returns from its
 * `read_page` tool. One node per line:
 *
 *     link "Skip content" [ref_1] href="#main"
 *     button [ref_2] type="button"
 *     textbox "Chat with ChatGPT" [ref_6]
 *     Viewport: 574x1243
 *
 * Role is bare, the accessible name is quoted and optional, and `[ref_N]` is
 * the handle the host's click and fill tools accept. Parsing happens here so
 * element resolution stays deterministic: the host's natural-language `find`
 * tool would put a model's judgement inside CueLine's control loop.
 */

export interface A11yNode {
  role: string;
  name?: string;
  ref?: string;
  /** Leading-space count, kept so callers can reason about nesting. */
  depth: number;
  disabled: boolean;
}

const NODE_LINE =
  /^(?<indent>[ \t]*)(?<role>[A-Za-z][A-Za-z0-9_-]*)(?:[ \t]+"(?<name>(?:[^"\\]|\\.)*)")?(?<rest>[ \t].*)?$/;
const REF = /\[(ref_[A-Za-z0-9_]+)\]/;
const VIEWPORT_LINE = /^[ \t]*Viewport:/;

/** Playwright-style name comparison: trimmed, whitespace-collapsed, case-insensitive. */
function normalizeName(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

function unescapeName(value: string): string {
  return value.replace(/\\(.)/g, "$1");
}

export function parseAccessibilityTree(raw: string): A11yNode[] {
  const nodes: A11yNode[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (line.trim() === "" || VIEWPORT_LINE.test(line)) continue;
    const groups = NODE_LINE.exec(line)?.groups;
    if (groups === undefined) continue;

    const rest = groups["rest"] ?? "";
    const ref = REF.exec(rest)?.[1];
    const name = groups["name"];
    nodes.push({
      role: groups["role"]!,
      ...(name === undefined ? {} : { name: unescapeName(name) }),
      ...(ref === undefined ? {} : { ref }),
      depth: (groups["indent"] ?? "").length,
      disabled: /\bdisabled\b/.test(rest),
    });
  }
  return nodes;
}

export function findNodesByRole(
  nodes: readonly A11yNode[],
  role: string,
  name: string,
): A11yNode[] {
  const wanted = normalizeName(name);
  const wantedRole = role.toLowerCase();
  return nodes.filter(
    (node) =>
      node.role.toLowerCase() === wantedRole &&
      node.name !== undefined &&
      normalizeName(node.name) === wanted,
  );
}
