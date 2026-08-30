"use client";

import { ArrowsOutSimple, Minus, Plus } from "@phosphor-icons/react";
import { memo, useCallback, useEffect, useMemo, useRef, useState, type PointerEvent, type ReactNode } from "react";
import type { AgentState, WorkEdge, WorkNode } from "../../lib/symphony/contracts";

const NODE_WIDTH = 206;
const NODE_HEIGHT = 64;
const PADDING = 76;
const MIN_SCALE = 0.001;
const MAX_SCALE = 2.5;

const stateClass: Record<AgentState, string> = {
  queued: "bg-info", running: "bg-info", waiting: "bg-warning", blocked: "bg-warning",
  succeeded: "bg-success", failed: "bg-destructive", cancelled: "bg-warning", stale: "bg-warning",
};

export type ViewTransform = { x: number; y: number; scale: number };
export type GraphBounds = { minX: number; minY: number; maxX: number; maxY: number };

export const WorkflowGraph = memo(function WorkflowGraph({ nodes, edges, selectedId, onSelect }: {
  nodes: WorkNode[];
  edges: WorkEdge[];
  selectedId?: string | null;
  onSelect?: (node: WorkNode) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ pointerId: number; x: number; y: number; originX: number; originY: number } | null>(null);
  const transformRef = useRef<ViewTransform>({ x: 0, y: 0, scale: 1 });
  const transformFrameRef = useRef<number | null>(null);
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const [transform, setTransform] = useState<ViewTransform>({ x: 0, y: 0, scale: 1 });
  const geometryKey = nodes.map((node) => `${node.id}:${node.x}:${node.y}`).join("|");
  const bounds = useMemo(() => graphBounds(nodes), [geometryKey]);
  const byId = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);

  const scheduleTransform = useCallback((next: ViewTransform) => {
    transformRef.current = next;
    if (transformFrameRef.current !== null) return;
    transformFrameRef.current = window.requestAnimationFrame(() => {
      transformFrameRef.current = null;
      setTransform(transformRef.current);
    });
  }, []);

  const fitToView = useCallback(() => {
    if (!viewport.width || !viewport.height || !nodes.length) return;
    scheduleTransform(fitGraphTransform(bounds, viewport));
  }, [bounds.maxX, bounds.maxY, bounds.minX, bounds.minY, nodes.length, scheduleTransform, viewport.height, viewport.width]);

  const zoomAt = useCallback((nextScale: number, clientX?: number, clientY?: number) => {
    const current = transformRef.current;
    const scale = clamp(nextScale, MIN_SCALE, MAX_SCALE);
    const rect = containerRef.current?.getBoundingClientRect();
    const anchorX = clientX !== undefined && rect ? clientX - rect.left : (rect?.width ?? viewport.width) / 2;
    const anchorY = clientY !== undefined && rect ? clientY - rect.top : (rect?.height ?? viewport.height) / 2;
    const graphX = (anchorX - current.x) / current.scale;
    const graphY = (anchorY - current.y) / current.scale;
    scheduleTransform({ scale, x: anchorX - graphX * scale, y: anchorY - graphY * scale });
  }, [scheduleTransform, viewport.height, viewport.width]);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const measure = (width: number, height: number) => {
      setViewport((current) => current.width === width && current.height === height ? current : { width, height });
    };
    const initial = element.getBoundingClientRect();
    measure(initial.width, initial.height);
    const resize = new ResizeObserver(([entry]) => {
      if (entry) measure(entry.contentRect.width, entry.contentRect.height);
    });
    resize.observe(element);
    return () => resize.disconnect();
  }, []);
  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const wheel = (event: globalThis.WheelEvent) => {
      event.preventDefault();
      if (event.ctrlKey || event.metaKey) {
        const factor = Math.exp(-normalizeWheelDelta(event, element) * 0.002);
        zoomAt(transformRef.current.scale * factor, event.clientX, event.clientY);
        return;
      }
      const current = transformRef.current;
      const { x, y } = wheelPanDelta(event, element);
      scheduleTransform({ ...current, x: current.x - x, y: current.y - y });
    };
    element.addEventListener("wheel", wheel, { passive: false });
    return () => element.removeEventListener("wheel", wheel);
  }, [scheduleTransform, zoomAt]);
  useEffect(() => () => {
    if (transformFrameRef.current !== null) window.cancelAnimationFrame(transformFrameRef.current);
  }, []);
  useEffect(() => fitToView(), [fitToView, geometryKey]);

  const pointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, originX: transformRef.current.x, originY: transformRef.current.y };
  };
  const pointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    scheduleTransform({ ...transformRef.current, x: drag.originX + event.clientX - drag.x, y: drag.originY + event.clientY - drag.y });
  };
  const pointerUp = (event: PointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId === event.pointerId) dragRef.current = null;
  };
  if (nodes.length === 0) return <p className="text-xs text-muted-foreground">No workflow graph for this conversation yet.</p>;

  return (
    <div
      ref={containerRef}
      className="relative h-full min-h-[30rem] w-full cursor-grab touch-none select-none overflow-hidden bg-card/28 active:cursor-grabbing"
      role="application"
      aria-label="Scrollable workflow graph"
      onPointerDown={pointerDown}
      onPointerMove={pointerMove}
      onPointerUp={pointerUp}
      onPointerCancel={pointerUp}
      tabIndex={0}
    >
      <div className="pointer-events-none absolute inset-0 symphony-graph-surface" />
      <div
        className="absolute left-0 top-0 overflow-visible [transform-origin:0_0]"
        style={{ transform: `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})` }}
      >
        <svg className="pointer-events-none absolute left-0 top-0 overflow-visible" width={Math.max(1, bounds.maxX)} height={Math.max(1, bounds.maxY)} aria-hidden="true">
          {edges.map((edge) => {
            const from = byId.get(edge.from);
            const to = byId.get(edge.to);
            if (!from || !to) return null;
            const x1 = from.x + NODE_WIDTH;
            const y1 = from.y + NODE_HEIGHT / 2;
            const x2 = to.x;
            const y2 = to.y + NODE_HEIGHT / 2;
            const curve = Math.max(54, Math.abs(x2 - x1) * 0.46);
            return (
              <path
                key={`${edge.from}-${edge.to}-${edge.kind}`}
                d={`M ${x1} ${y1} C ${x1 + curve} ${y1}, ${x2 - curve} ${y2}, ${x2} ${y2}`}
                fill="none"
                stroke="var(--color-foreground)"
                strokeOpacity={edge.kind === "delegation" ? 0.28 : 0.17}
                strokeWidth={1.25 / transform.scale}
                strokeDasharray={edge.kind === "dependency" ? `${5 / transform.scale} ${5 / transform.scale}` : undefined}
              />
            );
          })}
        </svg>

        {nodes.map((node) => {
          const selected = node.id === selectedId || node.agentId === selectedId;
          return (
            <button
              key={node.id}
              type="button"
              disabled={!node.agentId || !onSelect}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={() => onSelect?.(node)}
              className={`absolute flex cursor-pointer items-center gap-3 rounded-xl border bg-card/96 px-4 text-left shadow-sm backdrop-blur-xl transition-[border-color,background-color,box-shadow] hover:bg-muted/85 disabled:cursor-default ${selected ? "border-foreground/85 shadow-[0_0_0_1px_color-mix(in_oklab,var(--color-foreground)_12%,transparent)]" : "border-border/85"}`}
              style={{ left: node.x, top: node.y, width: NODE_WIDTH, height: NODE_HEIGHT }}
              aria-label={`${node.label} ${node.detail}`}
            >
              <span className={`size-2 shrink-0 rounded-full ${stateClass[node.state]}`} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[12px] font-medium text-foreground/95" title={node.label}>{node.label}</span>
                <span className="mt-1 block truncate text-[9px] text-muted-foreground" title={node.detail}>{node.detail}</span>
              </span>
            </button>
          );
        })}
      </div>

      <div className="absolute right-3 top-3 flex items-center gap-0.5 rounded-lg border border-border/80 bg-background/78 p-1 shadow-sm backdrop-blur-xl" onPointerDown={(event) => event.stopPropagation()}>
        <GraphButton label="Zoom out" onClick={() => zoomAt(transformRef.current.scale / 1.2)}><Minus /></GraphButton>
        <span className="w-10 text-center font-mono text-[9px] text-muted-foreground">{Math.round(transform.scale * 100)}%</span>
        <GraphButton label="Zoom in" onClick={() => zoomAt(transformRef.current.scale * 1.2)}><Plus /></GraphButton>
        <GraphButton label="Fit graph" onClick={fitToView}><ArrowsOutSimple /></GraphButton>
      </div>
      <div className="absolute bottom-3 left-3 flex flex-wrap gap-3 rounded-lg border border-border/75 bg-background/72 px-3 py-2 text-[9px] text-muted-foreground backdrop-blur-xl">
        <Legend color="bg-info" label="Active" /><Legend color="bg-success" label="Done" /><Legend color="bg-destructive" label="Failed" /><Legend color="bg-warning" label="Waiting" />
        <span className="inline-flex items-center gap-1.5"><span className="w-4 border-t border-foreground/30" />Delegation</span>
        <span className="inline-flex items-center gap-1.5"><span className="w-4 border-t border-dashed border-foreground/25" />Dependency</span>
      </div>
      <p className="pointer-events-none absolute bottom-3 right-3 rounded-md bg-background/70 px-2 py-1 text-[8px] text-muted-foreground backdrop-blur-xl">Drag or two-finger scroll to pan · Trackpad pinch to zoom</p>
    </div>
  );
}, graphPropsEqual);

function graphPropsEqual(
  previous: { nodes: WorkNode[]; edges: WorkEdge[]; selectedId?: string | null; onSelect?: (node: WorkNode) => void },
  next: { nodes: WorkNode[]; edges: WorkEdge[]; selectedId?: string | null; onSelect?: (node: WorkNode) => void },
): boolean {
  if (previous.selectedId !== next.selectedId || previous.onSelect !== next.onSelect) return false;
  if (previous.nodes.length !== next.nodes.length || previous.edges.length !== next.edges.length) return false;
  for (let index = 0; index < previous.nodes.length; index += 1) {
    const left = previous.nodes[index];
    const right = next.nodes[index];
    if (!left || !right || left.id !== right.id || left.agentId !== right.agentId || left.label !== right.label || left.detail !== right.detail || left.state !== right.state || left.x !== right.x || left.y !== right.y) return false;
  }
  for (let index = 0; index < previous.edges.length; index += 1) {
    const left = previous.edges[index];
    const right = next.edges[index];
    if (!left || !right || left.from !== right.from || left.to !== right.to || left.kind !== right.kind) return false;
  }
  return true;
}

function GraphButton({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return <button type="button" onClick={onClick} className="grid size-7 cursor-pointer place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground" aria-label={label} title={label}>{children}</button>;
}
function Legend({ color, label }: { color: string; label: string }) { return <span className="inline-flex items-center gap-1.5"><span className={`size-1.5 rounded-full ${color}`} />{label}</span>; }
export function graphBounds(nodes: WorkNode[]): GraphBounds {
  if (nodes.length === 0) return { minX: 0, minY: 0, maxX: 1, maxY: 1 };
  return { minX: Math.min(...nodes.map((node) => node.x)), minY: Math.min(...nodes.map((node) => node.y)), maxX: Math.max(...nodes.map((node) => node.x + NODE_WIDTH)), maxY: Math.max(...nodes.map((node) => node.y + NODE_HEIGHT)) };
}

export function fitGraphTransform(bounds: GraphBounds, viewport: { width: number; height: number }, padding = PADDING): ViewTransform {
  const contentWidth = Math.max(1, bounds.maxX - bounds.minX);
  const contentHeight = Math.max(1, bounds.maxY - bounds.minY);
  const safeWidth = Math.max(1, viewport.width);
  const safeHeight = Math.max(1, viewport.height);
  const scale = clamp(Math.min(
    safeWidth / (contentWidth + Math.max(0, padding) * 2),
    safeHeight / (contentHeight + Math.max(0, padding) * 2),
  ), MIN_SCALE, 1);
  return {
    scale,
    x: (safeWidth - contentWidth * scale) / 2 - bounds.minX * scale,
    y: (safeHeight - contentHeight * scale) / 2 - bounds.minY * scale,
  };
}

function normalizeWheelDelta(event: globalThis.WheelEvent, element: HTMLElement): number {
  const multiplier = event.deltaMode === globalThis.WheelEvent.DOM_DELTA_LINE
    ? 16
    : event.deltaMode === globalThis.WheelEvent.DOM_DELTA_PAGE
      ? element.clientHeight
      : 1;
  return event.deltaY * multiplier;
}

function wheelPanDelta(event: globalThis.WheelEvent, element: HTMLElement): { x: number; y: number } {
  const multiplier = event.deltaMode === globalThis.WheelEvent.DOM_DELTA_LINE
    ? 16
    : event.deltaMode === globalThis.WheelEvent.DOM_DELTA_PAGE
      ? element.clientHeight
      : 1;
  if (event.shiftKey && event.deltaX === 0) return { x: event.deltaY * multiplier, y: 0 };
  return { x: event.deltaX * multiplier, y: event.deltaY * multiplier };
}
function clamp(value: number, min: number, max: number) { return Math.min(max, Math.max(min, value)); }
