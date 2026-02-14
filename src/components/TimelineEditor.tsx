import { PointerEvent, useMemo, useRef } from 'react';

type TimelineSegment = {
  id: string;
  t0: number;
  t1: number;
};

type DragType = 'move' | 'left' | 'right';

type TimelineEditorProps = {
  duration: number;
  segments: TimelineSegment[];
  snapEnabled: boolean;
  onChangeSegment: (segmentId: string, t0: number, t1: number) => void;
};

type DragState = {
  pointerId: number;
  segmentId: string;
  type: DragType;
  startX: number;
  startT0: number;
  startT1: number;
  prevEnd: number;
  nextStart: number;
};

const SNAP_THRESHOLD = 0.2;
const MIN_LENGTH = 0.1;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function roundTime(value: number): number {
  return Number(value.toFixed(3));
}

export function TimelineEditor({ duration, segments, snapEnabled, onChangeSegment }: TimelineEditorProps) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<DragState | null>(null);

  const orderedSegments = useMemo(
    () =>
      [...segments]
        .filter((segment) => Number.isFinite(segment.t0) && Number.isFinite(segment.t1) && segment.t0 < segment.t1)
        .sort((a, b) => a.t0 - b.t0),
    [segments],
  );

  const segmentById = useMemo(() => {
    const map = new Map<string, TimelineSegment>();
    for (const segment of orderedSegments) {
      map.set(segment.id, segment);
    }
    return map;
  }, [orderedSegments]);

  const getBoundsForSegment = (segmentId: string) => {
    const index = orderedSegments.findIndex((item) => item.id === segmentId);
    if (index < 0) {
      return { prevEnd: 0, nextStart: duration };
    }
    const prev = index > 0 ? orderedSegments[index - 1] : null;
    const next = index < orderedSegments.length - 1 ? orderedSegments[index + 1] : null;
    return {
      prevEnd: prev?.t1 ?? 0,
      nextStart: next?.t0 ?? duration,
    };
  };

  const maybeSnap = (value: number, target: number) => {
    if (!snapEnabled) {
      return value;
    }
    return Math.abs(value - target) <= SNAP_THRESHOLD ? target : value;
  };

  const updateDrag = (clientX: number) => {
    const drag = dragRef.current;
    const track = trackRef.current;
    if (!drag || !track) {
      return;
    }

    const width = track.clientWidth;
    if (width <= 0) {
      return;
    }

    const deltaX = clientX - drag.startX;
    const deltaTime = (deltaX / width) * duration;

    let nextT0 = drag.startT0;
    let nextT1 = drag.startT1;

    if (drag.type === 'move') {
      const length = drag.startT1 - drag.startT0;
      const minStart = drag.prevEnd;
      const maxStart = Math.max(minStart, drag.nextStart - length);
      let candidateStart = clamp(drag.startT0 + deltaTime, minStart, maxStart);

      candidateStart = maybeSnap(candidateStart, drag.prevEnd);
      candidateStart = maybeSnap(candidateStart + length, drag.nextStart) - length;
      candidateStart = clamp(candidateStart, minStart, maxStart);

      nextT0 = candidateStart;
      nextT1 = candidateStart + length;
    }

    if (drag.type === 'left') {
      const minT0 = drag.prevEnd;
      const maxT0 = drag.startT1 - MIN_LENGTH;
      let candidate = clamp(drag.startT0 + deltaTime, minT0, maxT0);
      candidate = maybeSnap(candidate, drag.prevEnd);
      nextT0 = clamp(candidate, minT0, maxT0);
      nextT1 = drag.startT1;
    }

    if (drag.type === 'right') {
      const minT1 = drag.startT0 + MIN_LENGTH;
      const maxT1 = drag.nextStart;
      let candidate = clamp(drag.startT1 + deltaTime, minT1, maxT1);
      candidate = maybeSnap(candidate, drag.nextStart);
      nextT1 = clamp(candidate, minT1, maxT1);
      nextT0 = drag.startT0;
    }

    onChangeSegment(drag.segmentId, roundTime(nextT0), roundTime(nextT1));
  };

  const stopDrag = () => {
    dragRef.current = null;
    window.removeEventListener('pointermove', onWindowPointerMove);
    window.removeEventListener('pointerup', onWindowPointerUp);
    window.removeEventListener('pointercancel', onWindowPointerUp);
  };

  const onWindowPointerMove = (event: globalThis.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }
    updateDrag(event.clientX);
  };

  const onWindowPointerUp = (event: globalThis.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }
    stopDrag();
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>, segmentId: string, type: DragType) => {
    event.preventDefault();

    const segment = segmentById.get(segmentId);
    if (!segment) {
      return;
    }

    const { prevEnd, nextStart } = getBoundsForSegment(segmentId);
    dragRef.current = {
      pointerId: event.pointerId,
      segmentId,
      type,
      startX: event.clientX,
      startT0: segment.t0,
      startT1: segment.t1,
      prevEnd,
      nextStart,
    };

    window.addEventListener('pointermove', onWindowPointerMove);
    window.addEventListener('pointerup', onWindowPointerUp);
    window.addEventListener('pointercancel', onWindowPointerUp);
  };

  return (
    <div ref={trackRef} className="relative mt-3 h-20 select-none rounded-lg border border-slate-200 bg-slate-50" style={{ touchAction: 'none' }}>
      {orderedSegments.map((segment) => {
        const left = `${(segment.t0 / duration) * 100}%`;
        const width = `${((segment.t1 - segment.t0) / duration) * 100}%`;

        return (
          <div
            key={segment.id}
            className="absolute top-3 h-14 rounded-md border border-blue-200 bg-blue-100"
            style={{ left, width }}
          >
            <div
              onPointerDown={(event) => onPointerDown(event, segment.id, 'left')}
              className="absolute left-0 top-0 h-full w-2 cursor-ew-resize bg-blue-500/60"
            />
            <div
              onPointerDown={(event) => onPointerDown(event, segment.id, 'move')}
              className="h-full w-full cursor-grab px-3 py-1 text-xs font-medium text-blue-900"
            >
              {segment.t0.toFixed(2)} - {segment.t1.toFixed(2)}
            </div>
            <div
              onPointerDown={(event) => onPointerDown(event, segment.id, 'right')}
              className="absolute right-0 top-0 h-full w-2 cursor-ew-resize bg-blue-500/60"
            />
          </div>
        );
      })}
    </div>
  );
}
