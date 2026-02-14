import { PointerEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { useSearchParams } from 'react-router-dom';
import { getMemoryById, listPublishedMemories } from '../lib/api/memories';
import { listSegmentsByMemoryId } from '../lib/api/segments';
import loveHeartButton from '../assets/heart with love.png';

type PublicPlayerProps = {
  isAuthenticated: boolean;
  isAuthLoading: boolean;
};

const PLACEHOLDER_PEAKS = Array.from({ length: 160 }, (_, i) => {
  const wave = Math.sin(i * 0.21) * 0.35 + Math.sin(i * 0.05) * 0.2;
  const noise = ((i % 9) - 4) / 24;
  return Math.max(0.08, Math.min(1, 0.45 + wave + noise));
});

function normalizePeaks(value: unknown): number[] {
  if (!Array.isArray(value)) {
    return PLACEHOLDER_PEAKS;
  }

  const normalized = value
    .map((item) => (typeof item === 'number' ? item : Number(item)))
    .filter((item) => Number.isFinite(item))
    .map((item) => Math.max(0.02, Math.min(1, item)));

  return normalized.length > 0 ? normalized : PLACEHOLDER_PEAKS;
}

type LoadedMemory = {
  id: string;
  title: string;
  audioUrl: string;
  segments: Array<{
    id: string;
    t0: number;
    t1: number;
    leftImageUrl?: string;
    rightImageUrl?: string;
  }>;
  peaks: number[];
  durationSeconds: number;
};

type ImageFrame = {
  id: string;
  leftImageUrl?: string;
  rightImageUrl?: string;
};

function normalizeAngleDelta(delta: number): number {
  return ((delta + 540) % 360) - 180;
}

function formatClock(value: number): string {
  const safe = Math.max(0, Math.floor(value));
  const mm = String(Math.floor(safe / 60)).padStart(2, '0');
  const ss = String(safe % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

async function getAudioDurationFromUrl(audioUrl: string): Promise<number | null> {
  return new Promise((resolve) => {
    const audio = new Audio();
    const cleanup = () => {
      audio.removeAttribute('src');
      audio.load();
    };
    audio.preload = 'metadata';
    audio.onloadedmetadata = () => {
      const duration = Number.isFinite(audio.duration) ? audio.duration : null;
      cleanup();
      resolve(duration);
    };
    audio.onerror = () => {
      cleanup();
      resolve(null);
    };
    audio.src = audioUrl;
  });
}

function buildAutoSegments(frames: ImageFrame[], durationSeconds: number): LoadedMemory['segments'] {
  if (frames.length === 0) {
    return [];
  }
  const safeDuration = Math.max(1, durationSeconds);
  const unit = safeDuration / frames.length;
  return frames.map((frame, index) => {
    const t0 = Number((index * unit).toFixed(3));
    const t1 = Number(((index + 1) * unit).toFixed(3));
    return {
      id: `${frame.id}-auto-${index}`,
      t0,
      t1: index === frames.length - 1 ? safeDuration : t1,
      leftImageUrl: frame.leftImageUrl,
      rightImageUrl: frame.rightImageUrl,
    };
  });
}

export function PublicPlayer({ isAuthenticated, isAuthLoading }: PublicPlayerProps) {
  const [searchParams] = useSearchParams();
  const previewId = searchParams.get('preview');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [memory, setMemory] = useState<LoadedMemory | null>(null);
  const [virtualTime, setVirtualTime] = useState(0);
  const [isWinding, setIsWinding] = useState(false);
  const [heartBounceTick, setHeartBounceTick] = useState(0);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const pointerIdRef = useRef<number | null>(null);
  const lastAngleRef = useRef<number | null>(null);
  const clockwiseDeltaRef = useRef(0);
  const rafRef = useRef<number | null>(null);
  const rafLastTsRef = useRef<number | null>(null);
  const lastAudioSeekAtRef = useRef(0);
  const isWindingRef = useRef(false);
  const isMountedRef = useRef(true);
  const isMobileRef = useRef(false);
  const [isMobileView, setIsMobileView] = useState(false);
  const deadZoneDeg = 1.4;
  const secondsPerDegree = 0.02;
  const mobileSecondsPerSecond = 1.0;

  useEffect(() => {
    let active = true;

    const run = async () => {
      setLoading(true);
      setError(null);

      if (previewId && isAuthLoading) {
        return;
      }

      try {
        if (previewId) {
          if (!isAuthenticated) {
            if (!active) {
              return;
            }
            setError('미리보기는 로그인 후 이용할 수 있습니다.');
            setMemory(null);
            return;
          }

          const previewMemory = await getMemoryById(previewId);
          if (!previewMemory) {
            throw new Error('미리보기 메모리를 찾을 수 없습니다.');
          }
          const previewSegments = await listSegmentsByMemoryId(previewMemory.id);

          if (!active) {
            return;
          }

          const preparedSegments = previewSegments
            .map((segment) => ({
              id: segment.id,
              t0: Number(segment.t0 ?? 0),
              t1: Number(segment.t1 ?? 0),
              leftImageUrl: segment.left_image_url ?? undefined,
              rightImageUrl: segment.right_image_url ?? undefined,
            }))
            .filter((segment) => Number.isFinite(segment.t0) && Number.isFinite(segment.t1) && segment.t0 < segment.t1)
            .sort((a, b) => a.t0 - b.t0);
          const imageFrames = previewSegments
            .map((segment) => ({
              id: segment.id,
              leftImageUrl: segment.left_image_url ?? undefined,
              rightImageUrl: segment.right_image_url ?? undefined,
            }))
            .filter((segment) => segment.leftImageUrl || segment.rightImageUrl);
          const storedDuration = Number(previewMemory.duration_seconds);
          const fallbackDuration = previewMemory.audio_url
            ? await getAudioDurationFromUrl(previewMemory.audio_url)
            : null;
          const durationSeconds = Math.max(
            1,
            Number.isFinite(storedDuration) && storedDuration > 0 ? storedDuration : Number(fallbackDuration ?? 60),
          );

          setMemory({
            id: previewMemory.id,
            title: previewMemory.title || '새 메모리',
            audioUrl: previewMemory.audio_url ?? '',
            segments: preparedSegments.length > 0 ? preparedSegments : buildAutoSegments(imageFrames, durationSeconds),
            peaks: normalizePeaks(previewMemory.waveform_peaks),
            durationSeconds,
          });
          return;
        }

        const published = await listPublishedMemories();
        const first = published[0];
        if (!first) {
          throw new Error('아직 공개된 메모리가 없습니다. /studio에서 공개하세요.');
        }

        const segments = await listSegmentsByMemoryId(first.id);

        if (!active) {
          return;
        }

        const preparedSegments = segments
          .map((segment) => ({
            id: segment.id,
            t0: Number(segment.t0 ?? 0),
            t1: Number(segment.t1 ?? 0),
            leftImageUrl: segment.left_image_url ?? undefined,
            rightImageUrl: segment.right_image_url ?? undefined,
          }))
          .filter((segment) => Number.isFinite(segment.t0) && Number.isFinite(segment.t1) && segment.t0 < segment.t1)
          .sort((a, b) => a.t0 - b.t0);
        const imageFrames = segments
          .map((segment) => ({
            id: segment.id,
            leftImageUrl: segment.left_image_url ?? undefined,
            rightImageUrl: segment.right_image_url ?? undefined,
          }))
          .filter((segment) => segment.leftImageUrl || segment.rightImageUrl);
        const storedDuration = Number(first.duration_seconds);
        const fallbackDuration = first.audio_url ? await getAudioDurationFromUrl(first.audio_url) : null;
        const durationSeconds = Math.max(
          1,
          Number.isFinite(storedDuration) && storedDuration > 0 ? storedDuration : Number(fallbackDuration ?? 60),
        );

        setMemory({
          id: first.id,
          title: first.title || '새 메모리',
          audioUrl: first.audio_url ?? '',
          segments: preparedSegments.length > 0 ? preparedSegments : buildAutoSegments(imageFrames, durationSeconds),
          peaks: normalizePeaks(first.waveform_peaks),
          durationSeconds,
        });
      } catch (loadError) {
        if (!active) {
          return;
        }
        setMemory(null);
        setError(loadError instanceof Error ? loadError.message : '메모리를 불러오지 못했습니다.');
      } finally {
        if (active) {
          setLoading(false);
        }
      }
    };

    run();
    return () => {
      active = false;
    };
  }, [previewId, isAuthenticated, isAuthLoading]);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    const query = window.matchMedia('(max-width: 639px)');
    const apply = () => {
      const next = query.matches;
      isMobileRef.current = next;
      setIsMobileView(next);
    };
    apply();
    query.addEventListener('change', apply);
    return () => {
      query.removeEventListener('change', apply);
    };
  }, []);

  useEffect(() => {
    isWindingRef.current = isWinding;
  }, [isWinding]);

  useEffect(() => {
    const currentAudio = audioRef.current;
    if (currentAudio) {
      currentAudio.pause();
      currentAudio.removeAttribute('src');
      currentAudio.load();
    }

    if (!memory?.audioUrl) {
      audioRef.current = null;
      return;
    }

    const nextAudio = new Audio(memory.audioUrl);
    nextAudio.preload = 'auto';
    const onLoadedMetadata = () => {
      const nextDuration = Number.isFinite(nextAudio.duration) ? nextAudio.duration : 0;
      if (nextDuration > 0) {
        setMemory((prev) => {
          if (!prev) {
            return prev;
          }
          // Keep UI duration synced to actual file length even when DB duration is missing.
          if (Math.abs(prev.durationSeconds - nextDuration) <= 0.05) {
            return prev;
          }
          return { ...prev, durationSeconds: nextDuration };
        });
      }
    };
    const onAudioEnded = () => {
      isWindingRef.current = false;
      if (isMountedRef.current) {
        setIsWinding(false);
      }
    };
    nextAudio.addEventListener('loadedmetadata', onLoadedMetadata);
    nextAudio.addEventListener('ended', onAudioEnded);
    audioRef.current = nextAudio;

    return () => {
      nextAudio.pause();
      nextAudio.removeEventListener('loadedmetadata', onLoadedMetadata);
      nextAudio.removeEventListener('ended', onAudioEnded);
      nextAudio.removeAttribute('src');
      nextAudio.load();
      if (audioRef.current === nextAudio) {
        audioRef.current = null;
      }
    };
  }, [memory?.audioUrl]);

  const syncAudioTime = (nextVirtualTime: number) => {
    const audio = audioRef.current;
    if (!audio) {
      return;
    }
    // Avoid aggressive seeking while audio is actively playing; it causes audible stutter.
    if (isWindingRef.current && !audio.paused) {
      return;
    }
    const now = performance.now();
    if (now - lastAudioSeekAtRef.current < 60) {
      return;
    }
    if (Math.abs(audio.currentTime - nextVirtualTime) > 0.08) {
      audio.currentTime = nextVirtualTime;
      lastAudioSeekAtRef.current = now;
    }
  };

  useEffect(() => {
    syncAudioTime(virtualTime);
  }, [virtualTime]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) {
      return;
    }
    if (!isWinding) {
      audio.pause();
      return;
    }
    audio.playbackRate = isMobileRef.current ? mobileSecondsPerSecond : 1;
    void audio.play().catch(() => undefined);
  }, [isWinding, memory?.audioUrl]);

  useEffect(() => {
    setVirtualTime(0);
    lastAudioSeekAtRef.current = 0;
    rafLastTsRef.current = null;
  }, [memory?.id]);

  useEffect(() => {
    if (!isWinding) {
      if (rafRef.current != null) {
        window.cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      return;
    }
    if (rafRef.current != null) {
      return;
    }

    const tick = () => {
      if (!isWindingRef.current) {
        if (rafRef.current != null) {
          window.cancelAnimationFrame(rafRef.current);
          rafRef.current = null;
        }
        return;
      }
      const now = performance.now();
      const maxDuration = Math.max(1, memory?.durationSeconds ?? 60);
      const lastTs = rafLastTsRef.current;
      const dtSec = lastTs == null ? 0 : (now - lastTs) / 1000;
      rafLastTsRef.current = now;

      if (isMobileRef.current && pointerIdRef.current == null) {
        if (dtSec > 0) {
          setVirtualTime((prev) => Math.min(maxDuration, prev + dtSec * mobileSecondsPerSecond));
        }
      } else {
        const delta = clockwiseDeltaRef.current;
        if (delta > 0) {
          clockwiseDeltaRef.current = 0;
          setVirtualTime((prev) => Math.min(maxDuration, prev + delta * secondsPerDegree));
        }
      }
      rafRef.current = window.requestAnimationFrame(tick);
    };

    rafRef.current = window.requestAnimationFrame(tick);
    return () => {
      if (rafRef.current != null) {
        window.cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [isWinding, memory?.durationSeconds]);

  const stopWinding = () => {
    const audio = audioRef.current;
    if (audio) {
      audio.pause();
    }
    isWindingRef.current = false;
    setIsWinding(false);
    pointerIdRef.current = null;
    lastAngleRef.current = null;
    clockwiseDeltaRef.current = 0;
    rafLastTsRef.current = null;
  };

  useEffect(() => {
    if (!isWinding || isMobileView) {
      return;
    }

    const onPointerEnd = () => stopWinding();
    const onBlur = () => stopWinding();
    const onVisibility = () => {
      if (document.hidden) {
        stopWinding();
      }
    };

    window.addEventListener('pointerup', onPointerEnd);
    window.addEventListener('pointercancel', onPointerEnd);
    window.addEventListener('blur', onBlur);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('pointerup', onPointerEnd);
      window.removeEventListener('pointercancel', onPointerEnd);
      window.removeEventListener('blur', onBlur);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [isWinding, isMobileView]);

  const getPointerAngle = (target: HTMLButtonElement, clientX: number, clientY: number): number => {
    const rect = target.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    return (Math.atan2(clientY - cy, clientX - cx) * 180) / Math.PI;
  };

  const onKnobPointerDown = (event: PointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    if (isMobileRef.current) {
      return;
    }
    pointerIdRef.current = event.pointerId;
    event.currentTarget.setPointerCapture(event.pointerId);
    lastAngleRef.current = getPointerAngle(event.currentTarget, event.clientX, event.clientY);
    clockwiseDeltaRef.current = 0;
    isWindingRef.current = true;
    setIsWinding(true);
  };

  const onMobileKnobClick = () => {
    if (!isMobileRef.current) {
      return;
    }

    if (isWindingRef.current) {
      stopWinding();
      return;
    }

    const maxDuration = Math.max(1, memory?.durationSeconds ?? 60);
    if (virtualTime >= maxDuration - 0.05) {
      setVirtualTime(0);
      const audio = audioRef.current;
      if (audio) {
        audio.currentTime = 0;
      }
    }

    pointerIdRef.current = null;
    lastAngleRef.current = null;
    clockwiseDeltaRef.current = 0;
    rafLastTsRef.current = null;
    isWindingRef.current = true;
    setIsWinding(true);
  };

  const onKnobPointerMove = (event: PointerEvent<HTMLButtonElement>) => {
    if (pointerIdRef.current !== event.pointerId) {
      return;
    }

    const nextAngle = getPointerAngle(event.currentTarget, event.clientX, event.clientY);
    const prevAngle = lastAngleRef.current;
    if (prevAngle == null) {
      return;
    }

    const delta = normalizeAngleDelta(nextAngle - prevAngle);
    lastAngleRef.current = nextAngle;

    if (Math.abs(delta) < deadZoneDeg) {
      return;
    }
    if (delta > 0) {
      clockwiseDeltaRef.current += delta;
    }
  };

  const onKnobPointerUp = (event: PointerEvent<HTMLButtonElement>) => {
    if (pointerIdRef.current !== event.pointerId) {
      return;
    }
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    stopWinding();
  };

  const peaks = memory?.peaks ?? PLACEHOLDER_PEAKS;
  const displayPeaks = useMemo(() => {
    const targetBars = 72;
    if (peaks.length <= targetBars) {
      return peaks;
    }
    const step = peaks.length / targetBars;
    return Array.from({ length: targetBars }, (_, index) => peaks[Math.floor(index * step)] ?? 0.1);
  }, [peaks]);
  const waveformBars = useMemo(
    () =>
      displayPeaks.map((peak, index) => {
        const centerWeight = 1 - Math.abs((index / Math.max(1, displayPeaks.length - 1)) * 2 - 1);
        const boostedPeak = Math.pow(Math.min(1, peak * 1.45), 0.72);
        const texture = Math.sin(index * 0.62) * 0.08 + Math.cos(index * 0.23) * 0.05;
        const shapedPeak = Math.min(1, Math.max(0.08, boostedPeak + centerWeight * 0.22 + texture * 0.25));
        return (
          <div
            key={`${index}-${peak}`}
            className="w-[3px] rounded-full bg-[#5a473d]"
            style={{ height: `${Math.max(8, Math.min(100, Math.round(shapedPeak * 100)))}%` }}
          />
        );
      }),
    [displayPeaks],
  );
  const totalDuration = Math.max(1, memory?.durationSeconds ?? 60);
  const playheadPercent = Math.min(100, (virtualTime / totalDuration) * 100);
  const carouselImages = useMemo(() => {
    const ordered = memory?.segments ?? [];
    const urls: string[] = [];
    for (const segment of ordered) {
      if (segment.leftImageUrl) {
        urls.push(segment.leftImageUrl);
      }
      if (segment.rightImageUrl) {
        urls.push(segment.rightImageUrl);
      }
    }
    return urls;
  }, [memory?.segments]);
  const stripViewportRef = useRef<HTMLDivElement | null>(null);
  const stripTrackRef = useRef<HTMLDivElement | null>(null);
  const [stripOffsets, setStripOffsets] = useState({ start: 0, end: 0 });
  const stripImages = carouselImages;
  const measureStrip = useCallback(() => {
    const viewport = stripViewportRef.current;
    const track = stripTrackRef.current;
    if (!viewport || !track) {
      setStripOffsets({ start: 0, end: 0 });
      return;
    }

    const viewportWidth = viewport.clientWidth;
    const children = Array.from(track.children) as HTMLElement[];
    if (children.length === 0) {
      setStripOffsets({ start: 0, end: 0 });
      return;
    }

    const first = children[0];
    const last = children[children.length - 1];
    const firstLeft = first?.offsetLeft ?? 0;
    const firstWidth = first?.offsetWidth ?? 0;
    const lastCenter = (last?.offsetLeft ?? 0) + (last?.offsetWidth ?? 0) / 2;

    // Start: show only one-third of the first image (peek-in from right).
    const start = viewportWidth - firstLeft - firstWidth / 3;
    // End: last image is the focus (without wrapping to first image).
    const end = viewportWidth / 2 - lastCenter;

    setStripOffsets({ start, end });
  }, []);
  const stripTranslateX = useMemo(() => {
    if (carouselImages.length === 0) {
      return 0;
    }
    const ratio = Math.max(0, Math.min(1, virtualTime / totalDuration));
    return stripOffsets.start + (stripOffsets.end - stripOffsets.start) * ratio;
  }, [carouselImages.length, stripOffsets.start, stripOffsets.end, virtualTime, totalDuration]);

  useEffect(() => {
    measureStrip();
    window.addEventListener('resize', measureStrip);
    const resizeObserver = new ResizeObserver(() => {
      measureStrip();
    });
    if (stripViewportRef.current) {
      resizeObserver.observe(stripViewportRef.current);
    }
    if (stripTrackRef.current) {
      resizeObserver.observe(stripTrackRef.current);
    }
    return () => {
      resizeObserver.disconnect();
      window.removeEventListener('resize', measureStrip);
    };
  }, [carouselImages.length, measureStrip]);

  return (
    <div className="vm-player h-full w-full select-none overflow-hidden overscroll-none touch-none p-0 sm:p-8">
      <motion.main
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        className="relative mx-auto h-[100dvh] w-full max-w-4xl overflow-hidden touch-none px-3 pb-4 pt-3 sm:h-auto sm:overflow-visible sm:rounded-[34px] sm:p-8"
      >
        <div className="mt-0 flex justify-center">
          <div
            ref={stripViewportRef}
            className="relative h-[24.1rem] w-[97%] max-w-[760px] overflow-hidden rounded-[30px] border border-white bg-white px-5 py-2 shadow-[0_12px_28px_rgba(0,0,0,0.12)] sm:h-[29.4rem] sm:px-6 sm:py-2"
          >
            {stripImages.length > 0 && (
              <div
                ref={stripTrackRef}
                className="flex h-full min-w-max items-center gap-2 px-0 will-change-transform"
                style={{ transform: `translateX(${stripTranslateX}px)` }}
              >
                {stripImages.map((imageUrl, index) => (
                  <img
                    key={`strip-${imageUrl}-${index}`}
                    src={imageUrl}
                    alt=""
                    onLoad={measureStrip}
                    onError={measureStrip}
                    className="h-[98%] aspect-[3/4] shrink-0 rounded-xl object-cover opacity-90"
                  />
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="mt-4">
          <div className="relative h-16 overflow-hidden rounded-xl bg-white sm:h-24">
            <div className="flex h-full w-full items-center justify-between px-[3px] py-2 sm:py-3">
              {waveformBars}
            </div>
            <div
              className="pointer-events-none absolute bottom-0 top-0 z-10 w-[3px] rounded bg-red-500"
              style={{ left: `${playheadPercent}%` }}
            />
          </div>
        </div>
        <p className="mt-1 text-right text-sm text-[#5e4d44]">
          {formatClock(virtualTime)}/{formatClock(totalDuration)}
        </p>

        <div className="mt-4 flex items-center justify-center">
          <motion.button
            type="button"
            onPointerDown={onKnobPointerDown}
            onPointerMove={onKnobPointerMove}
            onPointerUp={onKnobPointerUp}
            onPointerCancel={onKnobPointerUp}
            onClick={() => {
              setHeartBounceTick((prev) => prev + 1);
              onMobileKnobClick();
            }}
            animate={{
              scale: [1, 1.12, 1],
            }}
            transition={{
              scale: { duration: 0.28, times: [0, 0.45, 1], ease: 'easeOut' },
            }}
            key={heartBounceTick}
            className="relative flex h-20 w-24 items-center justify-center sm:h-24 sm:w-28"
            aria-label="LOVE 재생 버튼"
          >
            <img src={loveHeartButton} alt="" className="h-full w-full object-contain select-none" draggable={false} />
          </motion.button>
        </div>

        {!loading && error && <p className="mt-3 text-sm text-red-700">{error}</p>}

        {loading && (
          <div className="absolute inset-0 z-30 flex items-center justify-center bg-[#2b1b15]/28 backdrop-blur-[2px]">
            <div className="h-10 w-10 animate-spin rounded-full border-4 border-[#f2e6d6] border-t-[#7f6052]" />
          </div>
        )}
      </motion.main>
    </div>
  );
}
