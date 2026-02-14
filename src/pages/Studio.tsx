import { ChangeEvent, FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { useNavigate } from 'react-router-dom';
import {
  Memory,
  createMemory,
  deleteMemory,
  listMemories,
  publishMemory,
  updateMemoryAudio,
  updateMemoryWaveform,
} from '../lib/api/memories';
import {
  Segment,
  createSegment,
  listSegmentsByMemoryId,
  updateSegment,
} from '../lib/api/segments';
import { supabase } from '../lib/supabaseClient';

type SegmentDraft = {
  id: string;
  t0: string;
  t1: string;
  left_image_url: string;
  right_image_url: string;
  created_at: string;
};

type NumericSegment = {
  id: string;
  t0: number;
  t1: number;
};

type AudioUploadState = {
  phase: 'idle' | 'uploading' | 'saving' | 'done' | 'error';
  progress: number;
  path: string | null;
  error: string | null;
};

type UploadedImageItem = {
  url: string;
  segmentId: string;
  side: 'left' | 'right';
};

type ImageUploadState = {
  phase: 'idle' | 'preparing' | 'uploading' | 'done' | 'error';
  total: number;
  completed: number;
  progress: number;
  error: string | null;
};

const RECORDING_MIME_CANDIDATES = [
  'audio/mp4;codecs=mp4a.40.2',
  'audio/mp4',
  'audio/webm;codecs=opus',
  'audio/ogg;codecs=opus',
  'audio/webm',
  'audio/ogg',
] as const;
const MAX_IMAGE_COUNT = 30;
const IMAGE_UPLOAD_CONCURRENCY = 4;

function pickRecordingMimeType(): string | null {
  if (typeof window === 'undefined' || typeof MediaRecorder === 'undefined') {
    return null;
  }

  for (const mimeType of RECORDING_MIME_CANDIDATES) {
    if (MediaRecorder.isTypeSupported(mimeType)) {
      return mimeType;
    }
  }

  return null;
}

function fileExt(name: string): string {
  const idx = name.lastIndexOf('.');
  return idx >= 0 ? name.slice(idx + 1) : 'bin';
}

function extFromMimeType(mimeType: string): string {
  if (mimeType.includes('mp4')) {
    return 'm4a';
  }
  if (mimeType.includes('ogg')) {
    return 'ogg';
  }
  if (mimeType.includes('webm')) {
    return 'webm';
  }
  return 'bin';
}

function numText(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(3)));
}

function toDraft(segment: Segment): SegmentDraft {
  return {
    id: segment.id,
    t0: segment.t0 == null ? '' : numText(segment.t0),
    t1: segment.t1 == null ? '' : numText(segment.t1),
    left_image_url: segment.left_image_url ?? '',
    right_image_url: segment.right_image_url ?? '',
    created_at: segment.created_at,
  };
}

function toNumericSegment(segment: SegmentDraft): NumericSegment | null {
  const t0 = Number(segment.t0);
  const t1 = Number(segment.t1);
  if (!Number.isFinite(t0) || !Number.isFinite(t1) || t0 >= t1) {
    return null;
  }
  return { id: segment.id, t0, t1 };
}

function isDefaultTimelineSegments(segments: NumericSegment[]): boolean {
  if (segments.length === 0) {
    return false;
  }
  const epsilon = 0.02;
  return segments.every((segment, index) => {
    const expectedT0 = index;
    const expectedT1 = index + 1;
    return Math.abs(segment.t0 - expectedT0) <= epsilon && Math.abs(segment.t1 - expectedT1) <= epsilon;
  });
}

function extractMediaPathFromPublicUrl(urlText: string): string | null {
  try {
    const url = new URL(urlText);
    const marker = '/storage/v1/object/public/media/';
    const idx = url.pathname.indexOf(marker);
    if (idx < 0) {
      return null;
    }
    const encoded = url.pathname.slice(idx + marker.length);
    if (!encoded) {
      return null;
    }
    return decodeURIComponent(encoded);
  } catch {
    return null;
  }
}

function formatSeconds(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  const mm = String(Math.floor(safe / 60)).padStart(2, '0');
  const ss = String(safe % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

function formatDurationLabel(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds <= 0) {
    return '-';
  }
  const safe = Math.floor(seconds);
  const mm = Math.floor(safe / 60);
  const ss = safe % 60;
  if (mm <= 0) {
    return `${ss}초`;
  }
  return `${mm}분 ${String(ss).padStart(2, '0')}초`;
}

function createBoostedRecordingStream(inputStream: MediaStream, gainValue: number): {
  stream: MediaStream;
  context: AudioContext;
} | null {
  const AudioContextCtor =
    window.AudioContext ||
    (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextCtor) {
    return null;
  }

  const context = new AudioContextCtor();
  const source = context.createMediaStreamSource(inputStream);
  const gainNode = context.createGain();
  const destination = context.createMediaStreamDestination();
  gainNode.gain.value = gainValue;
  source.connect(gainNode);
  gainNode.connect(destination);
  return { stream: destination.stream, context };
}

async function getAudioDuration(file: File): Promise<number | null> {
  const metadataDuration = await new Promise<number | null>((resolve) => {
    const url = URL.createObjectURL(file);
    const audio = new Audio();

    const cleanup = () => {
      URL.revokeObjectURL(url);
      audio.removeAttribute('src');
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
    audio.src = url;
  });

  if (metadataDuration != null && Number.isFinite(metadataDuration) && metadataDuration > 0) {
    return metadataDuration;
  }

  // Fallback: decode audio buffer when metadata-based duration detection fails.
  const AudioContextCtor =
    window.AudioContext ||
    (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextCtor) {
    return null;
  }

  let audioContext: AudioContext | null = null;
  try {
    audioContext = new AudioContextCtor();
    const buffer = await file.arrayBuffer();
    const decoded = await audioContext.decodeAudioData(buffer.slice(0));
    const decodedDuration = Number.isFinite(decoded.duration) ? decoded.duration : null;
    return decodedDuration != null && decodedDuration > 0 ? decodedDuration : null;
  } catch {
    return null;
  } finally {
    if (audioContext) {
      await audioContext.close().catch(() => undefined);
    }
  }
}

function extractWaveformPeaks(audioBuffer: AudioBuffer, peakCount: number): number[] {
  const channels = audioBuffer.numberOfChannels;
  const length = audioBuffer.length;
  const blockSize = Math.max(1, Math.floor(length / peakCount));
  const peaks: number[] = [];

  for (let i = 0; i < peakCount; i += 1) {
    const start = i * blockSize;
    const end = Math.min(length, start + blockSize);
    let max = 0;

    for (let channel = 0; channel < channels; channel += 1) {
      const channelData = audioBuffer.getChannelData(channel);
      for (let j = start; j < end; j += 1) {
        const value = Math.abs(channelData[j] ?? 0);
        if (value > max) {
          max = value;
        }
      }
    }

    peaks.push(Number(max.toFixed(6)));
  }

  return peaks;
}

async function analyzeWaveformFromFile(file: File): Promise<number[]> {
  const AudioContextCtor =
    window.AudioContext ||
    (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextCtor) {
    throw new Error('이 브라우저는 파형 분석을 지원하지 않습니다.');
  }

  const audioContext = new AudioContextCtor();
  try {
    const buffer = await file.arrayBuffer();
    const decoded = await audioContext.decodeAudioData(buffer.slice(0));
    return extractWaveformPeaks(decoded, 160);
  } finally {
    await audioContext.close().catch(() => undefined);
  }
}

export function Studio() {
  const navigate = useNavigate();
  const [memories, setMemories] = useState<Memory[]>([]);
  const [selectedMemoryId, setSelectedMemoryId] = useState<string | null>(null);
  const [newMemoryTitle, setNewMemoryTitle] = useState('');
  const [segments, setSegments] = useState<SegmentDraft[]>([]);
  const [busy, setBusy] = useState(false);
  const [segmentsBusy, setSegmentsBusy] = useState(false);
  const [, setStatusMessage] = useState<string | null>(null);
  const [publishState, setPublishState] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [publishError, setPublishError] = useState<string | null>(null);
  const [recordingMimeType] = useState<string | null>(() => pickRecordingMimeType());
  const [recordingError, setRecordingError] = useState<string | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [recordingLevel, setRecordingLevel] = useState(0);
  const [recordedBlob, setRecordedBlob] = useState<Blob | null>(null);
  const [recordedUrl, setRecordedUrl] = useState<string | null>(null);
  const [analyzingWaveform, setAnalyzingWaveform] = useState(false);
  const [deletePreviousImageFile, setDeletePreviousImageFile] = useState(false);
  const [signOutBusy, setSignOutBusy] = useState(false);
  const [audioUploadState, setAudioUploadState] = useState<AudioUploadState>({
    phase: 'idle',
    progress: 0,
    path: null,
    error: null,
  });
  const [selectedImageFiles, setSelectedImageFiles] = useState<File[]>([]);
  const [imageUploadState, setImageUploadState] = useState<ImageUploadState>({
    phase: 'idle',
    total: 0,
    completed: 0,
    progress: 0,
    error: null,
  });

  const recorderRef = useRef<MediaRecorder | null>(null);
  const recordingChunksRef = useRef<BlobPart[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const analyserDataRef = useRef<Uint8Array<ArrayBuffer> | null>(null);
  const recordingBoostContextRef = useRef<AudioContext | null>(null);
  const levelIntervalRef = useRef<number | null>(null);
  const intervalRef = useRef<number | null>(null);
  const recordingStartedAtRef = useRef<number | null>(null);
  const audioFileInputRef = useRef<HTMLInputElement | null>(null);
  const imageUploadInputRef = useRef<HTMLInputElement | null>(null);

  const selectedMemory = useMemo(
    () => memories.find((memory) => memory.id === selectedMemoryId) ?? null,
    [memories, selectedMemoryId],
  );
  const uploadedImages = useMemo<UploadedImageItem[]>(() => {
    const items: UploadedImageItem[] = [];
    for (const segment of segments) {
      if (segment.left_image_url) {
        items.push({
          url: segment.left_image_url,
          segmentId: segment.id,
          side: 'left',
        });
      }
      if (segment.right_image_url) {
        items.push({
          url: segment.right_image_url,
          segmentId: segment.id,
          side: 'right',
        });
      }
    }
    return items;
  }, [segments]);

  const clampSegmentsToDuration = (durationValue: number) => {
    const maxDuration = Math.max(0.1, durationValue);
    const minLen = 0.1;
    const source = segments
      .map(toNumericSegment)
      .filter((item): item is NumericSegment => item != null)
      .sort((a, b) => a.t0 - b.t0);

    // If timeline is still in default "1s slots" state, redistribute evenly to new duration.
    if (isDefaultTimelineSegments(source)) {
      const unit = maxDuration / source.length;
      const redistributed = source.map((segment, index) => ({
        id: segment.id,
        t0: Number((index * unit).toFixed(3)),
        t1: Number(((index + 1) * unit).toFixed(3)),
      }));
      redistributed[redistributed.length - 1].t1 = Number(maxDuration.toFixed(3));

      setSegments((prev) =>
        prev.map((segment) => {
          const next = redistributed.find((item) => item.id === segment.id);
          if (!next) {
            return segment;
          }
          return { ...segment, t0: numText(next.t0), t1: numText(next.t1) };
        }),
      );
      return redistributed;
    }

    const clamped: NumericSegment[] = [];
    for (const current of source) {
      let t0 = Math.max(0, Math.min(current.t0, maxDuration));
      let t1 = Math.max(0, Math.min(current.t1, maxDuration));
      if (clamped.length > 0) {
        t0 = Math.max(t0, clamped[clamped.length - 1].t1);
      }
      if (t1 - t0 < minLen) {
        t1 = Math.min(maxDuration, t0 + minLen);
      }
      if (t1 - t0 >= minLen) {
        clamped.push({ id: current.id, t0: Number(t0.toFixed(3)), t1: Number(t1.toFixed(3)) });
      }
    }

    setSegments((prev) =>
      prev.map((segment) => {
        const next = clamped.find((item) => item.id === segment.id);
        if (!next) {
          return segment;
        }
        return { ...segment, t0: numText(next.t0), t1: numText(next.t1) };
      }),
    );

    return clamped;
  };

  const setMemoryInList = (next: Memory) => {
    setMemories((prev) => prev.map((item) => (item.id === next.id ? next : item)));
  };

  const loadMemories = async (options?: { selectFallback?: boolean }) => {
    const selectFallback = options?.selectFallback ?? true;
    const list = await listMemories();
    setMemories(list);
    setSelectedMemoryId((prev) => {
      if (prev && list.some((item) => item.id === prev)) {
        return prev;
      }
      return selectFallback ? (list[0]?.id ?? null) : null;
    });
  };

  const loadSegments = async (memoryId: string) => {
    const rows = await listSegmentsByMemoryId(memoryId);
    setSegments(rows.map(toDraft));
  };

  const clearRecordingInterval = () => {
    if (intervalRef.current != null) {
      window.clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  };

  const clearRecordingMeter = async () => {
    if (levelIntervalRef.current != null) {
      window.clearInterval(levelIntervalRef.current);
      levelIntervalRef.current = null;
    }
    analyserRef.current = null;
    analyserDataRef.current = null;
    setRecordingLevel(0);

    if (audioContextRef.current) {
      await audioContextRef.current.close().catch(() => undefined);
      audioContextRef.current = null;
    }
  };

  const stopRecordingStream = () => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
  };

  const stopRecordingResources = async () => {
    clearRecordingInterval();
    recordingStartedAtRef.current = null;
    await clearRecordingMeter();
    if (recordingBoostContextRef.current) {
      await recordingBoostContextRef.current.close().catch(() => undefined);
      recordingBoostContextRef.current = null;
    }
    stopRecordingStream();
  };

  const startLevelMeter = async (stream: MediaStream) => {
    const AudioContextCtor = window.AudioContext;
    if (!AudioContextCtor) {
      return;
    }

    const audioContext = new AudioContextCtor();
    const source = audioContext.createMediaStreamSource(stream);
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.35;
    source.connect(analyser);

    const dataArray = new Uint8Array(new ArrayBuffer(analyser.frequencyBinCount));
    audioContextRef.current = audioContext;
    analyserRef.current = analyser;
    analyserDataRef.current = dataArray;

    const tick = () => {
      const node = analyserRef.current;
      const bytes = analyserDataRef.current;
      if (!node || !bytes) {
        return;
      }

      node.getByteTimeDomainData(bytes);
      let sumSquares = 0;
      for (let i = 0; i < bytes.length; i += 1) {
        const centered = (bytes[i] - 128) / 128;
        sumSquares += centered * centered;
      }
      const rms = Math.sqrt(sumSquares / bytes.length);
      // Expand low RMS range so voice activity looks realistic on the meter.
      const boosted = Math.pow(Math.min(1, rms * 1.8), 0.75);
      setRecordingLevel(Math.min(1, Math.max(0.02, boosted)));
    };

    tick();
    levelIntervalRef.current = window.setInterval(tick, Math.round(1000 / 30));
  };

  const tryDeleteMediaByPublicUrl = async (publicUrl: string, label: string) => {
    const path = extractMediaPathFromPublicUrl(publicUrl);
    if (!path) {
      setStatusMessage(`경고: 이전 ${label} 경로를 해석하지 못했습니다.`);
      return;
    }

    const { error } = await supabase.storage.from('media').remove([path]);
    if (error) {
      setStatusMessage(`경고: 이전 ${label} 삭제에 실패했습니다 (${error.message}).`);
    }
  };

  const deleteMediaByPublicUrlSilently = async (publicUrl: string) => {
    const path = extractMediaPathFromPublicUrl(publicUrl);
    if (!path) {
      return;
    }
    await supabase.storage.from('media').remove([path]);
  };

  const uploadAudioFileToMemory = async (file: File, removePrevious: boolean) => {
    if (!selectedMemoryId) {
      return;
    }

    const previousAudioUrl = selectedMemory?.audio_url ?? '';
    const ext = fileExt(file.name);
    const path = `audio/${selectedMemoryId}/${Date.now()}.${ext}`;
    setAudioUploadState({ phase: 'uploading', progress: 20, path: `media/${path}`, error: null });

    const upload = await supabase.storage.from('media').upload(path, file, {
      contentType: file.type || undefined,
      upsert: false,
    });

    if (upload.error) {
      setAudioUploadState({
        phase: 'error',
        progress: 0,
        path: `media/${path}`,
        error: upload.error.message,
      });
      throw upload.error;
    }

    setAudioUploadState({ phase: 'saving', progress: 75, path: `media/${path}`, error: null });
    const { data } = supabase.storage.from('media').getPublicUrl(path);
    const duration = await getAudioDuration(file);
    const updated = await updateMemoryAudio(selectedMemoryId, {
      audio_url: data.publicUrl,
      duration_seconds: duration ?? selectedMemory?.duration_seconds ?? null,
    });

    setMemoryInList(updated);
    if (duration == null) {
      setStatusMessage('오디오 길이 계산에 실패해 기존 길이 값을 유지했습니다.');
    }

    if (duration != null) {
      const clamped = clampSegmentsToDuration(duration);
      try {
        await Promise.all(clamped.map((segment) => updateSegment(segment.id, { t0: segment.t0, t1: segment.t1 })));
      } catch {
        setStatusMessage('자동 보정 저장에 실패했습니다.');
      }
    }

    if (removePrevious && previousAudioUrl && previousAudioUrl !== data.publicUrl) {
      await tryDeleteMediaByPublicUrl(previousAudioUrl, '오디오 파일');
    }

    setAnalyzingWaveform(true);
    try {
      const peaks = await analyzeWaveformFromFile(file);
      const waveformUpdated = await updateMemoryWaveform(selectedMemoryId, peaks);
      setMemoryInList(waveformUpdated);
    } catch (error) {
      setStatusMessage(error instanceof Error ? `파형 자동 분석 실패: ${error.message}` : '파형 자동 분석에 실패했습니다.');
    } finally {
      setAnalyzingWaveform(false);
    }

    setAudioUploadState({ phase: 'done', progress: 0, path: null, error: null });
  };

  useEffect(() => {
    loadMemories().catch((error: unknown) => {
      setStatusMessage(error instanceof Error ? error.message : '메모리 목록을 불러오지 못했습니다.');
    });
  }, []);

  useEffect(() => {
    if (!selectedMemoryId) {
      setSegments([]);
      return;
    }
    loadSegments(selectedMemoryId).catch((error: unknown) => {
      setStatusMessage(error instanceof Error ? error.message : '세그먼트를 불러오지 못했습니다.');
    });
  }, [selectedMemoryId]);

  useEffect(() => {
    setSelectedImageFiles([]);
    setImageUploadState({ phase: 'idle', total: 0, completed: 0, progress: 0, error: null });
  }, [selectedMemoryId]);

  useEffect(() => {
    return () => {
      clearRecordingInterval();
      if (levelIntervalRef.current != null) {
        window.clearInterval(levelIntervalRef.current);
      }
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop());
      }
      if (audioContextRef.current) {
        audioContextRef.current.close().catch(() => undefined);
      }
      if (recordingBoostContextRef.current) {
        recordingBoostContextRef.current.close().catch(() => undefined);
      }
      if (recordedUrl) {
        URL.revokeObjectURL(recordedUrl);
      }
    };
  }, [recordedUrl]);

  const onCreateMemory = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const title = newMemoryTitle.trim();
    if (!title) {
      return;
    }

    setBusy(true);
    setStatusMessage(null);
    try {
      const created = await createMemory(title);
      setNewMemoryTitle('');
      await loadMemories();
      setSelectedMemoryId(created.id);
      setStatusMessage('메모리를 만들었습니다.');
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : '메모리 생성에 실패했습니다.');
    } finally {
      setBusy(false);
    }
  };

  const onDeleteMemory = async (targetMemoryId?: string) => {
    const memoryId = targetMemoryId ?? selectedMemoryId;
    if (!memoryId) {
      return;
    }
    setBusy(true);
    setStatusMessage(null);
    try {
      await deleteMemory(memoryId);
      await loadMemories({ selectFallback: false });
      setStatusMessage('메모리를 삭제했습니다.');
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : '메모리 삭제에 실패했습니다.');
    } finally {
      setBusy(false);
    }
  };

  const onAudioUpload = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file || !selectedMemoryId) {
      return;
    }

    setBusy(true);
    setStatusMessage(null);
    setAudioUploadState({ phase: 'idle', progress: 0, path: null, error: null });

    try {
      await uploadAudioFileToMemory(file, true);
      setStatusMessage('오디오를 업로드했습니다.');
    } catch (error) {
      setAudioUploadState((prev) => ({
        ...prev,
        phase: 'error',
        progress: 0,
        error: error instanceof Error ? error.message : '알 수 없는 업로드 오류',
      }));
      setStatusMessage(error instanceof Error ? `업로드 실패: ${error.message}` : '업로드에 실패했습니다.');
    } finally {
      setBusy(false);
    }
  };

  const onStartRecording = async () => {
    if (!selectedMemoryId) {
      return;
    }
    if (!recordingMimeType) {
      setRecordingError('이 브라우저는 녹음을 지원하지 않습니다. 대신 오디오 파일 업로드를 사용하세요.');
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      setRecordingError('마이크 접근을 사용할 수 없습니다. 대신 오디오 파일 업로드를 사용하세요.');
      return;
    }

    setRecordingError(null);
    setStatusMessage(null);

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          autoGainControl: false,
          noiseSuppression: false,
          echoCancellation: false,
        },
      });
      streamRef.current = stream;

      let recordingStream: MediaStream = stream;
      const boosted = createBoostedRecordingStream(stream, 1.2);
      if (boosted) {
        await boosted.context.resume().catch(() => undefined);
        recordingStream = boosted.stream;
        recordingBoostContextRef.current = boosted.context;
      }

      const recorder = new MediaRecorder(recordingStream, {
        mimeType: recordingMimeType,
        audioBitsPerSecond: 160000,
      });
      recorderRef.current = recorder;
      recordingChunksRef.current = [];

      if (recordedUrl) {
        URL.revokeObjectURL(recordedUrl);
      }
      setRecordedBlob(null);
      setRecordedUrl(null);
      setRecordingSeconds(0);
      recordingStartedAtRef.current = Date.now();

      intervalRef.current = window.setInterval(() => {
        const startedAt = recordingStartedAtRef.current;
        if (startedAt == null) {
          return;
        }
        setRecordingSeconds(Math.floor((Date.now() - startedAt) / 1000));
      }, 250);

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          recordingChunksRef.current.push(event.data);
        }
      };

      recorder.onstop = async () => {
        const blob = new Blob(recordingChunksRef.current, {
          type: recorder.mimeType || recordingMimeType,
        });
        if (blob.size === 0) {
          setRecordingError('녹음 데이터가 비어 있습니다. 마이크 권한과 입력 장치를 확인해주세요.');
          setIsRecording(false);
          clearRecordingInterval();
          await stopRecordingResources();
          return;
        }
        const url = URL.createObjectURL(blob);
        setRecordedBlob(blob);
        setRecordedUrl(url);
        setIsRecording(false);
        clearRecordingInterval();
        await stopRecordingResources();
      };

      await startLevelMeter(stream);
      recorder.start();
      setIsRecording(true);
    } catch (error) {
      await stopRecordingResources();
      setIsRecording(false);
      setRecordingError(
        error instanceof Error
          ? `마이크 권한이 거부되었거나 사용할 수 없습니다: ${error.message}`
          : '마이크 권한이 없거나 사용할 수 없습니다. 대신 오디오 파일 업로드를 사용하세요.',
      );
    }
  };

  const onStopRecording = () => {
    if (recorderRef.current && recorderRef.current.state !== 'inactive') {
      recorderRef.current.stop();
    }
  };

  const onToggleRecording = async () => {
    if (isRecording) {
      onStopRecording();
      return;
    }
    await onStartRecording();
  };

  const onSaveRecording = async () => {
    if (!recordedBlob || !selectedMemoryId) {
      return;
    }

    setBusy(true);
    setStatusMessage(null);
    setAudioUploadState({ phase: 'idle', progress: 0, path: null, error: null });

    try {
      const mimeType = recordedBlob.type || recordingMimeType || 'audio/webm';
      const ext = extFromMimeType(mimeType);
      const file = new File([recordedBlob], `recording-${Date.now()}.${ext}`, { type: mimeType });
      await uploadAudioFileToMemory(file, true);
      setStatusMessage('녹음 오디오를 업로드했습니다.');
    } catch (error) {
      setAudioUploadState((prev) => ({
        ...prev,
        phase: 'error',
        progress: 0,
        error: error instanceof Error ? error.message : '알 수 없는 업로드 오류',
      }));
      setStatusMessage(error instanceof Error ? `저장 실패: ${error.message}` : '저장에 실패했습니다.');
    } finally {
      setBusy(false);
    }
  };

  const uploadSegmentImageFile = async (segmentId: string, side: 'left' | 'right', file: File) => {
    if (!selectedMemoryId) {
      return;
    }

    const targetSegment = segments.find((segment) => segment.id === segmentId);
    const previousImageUrl =
      side === 'left' ? targetSegment?.left_image_url ?? '' : targetSegment?.right_image_url ?? '';
    const ext = fileExt(file.name);
    const path = `images/${selectedMemoryId}/${Date.now()}-${side}.${ext}`;

    const upload = await supabase.storage.from('media').upload(path, file, {
      contentType: file.type || undefined,
      upsert: false,
    });

    if (upload.error) {
      throw upload.error;
    }

    const { data } = supabase.storage.from('media').getPublicUrl(path);
    const payload = side === 'left' ? { left_image_url: data.publicUrl } : { right_image_url: data.publicUrl };
    const updated = await updateSegment(segmentId, payload);

    setSegments((prev) =>
      prev.map((segment) => (segment.id === updated.id ? toDraft(updated) : segment)),
    );

    if (deletePreviousImageFile && previousImageUrl && previousImageUrl !== data.publicUrl) {
      await tryDeleteMediaByPublicUrl(previousImageUrl, '이미지 파일');
    }
  };

  const ensureSegmentIdsForImageCount = async (requiredCount: number): Promise<string[]> => {
    if (!selectedMemoryId) {
      return [];
    }

    const sorted = [...segments].sort((a, b) => Number(a.t0 || 0) - Number(b.t0 || 0));
    const ids = sorted.map((segment) => segment.id);
    if (ids.length >= requiredCount) {
      return ids.slice(0, requiredCount);
    }

    const duration = Math.max(requiredCount, Number(selectedMemory?.duration_seconds ?? requiredCount));
    let cursor = sorted.length > 0
      ? Math.max(...sorted.map((segment) => Number(segment.t1 || 0)))
      : 0;
    const createdDrafts: SegmentDraft[] = [];

    while (ids.length < requiredCount) {
      const start = Number(cursor.toFixed(3));
      const end = Number((start + 1).toFixed(3));
      const created = await createSegment(selectedMemoryId, start, Math.min(end, duration));
      createdDrafts.push(toDraft(created));
      ids.push(created.id);
      cursor = Number(created.t1 ?? end);
    }

    if (createdDrafts.length > 0) {
      setSegments((prev) => [...prev, ...createdDrafts]);
    }

    return ids.slice(0, requiredCount);
  };

  const onQuickSegmentImageUpload = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = '';
    if (files.length === 0) {
      return;
    }
    setSelectedImageFiles(files);
    setImageUploadState({ phase: 'idle', total: 0, completed: 0, progress: 0, error: null });
  };

  const runWithConcurrency = async <T,>(items: T[], worker: (item: T, index: number) => Promise<void>) => {
    const workers = Array.from(
      { length: Math.min(IMAGE_UPLOAD_CONCURRENCY, items.length) },
      async (_, workerIndex) => {
        for (let i = workerIndex; i < items.length; i += IMAGE_UPLOAD_CONCURRENCY) {
          await worker(items[i], i);
        }
      },
    );
    await Promise.all(workers);
  };

  const onStartImageUpload = async () => {
    const files = [...selectedImageFiles];
    if (files.length === 0 || !selectedMemoryId) {
      return;
    }

    const currentImageCount = uploadedImages.length;
    const nextTotal = deletePreviousImageFile ? files.length : currentImageCount + files.length;
    if (nextTotal > MAX_IMAGE_COUNT) {
      const remaining = Math.max(0, MAX_IMAGE_COUNT - currentImageCount);
      if (deletePreviousImageFile) {
        setStatusMessage(`이미지는 최대 ${MAX_IMAGE_COUNT}장까지 업로드할 수 있습니다.`);
      } else {
        setStatusMessage(`이미지는 최대 ${MAX_IMAGE_COUNT}장까지 업로드할 수 있습니다. 현재 ${remaining}장 더 업로드 가능합니다.`);
      }
      return;
    }

    setSegmentsBusy(true);
    setStatusMessage(null);
    setImageUploadState({
      phase: 'preparing',
      total: files.length,
      completed: 0,
      progress: 0,
      error: null,
    });
    try {
      let workingSegments = [...segments].sort((a, b) => Number(a.t0 || 0) - Number(b.t0 || 0));
      const existingUrlsForCleanup = deletePreviousImageFile
        ? uploadedImages.map((item) => item.url)
        : [];

      if (deletePreviousImageFile) {
        for (const segment of workingSegments) {
          const cleared = await updateSegment(segment.id, {
            left_image_url: null,
            right_image_url: null,
          });
          setSegments((prev) => prev.map((item) => (item.id === cleared.id ? toDraft(cleared) : item)));
        }
        workingSegments = workingSegments.map((segment) => ({
          ...segment,
          left_image_url: '',
          right_image_url: '',
        }));
      }

      const slots: Array<{ segmentId: string; side: 'left' | 'right' }> = [];
      if (deletePreviousImageFile) {
        for (const segment of workingSegments) {
          slots.push({ segmentId: segment.id, side: 'left' });
          slots.push({ segmentId: segment.id, side: 'right' });
        }
      } else {
        for (const segment of workingSegments) {
          if (!segment.left_image_url) {
            slots.push({ segmentId: segment.id, side: 'left' });
          }
          if (!segment.right_image_url) {
            slots.push({ segmentId: segment.id, side: 'right' });
          }
        }
      }

      if (workingSegments.length === 0) {
        const ids = await ensureSegmentIdsForImageCount(Math.max(1, Math.ceil(files.length / 2)));
        for (const id of ids) {
          slots.push({ segmentId: id, side: 'left' });
          slots.push({ segmentId: id, side: 'right' });
        }
      }

      while (slots.length < files.length) {
        const sorted = [...segments].sort((a, b) => Number(a.t0 || 0) - Number(b.t0 || 0));
        const parsed = sorted
          .map((segment) => Number(segment.t1))
          .filter((value) => Number.isFinite(value)) as number[];
        const start = parsed.length > 0 ? Math.max(...parsed) : 0;
        const end = selectedMemory?.duration_seconds
          ? Math.min(start + 1, selectedMemory.duration_seconds)
          : start + 1;
        const safeEnd = end <= start ? start + 0.5 : end;
        const created = await createSegment(selectedMemoryId, start, safeEnd);
        const draft = toDraft(created);
        setSegments((prev) => [...prev, draft]);
        slots.push({ segmentId: draft.id, side: 'left' });
        slots.push({ segmentId: draft.id, side: 'right' });
      }

      if (slots.length === 0) {
        throw new Error('세그먼트를 찾을 수 없습니다.');
      }

      const assignments = files
        .map((file, index) => {
          const slot = slots[index];
          if (!slot) {
            return null;
          }
          return { file, segmentId: slot.segmentId, side: slot.side };
        })
        .filter(
          (item): item is { file: File; segmentId: string; side: 'left' | 'right' } =>
            item != null,
        );

      setImageUploadState((prev) => ({
        ...prev,
        phase: 'uploading',
        total: assignments.length,
        completed: 0,
        progress: 0,
      }));

      await runWithConcurrency(assignments, async (item) => {
        await uploadSegmentImageFile(item.segmentId, item.side, item.file);
        setImageUploadState((prev) => {
          const completed = Math.min(prev.total, prev.completed + 1);
          const progress = prev.total > 0 ? Math.round((completed / prev.total) * 100) : 100;
          return { ...prev, completed, progress };
        });
      });

      if (existingUrlsForCleanup.length > 0) {
        void Promise.allSettled(existingUrlsForCleanup.map((url) => deleteMediaByPublicUrlSilently(url)));
      }

      setImageUploadState((prev) => ({
        ...prev,
        phase: 'done',
        completed: prev.total,
        progress: 100,
      }));
      setSelectedImageFiles([]);
      setStatusMessage(`${files.length}개 이미지를 업로드했습니다.`);
    } catch (error) {
      setImageUploadState((prev) => ({
        ...prev,
        phase: 'error',
        error: error instanceof Error ? error.message : '이미지 업로드 실패',
      }));
      setStatusMessage(error instanceof Error ? `이미지 업로드 실패: ${error.message}` : '이미지 업로드에 실패했습니다.');
    } finally {
      setSegmentsBusy(false);
    }
  };

  const onRemoveUploadedImage = async (image: UploadedImageItem) => {
    setSegmentsBusy(true);
    setStatusMessage(null);
    try {
      await tryDeleteMediaByPublicUrl(image.url, '이미지 파일');
      const payload = image.side === 'left'
        ? { left_image_url: null }
        : { right_image_url: null };
      const updated = await updateSegment(image.segmentId, payload);
      setSegments((prev) => prev.map((segment) => (segment.id === updated.id ? toDraft(updated) : segment)));
      setStatusMessage('이미지를 삭제했습니다.');
    } catch (error) {
      setStatusMessage(error instanceof Error ? `이미지 삭제 실패: ${error.message}` : '이미지 삭제에 실패했습니다.');
    } finally {
      setSegmentsBusy(false);
    }
  };

  const onPublish = async () => {
    if (!selectedMemoryId) {
      return;
    }

    setPublishState('loading');
    setPublishError(null);

    try {
      await publishMemory(selectedMemoryId);
      setPublishState('success');
      await loadMemories();
    } catch (error) {
      setPublishState('error');
      setPublishError(error instanceof Error ? error.message : '메모리 공개에 실패했습니다.');
    }
  };

  const onSignOut = async () => {
    setSignOutBusy(true);
    setStatusMessage(null);
    try {
      const { error } = await supabase.auth.signOut();
      if (error) {
        throw error;
      }
      navigate('/signin', { replace: true });
    } catch (error) {
      setStatusMessage(error instanceof Error ? `로그아웃 실패: ${error.message}` : '로그아웃에 실패했습니다.');
    } finally {
      setSignOutBusy(false);
    }
  };

  return (
    <motion.main
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      className="vm-studio mx-auto w-full max-w-[430px] overflow-x-hidden rounded-2xl p-3 max-[393px]:p-2.5 max-[375px]:p-2 sm:max-w-6xl sm:p-6"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900 max-[393px]:text-xl">스튜디오</h1>
        <button
          type="button"
          onClick={onSignOut}
          disabled={signOutBusy}
          className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 transition hover:border-slate-400 hover:bg-slate-50 disabled:opacity-50 max-[430px]:px-2.5 max-[430px]:py-1 max-[430px]:text-[13px]"
        >
          {signOutBusy ? '로그아웃 중...' : '로그아웃'}
        </button>
      </div>

      <div className="mt-4 grid gap-3 max-[393px]:gap-2.5 lg:mt-6 lg:gap-6 lg:grid-cols-[300px_1fr]">
        <section className="min-w-0 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <h2 className="text-sm font-semibold text-slate-700">메모리 목록</h2>
          <form className="mt-3 grid grid-cols-[minmax(0,1fr)_44px] gap-2" onSubmit={onCreateMemory}>
            <input
              value={newMemoryTitle}
              onChange={(event) => setNewMemoryTitle(event.target.value)}
              placeholder="새 메모리 제목"
              className="min-w-0 w-full rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-sm max-[430px]:py-1.5 max-[430px]:text-[13px]"
            />
            <button
              type="submit"
              disabled={busy}
              className="h-full w-full rounded-lg bg-slate-900 px-0 py-2 text-base font-semibold text-white disabled:opacity-50 max-[430px]:py-1.5"
            >
              +
            </button>
          </form>

          <div className="mt-4 max-h-[34vh] space-y-2 overflow-auto pr-1 lg:max-h-none">
            {memories.map((memory) => (
              <div
                key={memory.id}
                className={`w-full rounded-lg border px-3 py-2 text-left text-sm ${
                  memory.id === selectedMemoryId
                    ? 'border-slate-900 bg-slate-50 shadow-sm'
                    : 'border-slate-200 bg-white'
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <button type="button" onClick={() => setSelectedMemoryId(memory.id)} className="min-w-0 flex-1 text-left">
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate font-medium">{memory.title || '제목 없음'}</span>
                      {memory.id === selectedMemoryId && (
                        <span className="shrink-0 rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold text-emerald-700">
                          active
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-slate-500">{new Date(memory.created_at).toLocaleString()}</div>
                  </button>
                  <button
                    type="button"
                    onClick={() => onDeleteMemory(memory.id)}
                    disabled={busy}
                    className="shrink-0 rounded-lg border border-red-200 p-1.5 text-red-500 transition hover:bg-red-50 hover:text-red-600 disabled:opacity-50"
                    aria-label="메모리 삭제"
                    title="메모리 삭제"
                  >
                    <svg
                      viewBox="0 0 24 24"
                      fill="none"
                      className="h-4 w-4"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <path d="M3 6h18" />
                      <path d="M8 6V4h8v2" />
                      <path d="M19 6l-1 14H6L5 6" />
                      <path d="M10 11v6" />
                      <path d="M14 11v6" />
                    </svg>
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className="min-w-0 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          {!selectedMemory ? (
            <p className="text-sm text-slate-500">편집할 메모리를 선택하세요.</p>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-1.5 sm:flex sm:flex-wrap sm:items-center sm:gap-2">
                <h2 className="col-span-2 text-lg font-semibold tracking-tight text-slate-900">{selectedMemory.title || '제목 없음'}</h2>
                <button
                  type="button"
                  onClick={() => window.open(`/?preview=${selectedMemory.id}`, '_blank', 'noopener,noreferrer')}
                  className="w-full rounded-lg border border-slate-300 bg-white px-2.5 py-1 text-[13px] font-medium text-slate-700 sm:w-auto sm:px-3 sm:py-1.5 sm:text-sm"
                >
                  미리보기
                </button>
                <button
                  type="button"
                  onClick={onPublish}
                  disabled={publishState === 'loading' || busy || segmentsBusy || analyzingWaveform}
                  className="w-full rounded-lg bg-slate-900 px-2.5 py-1 text-[13px] text-white disabled:opacity-50 sm:w-auto sm:px-3 sm:py-1.5 sm:text-sm"
                >
                  {publishState === 'loading' ? '공개 중...' : '공개'}
                </button>
              </div>

              {publishState === 'success' && (
                <p className="mt-2 text-sm text-emerald-700">공개했습니다.</p>
              )}
              {publishState === 'error' && (
                <p className="mt-2 text-sm text-red-700">{publishError ?? '공개에 실패했습니다.'}</p>
              )}

              <div className="mt-4 rounded-lg border border-slate-200 bg-white p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <label className="text-sm font-medium">오디오 업로드</label>
                  {audioUploadState.phase === 'done' && (
                    <div className="inline-flex items-center gap-2">
                      <div className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-1 text-xs text-emerald-700">
                        <span className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-emerald-500 text-[10px] text-white">
                          ✓
                        </span>
                        업로드 성공
                      </div>
                      <span className="text-xs text-slate-600">
                        길이: {formatDurationLabel(selectedMemory.duration_seconds)}
                      </span>
                    </div>
                  )}
                  {audioUploadState.phase === 'error' && (
                    <div className="inline-flex items-center gap-1 rounded-full bg-red-50 px-2 py-1 text-xs text-red-700">
                      <span className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-red-500 text-[10px] text-white">
                        !
                      </span>
                      업로드 실패
                    </div>
                  )}
                </div>
                <input
                  ref={audioFileInputRef}
                  type="file"
                  accept="audio/*"
                  onChange={onAudioUpload}
                  disabled={busy || analyzingWaveform}
                  className="hidden"
                />
                <div className="mt-3 grid grid-cols-3 gap-1.5 sm:flex sm:flex-wrap sm:items-center sm:gap-2">
                  <button
                    type="button"
                    onClick={onToggleRecording}
                    disabled={!recordingMimeType || busy || analyzingWaveform || segmentsBusy}
                    className="w-full rounded-lg bg-slate-900 px-2.5 py-1 text-[13px] text-white disabled:opacity-50 sm:w-auto sm:px-3 sm:py-1.5 sm:text-sm"
                  >
                    {isRecording ? '정지' : recordedBlob ? '다시 녹음하기' : '녹음하기'}
                  </button>
                  <button
                    type="button"
                    onClick={onSaveRecording}
                    disabled={isRecording || !recordedBlob || busy}
                    className="w-full rounded-lg bg-blue-600 px-2.5 py-1 text-[13px] text-white disabled:opacity-50 sm:w-auto sm:px-3 sm:py-1.5 sm:text-sm"
                  >
                    저장(업로드)
                  </button>
                  <button
                    type="button"
                    onClick={() => audioFileInputRef.current?.click()}
                    disabled={busy || analyzingWaveform}
                    className="w-full rounded-lg border border-slate-300 px-2.5 py-1 text-[13px] disabled:opacity-50 sm:w-auto sm:px-3 sm:py-1.5 sm:text-sm"
                  >
                    파일 선택
                  </button>
                  {(isRecording || recordedBlob || recordingSeconds > 0) && (
                    <span className="col-span-3 text-center text-sm font-medium tabular-nums text-slate-700 max-[430px]:text-[13px] sm:col-span-1 sm:text-left sm:text-sm">
                      {formatSeconds(recordingSeconds)}
                    </span>
                  )}
                </div>

                {(isRecording || recordingSeconds > 0) && (
                  <div className="mt-2 h-2 w-full overflow-hidden rounded bg-slate-200">
                    <div
                      className="h-full bg-emerald-500"
                      style={{ width: `${Math.round(recordingLevel * 100)}%` }}
                    />
                  </div>
                )}

                {recordedUrl && (
                  <audio controls src={recordedUrl} className="mt-3 w-full">
                  </audio>
                )}

                {recordingError && (
                  <p className="mt-2 text-sm text-amber-700">{recordingError}</p>
                )}

                {!recordingMimeType && (
                  <p className="mt-2 text-sm text-amber-700">
                    MediaRecorder 형식을 지원하지 않습니다. 파일 업로드를 사용하세요.
                  </p>
                )}
                {(audioUploadState.phase === 'uploading' || audioUploadState.phase === 'saving') && (
                  <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-2 text-xs text-slate-700">
                    <p>
                      업로드 중 {audioUploadState.progress}%
                    </p>
                    {audioUploadState.error && (
                      <p className="mt-1 text-red-700">오류: {audioUploadState.error}</p>
                    )}
                    <div className="mt-2 h-2 w-full overflow-hidden rounded bg-slate-200">
                      <div
                        className="h-full bg-blue-500 transition-all"
                        style={{ width: `${audioUploadState.progress}%` }}
                      />
                    </div>
                  </div>
                )}
              </div>

              <div className="mt-4 rounded-lg border border-slate-200 bg-white p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <label className="text-sm font-medium">이미지 업로드</label>
                  {imageUploadState.phase === 'done' && (
                    <div className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-1 text-xs text-emerald-700">
                      <span className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-emerald-500 text-[10px] text-white">
                        ✓
                      </span>
                      업로드 성공
                    </div>
                  )}
                  {imageUploadState.phase === 'error' && (
                    <div className="inline-flex items-center gap-1 rounded-full bg-red-50 px-2 py-1 text-xs text-red-700">
                      <span className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-red-500 text-[10px] text-white">
                        !
                      </span>
                      업로드 실패
                    </div>
                  )}
                </div>
                <div className="mt-2 flex items-center gap-2">
                  <input
                    ref={imageUploadInputRef}
                    type="file"
                    multiple
                    accept="image/*"
                    onChange={onQuickSegmentImageUpload}
                    disabled={segmentsBusy || busy}
                    className="hidden"
                  />
                  <button
                    type="button"
                    onClick={() => imageUploadInputRef.current?.click()}
                    disabled={segmentsBusy || busy}
                    className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm disabled:opacity-50"
                  >
                    파일 선택
                  </button>
                  <button
                    type="button"
                    onClick={onStartImageUpload}
                    disabled={segmentsBusy || busy || selectedImageFiles.length === 0}
                    className="rounded-lg bg-slate-900 px-3 py-1.5 text-sm text-white disabled:opacity-50"
                  >
                    업로드
                  </button>
                </div>
                <p className="mt-2 text-xs text-slate-600">
                  선택됨: {selectedImageFiles.length}개 / 최대 {MAX_IMAGE_COUNT}개
                </p>
                <label className="mt-2 flex items-center gap-2 text-xs text-slate-600">
                  <input
                    type="checkbox"
                    checked={deletePreviousImageFile}
                    onChange={(event) => setDeletePreviousImageFile(event.target.checked)}
                  />
                  교체 성공 후 이전 이미지 파일 삭제
                </label>
                {(imageUploadState.phase === 'preparing' || imageUploadState.phase === 'uploading') && (
                  <div className="mt-2 rounded-lg border border-slate-200 bg-slate-50 p-2 text-xs text-slate-700">
                    <p>
                      {imageUploadState.phase === 'preparing'
                        ? '업로드 준비 중...'
                        : `업로드 중 ${imageUploadState.progress}%`}
                    </p>
                    {imageUploadState.error && (
                      <p className="mt-1 text-red-700">{imageUploadState.error}</p>
                    )}
                    <div className="mt-2 h-2 w-full overflow-hidden rounded bg-slate-200">
                      <div
                        className="h-full bg-blue-500 transition-all"
                        style={{ width: `${imageUploadState.progress}%` }}
                      />
                    </div>
                  </div>
                )}
                <div className="mt-3">
                  <p className="text-xs text-slate-600">업로드된 이미지 ({uploadedImages.length})</p>
                  {uploadedImages.length === 0 ? (
                    <p className="mt-2 text-xs text-slate-500">아직 업로드된 이미지가 없습니다.</p>
                  ) : (
                    <div className="mt-2 grid grid-cols-4 gap-2 sm:grid-cols-6">
                      {uploadedImages.map((image, index) => (
                        <div key={`${image.segmentId}-${image.side}-${index}`} className="relative overflow-hidden rounded-lg border border-slate-200 bg-slate-100">
                          <img src={image.url} alt={`업로드 이미지 ${index + 1}`} className="h-16 w-full object-cover" />
                          <button
                            type="button"
                            onClick={() => onRemoveUploadedImage(image)}
                            disabled={segmentsBusy || busy}
                            className="absolute right-1 top-1 inline-flex h-4 w-4 items-center justify-center rounded-full bg-black/70 text-[10px] text-white disabled:opacity-50"
                            aria-label="이미지 삭제"
                            title="이미지 삭제"
                          >
                            ×
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </>
          )}

        </section>
      </div>
    </motion.main>
  );
}
