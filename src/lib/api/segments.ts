import { supabase } from '../supabaseClient';

export type Segment = {
  id: string;
  memory_id: string;
  t0: number | null;
  t1: number | null;
  left_image_url: string | null;
  right_image_url: string | null;
  created_at: string;
};

const SEGMENT_SELECT = 'id, memory_id, t0, t1, left_image_url, right_image_url, created_at';

export async function listSegmentsByMemoryId(memoryId: string): Promise<Segment[]> {
  const { data, error } = await supabase
    .from('segments')
    .select(SEGMENT_SELECT)
    .eq('memory_id', memoryId)
    .order('created_at', { ascending: true });

  if (error) {
    throw error;
  }

  return (data ?? []) as Segment[];
}

export async function createSegment(memoryId: string, t0: number, t1: number): Promise<Segment> {
  const { data, error } = await supabase
    .from('segments')
    .insert({ memory_id: memoryId, t0, t1 })
    .select(SEGMENT_SELECT)
    .single();

  if (error) {
    throw error;
  }

  return data as Segment;
}

export async function updateSegment(
  segmentId: string,
  payload: Partial<Pick<Segment, 't0' | 't1' | 'left_image_url' | 'right_image_url'>>,
): Promise<Segment> {
  const { data, error } = await supabase
    .from('segments')
    .update(payload)
    .eq('id', segmentId)
    .select(SEGMENT_SELECT)
    .single();

  if (error) {
    throw error;
  }

  return data as Segment;
}

export async function deleteSegment(segmentId: string): Promise<void> {
  const { error } = await supabase.from('segments').delete().eq('id', segmentId);

  if (error) {
    throw error;
  }
}
