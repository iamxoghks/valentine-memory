# Valentine Memory

Valentine Memory는 사진과 오디오를 조합해 추억을 구성하고 공유하는 웹 프로젝트입니다.  
`Vite + React + TypeScript + Tailwind + Supabase` 스택으로 구성되어 있습니다.

## 주요 기능

- 회원가입/로그인
- 메모리 생성 및 편집
- 세그먼트(구간) 단위 이미지 구성
- 공개 메모리 재생 페이지
- Supabase 기반 데이터/스토리지 연동

## 기술 스택

- Frontend: React, TypeScript, Vite, Tailwind CSS
- Backend(BaaS): Supabase (Auth, Database, Storage, RPC)
- Routing: React Router

## 시작하기

### 1) 환경 변수 설정

`.env.example`를 복사해 `.env` 파일을 만드세요.

```bash
cp .env.example .env
```

아래 값을 채워야 앱이 정상 동작합니다.

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`

### 2) 설치 및 실행

```bash
npm install
npm run dev
```

### 3) 빌드

```bash
npm run build
npm run preview
```

## 배포 체크리스트

1. 배포 환경에 `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` 등록
2. `npm run build` 성공 확인
3. 서버 환경에서 정적 파일 및 API 연동 정상 동작 확인

## Supabase 설정 문서

테이블, RLS, RPC, Storage 정책은 `docs/supabase.md`를 참고하세요.

## 보안 주의사항 (Public 저장소용)

- `.env` 파일은 커밋하지 마세요.
- `service_role` 키, DB 비밀번호, 개인 토큰은 코드/문서에 넣지 마세요.
- 이 프로젝트는 브라우저용 `anon/publishable` 키만 사용합니다.
- 커밋 전 아래 명령으로 민감 문자열을 점검하세요.

```bash
rg -n "(service_role|SECRET|TOKEN|PASSWORD|PRIVATE KEY|sk-[A-Za-z0-9]|AIza|xoxb|ghp_)" -S . --glob '!node_modules/**' --glob '!dist/**'
```
