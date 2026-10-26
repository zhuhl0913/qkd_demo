"use client";

import { useEffect, useState } from "react";
import {
  tutorialIndex,
  tutorialTarget,
  TUTORIAL_STEP_IDS,
  type TutorialCopy,
  type TutorialStepId,
  type TutorialTarget,
} from "./tutorial";

type Box = { top: number; left: number; width: number; height: number };

function clampToViewport(rect: DOMRect): Box | null {
  const top = Math.max(0, rect.top);
  const left = Math.max(0, rect.left);
  const right = Math.min(window.innerWidth, rect.right);
  const bottom = Math.min(window.innerHeight, rect.bottom);
  const width = right - left;
  const height = bottom - top;
  if (width < 8 || height < 8) return null;
  return { top, left, width, height };
}

export function TutorialCoach({
  step,
  copy,
  canAdvance,
  layoutKey,
  onNext,
  onSkip,
  onExit,
}: {
  step: TutorialStepId;
  copy: TutorialCopy;
  canAdvance: boolean;
  layoutKey: string;
  onNext: () => void;
  onSkip: () => void;
  onExit: () => void;
}) {
  const target = tutorialTarget(step);
  const [box, setBox] = useState<Box | null>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onExit();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onExit]);

  useEffect(() => {
    document.querySelector(`[data-tutorial-target="${target}"]`)?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [target]);

  useEffect(() => {
    const el = document.querySelector(`[data-tutorial-target="${target}"]`);
    if (!el) return;
    let frame = 0;
    const measure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        setBox(clampToViewport(el.getBoundingClientRect()));
      });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [target, layoutKey]);

  const card = placeCard(target, box);

  return (
    <div data-tutorial-coach={step} data-tutorial-open="true">
      <div className="pointer-events-none fixed inset-0 z-30">
        {box ? (
          <div
            data-tutorial-spot={target}
            className="fixed border border-[var(--nw-pop)]"
            style={{
              top: box.top,
              left: box.left,
              width: box.width,
              height: box.height,
              boxShadow: "0 0 0 9999px rgba(8, 10, 9, 0.72)",
            }}
          />
        ) : (
          <div className="fixed inset-0" style={{ background: "rgba(8, 10, 9, 0.72)" }} />
        )}
      </div>
      <section
        role="dialog"
        aria-modal="false"
        aria-label={copy.title}
        className="fixed z-40 flex max-h-[calc(100dvh-1.5rem)] w-[22rem] max-w-[calc(100vw-1.5rem)] flex-col gap-3 border border-[var(--nw-line-strong)] bg-[var(--nw-panel)] p-3"
        style={target === "hitl" && box ? { ...card, maxHeight: Math.max(140, box.top - 24) } : card}
      >
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="text-sm font-medium">{copy.title}</h2>
          <span className="nw-faint text-xs">
            {tutorialIndex(step)}/{TUTORIAL_STEP_IDS.length}
          </span>
        </div>
        <div className="flex flex-col gap-1 overflow-y-auto">
          {copy.lines.map((line) => (
            <p key={line} className="text-sm leading-5">
              {line}
            </p>
          ))}
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className="nw-btn nw-btn-primary px-3 py-2 text-sm"
            data-action="tutorial-next"
            disabled={!canAdvance}
            title={copy.nextTitle}
            onClick={onNext}
          >
            {copy.nextLabel}
          </button>
          <button type="button" className="nw-btn px-3 py-2 text-sm" data-action="tutorial-skip" onClick={onSkip}>
            跳过
          </button>
          <button type="button" className="nw-btn px-3 py-2 text-sm" data-action="tutorial-exit" onClick={onExit}>
            退出
          </button>
        </div>
      </section>
    </div>
  );
}

function placeCard(target: TutorialTarget, box: Box | null): { top: number; left: number } {
  const width = Math.min(352, typeof window === "undefined" ? 352 : window.innerWidth - 24);
  const margin = 12;
  if (!box || typeof window === "undefined") return { top: margin, left: margin };
  const gap = 12;
  if (target === "hitl") return { top: margin, left: margin };
  const right = box.left + box.width + gap;
  if (right + width <= window.innerWidth - margin) {
    return { top: Math.max(margin, Math.min(box.top, window.innerHeight - 240)), left: right };
  }
  const left = box.left - gap - width;
  if (left >= margin) {
    return { top: Math.max(margin, Math.min(box.top, window.innerHeight - 240)), left };
  }
  const below = box.top + box.height + gap;
  if (below + 200 < window.innerHeight) return { top: below, left: margin };
  return { top: margin, left: margin };
}
