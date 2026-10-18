// Board tools shared by the local stdio server (server.mjs) and the hosted endpoint (api/mcp.js).
// `call(method, params)` delivers one command to the open board tab and resolves with its result.
import { z } from "zod";

export const INSTRUCTIONS = [
  "Tools for reading and editing the user's open whiteboard (an infinite canvas). The user watches changes live and can undo each call.",
  "For anything with structure (flowcharts, processes, system architecture, org charts, mind maps, feature breakdowns, kanban, roadmaps, timelines, brainstorm clusters) use create_diagram: describe nodes, edges and groups and the board lays them out, sizes nodes to their text and routes the connectors. Don't compute coordinates by hand for those.",
  "For planning a whole product, project or idea, follow the plan_board prompt: a set of titled sections placed side by side, each built with create_diagram, then checked with get_screenshot.",
  "When the user asks to change a diagram, use update_elements for small edits (text, colours) and create_diagram with replace:<section id> to restructure it in place. Use create_elements for small additions (a note, a label, one connector) and arrange_elements to tidy. Coordinates are world units, x right, y down; elements have x/y (top-left) and w/h.",
  "On a board with existing content, start with get_board {outline:true}, then read sections with get_board {frame:id}. Place new work with place:{near:id, side} so it doesn't overlap.",
  "get_screenshot {ids:[...]} shows any region without moving the user's view; check your work with it and fix overlaps or unclear labels.",
].join(" ");

export const PLAN_BOARD = `Plan this on my InfiniteBoard as a clear visual workspace: {idea}

Work like a strong product lead and systems designer:
1. Think first. Work out the goal, the users, the core features, how it works, and how to get there. Make sensible assumptions and state them on the board instead of asking.
2. Choose the sections that fit this idea (not all are needed; add others if they help). For a product, typically:
   - Overview: problem, goal, target users, success metrics (grid of notes or cards, grouped)
   - Users and their journey (flow, direction right)
   - Features by priority (columns: Must / Should / Later)
   - System architecture (flow, direction right, groups such as Client / Backend / Data / External, with database and queue kinds and labelled edges)
   - Key flow or data model (flow with decisions)
   - Roadmap (timeline with dates in detail, or columns Now / Next / Later)
   - Risks and open questions (grid)
3. Build each section with one create_diagram call and a title. Place the first section where it lands by default, the next ones with place:{near:<previous section frame or heading id>, side:"right"}, and start a new row with side:"below" from the first section of the previous row. Use 2-3 sections per row.
4. Keep labels short and specific to this idea; no filler.
5. Check each section with get_screenshot {ids:[sectionId]} and fix anything unclear, crowded or overlapping (update_elements, arrange_elements, or delete and recreate).
6. Finish with focus_view (no arguments) to show the whole plan, and summarise what you put on the board in a few lines.`;

const asText = (value) => ({ content: [{ type: "text", text: JSON.stringify(value, null, 1) }] });
const asError = (e) => ({ isError: true, content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }] });
const relayVia = (call) => (method) => async (params) => {
  try {
    return asText(await call(method, params));
  } catch (e) {
    return asError(e);
  }
};

/**
 * @param {import("@modelcontextprotocol/sdk/server/mcp.js").McpServer} server
 * @param {(method: string, params?: object) => Promise<any>} call
 */
export function registerBoardTools(server, call) {
  const relay = relayVia(call);
  const color = z.string().describe("Hex colour (#rrggbb) or a name: yellow, orange, pink, purple, blue, green, lime, gray, white, black, red, darkblue, darkgreen");
  const point = z.tuple([z.number(), z.number()]);
  const common = {
    x: z.number().optional().describe("Left edge (world units). Omit x and y to auto-place in free space"),
    y: z.number().optional().describe("Top edge (world units)"),
    w: z.number().positive().optional(),
    h: z.number().positive().optional(),
    text: z.string().optional().describe("Text for sticky, shape and text elements (plain text, \\n for new lines)"),
    title: z.string().optional().describe("Frame title"),
    color: color.optional().describe("Sticky/frame: background. Text/shape: text colour. Connector/stroke: line colour"),
    fill: z.string().optional().describe('Shape fill colour, or "none"'),
    stroke: color.optional().describe("Shape border colour"),
    kind: z.enum(["rect", "roundrect", "ellipse", "diamond", "triangle", "hexagon", "parallelogram", "cylinder"]).optional().describe("Shape kind (default rect). cylinder = database/storage, parallelogram = input/output, hexagon = queue/event"),
    fontSize: z.number().positive().optional(),
    align: z.enum(["left", "center", "right"]).optional(),
    bold: z.boolean().optional(),
    angle: z.number().optional().describe("Rotation in degrees, clockwise"),
    from: z.string().optional().describe("Connector start: element id or ref"),
    to: z.string().optional().describe("Connector end: element id or ref"),
    fromPoint: point.optional().describe("Connector start as [x, y] when not attached"),
    toPoint: point.optional().describe("Connector end as [x, y] when not attached"),
    route: z.enum(["straight", "elbow", "curved"]).optional(),
    label: z.string().optional().describe("Connector label"),
    endHead: z.enum(["none", "open", "filled"]).optional(),
    startHead: z.enum(["none", "open", "filled"]).optional(),
    dash: z.enum(["solid", "dashed", "dotted"]).optional(),
  };

  server.registerTool("get_board", {
    title: "Read the board",
    description: "Lists the board's elements (id, type, position, size, text, colours, frame membership, connector endpoints), the visible viewport, content bounds and current selection. On big boards use outline:true first (sections only), then frame:<id> to read one section.",
    inputSchema: {
      outline: z.boolean().optional().describe("Return only an outline: frames (sections) with titles, bounds, what they contain and sample text, plus headings"),
      frame: z.string().optional().describe("Only list this frame and what's inside it"),
      type: z.enum(["sticky", "shape", "text", "frame", "connector", "stroke", "image"]).optional().describe("Only list this element type"),
      limit: z.number().int().positive().max(5000).optional().describe("Maximum elements to return (default 500)"),
    },
    annotations: { readOnlyHint: true },
  }, relay("get_board"));

  server.registerTool("create_elements", {
    title: "Create elements",
    description:
      "Creates sticky notes, shapes, text, frames, connectors and pen strokes in one undoable step. " +
      "Give elements a `ref` to connect them in the same call, e.g. [{type:'sticky',ref:'a',text:'Idea'},{type:'sticky',ref:'b',text:'Plan'},{type:'connector',from:'a',to:'b'}]. " +
      "Elements placed at least half inside a frame automatically belong to it. Returns the new ids.",
    inputSchema: {
      elements: z.array(z.object({
        type: z.enum(["sticky", "shape", "text", "frame", "connector", "stroke"]),
        ref: z.string().optional().describe("Your own key for referring to this element later in the same call"),
        ...common,
        points: z.array(point).optional().describe("Stroke points [[x, y], …] in world units"),
        width: z.number().positive().optional().describe("Stroke width"),
      })).min(1).max(500),
    },
  }, relay("create_elements"));


  const nodeKind = z.enum(["process", "decision", "terminal", "io", "database", "service", "user", "external", "queue", "card", "note", "topic", "text"]);
  server.registerTool("create_diagram", {
    title: "Create a laid-out diagram",
    description: [
      "Builds a complete, automatically laid-out diagram in one undoable step. You describe the structure; the board sizes every node to its text, positions everything without overlaps, draws group frames and routes connectors.",
      "Layouts: flow = layered graph from edges (flowcharts, processes, system architecture, data flow, dependencies; direction down or right); tree = hierarchy from each node's parent (org chart, feature/work breakdown, sitemap); mindmap = one root (no parent) with branches on both sides, coloured per branch; columns = one column per group, nodes stacked (kanban, Now/Next/Later roadmap, user-story map, pros/cons, categories); grid = cards in a grid, one cluster per group (brainstorm, affinity map, personas, risks); timeline = nodes in the given order along an axis, detail shown as the date, groups become phases.",
      "Node kinds: process (rounded box), decision (diamond), terminal (start/end pill), io (parallelogram), database (cylinder), service (box), user (actor), external (grey box), queue (hexagon), card (white card), note (sticky note), topic (mind-map topic), text (plain label). Defaults: flow/tree process, mindmap topic, columns/timeline card, grid note.",
      "Groups become frames around their nodes (e.g. Frontend / Backend / Data in an architecture; lanes; phases). Give the diagram a title to make it a titled section.",
      "Keep node text short (2–8 words); put extra explanation in detail. Returns the element id for each node id, group frame ids, a section id (when titled) and bounds. Place the next diagram with place:{near:<section id>, side}; it goes beside the whole section.",
    ].join(" "),
    inputSchema: {
      layout: z.enum(["flow", "tree", "mindmap", "columns", "grid", "timeline"]),
      title: z.string().optional().describe("Section title: shown as the frame title (or as a heading above group frames)"),
      direction: z.enum(["down", "right"]).optional().describe("flow/tree: down (default) or right (good for architecture and pipelines)"),
      nodes: z.array(z.object({
        id: z.string().describe("Your id for this node, used by edges, parent and in the result"),
        text: z.string().describe("Label, short"),
        detail: z.string().optional().describe("Second line of smaller detail; for timeline nodes, the date or period"),
        kind: nodeKind.optional(),
        color: color.optional().describe("Fill tone (pastel): yellow, orange, red, pink, purple, blue, teal, green, lime, gray, white, or #rrggbb"),
        group: z.string().optional().describe("Group id: frame (flow/grid), column (columns) or phase (timeline)"),
        parent: z.string().optional().describe("tree/mindmap: parent node id (omit on the root)"),
      })).min(1).max(400),
      edges: z.array(z.object({
        from: z.string(),
        to: z.string(),
        label: z.string().optional().describe("Short label, e.g. Yes / No / HTTPS / publishes"),
        style: z.enum(["solid", "dashed", "dotted"]).optional().describe("dashed for async/optional/indirect"),
        route: z.enum(["straight", "elbow", "curved"]).optional(),
        bidirectional: z.boolean().optional(),
      })).max(800).optional().describe("Connections. tree/mindmap edges from parent come automatically; add extra cross-links here"),
      groups: z.array(z.object({
        id: z.string(),
        title: z.string().optional(),
        color: color.optional(),
      })).optional().describe("Titles, colours and order for groups (optional; groups used by nodes are created anyway)"),
      place: z.union([
        z.object({ x: z.number(), y: z.number() }).describe("Top-left corner"),
        z.object({ near: z.string().describe("Existing element or frame id"), side: z.enum(["right", "below", "left", "above"]).optional(), gap: z.number().optional() }),
      ]).optional().describe("Where to put it. Default: to the right of existing content (or centred in view on an empty board)"),
      spacing: z.enum(["compact", "normal", "roomy"]).optional(),
      focus: z.boolean().optional().describe("Move the user's view to the new diagram (default true)"),
      replace: z.string().optional().describe("To change a diagram you made: its section id (or any element in it). The old one is swapped out in place, as one undo step"),
    },
  }, relay("create_diagram"));

  server.registerTool("arrange_elements", {
    title: "Arrange elements",
    description: "Tidies existing elements in one undoable step: flow/tree re-layout using the connectors between them (connectors re-attach cleanly), or grid/row/column. Pass ids, or a frame to arrange its contents (the frame grows to fit).",
    inputSchema: {
      ids: z.array(z.string()).optional(),
      frame: z.string().optional(),
      layout: z.enum(["flow", "tree", "grid", "row", "column"]).optional().describe("Default flow"),
      direction: z.enum(["down", "right"]).optional(),
      columns: z.number().int().positive().optional().describe("grid: number of columns"),
      spacing: z.enum(["compact", "normal", "roomy"]).optional(),
    },
  }, relay("arrange_elements"));

  server.registerTool("update_elements", {
    title: "Update elements",
    description: "Moves, resizes, recolours, retexts or rewires existing elements (one undoable step). Only the fields you pass change. Set locked to stop the user moving an element.",
    inputSchema: {
      updates: z.array(z.object({ id: z.string(), ...common, locked: z.boolean().optional() })).min(1).max(1000),
    },
  }, relay("update_elements"));

  server.registerTool("delete_elements", {
    title: "Delete elements",
    description: "Deletes elements by id (deleting a frame deletes its contents). Pass all: true to clear the board. One undoable step.",
    inputSchema: {
      ids: z.array(z.string()).optional(),
      all: z.boolean().optional().describe("Delete everything on the board"),
    },
    annotations: { destructiveHint: true },
  }, relay("delete_elements"));

  server.registerTool("focus_view", {
    title: "Move the view",
    description: "Pans/zooms the user's view: fit the given element ids, centre on x/y (optionally at a zoom), set a zoom level, or with no arguments fit the whole board.",
    inputSchema: {
      ids: z.array(z.string()).optional(),
      x: z.number().optional(),
      y: z.number().optional(),
      zoom: z.number().positive().max(8).optional().describe("1 = 100%"),
    },
  }, relay("focus_view"));

  server.registerTool("select_elements", {
    title: "Select elements",
    description: "Highlights elements for the user by selecting them (empty list clears the selection).",
    inputSchema: { ids: z.array(z.string()) },
  }, relay("select"));

  server.registerPrompt("plan_board", {
    title: "Plan an idea on the board",
    description: "Turns a product, project or idea into a structured visual plan on the board.",
    argsSchema: { idea: z.string().describe("What you want to plan, build or explore") },
  }, ({ idea }) => ({
    messages: [{ role: "user", content: { type: "text", text: PLAN_BOARD.replace("{idea}", idea) } }],
  }));

  server.registerTool("undo", { title: "Undo", description: "Undoes the last change on the board (the user's or the assistant's).", inputSchema: {} }, relay("undo"));
  server.registerTool("redo", { title: "Redo", description: "Redoes the last undone change.", inputSchema: {} }, relay("redo"));

  server.registerTool("get_screenshot", {
    title: "Screenshot the board",
    description: "Returns an image of the board. With ids (or bounds, or all:true) it renders that region without moving the user's view, which is the best way to check a diagram you just made; with no arguments it shows what the user currently sees.",
    inputSchema: {
      ids: z.array(z.string()).optional().describe("Render the area around these elements (e.g. a section frame id)"),
      bounds: z.object({ x: z.number(), y: z.number(), w: z.number().positive(), h: z.number().positive() }).optional(),
      all: z.boolean().optional().describe("Render the whole board"),
      maxWidth: z.number().int().min(200).max(2400).optional().describe("Maximum image width in pixels (default 1280)"),
    },
    annotations: { readOnlyHint: true },
  }, async (params) => {
    try {
      const { image } = await call("screenshot", params);
      const m = /^data:(image\/\w+);base64,(.*)$/s.exec(image ?? "");
      if (!m) throw new Error("The board returned no image");
      return { content: [{ type: "image", mimeType: m[1], data: m[2] }] };
    } catch (e) {
      return asError(e);
    }
  });
}
