import { supabase } from '../supabaseClient';

export type Memory = {
  id: string;
  title: string | null;
  audio_url: string | null;
  duration_seconds: number | null;
  waveform_peaks: unknown;
  settings: unknown;
  published: boolean;
  created_at: string;
};

const MEMORY_SELECT =
  'id, title, audio_url, duration_seconds, waveform_peaks, settings, published, created_at';

export async function listMemories(): Promise<Memory[]> {
  const { data, error } = await supabase
    .from('memories')
    .select(MEMORY_SELECT)
    .order('created_at', { ascending: false });

  if (error) {
    throw error;
  }

  return (data ?? []) as Memory[];
}

export async function listPublishedMemories(): Promise<Memory[]> {
  const { data, error } = await supabase
    .from('memories')
    .select(MEMORY_SELECT)
    .eq('published', true)
    .order('created_at', { ascending: false });

  if (error) {
    throw error;
  }

  return (data ?? []) as Memory[];
}

export async function getMemoryById(memoryId: string): Promise<Memory | null> {
  const { data, error } = await supabase
    .from('memories')
    .select(MEMORY_SELECT)
    .eq('id', memoryId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return (data as Memory | null) ?? null;
}

export async function createMemory(title: string): Promise<Memory> {
  const { data, error } = await supabase
    .from('memories')
    .insert({ title })
    .select(MEMORY_SELECT)
    .single();

  if (error) {
    throw error;
  }

  return data as Memory;
}

export async function deleteMemory(memoryId: string): Promise<void> {
  const { error } = await supabase.from('memories').delete().eq('id', memoryId);

  if (error) {
    throw error;
  }
}

export async function updateMemoryAudio(
  memoryId: string,
  payload: { audio_url: string; duration_seconds: number | null },
): Promise<Memory> {
  const { data, error } = await supabase
    .from('memories')
    .update(payload)
    .eq('id', memoryId)
    .select(MEMORY_SELECT)
    .single();

  if (error) {
    throw error;
  }

  return data as Memory;
}

export async function publishMemory(memoryId: string): Promise<void> {
  const { error } = await supabase.rpc('publish_memory', { target_id: memoryId });

  if (error) {
    throw error;
  }
}

export async function updateMemoryWaveform(memoryId: string, waveform_peaks: number[]): Promise<Memory> {
  const { data, error } = await supabase
    .from('memories')
    .update({ waveform_peaks })
    .eq('id', memoryId)
    .select(MEMORY_SELECT)
    .single();

  if (error) {
    throw error;
  }

  return data as Memory;
}
