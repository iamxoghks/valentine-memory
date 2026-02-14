# Supabase 설정

## 1) 확장 기능

```sql
create extension if not exists pgcrypto;
```

## 2) 테이블

```sql
create table if not exists public.memories (
  id uuid primary key default gen_random_uuid(),
  title text,
  audio_url text,
  duration_seconds numeric,
  waveform_peaks jsonb,
  settings jsonb,
  published boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists public.segments (
  id uuid primary key default gen_random_uuid(),
  memory_id uuid not null references public.memories(id) on delete cascade,
  t0 numeric,
  t1 numeric,
  left_image_url text,
  right_image_url text,
  created_at timestamptz not null default now()
);

create index if not exists idx_memories_published on public.memories (published);
create index if not exists idx_segments_memory_id on public.segments (memory_id);
```

## 3) RLS 활성화

```sql
alter table public.memories enable row level security;
alter table public.segments enable row level security;
```

## 4) RLS 정책

### memories

```sql
drop policy if exists "memories_select_published_anon" on public.memories;
create policy "memories_select_published_anon"
on public.memories
for select
to anon
using (published = true);

drop policy if exists "memories_select_all_authenticated" on public.memories;
create policy "memories_select_all_authenticated"
on public.memories
for select
to authenticated
using (true);

drop policy if exists "memories_insert_authenticated" on public.memories;
create policy "memories_insert_authenticated"
on public.memories
for insert
to authenticated
with check (true);

drop policy if exists "memories_update_authenticated" on public.memories;
create policy "memories_update_authenticated"
on public.memories
for update
to authenticated
using (true)
with check (true);

drop policy if exists "memories_delete_authenticated" on public.memories;
create policy "memories_delete_authenticated"
on public.memories
for delete
to authenticated
using (true);
```

### segments

```sql
drop policy if exists "segments_select_published_anon" on public.segments;
create policy "segments_select_published_anon"
on public.segments
for select
to anon
using (
  exists (
    select 1
    from public.memories m
    where m.id = segments.memory_id
      and m.published = true
  )
);

drop policy if exists "segments_select_all_authenticated" on public.segments;
create policy "segments_select_all_authenticated"
on public.segments
for select
to authenticated
using (true);

drop policy if exists "segments_insert_authenticated" on public.segments;
create policy "segments_insert_authenticated"
on public.segments
for insert
to authenticated
with check (true);

drop policy if exists "segments_update_authenticated" on public.segments;
create policy "segments_update_authenticated"
on public.segments
for update
to authenticated
using (true)
with check (true);

drop policy if exists "segments_delete_authenticated" on public.segments;
create policy "segments_delete_authenticated"
on public.segments
for delete
to authenticated
using (true);
```

## 5) 공개 RPC (원자적 처리)

`publish_memory(target_id uuid)`는 단일 트랜잭션(함수 호출 트랜잭션)으로 실행됩니다.
`target_id`가 없으면 예외를 발생시키고 전체 업데이트가 롤백됩니다.

```sql
create or replace function public.publish_memory(target_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  updated_count integer;
begin
  update public.memories
  set published = false
  where published = true;

  update public.memories
  set published = true
  where id = target_id;

  get diagnostics updated_count = row_count;
  if updated_count = 0 then
    raise exception '메모리를 찾을 수 없습니다: %', target_id;
  end if;
end;
$$;
```

### RPC 권한

```sql
revoke all on function public.publish_memory(uuid) from public;
grant execute on function public.publish_memory(uuid) to authenticated;
```

## 6) Storage 가이드 (`media` 버킷)

1. 버킷 생성: `media`
2. 버킷 공개 여부: Public
3. `authenticated`만 업로드/수정/삭제 허용
4. 읽기 권한은 public 유지

권장 객체 경로:
- `audio/{memoryId}/{timestamp}.{ext}`
- `images/{memoryId}/{timestamp}.{ext}`

Storage 정책 SQL 예시:

```sql
-- 공개 읽기
create policy "media_public_read"
on storage.objects
for select
to public
using (bucket_id = 'media');

-- 인증 사용자 쓰기
create policy "media_auth_insert"
on storage.objects
for insert
to authenticated
with check (bucket_id = 'media');

create policy "media_auth_update"
on storage.objects
for update
to authenticated
using (bucket_id = 'media')
with check (bucket_id = 'media');

create policy "media_auth_delete"
on storage.objects
for delete
to authenticated
using (bucket_id = 'media');
```

## 7) 브라우저 마이크 안내

- 브라우저 마이크 녹음은 `https` 또는 `localhost`에서만 동작하도록 제한될 수 있습니다.
- 마이크 권한이 거부되거나 미지원이면 `오디오 파일 업로드`를 사용하세요.

## 8) 운영 체크리스트

배포 전에 아래 순서대로 점검하세요.

1. 확장 기능 + 테이블 SQL 실행
2. `memories`, `segments`에 RLS 활성화
3. `memories` 정책 전체 적용
4. `segments` 정책 전체 적용
5. `publish_memory` 함수 생성
6. RPC 권한 적용
   - `revoke all on function public.publish_memory(uuid) from public;`
   - `grant execute on function public.publish_memory(uuid) to authenticated;`
7. `media` 버킷 생성 및 public read 확인
8. `media` 버킷에서 authenticated 업로드/수정/삭제 확인
9. anon 조회 테스트
   - published 메모리만 조회되는지
   - published 메모리에 연결된 세그먼트만 조회되는지
10. authenticated 조회/삽입/수정/삭제 테스트 (`memories`, `segments`)
11. RPC 테스트
   - authenticated로 `publish_memory(target_id)` 호출
   - `published = true` 메모리가 정확히 1개인지 확인
12. 대시보드에서 Storage 정책 동작 확인
   - 비로그인 사용자는 업로드/삭제 불가
   - 로그인 사용자는 업로드/삭제 가능
