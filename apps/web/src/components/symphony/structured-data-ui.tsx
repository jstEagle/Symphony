"use client";

import { useEffect, useState } from "react";
import { CircleIcon } from "lucide-react";
import { makeAssistantDataUI } from "@assistant-ui/react";
import { SpeakerIdentity } from "@/components/assistant-ui/elements/speaker-identity";
import { Diagram } from "@/components/assistant-ui/elements/diagram";
import { FlowGraph } from "@/components/assistant-ui/elements/flow-graph";
import { SpecSheet } from "@/components/assistant-ui/elements/spec-sheet";
import { Timeline } from "@/components/assistant-ui/elements/timeline";
import { JobProgress } from "@/components/assistant-ui/elements/job-progress";
import { ScoreBreakdown } from "@/components/assistant-ui/elements/score-breakdown";
import { AgentPlan } from "@/components/assistant-ui/elements/agent-plan";
import { SubagentList } from "@/components/assistant-ui/elements/subagent-list";
import { RecommendationCard } from "@/components/assistant-ui/elements/recommendation-card";
import { AgentHandoff } from "@/components/assistant-ui/elements/agent-handoff";
import { CheckpointHistory } from "@/components/assistant-ui/elements/checkpoint-history";
import { ScheduleCard } from "@/components/assistant-ui/elements/schedule-card";
import { CostMeter } from "@/components/assistant-ui/elements/cost-meter";
import { ToolTimeline } from "@/components/assistant-ui/elements/tool-timeline";
import { useOptionalSymphony } from "@/components/symphony/context";

type SurfaceData = Record<string, unknown>;

const SpeakerUI = makeAssistantDataUI<SurfaceData>({ name: "speaker-identity", render: ({ data }) => <SpeakerIdentity turns={array(data.turns) as never} /> });
const DiagramUI = makeAssistantDataUI<SurfaceData>({
  name: "diagram",
  render: ({ data }) => <DiagramSurface data={data} />,
});
const FlowGraphUI = makeAssistantDataUI<SurfaceData>({ name: "flow-graph", render: ({ data }) => <FlowGraph nodes={array(data.nodes) as never} edges={array(data.edges) as never} visibleCount={number(data.visibleCount, array(data.nodes).length)} /> });
const SpecSheetUI = makeAssistantDataUI<SurfaceData>({ name: "spec-sheet", render: ({ data }) => <SpecSheet title={text(data.title, "Specification")} subtitle={optionalText(data.subtitle)} rows={array(data.rows) as never} visibleCount={number(data.visibleCount, array(data.rows).length)} /> });
const TimelineUI = makeAssistantDataUI<SurfaceData>({ name: "timeline", render: ({ data }) => <Timeline events={array(data.events) as never} visibleCount={number(data.visibleCount, array(data.events).length)} /> });
const JobProgressUI = makeAssistantDataUI<SurfaceData>({ name: "job-progress", render: ({ data }) => <JobProgressSurface data={data} /> });
const ScoreBreakdownUI = makeAssistantDataUI<SurfaceData>({ name: "score-breakdown", render: ({ data }) => <ScoreBreakdown verdict={text(data.verdict, "Score")} total={number(data.total, 0)} outOf={number(data.outOf, 10)} criteria={array(data.criteria) as never} visibleCount={number(data.visibleCount, array(data.criteria).length)} /> });
const AgentPlanUI = makeAssistantDataUI<SurfaceData>({ name: "agent-plan", render: ({ data }) => <AgentPlan steps={strings(data.steps)} activeIndex={number(data.activeIndex, 0)} /> });
const SubagentListUI = makeAssistantDataUI<SurfaceData>({
  name: "subagent-list",
  render: ({ data }) => {
    const agents = array(data.agents);
    return <SubagentList agents={agents as never} completedCount={number(data.completedCount, 0)} progress={numbers(data.progress)} showSummary={boolean(data.showSummary)} summaryAgent={(record(data.summaryAgent) ?? agents[0] ?? { name: "Summary", model: "—" }) as never} />;
  },
});
const RecommendationUI = makeAssistantDataUI<SurfaceData>({ name: "recommendation-card", render: ({ data }) => <RecommendationSurface data={data} /> });
const HandoffUI = makeAssistantDataUI<SurfaceData>({ name: "handoff", render: ({ data }) => <AgentHandoff from={text(data.from, "Agent")} to={text(data.to, "Agent")} reason={text(data.reason, "Handoff")} carried={strings(data.carried)} settled={boolean(data.settled)} /> });
const ScheduleUI = makeAssistantDataUI<SurfaceData>({ name: "schedule", render: ({ data }) => <ScheduleSurface data={data} /> });
const CheckpointsUI = makeAssistantDataUI<SurfaceData>({ name: "checkpoints", render: ({ data }) => <CheckpointsSurface data={data} /> });
const CostUI = makeAssistantDataUI<SurfaceData>({ name: "cost-meter", render: ({ data }) => <CostMeter runCost={text(data.runCost, "$0.00")} sessionCost={text(data.sessionCost, "$0.00")} lines={array(data.lines) as never} /> });
const ToolTimelineUI = makeAssistantDataUI<SurfaceData>({ name: "tool-timeline", render: ({ data }) => <ToolTimeline steps={array(data.steps).map((step) => ({ ...record(step), verb: text(record(step)?.verb, "Worked"), chip: text(record(step)?.chip, "step"), icon: CircleIcon })) as never} visibleSteps={number(data.visibleSteps, array(data.steps).length)} streaming={boolean(data.streaming)} open={data.open !== false} onOpenChange={() => undefined} restingLabel={text(data.restingLabel, "Work complete")} activeLabel={text(data.activeLabel, "Working")} stats={array(data.stats) as never} /> });
const registrations = [SpeakerUI, DiagramUI, FlowGraphUI, SpecSheetUI, TimelineUI, JobProgressUI, ScoreBreakdownUI, AgentPlanUI, SubagentListUI, RecommendationUI, HandoffUI, ScheduleUI, CheckpointsUI, CostUI, ToolTimelineUI];

export function SymphonyStructuredDataUI() {
  return <>{registrations.map((Registration, index) => <Registration key={index} />)}</>;
}

function DiagramSurface({ data }: { data: SurfaceData }) {
  const initialZoom = number(data.zoom, 1);
  const [zoom, setZoom] = useState(initialZoom);
  useEffect(() => setZoom(initialZoom), [initialZoom]);
  return (
    <Diagram
      title={text(data.title, "Diagram")}
      zoom={zoom}
      onZoomIn={() => setZoom((current) => Math.min(2, current + 0.1))}
      onZoomOut={() => setZoom((current) => Math.max(0.5, current - 0.1))}
      onReset={() => setZoom(1)}
    >
      <div className="grid min-h-36 place-items-center p-5 text-center text-xs text-muted-foreground">
        {text(data.content, text(data.description, "No diagram content."))}
      </div>
    </Diagram>
  );
}

function JobProgressSurface({ data }: { data: SurfaceData }) {
  const symphony = useOptionalSymphony();
  return (
    <JobProgress
      title={text(data.title, "Job progress")}
      stages={array(data.stages) as never}
      stageIndex={number(data.stageIndex, 0)}
      stageProgress={number(data.stageProgress, 0)}
      eta={text(data.eta, "—")}
      onCancel={symphony ? () => void symphony.cancelRun() : undefined}
    />
  );
}

function RecommendationSurface({ data }: { data: SurfaceData }) {
  const symphony = useOptionalSymphony();
  const [accepted, setAccepted] = useState(data.state === "accepted");
  const question = text(data.question, "Recommendation");
  const detail = text(data.body, text(data.detail, ""));
  useEffect(() => setAccepted(data.state === "accepted"), [data.state]);
  const respond = async (kind: "accept" | "alternatives") => {
    if (kind === "accept") setAccepted(true);
    await sendConductorAction(
      symphony,
      kind === "accept"
        ? `Accept this recommendation and continue: ${question}. ${detail}`
        : `Show alternatives to this recommendation: ${question}. ${detail}`,
    );
  };
  return (
    <RecommendationCard
      state={accepted ? "accepted" : "idle"}
      question={question}
      confidenceLabel={text(data.confidenceLabel, "Recommendation")}
      acceptedLabel={text(data.acceptedLabel, "Accepted")}
      onAccept={() => void respond("accept")}
      onAlternatives={() => void respond("alternatives")}
    >
      {detail}
    </RecommendationCard>
  );
}

function ScheduleSurface({ data }: { data: SurfaceData }) {
  const symphony = useOptionalSymphony();
  const [enabled, setEnabled] = useState(boolean(data.enabled));
  const name = text(data.name, "Schedule");
  useEffect(() => setEnabled(boolean(data.enabled)), [data.enabled]);
  const toggle = () => {
    const next = !enabled;
    setEnabled(next);
    void sendConductorAction(symphony, `${next ? "Enable" : "Pause"} the schedule named “${name}”.`);
  };
  return (
    <ScheduleCard
      name={name}
      cadence={text(data.cadence, "Manual")}
      nextRun={text(data.nextRun, "—")}
      enabled={enabled}
      history={array(data.history) as never}
      onToggle={toggle}
    />
  );
}

function CheckpointsSurface({ data }: { data: SurfaceData }) {
  const symphony = useOptionalSymphony();
  const checkpoints = array(data.checkpoints);
  return (
    <CheckpointHistory
      checkpoints={checkpoints as never}
      currentId={text(data.currentId, "")}
      onRestore={(id) => {
        const checkpoint = checkpoints.find((candidate) => candidate.id === id);
        const label = text(checkpoint?.label, id);
        void sendConductorAction(symphony, `Restore checkpoint “${label}” (${id}). Confirm the exact target before applying any destructive change.`);
      }}
    />
  );
}

async function sendConductorAction(
  symphony: ReturnType<typeof useOptionalSymphony>,
  content: string,
): Promise<void> {
  const threadId = symphony?.activeConversation?.id;
  if (!symphony || !threadId || symphony.mode === "preview") return;
  await symphony.sendMessage(threadId, { messageId: crypto.randomUUID(), content, attachments: [] });
}

function record(value: unknown): SurfaceData | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as SurfaceData : null;
}
function array(value: unknown): SurfaceData[] { return Array.isArray(value) ? value.filter((item): item is SurfaceData => record(item) !== null) : []; }
function text(value: unknown, fallback: string): string { return typeof value === "string" ? value : fallback; }
function optionalText(value: unknown): string | undefined { return typeof value === "string" ? value : undefined; }
function number(value: unknown, fallback: number): number { return typeof value === "number" && Number.isFinite(value) ? value : fallback; }
function boolean(value: unknown): boolean { return value === true; }
function strings(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []; }
function numbers(value: unknown): number[] { return Array.isArray(value) ? value.filter((item): item is number => typeof item === "number" && Number.isFinite(item)) : []; }
