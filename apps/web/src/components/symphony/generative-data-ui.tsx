"use client";

import { makeAssistantDataUI } from "@assistant-ui/react";
import { renderGenerativeUI } from "@assistant-ui/react-generative-ui";
import { styledGenerativeUILibrary } from "@/components/assistant-ui/elements/generative-ui";

type SurfaceData = Record<string, unknown>;

const GenerativeUI = makeAssistantDataUI<SurfaceData>({
  name: "generative-ui",
  render: ({ data }) => (
    <div className="w-full max-w-xl">
      {renderGenerativeUI(data.tree ?? data.root ?? data, styledGenerativeUILibrary, { status: "done" })}
    </div>
  ),
});

export function SymphonyGenerativeDataUI() {
  return <GenerativeUI />;
}
