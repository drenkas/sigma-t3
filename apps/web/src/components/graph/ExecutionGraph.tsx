import { MinusIcon, PlusIcon } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";

import { observeResize } from "~/lib/observeResize";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import {
  FAILED_STATUSES,
  layoutExecutionGraph,
  NODE_H,
  NODE_W,
  RUNNING_STATUSES,
  type ExecutionGraphEdge,
  type ExecutionGraphNode,
} from "./executionGraphLayout";

const pretty = (value: string) => value.replaceAll("_", " ").replaceAll("-", " ");
const EDGE_DASH: Record<string, string | undefined> = {
  result: "6 3",
  context_transfer: "2 3",
  merge: "5 4",
};
const LEGEND: Record<string, string> = {
  delegation: "── delegated",
  fork: "── fork",
  subagent: "── subagent",
  result: "╌╌ result",
  context_transfer: "┈┈ context transfer",
  merge: "- - merge",
};
const clampZoom = (value: number) => Math.max(0.3, Math.min(2, value));

/**
 * The execution tree of agents and the links recorded between them. Draws once per data
 * change and never animates; panning and zooming only move one transformed layer.
 */
export function ExecutionGraph({
  label,
  nodes,
  edges,
  treeKinds,
  selectedId,
  onSelect,
}: {
  label: string;
  nodes: ReadonlyArray<ExecutionGraphNode>;
  edges: ReadonlyArray<ExecutionGraphEdge>;
  treeKinds: ReadonlySet<string>;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const layout = layoutExecutionGraph(nodes, edges, treeKinds);
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const viewportRef = useRef<HTMLDivElement>(null);
  const movedRef = useRef(false);
  const dragRef = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);
  const [view, setView] = useState({ zoom: 1, x: 0, y: 0 });
  const [hover, setHover] = useState<string | null>(null);

  const fitTo = (viewport: HTMLDivElement) => {
    const zoom = Math.max(0.3, Math.min(1, (viewport.clientWidth - 16) / layout.width));
    movedRef.current = false;
    setView({ zoom, x: Math.max(8, (viewport.clientWidth - layout.width * zoom) / 2), y: 8 });
  };
  const zoomBy = (factor: number) => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    movedRef.current = true;
    const cx = viewport.clientWidth / 2;
    const cy = viewport.clientHeight / 2;
    setView((old) => {
      const zoom = clampZoom(old.zoom * factor);
      return {
        zoom,
        x: cx - ((cx - old.x) * zoom) / old.zoom,
        y: cy - ((cy - old.y) * zoom) / old.zoom,
      };
    });
  };

  // Keeps the whole tree in view while it grows, until the user pans or zooms.
  const { width } = layout;
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    return observeResize(viewport, () => {
      if (!movedRef.current && viewport.clientWidth > 0) {
        const zoom = Math.max(0.3, Math.min(1, (viewport.clientWidth - 16) / width));
        setView({ zoom, x: Math.max(8, (viewport.clientWidth - width * zoom) / 2), y: 8 });
      }
    });
  }, [width]);

  // React registers wheel listeners as passive, and zooming has to keep the page from scrolling.
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      movedRef.current = true;
      setView((old) => ({ ...old, zoom: clampZoom(old.zoom * (event.deltaY > 0 ? 0.9 : 1.1)) }));
    };
    viewport.addEventListener("wheel", onWheel, { passive: false });
    return () => viewport.removeEventListener("wheel", onWheel);
  }, []);

  const panKeys = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    const step = {
      ArrowLeft: [40, 0],
      ArrowRight: [-40, 0],
      ArrowUp: [0, 40],
      ArrowDown: [0, -40],
    }[event.key];
    if (!step) return;
    event.preventDefault();
    movedRef.current = true;
    setView((old) => ({ ...old, x: old.x + step[0]!, y: old.y + step[1]! }));
  };
  const nodeKeys = (event: KeyboardEvent<HTMLButtonElement>, id: string) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    event.stopPropagation();
    const index = layout.order.findIndex((item) => item.id === id);
    const next = layout.order[index + (event.key === "ArrowDown" ? 1 : -1)];
    if (next)
      viewportRef.current
        ?.querySelector<HTMLButtonElement>(`[data-node="${CSS.escape(next.id)}"]`)
        ?.focus();
  };

  const related = (edge: ExecutionGraphEdge) =>
    hover === null || edge.source === hover || edge.target === hover;
  const neighbour = (id: string) =>
    hover === null ||
    hover === id ||
    edges.some(
      (edge) =>
        (edge.source === hover && edge.target === id) ||
        (edge.target === hover && edge.source === id),
    );
  const running = nodes.filter((node) => RUNNING_STATUSES.has(node.status)).length;
  const failed = nodes.filter((node) => FAILED_STATUSES.has(node.status)).length;
  const waiting = nodes.filter((node) => node.pendingApproval).length;

  return (
    <section aria-label={label} className="space-y-2">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <p role="status" className="text-sm">
          <strong>{running ? "Live" : "Idle"}</strong>
          <span className="text-muted-foreground">
            {` · ${nodes.length} ${nodes.length === 1 ? "node" : "nodes"}`}
            {running ? ` · ${running} running` : ""}
            {failed ? ` · ${failed} failed` : ""}
          </span>
          {waiting ? (
            <span className="ml-2 rounded-full bg-warning/15 px-2 py-0.5 text-xs text-warning">
              {waiting} waiting for approval
            </span>
          ) : null}
        </p>
        <div role="toolbar" aria-label="Graph view" className="flex items-center gap-1">
          <Button size="icon-xs" variant="ghost" aria-label="Zoom out" onClick={() => zoomBy(0.8)}>
            <MinusIcon />
          </Button>
          <output aria-label="Graph zoom" className="w-10 text-center text-xs tabular-nums">
            {Math.round(view.zoom * 100)}%
          </output>
          <Button size="icon-xs" variant="ghost" aria-label="Zoom in" onClick={() => zoomBy(1.25)}>
            <PlusIcon />
          </Button>
          <Button
            size="xs"
            variant="outline"
            onClick={() => viewportRef.current && fitTo(viewportRef.current)}
          >
            Fit
          </Button>
        </div>
      </header>
      <div
        ref={viewportRef}
        role="region"
        aria-label="Graph canvas. Arrow keys pan; arrow keys on a node move between nodes."
        tabIndex={0}
        className="touch-none rounded-lg border border-border bg-muted/20"
        // Independent of zoom: a height that followed the fitted zoom could toggle the page
        // scrollbar, change the width and refit forever.
        // Positioning is inline with the computed geometry, so it holds without the stylesheet.
        style={{
          position: "relative",
          overflow: "hidden",
          height: `min(60vh, ${layout.height + 16}px)`,
        }}
        onKeyDown={panKeys}
        onPointerDown={(event) => {
          if ((event.target as Element).closest("button")) return;
          dragRef.current = { x: event.clientX, y: event.clientY, ox: view.x, oy: view.y };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          const drag = dragRef.current;
          if (!drag) return;
          movedRef.current = true;
          setView((old) => ({
            ...old,
            x: drag.ox + event.clientX - drag.x,
            y: drag.oy + event.clientY - drag.y,
          }));
        }}
        onPointerUp={() => {
          dragRef.current = null;
        }}
        onPointerCancel={() => {
          dragRef.current = null;
        }}
      >
        <div
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            transformOrigin: "0 0",
            width: layout.width,
            height: layout.height,
            transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})`,
          }}
        >
          <svg
            width={layout.width}
            height={layout.height}
            aria-hidden="true"
            className="text-muted-foreground"
            style={{ position: "absolute", inset: 0 }}
          >
            <defs>
              <marker
                id="execution-graph-arrow"
                viewBox="0 0 10 10"
                refX="9"
                refY="5"
                markerWidth="7"
                markerHeight="7"
                orient="auto-start-reverse"
              >
                <path d="M0 1 L10 5 L0 9 z" fill="currentColor" />
              </marker>
            </defs>
            {layout.edges.map(({ edge, path }) => (
              <path
                key={edge.id}
                d={path}
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeDasharray={EDGE_DASH[edge.kind]}
                markerEnd="url(#execution-graph-arrow)"
                className={related(edge) ? "opacity-100" : "opacity-20"}
              />
            ))}
          </svg>
          {layout.order.map(({ id }) => {
            const node = byId.get(id)!;
            const point = layout.positions.get(id)!;
            return (
              <button
                key={id}
                type="button"
                data-node={id}
                aria-pressed={selectedId === id}
                aria-label={`${node.title}. ${node.subtitle}. ${pretty(node.status)}${node.pendingApproval ? ", waiting for your approval" : ""}.`}
                className={cn(
                  "flex flex-col items-start gap-0.5 rounded-lg border bg-card px-3 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
                  selectedId === id ? "border-primary ring-1 ring-primary" : "border-border",
                  node.pendingApproval && "border-warning",
                  FAILED_STATUSES.has(node.status) && "border-destructive/60",
                  !neighbour(id) && "opacity-40",
                )}
                style={{
                  position: "absolute",
                  left: point.x,
                  top: point.y,
                  width: NODE_W,
                  height: NODE_H,
                }}
                onClick={() => onSelect(id)}
                onKeyDown={(event) => nodeKeys(event, id)}
                onPointerEnter={() => setHover(id)}
                onPointerLeave={() => setHover(null)}
                onFocus={() => setHover(id)}
                onBlur={() => setHover(null)}
              >
                <span className="w-full truncate text-xs font-medium">{node.title}</span>
                <span className="w-full truncate text-3xs text-muted-foreground">
                  {node.subtitle}
                </span>
                <span
                  className={cn(
                    "text-3xs",
                    node.pendingApproval ? "text-warning" : "text-muted-foreground capitalize",
                  )}
                >
                  {node.pendingApproval ? "Waiting for approval" : pretty(node.status)}
                </span>
              </button>
            );
          })}
        </div>
      </div>
      <ul aria-label="Link types" className="flex flex-wrap gap-3 text-xs text-muted-foreground">
        {Object.entries(LEGEND)
          .filter(([kind]) => edges.some((edge) => edge.kind === kind))
          .map(([kind, text]) => (
            <li key={kind}>{text}</li>
          ))}
      </ul>
    </section>
  );
}
