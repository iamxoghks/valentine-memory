import { FormEvent, useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabaseClient';

type RedirectState = {
  from?: {
    pathname?: string;
    search?: string;
  };
};

export function SignIn() {
  const navigate = useNavigate();
  const location = useLocation();
  const redirectState = location.state as RedirectState | null;
  const destination = useMemo(
    () => `${redirectState?.from?.pathname ?? '/studio'}${redirectState?.from?.search ?? ''}`,
    [redirectState],
  );

  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;

    supabase.auth.getSession().then(({ data }) => {
      if (mounted && data.session) {
        navigate(destination, { replace: true });
      }
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      if (session) {
        navigate(destination, { replace: true });
      }
    });

    return () => {
      mounted = false;
      subscription.unsubscribe();
    };
  }, [navigate, destination]);

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const normalized = email.trim();
    if (!normalized) {
      return;
    }

    setLoading(true);
    setMessage(null);

    try {
      const { error } = await supabase.auth.signInWithOtp({
        email: normalized,
        options: {
          shouldCreateUser: false,
          emailRedirectTo: `${window.location.origin}/signin`,
        },
      });

      if (error) {
        throw error;
      }

      setMessage('이메일로 로그인 링크를 보냈습니다. 메일함을 확인하세요.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '로그인에 실패했습니다.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <motion.main
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      className="vm-auth-card mx-auto w-full max-w-lg rounded-2xl border p-8 sm:p-10"
    >
      <h1 className="text-3xl font-semibold tracking-tight text-slate-900">로그인</h1>
      <p className="mt-2 text-sm leading-relaxed text-slate-600">이메일로 로그인 링크를 받아 접속하세요.</p>

      <form className="mt-6 space-y-3" onSubmit={onSubmit}>
        <input
          type="email"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          placeholder="이메일 주소"
          className="vm-input w-full rounded-xl px-4 py-3 text-sm"
        />
        <button
          type="submit"
          disabled={loading}
          className="vm-primary-btn w-full rounded-xl px-4 py-3 text-sm font-semibold text-white disabled:opacity-50"
        >
          {loading ? '전송 중...' : '로그인 링크 보내기'}
        </button>
      </form>

      {message && <p className="mt-4 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700">{message}</p>}

      <p className="mt-6 border-t border-slate-200 pt-5 text-sm text-slate-600">
        계정이 없나요?{' '}
        <Link to="/signup" className="font-semibold text-slate-900 underline decoration-slate-300 underline-offset-4">
          회원가입
        </Link>
      </p>
    </motion.main>
  );
}
