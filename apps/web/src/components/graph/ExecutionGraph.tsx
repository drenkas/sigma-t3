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

// Tailwind's 500 shades, inline so the canvas keeps its colours without the stylesheet.
const PALETTE = {
  violet: "oklch(0.606 0.25 292.717)",
  blue: "oklch(0.623 0.214 259.815)",
  amber: "oklch(0.769 0.188 70.08)",
  emerald: "oklch(0.696 0.17 162.48)",
  pink: "oklch(0.656 0.241 354.308)",
  cyan: "oklch(0.715 0.143 215.221)",
  teal: "oklch(0.704 0.14 182.503)",
  indigo: "oklch(0.585 0.233 277.117)",
  orange: "oklch(0.705 0.213 47.604)",
  lime: "oklch(0.768 0.233 130.85)",
  rose: "oklch(0.645 0.246 16.439)",
  slate: "oklch(0.554 0.046 257.417)",
};
const ROLE_COLORS: Record<string, string> = {
  coordinator: PALETTE.violet,
  implementation: PALETTE.blue,
  research: PALETTE.amber,
  review: PALETTE.emerald,
  design: PALETTE.pink,
  test: PALETTE.cyan,
  general: PALETTE.indigo,
  agent: PALETTE.slate,
  current: PALETTE.violet,
  parent: PALETTE.slate,
  fork: PALETTE.indigo,
  subagent: PALETTE.teal,
  unavailable: PALETTE.slate,
};
const SPARE_COLORS = [PALETTE.orange, PALETTE.lime, PALETTE.rose, PALETTE.indigo, PALETTE.cyan];
const roleColor = (role: string) =>
  ROLE_COLORS[role] ??
  SPARE_COLORS[[...role].reduce((sum, char) => sum + char.charCodeAt(0), 0) % SPARE_COLORS.length]!;

// Tree links are the structure and stay quiet; the other links say what moved between nodes.
const LINKS: Record<string, { label: string; color: string | null; dash?: string }> = {
  membership: { label: "repository", color: null },
  delegation: { label: "delegated", color: null },
  fork: { label: "fork", color: null },
  subagent: { label: "subagent", color: null },
  result: { label: "result", color: PALETTE.emerald, dash: "6 4" },
  context_transfer: { label: "context transfer", color: PALETTE.cyan, dash: "2 4" },
  merge: { label: "merge", color: PALETTE.violet, dash: "8 4" },
};
const statusTone = (status: string) =>
  FAILED_STATUSES.has(status)
    ? "bg-destructive"
    : RUNNING_STATUSES.has(status)
      ? "bg-info motion-safe:animate-status-pulse"
      : status === "completed"
        ? "bg-success"
        : status === "waiting"
          ? "bg-warning"
          : "bg-muted-foreground/40";
const clampZoom = (value: number) => Math.max(0.3, Math.min(2, value));
const fitZoom = (viewport: HTMLDivElement, width: number, height: number) =>
  Math.max(
    0.3,
    Math.min(1, (viewport.clientWidth - 16) / width, (viewport.clientHeight - 16) / height),
  );

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
  // Buttons glide the view; dragging and wheel zoom follow the pointer without a lag.
  const [gliding, setGliding] = useState(false);
  const [hover, setHover] = useState<string | null>(null);

  const fitTo = (viewport: HTMLDivElement) => {
    const zoom = fitZoom(viewport, layout.width, layout.height);
    movedRef.current = false;
    setGliding(true);
    setView({ zoom, x: Math.max(8, (viewport.clientWidth - layout.width * zoom) / 2), y: 8 });
  };
  const zoomBy = (factor: number) => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    movedRef.current = true;
    setGliding(true);
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
  const { width, height } = layout;
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    return observeResize(viewport, () => {
      if (!movedRef.current && viewport.clientWidth > 0) {
        const zoom = fitZoom(viewport, width, height);
        setView({ zoom, x: Math.max(8, (viewport.clientWidth - width * zoom) / 2), y: 8 });
      }
    });
  }, [viewportRef, width, height]);

  // React registers wheel listeners as passive, and zooming has to keep the page from scrolling.
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      movedRef.current = true;
      setGliding(false);
      setView((old) => ({ ...old, zoom: clampZoom(old.zoom * (event.deltaY > 0 ? 0.9 : 1.1)) }));
    };
    viewport.addEventListener("wheel", onWheel, { passive: false });
    return () => viewport.removeEventListener("wheel", onWheel);
  }, [viewportRef]);

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
          setGliding(false);
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
          className={
            gliding
              ? "transition-transform duration-200 ease-out motion-reduce:transition-none"
              : ""
          }
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
              {Object.entries(LINKS).map(([kind, link]) =>
                link.color === null ? null : (
                  <marker
                    key={kind}
                    id={`execution-graph-arrow-${kind}`}
                    viewBox="0 0 10 10"
                    refX="8"
                    refY="5"
                    markerWidth="8"
                    markerHeight="8"
                    orient="auto-start-reverse"
                  >
                    <path
                      d="M2 1.5 L8 5 L2 8.5"
                      fill="none"
                      stroke={link.color}
                      strokeWidth="1.6"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </marker>
                ),
              )}
            </defs>
            {layout.edges.map(({ edge, path, tree }) => {
              const link = LINKS[edge.kind];
              const color = link?.color ?? null;
              const end = layout.positions.get(edge.target);
              return (
                <g
                  key={edge.id}
                  className={cn(
                    "transition-opacity duration-150 starting:opacity-0 motion-reduce:transition-none",
                    related(edge) ? "opacity-100" : "opacity-15",
                  )}
                >
                  <path
                    d={path}
                    fill="none"
                    stroke={color ?? "currentColor"}
                    strokeOpacity={tree ? 0.45 : 0.9}
                    strokeWidth={hover !== null && related(edge) ? 2 : 1.25}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeDasharray={link?.dash}
                    markerEnd={
                      color === null ? undefined : `url(#execution-graph-arrow-${edge.kind})`
                    }
                  />
                  {tree && end ? (
                    <circle
                      cx={end.x}
                      cy={end.y + NODE_H / 2}
                      r="2.5"
                      fill={roleColor(byId.get(edge.target)!.role)}
                    />
                  ) : null}
                </g>
              );
            })}
          </svg>
          {layout.order.map(({ id }) => {
            const node = byId.get(id)!;
            const point = layout.positions.get(id)!;
            const color = roleColor(node.role);
            return (
              <button
                key={id}
                type="button"
                data-node={id}
                aria-pressed={selectedId === id}
                aria-label={`${node.title}. ${node.subtitle}. ${pretty(node.status)}${node.pendingApproval ? ", waiting for your approval" : ""}.`}
                className={cn(
                  "flex flex-col items-start gap-0.5 overflow-hidden rounded-lg border py-2 pr-3 pl-3.5 text-left shadow-xs outline-none transition-[opacity,translate,border-color,box-shadow] duration-200 ease-out starting:translate-y-1 starting:opacity-0 hover:shadow-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset motion-reduce:transition-none",
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
                  // The role colour tints the card; the bar below marks its edge.
                  backgroundColor: `color-mix(in oklab, ${color} 7%, var(--color-card))`,
                }}
                onClick={() => onSelect(id)}
                onKeyDown={(event) => nodeKeys(event, id)}
                onPointerEnter={() => setHover(id)}
                onPointerLeave={() => setHover(null)}
                onFocus={() => setHover(id)}
                onBlur={() => setHover(null)}
              >
                <span
                  aria-hidden="true"
                  style={{
                    position: "absolute",
                    top: 0,
                    bottom: 0,
                    left: 0,
                    width: 3,
                    backgroundColor: color,
                  }}
                />
                <span className="w-full truncate text-xs font-medium">{node.title}</span>
                <span className="w-full truncate text-3xs text-muted-foreground">
                  {node.subtitle}
                </span>
                <span
                  className={cn(
                    "flex items-center gap-1.5 text-3xs",
                    node.pendingApproval ? "text-warning" : "text-muted-foreground capitalize",
                  )}
                >
                  <span
                    aria-hidden="true"
                    className={cn(
                      "size-1.5 shrink-0 rounded-full",
                      node.pendingApproval
                        ? "bg-warning motion-safe:animate-status-pulse"
                        : statusTone(node.status),
                    )}
                  />
                  {node.pendingApproval ? "Waiting for approval" : pretty(node.status)}
                </span>
              </button>
            );
          })}
        </div>
      </div>
      <ul
        aria-label="Legend"
        className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground"
      >
        {[...new Set(nodes.map((node) => node.role))].map((role) => (
          <li key={`role:${role}`} className="flex items-center gap-1.5 capitalize">
            <span
              aria-hidden="true"
              className="size-2 rounded-sm"
              style={{ backgroundColor: roleColor(role) }}
            />
            {pretty(role)}
          </li>
        ))}
        {Object.entries(LINKS)
          .filter(([kind]) => edges.some((edge) => edge.kind === kind))
          .map(([kind, link]) => (
            <li key={kind} className="flex items-center gap-1.5">
              <svg aria-hidden="true" width="18" height="6">
                <line
                  x1="1"
                  y1="3"
                  x2="17"
                  y2="3"
                  stroke={link.color ?? "currentColor"}
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeDasharray={link.dash}
                />
              </svg>
              {link.label}
            </li>
          ))}
      </ul>
    </section>
  );
}
