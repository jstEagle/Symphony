"use client";

import type { CSSProperties } from "react";

import { DotMatrixBase } from "@/lib/dotmatrix-core";
import { useDotMatrixPhases } from "@/lib/dotmatrix-hooks";
import { isWithinCircularMask } from "@/lib/dotmatrix-core";
import { usePrefersReducedMotion } from "@/lib/dotmatrix-hooks";
import type { DotAnimationResolver, DotMatrixCommonProps } from "@/lib/dotmatrix-core";

export type DotmCircular5Props = DotMatrixCommonProps;

const BASE_OPACITY = 0.08;

const circularResolver: DotAnimationResolver = ({ row, col, phase, reducedMotion }) => {
  if (!isWithinCircularMask(row, col)) return { className: "dmx-inactive" };

  const x = col - 2;
  const y = row - 2;
  const radius = Math.hypot(x, y);
  if (radius < 0.6) return { style: { opacity: 0.66 } };

  const angle = (Math.atan2(y, x) + Math.PI * 2) % (Math.PI * 2);
  const orbit = angle / (Math.PI * 2) + Math.min(radius, 2.8) * 0.075;
  const style = { "--dmx-orbit": orbit } as CSSProperties;

  if (reducedMotion || phase === "idle") {
    return { style: { ...style, opacity: BASE_OPACITY + (1 - Math.min(1, radius / 3)) * 0.32 } };
  }

  return { className: "dmx-circular-orbit", style };
};

export function DotmCircular5({
  speed = 1.7,
  animated = true,
  hoverAnimated = false,
  ...rest
}: DotmCircular5Props) {
  const reducedMotion = usePrefersReducedMotion();
  const { phase: matrixPhase, onMouseEnter, onMouseLeave } = useDotMatrixPhases({
    animated: Boolean(animated && !reducedMotion),
    hoverAnimated: Boolean(hoverAnimated && !reducedMotion),
    speed
  });
  return (
    <DotMatrixBase
      {...rest}
      size={rest.size ?? 36}
      dotSize={rest.dotSize ?? 5}
      speed={speed}
      pattern="full"
      animated={animated}
      phase={matrixPhase}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      reducedMotion={reducedMotion}
      animationResolver={circularResolver}
    />
  );
}
