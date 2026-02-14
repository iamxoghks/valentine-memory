import { useEffect, useState } from 'react';
import { Route, Routes, useLocation } from 'react-router-dom';
import { Session } from '@supabase/supabase-js';
import { PublicPlayer } from './pages/PublicPlayer';
import { SignIn } from './pages/SignIn';
import { SignUp } from './pages/SignUp';
import { Studio } from './pages/Studio';
import { ProtectedRoute } from './routes/ProtectedRoute';
import { isSupabaseConfigured, supabase, supabaseConfigError } from './lib/supabaseClient';

function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const location = useLocation();

  useEffect(() => {
    if (!isSupabaseConfigured) {
      setIsLoading(false);
      return;
    }

    let mounted = true;

    supabase.auth.getSession().then(({ data }) => {
      if (!mounted) {
        return;
      }
      setSession(data.session);
      setIsLoading(false);
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
      setIsLoading(false);
    });

    return () => {
      mounted = false;
      subscription.unsubscribe();
    };
  }, []);

  const isPublicPlayerRoute = location.pathname === '/';
  const isAuthRoute = location.pathname === '/signin' || location.pathname === '/signup';
  const appClassName = isPublicPlayerRoute
    ? 'vm-public-shell h-[100dvh] overflow-hidden overscroll-none'
    : isAuthRoute
      ? 'vm-page-shell h-[100dvh] overflow-hidden overscroll-none px-4 pt-[max(16px,env(safe-area-inset-top))] pb-[max(16px,env(safe-area-inset-bottom))] sm:px-8 sm:pt-8 sm:pb-8'
      : 'vm-page-shell min-h-[100dvh] overflow-x-hidden px-4 pt-[max(16px,env(safe-area-inset-top))] pb-[max(16px,env(safe-area-inset-bottom))] sm:px-8 sm:pt-8 sm:pb-8';

  useEffect(() => {
    document.documentElement.classList.toggle('vm-public-mode', isPublicPlayerRoute);
    document.body.classList.toggle('vm-public-mode', isPublicPlayerRoute);
    document.documentElement.classList.toggle('vm-auth-mode', isAuthRoute);
    document.body.classList.toggle('vm-auth-mode', isAuthRoute);
    return () => {
      document.documentElement.classList.remove('vm-public-mode');
      document.body.classList.remove('vm-public-mode');
      document.documentElement.classList.remove('vm-auth-mode');
      document.body.classList.remove('vm-auth-mode');
    };
  }, [isAuthRoute, isPublicPlayerRoute]);

  useEffect(() => {
    if (!isPublicPlayerRoute) {
      return;
    }
    const previousBodyOverflow = document.body.style.overflow;
    const previousBodyOverscroll = document.body.style.overscrollBehavior;
    const previousBodyUserSelect = document.body.style.userSelect;
    const previousBodyWebkitUserSelect = document.body.style.webkitUserSelect;
    const previousBodyWebkitTouchCallout = document.body.style.getPropertyValue('-webkit-touch-callout');
    const previousHtmlOverflow = document.documentElement.style.overflow;
    const previousHtmlOverscroll = document.documentElement.style.overscrollBehavior;
    const previousHtmlUserSelect = document.documentElement.style.userSelect;
    const previousHtmlWebkitUserSelect = document.documentElement.style.webkitUserSelect;
    const previousHtmlWebkitTouchCallout = document.documentElement.style.getPropertyValue('-webkit-touch-callout');

    document.body.style.overflow = 'hidden';
    document.body.style.overscrollBehavior = 'none';
    document.body.style.userSelect = 'none';
    document.body.style.webkitUserSelect = 'none';
    document.body.style.setProperty('-webkit-touch-callout', 'none');
    document.documentElement.style.overflow = 'hidden';
    document.documentElement.style.overscrollBehavior = 'none';
    document.documentElement.style.userSelect = 'none';
    document.documentElement.style.webkitUserSelect = 'none';
    document.documentElement.style.setProperty('-webkit-touch-callout', 'none');

    return () => {
      document.body.style.overflow = previousBodyOverflow;
      document.body.style.overscrollBehavior = previousBodyOverscroll;
      document.body.style.userSelect = previousBodyUserSelect;
      document.body.style.webkitUserSelect = previousBodyWebkitUserSelect;
      document.body.style.setProperty('-webkit-touch-callout', previousBodyWebkitTouchCallout);
      document.documentElement.style.overflow = previousHtmlOverflow;
      document.documentElement.style.overscrollBehavior = previousHtmlOverscroll;
      document.documentElement.style.userSelect = previousHtmlUserSelect;
      document.documentElement.style.webkitUserSelect = previousHtmlWebkitUserSelect;
      document.documentElement.style.setProperty('-webkit-touch-callout', previousHtmlWebkitTouchCallout);
    };
  }, [isPublicPlayerRoute]);

  if (!isSupabaseConfigured) {
    return (
      <div className="min-h-screen bg-slate-100 p-6 sm:p-10">
        <div className="mx-auto max-w-xl rounded-xl border border-amber-300 bg-white p-6">
          <h1 className="text-xl font-semibold text-slate-900">설정이 필요합니다</h1>
          <p className="mt-3 text-sm text-slate-700">
            {supabaseConfigError}
          </p>
          <p className="mt-2 text-sm text-slate-700">
            `.env`에 값을 입력한 뒤 개발/빌드 프로세스를 다시 시작하세요.
          </p>
          <p className="mt-4 text-xs text-slate-500">
            필수 값: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className={appClassName}>
      <Routes>
        <Route path="/" element={<PublicPlayer isAuthenticated={!!session} isAuthLoading={isLoading} />} />
        <Route path="/signin" element={<SignIn />} />
        <Route path="/signup" element={<SignUp />} />
        <Route element={<ProtectedRoute isAuthenticated={!!session} isLoading={isLoading} />}>
          <Route path="/studio" element={<Studio />} />
        </Route>
      </Routes>
    </div>
  );
}

export default App;
